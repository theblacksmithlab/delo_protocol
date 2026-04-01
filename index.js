/* global Pear */
// Bare entry point — runs in Pear's JS runtime (not in the browser/WebView)
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'
import Hyperswarm from 'hyperswarm'
import crypto from 'hypercore-crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, rmSync } from 'bare-fs'
import { join } from 'bare-path'
import b4a from 'b4a'
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
let swarm = null  // persistent swarm that announces our own drive to DHT

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

      const driveSaved = JSON.parse(readFileSync(drivePath, 'utf8'))
      return json({ publicKey, driveKey: driveSaved.key })
    }

    // --- Identity: delete -----------------------------------------------
    if (url === '/api/delete-identity') {
      if (swarm) { await swarm.destroy(); swarm = null }
      if (drive) { await drive.close(); drive = null }
      if (store) { await store.close(); store = null }

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

      // Remote peer — use cached data from store (already replicated during profile fetch)
      const peerDrive = new Hyperdrive(store, b4a.from(peerDriveKey, 'hex'))
      await peerDrive.ready()
      const buf = await peerDrive.get('/avatar')
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

      const peerDrive = new Hyperdrive(store, b4a.from(peerDriveKey, 'hex'))
      await peerDrive.ready()

      // Slow path: connect to peer via Hyperswarm and replicate
      const peerSwarm = new Hyperswarm()
      peerSwarm.on('connection', socket => store.replicate(socket))
      peerSwarm.join(peerDrive.discoveryKey, { server: false, client: true })

      try {
        await Promise.race([
          (async () => {
            await new Promise(resolve => peerSwarm.once('connection', resolve))
            await peerDrive.update()
          })(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Peer not reachable (timeout)')), 15000)
          )
        ])

        const profileBuf = await peerDrive.get('/profile.json')
        if (!profileBuf) return json({ error: 'Profile not found' }, 404)

        return json(JSON.parse(b4a.toString(profileBuf)))
      } finally {
        await peerSwarm.destroy()
      }
    }

    bridgeHandler(req, res)

  } catch (err) {
    json({ error: String(err) }, 500)
  }
})

const runtime = new Runtime()
const pipe = await runtime.start({ bridge })

Pear.teardown(async () => {
  if (swarm) await swarm.destroy()
  pipe.end()
})
