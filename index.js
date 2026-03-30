/* global Pear */
// Bare entry point — runs in Pear's JS runtime (not in the browser/WebView)
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'
import crypto from 'hypercore-crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'bare-fs'
import { join } from 'bare-path'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'

const storage = Pear.config.storage
const keypairPath  = join(storage, 'keypair.json')
const pubkeyPath   = join(storage, 'pubkey.json')
const drivePath    = join(storage, 'drive.json')
const corestorePath = join(storage, 'corestore')

mkdirSync(storage, { recursive: true })

// Global references — set during startup or identity creation
let store = null
let drive = null

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

// Opens (or creates) the shared Corestore — manages all Hypercore instances on disk.
// Idempotent: safe to call multiple times.
async function initStore () {
  if (store) return
  store = new Corestore(corestorePath)
  await store.ready()
}

// Opens an existing Hyperdrive using the key saved in drive.json.
async function openDrive () {
  await initStore()
  const saved = JSON.parse(readFileSync(drivePath, 'utf8'))
  drive = new Hyperdrive(store, b4a.from(saved.key, 'hex'))
  await drive.ready()
}

// Creates a brand-new Hyperdrive, saves its key, writes an empty profile.
async function createDrive () {
  await initStore()
  drive = new Hyperdrive(store)
  await drive.ready()

  // Persist the drive key so we can reopen the same drive on next launch
  writeFileSync(drivePath, JSON.stringify({
    key: b4a.toString(drive.key, 'hex')
  }))

  // Seed an empty profile so get-profile never returns null
  const emptyProfile = {
    name: '',
    bio: '',
    currency: 'USD',
    hasAvatar: false,
    avatarMime: ''
  }
  await drive.put('/profile.json', b4a.from(JSON.stringify(emptyProfile)))
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
// Startup — inform WebView about identity state, open drive if it exists
// ---------------------------------------------------------------------------
const existing = loadKeypair()

if (existing) {
  // Returning user — expose public key for display
  writeFileSync(pubkeyPath, JSON.stringify({
    publicKey: b4a.toString(existing.publicKey, 'hex')
  }))
  // Reopen drive if it was created before
  if (existsSync(drivePath)) {
    await openDrive()
  }
} else {
  // First launch — show onboarding in WebView
  writeFileSync(pubkeyPath, JSON.stringify({ status: 'pending' }))
}

// ---------------------------------------------------------------------------
// pear-bridge setup
// ---------------------------------------------------------------------------
const bridge = new Bridge({ mount: 'dist' })
await bridge.ready()

// Inject API routes into pear-bridge's HTTP server (same origin = no CORS block).
// bare-events returns listeners as [fn, once] tuples — double-destructure to get the fn.
const [[bridgeHandler]] = bridge.server.listeners('request')
bridge.server.removeAllListeners('request')

bridge.server.on('request', async (req, res) => {
  // Strip pear-bridge's internal URL suffix (e.g. /path+app+app → /path)
  const url = (req.url ?? '').split('+')[0]

  // Helper to send JSON
  const json = (data, status = 200) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(data))
  }

  try {
    // --- Identity: create -----------------------------------------------
    if (url === '/api/create-identity') {
      // Idempotent: if keypair already exists (double-click), return existing key
      if (existsSync(keypairPath)) {
        const saved = JSON.parse(readFileSync(keypairPath, 'utf8'))
        // Reopen drive if needed
        if (!drive && existsSync(drivePath)) await openDrive()
        return json({ publicKey: saved.publicKey })
      }

      const keypair = generateAndSaveKeypair()
      const publicKey = b4a.toString(keypair.publicKey, 'hex')
      writeFileSync(pubkeyPath, JSON.stringify({ publicKey }))

      // Initialize Hyperdrive for this new identity
      await createDrive()

      return json({ publicKey })
    }

    // --- Identity: delete -----------------------------------------------
    if (url === '/api/delete-identity') {
      // Close drive gracefully before wiping files
      if (drive) { await drive.close(); drive = null }
      if (store) { await store.close(); store = null }

      if (existsSync(keypairPath))  unlinkSync(keypairPath)
      if (existsSync(pubkeyPath))   unlinkSync(pubkeyPath)
      if (existsSync(drivePath))    unlinkSync(drivePath)
      // Remove corestore directory (all Hypercore data for this identity)
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

      // Read existing profile to preserve avatarMime
      const existing_buf = await drive.get('/profile.json')
      const existing_profile = existing_buf
        ? JSON.parse(b4a.toString(existing_buf))
        : { hasAvatar: false, avatarMime: '' }

      const profile = {
        name:       incoming.name       ?? '',
        bio:        incoming.bio        ?? '',
        currency:   incoming.currency   ?? 'USD',
        hasAvatar:  existing_profile.hasAvatar,
        avatarMime: existing_profile.avatarMime
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

      // Update profile to record avatar presence and mime type
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

      // Get mime type from profile
      const profileBuf = await drive.get('/profile.json')
      const mime = profileBuf
        ? (JSON.parse(b4a.toString(profileBuf)).avatarMime || 'image/jpeg')
        : 'image/jpeg'

      res.statusCode = 200
      res.setHeader('Content-Type', mime)
      res.setHeader('Content-Length', buf.length)
      return res.end(buf)
    }

    // Everything else: pass through to pear-bridge's original handler
    bridgeHandler(req, res)

  } catch (err) {
    json({ error: String(err) }, 500)
  }
})

const runtime = new Runtime()
const pipe = await runtime.start({ bridge })

Pear.teardown(() => pipe.end())
