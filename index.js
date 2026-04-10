/* global Pear */
// Bare entry point — runs in Pear's JS runtime (not in the browser/WebView)
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'bare-fs'
import { join } from 'bare-path'
import b4a from 'b4a'
import https from 'bare-https'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'

const storage = Pear.config.storage
const keypairPath   = join(storage, 'keypair.json')
const drivePath     = join(storage, 'drive.json')
const corestorePath = join(storage, 'corestore')

mkdirSync(storage, { recursive: true })

// Global references — set during startup or identity creation
let store = null
let drive = null
let swarm = null     // persistent swarm that announces our own drive to DHT
let msgSwarm = null  // listens for incoming deal messages on our public key topic
let outSwarm = null  // persistent pre-bootstrapped swarm for outgoing messages

// Pending sends keyed by topic hex → queue of { payload, resolve, reject, timer }.
// Queue per topic because multiple messages can target the same peer concurrently.
const pendingSends = new Map()

// Cache of peer drives we've already connected to: driveKey (hex) → Hyperdrive
// Swarms are kept alive so subsequent reads are instant (no re-connection needed).
const peerDrives = new Map()

// dealId (hex string) → { attempts: number, timer: Timeout | null }
// Tracks undelivered deal_request messages and their retry state.
const pendingDeliveries = new Map()

// driveKey hex → { peerDrive, swarm }
// Persistent Hyperswarm connections to counterparties' drives for active deals.
// Messages (deal_response, deal_confirmed, deal_cancelled) are delivered via drive replication.
const activePeerDriveConnections = new Map()

// Write an outgoing message to own Hyperdrive outbox.
// Peer will read it via drive replication when they come online.
async function writeOutbox (dealId, msg) {
  if (!drive) return
  await drive.put(`/outbox/${dealId}.json`, b4a.from(JSON.stringify(msg))).catch(e => {
    console.error('[writeOutbox] failed:', String(e))
  })
  console.log('[outbox ←drive]', msg.type, 'dealId:', dealId.slice(0, 8))
}

// Remove our outbox entry for a deal (e.g. after deal reaches terminal state).
async function clearOutbox (dealId) {
  if (!drive) return
  await drive.del(`/outbox/${dealId}.json`).catch(() => {})
}

// IDs of deals that were just deleted by the cleanup loop.
// WebView polls /api/get-expired-deals to read and clear this set.
// If the user is currently viewing one of these deals, the UI redirects to main.
const expiredDealIds = new Set()

// Pending notifications for the WebView.
// Each entry: { type, dealId, title } — pushed from message handlers, cleared after read.
const pendingNotifications = []

function pushNotification (n) {
  console.log('[notify →UI]', n.type, 'dealId:', n.dealId?.slice(0, 8), '|', n.title)
  pendingNotifications.push(n)
}

// ---------------------------------------------------------------------------
// Keypair helpers
// ---------------------------------------------------------------------------

function loadKeypair () {
  if (!existsSync(keypairPath)) return null
  const saved = JSON.parse(readFileSync(keypairPath, 'utf8'))
  return {
    publicKey: b4a.from(saved.publicKey, 'hex'),
    secretKey: b4a.from(saved.secretKey, 'hex')
  }
}

function generateAndSaveKeypair () {
  const keypair = crypto.keyPair()
  writeFileSync(keypairPath, JSON.stringify({
    publicKey: b4a.toString(keypair.publicKey, 'hex'),
    secretKey: b4a.toString(keypair.secretKey, 'hex')
  }))
  return keypair
}

// ---------------------------------------------------------------------------
// Corestore + Hyperdrive helpers
// ---------------------------------------------------------------------------

async function initStore () {
  if (store) return
  store = new Corestore(corestorePath)
  await store.ready()
}

async function openDrive () {
  await initStore()
  const saved = JSON.parse(readFileSync(drivePath, 'utf8'))
  drive = new Hyperdrive(store, b4a.from(saved.key, 'hex'))
  await drive.ready()
}

async function createDrive () {
  await initStore()
  drive = new Hyperdrive(store)
  await drive.ready()

  writeFileSync(drivePath, JSON.stringify({
    key: b4a.toString(drive.key, 'hex')
  }))

  const emptyProfile = {
    name: '',
    bio: '',
    currency: 'USD',
    hasAvatar: false,
    avatarMime: '',
    memberSince: new Date().toISOString()
  }
  await drive.put('/profile.json', b4a.from(JSON.stringify(emptyProfile)))
}

// Announces our own Hyperdrive to Hyperswarm DHT so peers can replicate it.
// server: true  — we appear in DHT (others can find us)
// client: false — we don't look for others on this topic (that's done per-request)
// Kept alive for the app lifetime.
async function announceToSwarm () {
  if (!drive || swarm) return
  swarm = new Hyperswarm()
  swarm.on('connection', socket => store.replicate(socket))
  swarm.join(drive.discoveryKey, { server: true, client: false })
}


// ---------------------------------------------------------------------------
// Messaging layer — direct peer-to-peer deal delivery
//
// Each app listens for incoming messages on a topic derived from its own
// public key: crypto.discoveryKey(publicKey). This is separate from the
// drive replication swarm so the two don't interfere.
//
// Protocol: sender writes JSON + calls end() (half-close).
//           receiver buffers all chunks until 'end', processes, writes ACK, calls end().
//           Both sides are small JSON messages, no framing needed.
// ---------------------------------------------------------------------------

// Start listening for incoming deal messages on our own public key topic.
// Called once after identity is ready.
async function setupMsgSwarm (keypair) {
  if (!keypair || msgSwarm) return
  msgSwarm = new Hyperswarm()
  const topic = crypto.discoveryKey(keypair.publicKey)
  console.log('[msgSwarm] listening on topic:', b4a.toString(topic, 'hex').slice(0, 16) + '...')
  msgSwarm.join(topic, { server: true, client: false })
  msgSwarm.on('connection', socket => handleIncomingMessage(socket))

  // Pre-bootstrapped outgoing swarm — avoids cold-start DHT delay on first delivery.
  // Single persistent connection handler routes each socket to the correct pending
  // send via peerInfo.topics — fixes the old once('connection') race condition.
  outSwarm = new Hyperswarm()
  outSwarm.on('connection', (socket, peerInfo) => {
    socket.on('error', () => {}) // prevent uncaught error if socket times out unmatched
    for (const t of (peerInfo.topics ?? [])) {
      const tHex = b4a.toString(t, 'hex')
      const queue = pendingSends.get(tHex)
      if (!queue?.length) continue

      const pending = queue.shift()
      if (queue.length === 0) {
        pendingSends.delete(tHex)
        outSwarm.leave(t)
      }
      clearTimeout(pending.timer)

      console.log('[send →]', pending.payload.type, 'dealId:', pending.payload.dealId?.slice(0, 8))
      socket.write(b4a.from(JSON.stringify(pending.payload)))
      socket.end()

      const chunks = []
      socket.on('data', chunk => chunks.push(chunk))
      socket.on('end', () => {
        try {
          const response = JSON.parse(b4a.concat(chunks).toString().trim())
          if (response.type === 'deal_ack') {
            console.log('[send ✓]', pending.payload.type, 'acked')
            pending.resolve(true)
          } else {
            console.log('[send ✗]', pending.payload.type, 'unexpected response:', response.type)
            pending.reject(new Error(`Unexpected response: ${response.type}`))
          }
        } catch (e) {
          pending.reject(e)
        }
      })
      socket.on('error', pending.reject)
      return
    }
  })
}

// Handle a raw socket connection from a peer who wants to send us a message.
// Buffers all incoming data until the peer closes their write side, then processes.
function handleIncomingMessage (socket) {
  socket.on('error', () => {}) // prevent uncaught error on socket timeout/reset
  const chunks = []
  socket.on('data', chunk => chunks.push(chunk))
  socket.on('end', async () => {
    let msg
    try {
      msg = JSON.parse(b4a.concat(chunks).toString().trim())
    } catch {
      socket.end()
      return
    }

    console.log('[recv ←]', msg.type, 'dealId:', msg.dealId?.slice(0, 8))
    let response = { type: 'error', reason: 'unknown message type' }

    // Socket carries only the initial ping — counterparty connects to our drive and reads the deal.
    if (msg.type === 'deal_announce') {
      try {
        await handleIncomingDeal(msg)
        response = { type: 'deal_ack', dealId: msg.dealId }
      } catch (e) {
        console.error('[handleIncomingDeal] error:', String(e))
        response = { type: 'error', reason: String(e) }
      }
    }

    console.log('[recv reply]', response.type, 'for dealId:', msg.dealId?.slice(0, 8))
    socket.write(b4a.from(JSON.stringify(response)))
    socket.end()
  })
  socket.on('error', () => {})
}

// Called when we receive a deal_announce ping via socket.
// Connects to the sender's drive, reads the deal from their outbox,
// and saves it to our /incoming/deals/<id>.json.
async function handleIncomingDeal ({ dealId, senderDriveKey }) {
  if (!drive) return

  // Idempotent: skip if we already have this deal
  const existing = await drive.get(`/incoming/deals/${dealId}.json`)
  if (existing) return

  if (!senderDriveKey) throw new Error('deal_announce missing senderDriveKey')

  // Connect to sender's drive and sync it — also sets up persistent outbox watching
  await connectToPeerDriveForDeals(senderDriveKey)

  // Read the deal from sender's outbox (written before the ping was sent)
  const peerDrive = peerDrives.get(senderDriveKey)
  if (!peerDrive) throw new Error('failed to open sender drive')

  const buf = await peerDrive.get(`/outbox/${dealId}.json`).catch(() => null)
  if (!buf) throw new Error('deal not found in sender outbox')

  const deal = JSON.parse(b4a.toString(buf))
  deal.status = 'pending_counterparty'
  deal.initiator_drive_key = senderDriveKey

  await drive.put(`/incoming/deals/${dealId}.json`, b4a.from(JSON.stringify(deal)))
  pushNotification({ type: 'new_deal', dealId, title: deal.title ?? 'New deal' })
  // Drive connection already established above — no second call needed
}

// Called when the other party cancelled the deal.
// Finds our local copy (in pending or incoming), moves it to history with the
// appropriate cancelled_by_* status.
async function handleIncomingCancellation ({ dealId, cancelledBy }) {
  if (!drive) return

  const folders = ['/pending/deals', '/incoming/deals']
  for (const folder of folders) {
    const buf = await drive.get(`${folder}/${dealId}.json`).catch(() => null)
    if (!buf) continue

    const deal = JSON.parse(b4a.toString(buf))
    deal.status = cancelledBy === 'initiator' ? 'cancelled_by_initiator' : 'cancelled_by_counterparty'
    await drive.put(`/history/deals/${dealId}.json`, b4a.from(JSON.stringify(deal)))
    await drive.del(`${folder}/${dealId}.json`).catch(() => {})
    expiredDealIds.add(dealId) // reuse expired signal — WebView will navigate away
    await clearOutbox(dealId) // clear any outbox entry we had for this deal
    pushNotification({ type: 'deal_cancelled', dealId, title: deal.title ?? 'Deal' })
    return
  }
}

// Called when initiator receives deal_response from counterparty.
// Counterparty has approved the deal and sent their terms.
// We update our /pending/deals/ copy: set counterparty_terms + status pending_initiator.
async function handleDealResponse ({ dealId, counterpartyTerms }) {
  if (!drive) return
  const buf = await drive.get(`/pending/deals/${dealId}.json`).catch(() => null)
  if (!buf) return
  const deal = JSON.parse(b4a.toString(buf))
  if (deal.status !== 'pending_counterparty') return // idempotent: already processed
  deal.counterparty_terms = counterpartyTerms
  deal.status = 'pending_initiator'
  await drive.put(`/pending/deals/${dealId}.json`, b4a.from(JSON.stringify(deal)))
  pushNotification({ type: 'deal_response', dealId, title: deal.title ?? 'Deal' })
}

// Called when counterparty receives deal_confirmed from initiator.
// Initiator has reviewed our terms and confirmed — we move to in_progress.
async function handleDealConfirmed ({ dealId }) {
  if (!drive) return
  const buf = await drive.get(`/incoming/deals/${dealId}.json`).catch(() => null)
  if (!buf) return
  const deal = JSON.parse(b4a.toString(buf))
  if (deal.status === 'in_progress') return // idempotent: already processed
  deal.status = 'in_progress'
  await drive.put(`/incoming/deals/${dealId}.json`, b4a.from(JSON.stringify(deal)))
  await clearOutbox(dealId) // clear our deal_response from outbox — deal is moving forward
  pushNotification({ type: 'deal_confirmed', dealId, title: deal.title ?? 'Deal' })
}

// Called when we receive deal_closed from the other party.
// They have declared their obligations fulfilled and recorded their outcome rating for us.
// Logic:
//   - If this is the FIRST close (our copy is still in_progress): update status to
//     closed_by_<role>, store their outcome field, send notification.
//   - If this is the SECOND close (our copy is already closed_by_<our_role>): both
//     parties have closed — move to completed, clear both outbox entries.
async function handleDealClosed ({ dealId, closedBy, outcome }) {
  if (!drive) return

  const folders = ['/pending/deals', '/incoming/deals']
  let folder = null
  let deal = null

  for (const f of folders) {
    const buf = await drive.get(`${f}/${dealId}.json`).catch(() => null)
    if (buf) { folder = f; deal = JSON.parse(b4a.toString(buf)); break }
  }
  if (!deal) return // already in history or unknown

  // Store the other party's outcome rating for us.
  // closedBy tells us who sent this message; their outcome field rates the *other* party.
  if (closedBy === 'initiator') {
    if (deal.initiator_outcome !== undefined && deal.initiator_outcome !== null) return // idempotent
    deal.initiator_outcome = outcome
  } else {
    if (deal.counterparty_outcome !== undefined && deal.counterparty_outcome !== null) return // idempotent
    deal.counterparty_outcome = outcome
  }

  // Determine what our own close status is (if we've already closed our side).
  const kp = loadKeypair()
  const myKey = kp ? b4a.toString(kp.publicKey, 'hex') : null
  const weAreInitiator = myKey && deal.initiator_key === myKey
  const ourCloseStatus = weAreInitiator ? 'closed_by_initiator' : 'closed_by_counterparty'
  const weHaveAlreadyClosed = deal.status === ourCloseStatus

  if (weHaveAlreadyClosed) {
    // Both parties have now declared — move to completed.
    deal.status = 'completed'
    await drive.put(`/history/deals/${dealId}.json`, b4a.from(JSON.stringify(deal)))
    await drive.del(`${folder}/${dealId}.json`).catch(() => {})
    await clearOutbox(dealId) // remove our own deal_closed from outbox
    pushNotification({ type: 'deal_completed', dealId, title: deal.title ?? 'Deal' })
  } else {
    // First close received — update status to show which party has closed.
    deal.status = closedBy === 'initiator' ? 'closed_by_initiator' : 'closed_by_counterparty'
    await drive.put(`${folder}/${dealId}.json`, b4a.from(JSON.stringify(deal)))
    pushNotification({ type: 'deal_closed_partial', dealId, title: deal.title ?? 'Deal' })
  }
}

// Send a lightweight ping to a peer by their public key.
// msg must be a plain object — will be JSON-serialised.
// Waits for { type: 'deal_ack' } response, rejects on timeout or error.
// Used only for deal_announce — actual deal payload lives in our Hyperdrive outbox.
async function sendDealToPeer (counterpartyPublicKeyHex, dealId, msg) {
  const topic = crypto.discoveryKey(b4a.from(counterpartyPublicKeyHex, 'hex'))
  const tHex = b4a.toString(topic, 'hex')
  const payload = msg ?? { type: 'deal_request', dealId }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Remove this entry from the queue on timeout
      const queue = pendingSends.get(tHex)
      if (queue) {
        const idx = queue.findIndex(p => p.resolve === resolve)
        if (idx !== -1) queue.splice(idx, 1)
        if (queue.length === 0) {
          pendingSends.delete(tHex)
          outSwarm.leave(topic)
        }
      }
      reject(new Error('Peer not reachable (timeout)'))
    }, 15000)

    // First message to this topic — join the swarm topic
    if (!pendingSends.has(tHex)) {
      pendingSends.set(tHex, [])
      outSwarm.join(topic, { server: false, client: true })
    }
    pendingSends.get(tHex).push({ payload, resolve, reject, timer })
  })
}

// Schedule delivery of a deal to its counterparty with exponential backoff.
// Retries until delivered, expired, or deleted from drive.
// Backoff: attempts 0–9 → 30s, 10–19 → 2min, 20+ → 10min
function scheduleDealDelivery (deal) {
  if (pendingDeliveries.has(deal.id)) return

  const state = { attempts: 0, timer: null }
  pendingDeliveries.set(deal.id, state)

  async function attempt () {
    if (!drive) return

    const buf = await drive.get(`/pending/deals/${deal.id}.json`).catch(() => null)
    if (!buf) { pendingDeliveries.delete(deal.id); return }

    const dealData = JSON.parse(b4a.toString(buf))
    const now = Math.floor(Date.now() / 1000)

    if (dealData.expires_at < now) {
      await drive.del(`/pending/deals/${deal.id}.json`).catch(() => {})
      pendingDeliveries.delete(deal.id)
      return
    }

    if (dealData.delivered) {
      pendingDeliveries.delete(deal.id)
      return
    }

    try {
      await sendDealToPeer(deal.counterparty_key, deal.id, {
        type: 'deal_announce',
        dealId: deal.id,
        senderDriveKey: b4a.toString(drive.key, 'hex')
      })

      // ACK received — counterparty read the deal from our outbox
      dealData.delivered = true
      dealData.status = 'pending_counterparty'
      await drive.put(`/pending/deals/${deal.id}.json`, b4a.from(JSON.stringify(dealData)))
      await clearOutbox(deal.id)
      pendingDeliveries.delete(deal.id)
      // Connect to counterparty's drive to receive their responses
      if (dealData.counterparty_drive_key) {
        connectToPeerDriveForDeals(dealData.counterparty_drive_key).catch(() => {})
      }
    } catch (err) {
      console.error('[delivery] attempt', state.attempts, 'failed:', String(err))
      state.attempts++
      const delay = state.attempts < 10 ? 30_000 : state.attempts < 20 ? 120_000 : 600_000
      state.timer = setTimeout(attempt, delay)
    }
  }

  attempt() // first attempt fires immediately
}

// Reads all JSON files from a Hyperdrive folder, returns parsed objects.
// drive.list() returns an async stream — cannot use .catch() on it like a Promise.
// Accepts optional d parameter to read from a peer's drive instead of own.
async function listDriveFolder (folder, d = drive) {
  const results = []
  try {
    for await (const entry of d.list(folder)) {
      const buf = await d.get(entry.key).catch(() => null)
      if (!buf) continue
      try { results.push(JSON.parse(b4a.toString(buf))) } catch {}
    }
  } catch {}
  return results
}

// On startup: scan /pending/deals/ and resume delivery for any undelivered deals.
// This handles the case where the app was closed before delivery succeeded.
async function resumePendingDeliveries () {
  if (!drive) return
  const now = Math.floor(Date.now() / 1000)
  const deals = await listDriveFolder('/pending/deals')
  for (const deal of deals) {
    if (deal.expires_at < now) {
      await drive.del(`/pending/deals/${deal.id}.json`).catch(() => {})
      continue
    }
    if (!deal.delivered) scheduleDealDelivery(deal)
  }
}

// ---------------------------------------------------------------------------
// Drive-based message delivery
//
// For deal_response, deal_confirmed, deal_cancelled — instead of pushing via
// socket (fragile), we write the message to our own Hyperdrive /outbox/<id>.json
// and keep a persistent Hyperswarm connection to the peer's drive.
// When peer comes online, drive replication delivers the message automatically.
// ---------------------------------------------------------------------------

// Connect to a peer's drive and keep it replicated for the duration of the deal.
// Sets up an append listener to process their outbox as new entries arrive.
async function connectToPeerDriveForDeals (peerDriveKeyHex) {
  if (!store || !peerDriveKeyHex) return
  if (activePeerDriveConnections.has(peerDriveKeyHex)) return

  let peerDrive = peerDrives.get(peerDriveKeyHex)
  if (!peerDrive) {
    peerDrive = new Hyperdrive(store, b4a.from(peerDriveKeyHex, 'hex'))
    await peerDrive.ready()
    peerDrives.set(peerDriveKeyHex, peerDrive)
  }

  const dealSwarm = new Hyperswarm()
  const done = peerDrive.db.core.findingPeers()
  dealSwarm.on('connection', socket => store.replicate(socket))
  dealSwarm.join(peerDrive.discoveryKey, { server: false, client: true })
  dealSwarm.flush().then(done, done)

  activePeerDriveConnections.set(peerDriveKeyHex, { peerDrive, swarm: dealSwarm })

  // Process outbox whenever new blocks arrive (covers both online and catch-up after offline)
  peerDrive.db.core.on('append', () => {
    processPeerOutbox(peerDriveKeyHex, peerDrive).catch(() => {})
  })

  // Initial scan after connecting — handles messages written while we were offline
  await peerDrive.db.core.update().catch(() => {})
  await processPeerOutbox(peerDriveKeyHex, peerDrive)
}

// Scan peer's /outbox/ and process any messages addressed to us.
// Idempotent — handlers check current deal state before applying changes.
async function processPeerOutbox (peerDriveKeyHex, peerDrive) {
  if (!drive) return
  const entries = await listDriveFolder('/outbox', peerDrive)
  for (const msg of entries) {
    if (!msg.type || !msg.dealId) continue
    try {
      if (msg.type === 'deal_response')  await handleDealResponse(msg)
      if (msg.type === 'deal_confirmed') await handleDealConfirmed(msg)
      if (msg.type === 'deal_cancelled') await handleIncomingCancellation(msg)
      if (msg.type === 'deal_closed')    await handleDealClosed(msg)
    } catch (e) {
      console.error('[processPeerOutbox]', msg.type, String(e))
    }
  }
}

// On startup: connect to drives of all peers with active (non-terminal) deals.
// Processes any outbox entries that arrived while we were offline.
async function setupActivePeerConnections () {
  if (!drive) return
  const kp = loadKeypair()
  if (!kp) return
  const myKey = b4a.toString(kp.publicKey, 'hex')

  const pending  = await listDriveFolder('/pending/deals')
  const incoming = await listDriveFolder('/incoming/deals')

  for (const deal of [...pending, ...incoming]) {
    const isInitiator  = deal.initiator_key === myKey
    const peerDriveKey = isInitiator ? deal.counterparty_drive_key : deal.initiator_drive_key
    if (peerDriveKey) await connectToPeerDriveForDeals(peerDriveKey)
  }
}


// ---------------------------------------------------------------------------
// Deal expiry cleanup
//
// Deals that haven't reached InProgress within 24h are deleted.
// Checks /pending/deals/ (outgoing) and /incoming/deals/ (incoming).
// Runs on startup and then every 60 seconds.
// Deleted deal IDs are added to expiredDealIds so the WebView can react.
// ---------------------------------------------------------------------------

async function cleanupExpiredDeals () {
  if (!drive) return
  const now = Math.floor(Date.now() / 1000)

  for (const folder of ['/pending/deals', '/incoming/deals']) {
    const deals = await listDriveFolder(folder)
    for (const deal of deals) {
      if (deal.expires_at < now) {
        // Move to history with status 'expired' instead of deleting — preserves record
        deal.status = 'expired'
        await drive.put(`/history/deals/${deal.id}.json`, b4a.from(JSON.stringify(deal)))
        await drive.del(`${folder}/${deal.id}.json`).catch(() => {})
        expiredDealIds.add(deal.id)

        const retry = pendingDeliveries.get(deal.id)
        if (retry) {
          if (retry.timer) clearTimeout(retry.timer)
          pendingDeliveries.delete(deal.id)
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Exchange rate cache
// Fetched in Bare because pear-electron blocks external requests from WebView.
// APIs used (no key required):
//   - open.er-api.com  → fiat: USD/RUB/EUR
//   - CoinGecko        → crypto: BTC, USDT
// Cache TTL: 5 minutes
// ---------------------------------------------------------------------------
const RATE_CACHE_TTL = 5 * 60 * 1000
let rateCache = null
let rateCacheAt = 0

function httpsGet (url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers: { 'User-Agent': 'TrustProtocol/0.1' } }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const body = b4a.concat(chunks).toString()
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url}: ${body.slice(0, 200)}`))
        }
        try {
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error(`JSON parse error from ${url}: ${body.slice(0, 200)}`))
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function fetchRates () {
  const now = Date.now()
  if (rateCache && (now - rateCacheAt) < RATE_CACHE_TTL) return rateCache

  const [fiat, crypto] = await Promise.all([
    httpsGet('https://open.er-api.com/v6/latest/USD'),
    httpsGet('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tether&vs_currencies=usd,rub,eur')
  ])

  rateCache = {
    RUB:  fiat.rates.RUB,
    EUR:  fiat.rates.EUR,
    BTC:  1 / crypto.bitcoin.usd,
    USDT: 1 / crypto.tether.usd
  }
  rateCacheAt = now
  return rateCache
}

function convertAmount (amount, currency, rates) {
  let usd
  switch (currency) {
    case 'USD':  usd = amount; break
    case 'RUB':  usd = amount / rates.RUB; break
    case 'EUR':  usd = amount / rates.EUR; break
    case 'BTC':  usd = amount / rates.BTC; break
    case 'USDT': usd = amount / rates.USDT; break
    default:     usd = amount
  }
  return {
    amount_usd:  usd,
    amount_rub:  usd * rates.RUB,
    amount_eur:  usd * rates.EUR,
    amount_btc:  usd * rates.BTC,
    amount_usdt: usd * rates.USDT
  }
}

// ---------------------------------------------------------------------------
// HTTP body reader — collects streamed request body into a single Buffer
// ---------------------------------------------------------------------------
function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(b4a.concat(chunks)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------------------
// Startup — open drive + announce if identity exists
// ---------------------------------------------------------------------------
const existing = loadKeypair()

if (existing && existsSync(drivePath)) {
  await openDrive()
  await announceToSwarm()
  await setupMsgSwarm(existing)
  await cleanupExpiredDeals()
  await resumePendingDeliveries()
  await setupActivePeerConnections()
  setInterval(cleanupExpiredDeals, 60_000)
}

// ---------------------------------------------------------------------------
// pear-bridge setup
// ---------------------------------------------------------------------------
const bridge = new Bridge({ mount: 'dist' })
await bridge.ready()

const [[bridgeHandler]] = bridge.server.listeners('request')
bridge.server.removeAllListeners('request')

bridge.server.on('request', async (req, res) => {
  const url = (req.url ?? '').split('+')[0]

  const json = (data, status = 200) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
  }

  try {
    // --- Identity: status ------------------------------------------------------
    // Returns { status: 'pending' } if no keypair, or { publicKey, driveKey } if exists.
    // WebView calls this on startup instead of reading pubkey.json via file://.
    if (url === '/api/get-identity') {
      if (!existsSync(keypairPath)) return json({ status: 'pending' })
      const saved = JSON.parse(readFileSync(keypairPath, 'utf8'))
      const driveSaved = existsSync(drivePath)
        ? JSON.parse(readFileSync(drivePath, 'utf8'))
        : null
      return json({
        publicKey: saved.publicKey,
        driveKey: driveSaved ? driveSaved.key : null
      })
    }

    // --- Identity: create -----------------------------------------------
    if (url === '/api/create-identity') {
      if (existsSync(keypairPath)) {
        // Idempotent: keypair already exists — return existing keys
        const saved = JSON.parse(readFileSync(keypairPath, 'utf8'))
        if (!drive && existsSync(drivePath)) await openDrive()
        if (!swarm) await announceToSwarm()
        const driveSaved = JSON.parse(readFileSync(drivePath, 'utf8'))
        return json({ publicKey: saved.publicKey, driveKey: driveSaved.key })
      }

      const keypair = generateAndSaveKeypair()
      const publicKey = b4a.toString(keypair.publicKey, 'hex')

      await createDrive()
      await announceToSwarm()
      await setupMsgSwarm(keypair)

      const driveSaved = JSON.parse(readFileSync(drivePath, 'utf8'))
      return json({ publicKey, driveKey: driveSaved.key })
    }

    // --- Identity: delete -----------------------------------------------
    if (url === '/api/delete-identity') {
      // Cancel all in-flight retry timers
      for (const { timer } of pendingDeliveries.values()) {
        if (timer) clearTimeout(timer)
      }
      pendingDeliveries.clear()

      // Cancel pending sends and destroy outSwarm
      for (const queue of pendingSends.values()) {
        for (const p of queue) { clearTimeout(p.timer); p.reject(new Error('identity deleted')) }
      }
      pendingSends.clear()

      // Destroy all active peer drive connections
      for (const { swarm: ds } of activePeerDriveConnections.values()) {
        await ds.destroy().catch(() => {})
      }
      activePeerDriveConnections.clear()

      if (outSwarm)  { await outSwarm.destroy();  outSwarm = null }
      if (msgSwarm)  { await msgSwarm.destroy();  msgSwarm = null }
      if (swarm)     { await swarm.destroy();     swarm = null }
      if (drive)    { await drive.close(); drive = null }
      if (store)    { await store.close(); store = null }

      // Old peer drives reference the now-closed store — drop them
      peerDrives.clear()

      if (existsSync(keypairPath))   unlinkSync(keypairPath)
      if (existsSync(drivePath))     unlinkSync(drivePath)
      if (existsSync(corestorePath)) rmSync(corestorePath, { recursive: true })

      return json({ ok: true })
    }

    // --- Profile: read --------------------------------------------------
    if (url === '/api/get-profile') {
      if (!drive) return json({ error: 'drive not ready' }, 500)
      const buf = await drive.get('/profile.json')
      if (!buf) return json({ name: '', bio: '', currency: 'USD', hasAvatar: false })
      return json(JSON.parse(b4a.toString(buf)))
    }

    // --- Profile: save --------------------------------------------------
    if (url === '/api/save-profile') {
      if (!drive) return json({ error: 'drive not ready' }, 500)
      const body = await readBody(req)
      const incoming = JSON.parse(b4a.toString(body))

      const existing_buf = await drive.get('/profile.json')
      const existing_profile = existing_buf
        ? JSON.parse(b4a.toString(existing_buf))
        : { hasAvatar: false, avatarMime: '' }

      const profile = {
        name:        incoming.name       ?? '',
        bio:         incoming.bio        ?? '',
        currency:    incoming.currency   ?? 'USD',
        hasAvatar:   existing_profile.hasAvatar,
        avatarMime:  existing_profile.avatarMime,
        memberSince: existing_profile.memberSince ?? null
      }

      await drive.put('/profile.json', b4a.from(JSON.stringify(profile)))
      return json({ ok: true })
    }

    // --- Avatar: upload -------------------------------------------------
    if (url === '/api/upload-avatar') {
      if (!drive) return json({ error: 'drive not ready' }, 500)

      const mime = req.headers['content-type'] || 'image/jpeg'
      const body = await readBody(req)

      await drive.put('/avatar', body)

      const buf = await drive.get('/profile.json')
      const profile = buf ? JSON.parse(b4a.toString(buf)) : {}
      profile.hasAvatar = true
      profile.avatarMime = mime
      await drive.put('/profile.json', b4a.from(JSON.stringify(profile)))

      return json({ ok: true })
    }

    // --- Avatar: serve --------------------------------------------------
    if (url === '/api/get-avatar') {
      if (!drive) return json({ error: 'drive not ready' }, 500)

      const buf = await drive.get('/avatar')
      if (!buf) { res.statusCode = 404; return res.end() }

      const profileBuf = await drive.get('/profile.json')
      const mime = profileBuf
        ? (JSON.parse(b4a.toString(profileBuf)).avatarMime || 'image/jpeg')
        : 'image/jpeg'

      res.statusCode = 200
      res.setHeader('Content-Type', mime)
      res.setHeader('Content-Length', buf.length)
      return res.end(buf)
    }

    // --- Peer avatar: serve --------------------------------------------
    // GET /api/get-peer-avatar?key=<driveKey>
    // Returns avatar binary for any peer (own or remote).
    if (url.startsWith('/api/get-peer-avatar')) {
      const peerDriveKey = url.split('?key=')[1]
      if (!peerDriveKey) { res.statusCode = 400; return res.end() }

      // Own avatar — read from our open drive directly
      if (drive && b4a.toString(drive.key, 'hex') === peerDriveKey) {
        const buf = await drive.get('/avatar')
        if (!buf) { res.statusCode = 404; return res.end() }
        const profileBuf = await drive.get('/profile.json')
        const mime = profileBuf
          ? (JSON.parse(b4a.toString(profileBuf)).avatarMime || 'image/jpeg')
          : 'image/jpeg'
        res.statusCode = 200
        res.setHeader('Content-Type', mime)
        res.setHeader('Content-Length', buf.length)
        return res.end(buf)
      }

      // Remote peer — reuse cached drive instance, fresh swarm for live connection
      let peerDrive = peerDrives.get(peerDriveKey)
      if (!peerDrive) {
        peerDrive = new Hyperdrive(store, b4a.from(peerDriveKey, 'hex'))
        await peerDrive.ready()
        peerDrives.set(peerDriveKey, peerDrive)
      }
      const avatarSwarm = new Hyperswarm()
      const avatarDone = peerDrive.db.core.findingPeers()
      avatarSwarm.on('connection', socket => store.replicate(socket))
      avatarSwarm.join(peerDrive.discoveryKey, { server: false, client: true })
      avatarSwarm.flush().then(avatarDone, avatarDone)

      try {
        await Promise.race([
          peerDrive.db.core.update(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))
        ])
      } catch {
        avatarSwarm.destroy()
        res.statusCode = 404; return res.end()
      }

      const buf = await peerDrive.get('/avatar').finally(() => avatarSwarm.destroy())
      if (!buf) { res.statusCode = 404; return res.end() }
      const profileBuf = await peerDrive.get('/profile.json')
      const mime = profileBuf
        ? (JSON.parse(b4a.toString(profileBuf)).avatarMime || 'image/jpeg')
        : 'image/jpeg'
      res.statusCode = 200
      res.setHeader('Content-Type', mime)
      res.setHeader('Content-Length', buf.length)
      return res.end(buf)
    }

    // --- Peer profile: fetch -------------------------------------------
    // Connects to a peer's Hyperdrive by driveKey and returns their profile.json.
    // Creates a short-lived Hyperswarm connection, destroys it when done.
    if (url === '/api/get-peer-profile') {
      const body = await readBody(req)
      const { driveKey: peerDriveKey } = JSON.parse(b4a.toString(body))

      // Fast path: own profile — data is already in our open drive
      if (drive && b4a.toString(drive.key, 'hex') === peerDriveKey) {
        const buf = await drive.get('/profile.json')
        if (!buf) return json({ error: 'Profile not found' }, 404)
        return json(JSON.parse(b4a.toString(buf)))
      }

      // Cache drive instance (keeps Hypercore data between requests) but always
      // create a fresh swarm — stale swarms don't recover after peer goes offline.
      let peerDrive = peerDrives.get(peerDriveKey)
      if (!peerDrive) {
        peerDrive = new Hyperdrive(store, b4a.from(peerDriveKey, 'hex'))
        await peerDrive.ready()
        peerDrives.set(peerDriveKey, peerDrive)
      }

      const freshSwarm = new Hyperswarm()

      // findingPeers() on the metadata core — tells Hypercore "wait for peer info
      // before resolving update()". Must be called BEFORE joining the swarm.
      const metaDone = peerDrive.db.core.findingPeers()

      freshSwarm.on('connection', socket => store.replicate(socket))
      freshSwarm.join(peerDrive.discoveryKey, { server: false, client: true })
      // When initial DHT discovery is exhausted, release the hold
      freshSwarm.flush().then(metaDone, metaDone)

      try {
        // update() now waits for the remote core length to be known
        // (blocked by findingPeers until flush() resolves or peer connects)
        await Promise.race([
          peerDrive.db.core.update(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Peer not reachable (timeout)')), 15000)
          )
        ])

        const profileBuf = await peerDrive.get('/profile.json')
        if (!profileBuf) return json({ error: 'Profile not found' }, 404)
        return json(JSON.parse(b4a.toString(profileBuf)))
      } finally {
        freshSwarm.destroy()
      }
    }

    // --- Exchange rates ------------------------------------------------
    // GET /api/get-rates?amount=100&currency=USD
    // Fetched in Bare — WebView can't reach external URLs (ERR_BLOCKED_BY_CLIENT)
    if (url.startsWith('/api/get-rates')) {
      const qs       = url.split('?')[1] ?? ''
      const amount   = parseFloat(qs.match(/amount=([^&]+)/)?.[1] ?? '0')
      const currency = (qs.match(/currency=([^&]+)/)?.[1] ?? 'USD').toUpperCase()

      if (!amount || amount <= 0) return json({ error: 'Invalid amount' }, 400)

      const rates = await fetchRates()
      return json({ ...convertAmount(amount, currency, rates), fetched_at: rateCacheAt })
    }

    // --- Deal: create --------------------------------------------------
    // POST /api/create-deal
    // Body: { title, initiator_terms, counterparty_key, original_amount,
    //         original_currency, amount_usd, amount_rub, amount_eur,
    //         amount_btc, amount_usdt, level, timestamp, expires_at }
    // Saves deal to /pending/deals/<id>.json and schedules delivery to counterparty.
    if (url === '/api/create-deal') {
      if (!drive) return json({ error: 'drive not ready' }, 500)
      const keypairData = loadKeypair()
      if (!keypairData) return json({ error: 'identity not ready' }, 500)

      const body = await readBody(req)
      const incoming = JSON.parse(b4a.toString(body))

      // Generate a random 32-byte deal ID, encoded as hex
      const idBytes = crypto.randomBytes(32)
      const id = b4a.toString(idBytes, 'hex')

      const deal = {
        id,
        initiator_key:       b4a.toString(keypairData.publicKey, 'hex'),
        initiator_drive_key: b4a.toString(drive.key, 'hex'),
        counterparty_key:    incoming.counterparty_key,
        counterparty_drive_key: incoming.counterparty_drive_key ?? null,
        timestamp:          incoming.timestamp,
        expires_at:         incoming.expires_at,
        original_amount:    incoming.original_amount,
        original_currency:  incoming.original_currency,
        amount_usd:         incoming.amount_usd,
        amount_rub:         incoming.amount_rub,
        amount_eur:         incoming.amount_eur,
        amount_btc:         incoming.amount_btc,
        amount_usdt:        incoming.amount_usdt,
        title:              incoming.title,
        level:              incoming.level,
        status:             'initiated',
        outcome:            null,
        initiator_terms:    incoming.initiator_terms,
        counterparty_terms: null,
        review_text:        null,
        rating_quality:     null,
        rating_timing:      null,
        rating_communication: null,
        initiator_sig:      null,
        counterparty_sig:   null,
        delivered:          false  // JS-only field, ignored by Rust deserializer
      }

      await drive.put(`/pending/deals/${id}.json`, b4a.from(JSON.stringify(deal)))
      await writeOutbox(id, deal)  // deal persists here until counterparty ACKs
      scheduleDealDelivery(deal)

      return json({ id })
    }

    // --- Deal: list incoming -------------------------------------------
    // GET /api/get-incoming-deals
    // Returns all deals in /incoming/deals/ — deals sent to us by counterparties.
    // WebView polls this on startup and periodically to detect new requests.
    if (url === '/api/get-incoming-deals') {
      if (!drive) return json([])
      return json(await listDriveFolder('/incoming/deals'))
    }

    // --- Deal: list outgoing ------------------------------------------
    // GET /api/get-outgoing-deals
    // Returns all deals in /pending/deals/ — deals we initiated.
    if (url === '/api/get-outgoing-deals') {
      if (!drive) return json([])
      return json(await listDriveFolder('/pending/deals'))
    }

    // --- Deal: cancel -------------------------------------------------
    // POST /api/cancel-deal  { id, role: 'initiator' | 'counterparty' }
    // Moves deal to history with cancelled_by_* status, then delivers
    // cancellation notice to the other party (fire and forget).
    if (url === '/api/cancel-deal') {
      if (!drive) return json({ error: 'drive not ready' }, 500)
      const body = await readBody(req)
      const { id, role } = JSON.parse(b4a.toString(body))

      const folder = role === 'initiator' ? '/pending/deals' : '/incoming/deals'
      const buf = await drive.get(`${folder}/${id}.json`).catch(() => null)
      if (!buf) return json({ error: 'deal not found' }, 404)

      const deal = JSON.parse(b4a.toString(buf))
      const newStatus = role === 'initiator' ? 'cancelled_by_initiator' : 'cancelled_by_counterparty'
      deal.status = newStatus
      await drive.put(`/history/deals/${id}.json`, b4a.from(JSON.stringify(deal)))
      await drive.del(`${folder}/${id}.json`).catch(() => {})

      // Cancel any pending delivery retries for this deal
      const retry = pendingDeliveries.get(id)
      if (retry) { if (retry.timer) clearTimeout(retry.timer); pendingDeliveries.delete(id) }

      const otherDriveKey = role === 'initiator' ? deal.counterparty_drive_key : deal.initiator_drive_key
      await writeOutbox(id, { type: 'deal_cancelled', dealId: id, cancelledBy: role })
      if (otherDriveKey) connectToPeerDriveForDeals(otherDriveKey).catch(() => {})

      return json({ ok: true })
    }

    // --- Deal: approve -----------------------------------------------
    // POST /api/approve-deal  { id, counterparty_terms }
    // Counterparty fills their terms and approves the deal.
    // Updates local /incoming/deals/ copy, delivers terms to initiator via msgSwarm.
    if (url === '/api/approve-deal') {
      if (!drive) return json({ error: 'drive not ready' }, 500)
      const body = await readBody(req)
      const { id, counterparty_terms } = JSON.parse(b4a.toString(body))

      const buf = await drive.get(`/incoming/deals/${id}.json`).catch(() => null)
      if (!buf) return json({ error: 'deal not found' }, 404)

      const deal = JSON.parse(b4a.toString(buf))
      deal.counterparty_terms = counterparty_terms
      deal.status = 'pending_initiator'
      await drive.put(`/incoming/deals/${id}.json`, b4a.from(JSON.stringify(deal)))

      await writeOutbox(id, { type: 'deal_response', dealId: id, counterpartyTerms: counterparty_terms })
      if (deal.initiator_drive_key) connectToPeerDriveForDeals(deal.initiator_drive_key).catch(() => {})

      return json({ ok: true })
    }

    // --- Deal: confirm -----------------------------------------------
    // POST /api/confirm-deal  { id }
    // Initiator reviews counterparty terms and confirms — both sides go in_progress.
    // Updates local /pending/deals/ copy, notifies counterparty via msgSwarm.
    if (url === '/api/confirm-deal') {
      if (!drive) return json({ error: 'drive not ready' }, 500)
      const body = await readBody(req)
      const { id } = JSON.parse(b4a.toString(body))

      const buf = await drive.get(`/pending/deals/${id}.json`).catch(() => null)
      if (!buf) return json({ error: 'deal not found' }, 404)

      const deal = JSON.parse(b4a.toString(buf))
      deal.status = 'in_progress'
      await drive.put(`/pending/deals/${id}.json`, b4a.from(JSON.stringify(deal)))

      await writeOutbox(id, { type: 'deal_confirmed', dealId: id })
      if (deal.counterparty_drive_key) connectToPeerDriveForDeals(deal.counterparty_drive_key).catch(() => {})

      return json({ ok: true })
    }

    // --- Deal: close -------------------------------------------------
    // POST /api/close-deal  { id, role: 'initiator' | 'counterparty', outcome: 'positive' | 'neutral' | 'negative' }
    // Caller declares their obligations fulfilled and rates the other party.
    // First close: status moves to closed_by_<role>, outcome stored, peer notified.
    // Second close: status moves to completed (both parties done), deal moves to history.
    if (url === '/api/close-deal') {
      if (!drive) return json({ error: 'drive not ready' }, 500)
      const body = await readBody(req)
      const { id, role, outcome } = JSON.parse(b4a.toString(body))
      if (!id || !role || !outcome) return json({ error: 'missing fields' }, 400)

      // Find the deal — could be in pending (outgoing) or incoming.
      const folders = ['/pending/deals', '/incoming/deals']
      let folder = null
      let deal = null
      for (const f of folders) {
        const buf = await drive.get(`${f}/${id}.json`).catch(() => null)
        if (buf) { folder = f; deal = JSON.parse(b4a.toString(buf)); break }
      }
      if (!deal) return json({ error: 'deal not found' }, 404)

      // Only in_progress or already partially-closed deals can be closed.
      const closeable = ['in_progress', 'closed_by_initiator', 'closed_by_counterparty']
      if (!closeable.includes(deal.status)) return json({ error: 'deal not closeable' }, 400)

      // Store our outcome — we rate the *other* party.
      if (role === 'initiator') {
        deal.initiator_outcome = outcome
      } else {
        deal.counterparty_outcome = outcome
      }

      // Determine if the other party has already closed their side.
      const otherClosed = role === 'initiator'
        ? deal.status === 'closed_by_counterparty'
        : deal.status === 'closed_by_initiator'

      const peerDriveKey = role === 'initiator'
        ? deal.counterparty_drive_key
        : deal.initiator_drive_key

      if (otherClosed) {
        // Both sides done — deal is completed.
        deal.status = 'completed'
        await drive.put(`/history/deals/${id}.json`, b4a.from(JSON.stringify(deal)))
        await drive.del(`${folder}/${id}.json`).catch(() => {})
        // Write deal_closed to outbox so peer can finalize their copy too.
        await writeOutbox(id, { type: 'deal_closed', dealId: id, closedBy: role, outcome })
        if (peerDriveKey) connectToPeerDriveForDeals(peerDriveKey).catch(() => {})
      } else {
        // First close — update status, notify peer.
        deal.status = role === 'initiator' ? 'closed_by_initiator' : 'closed_by_counterparty'
        await drive.put(`${folder}/${id}.json`, b4a.from(JSON.stringify(deal)))
        await writeOutbox(id, { type: 'deal_closed', dealId: id, closedBy: role, outcome })
        if (peerDriveKey) connectToPeerDriveForDeals(peerDriveKey).catch(() => {})
      }

      return json({ ok: true, status: deal.status })
    }

    // --- Deal: history ------------------------------------------------
    // GET /api/get-history-deals
    // Returns completed, expired, and cancelled deals from /history/deals/.
    if (url === '/api/get-history-deals') {
      if (!drive) return json([])
      return json(await listDriveFolder('/history/deals'))
    }

    // --- Deal: single lookup ------------------------------------------
    // GET /api/get-deal?id=<dealId>
    // Finds a single deal by ID across all folders. Used by WebView to
    // refresh DealView data after receiving a notification.
    if (url.startsWith('/api/get-deal')) {
      if (!drive) return json({ error: 'drive not ready' }, 500)
      const id = new URLSearchParams(req.url.split('?')[1] ?? '').get('id')
      if (!id) return json({ error: 'missing id' }, 400)
      for (const folder of ['/pending/deals', '/incoming/deals', '/history/deals']) {
        const buf = await drive.get(`${folder}/${id}.json`).catch(() => null)
        if (buf) return json(JSON.parse(b4a.toString(buf)))
      }
      return json({ error: 'not found' }, 404)
    }

    // --- Deal: expired ids --------------------------------------------
    // GET /api/get-expired-deals
    // Returns IDs of deals deleted by the cleanup loop since the last call.
    // WebView polls this every 30s — if the current deal's ID is in the list,
    // the UI navigates back to main. Clears the set after returning.
    if (url === '/api/get-expired-deals') {
      const ids = [...expiredDealIds]
      expiredDealIds.clear()
      return json(ids)
    }

    // --- Notifications ------------------------------------------------
    // GET /api/get-notifications
    // Returns pending notifications and clears them. WebView polls every 10s.
    if (url === '/api/get-notifications') {
      const notifications = [...pendingNotifications]
      pendingNotifications.length = 0
      return json(notifications)
    }

    bridgeHandler(req, res)

  } catch (err) {
    console.error('[request error]', err)
    json({ error: String(err) }, 500)
  }
})

const runtime = new Runtime()
const pipe = await runtime.start({ bridge })

Pear.teardown(async () => {
  for (const { timer } of pendingDeliveries.values()) {
    if (timer) clearTimeout(timer)
  }
  if (msgSwarm) await msgSwarm.destroy()
  if (swarm)    await swarm.destroy()
  pipe.end()
})
