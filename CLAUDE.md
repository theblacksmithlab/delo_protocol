# CLAUDE.md — Trust Protocol

## How to work with the developer

The developer is an active participant, not a spectator. Follow these rules:

1. **Never write large blocks of code without explanation.** Explain what the code does and why, so the developer understands every line. The developer will maintain this codebase alone.
2. **Ask before generating.** When the developer asks to implement something, first outline the approach, explain the key decisions, and get confirmation before writing code.
3. **Teach, don't just produce.** When using unfamiliar APIs (Pear, Hypercore, wasm-bindgen), explain the concepts first. Link to relevant docs when possible.
4. **Respect the developer's expertise.** The developer is experienced in Rust. Don't over-explain Rust basics. Do explain JS/P2P/Pear specifics in detail — that's the less familiar territory.
5. **Check ROADMAP.md** before starting any task. It tracks current progress, what's done and what's next. Update it together with the developer after completing each step.
6. **Small steps.** Don't try to build everything at once. One feature at a time, tested and understood before moving on.
7. **Review mode.** When the developer shares code, review it honestly — point out bugs, suggest improvements, explain trade-offs. Don't just say "looks good".

## Progress tracking

See **ROADMAP.md** for current progress, step-by-step plan, and checkboxes. Always check it at the start of a session to understand where we are.

## Project overview

Decentralized reputation system. Users build economic reputation through verified deals. No servers — all data stored on user devices via P2P (Pear Runtime). Reputation belongs to the user, not a platform.

## Tech stack

- **P2P layer**: Pear Runtime (Holepunch) — Hypercore, Hyperdrive, Hyperswarm
- **Desktop runtime**: `pear-electron` (spawns Electron from Bare process) + `pear-bridge` (local HTTP bridge to serve `dist/` to WebView)
- **Core logic**: Rust compiled to WASM (wasm-pack, wasm-bindgen)
- **UI**: Svelte 5 (runes syntax: `$state`, `$derived`, `$effect`)
- **Platform**: Pear desktop app (mobile later)
- **Build**: Vite for Svelte bundling, wasm-pack for Rust→WASM
- **Language**: TypeScript for JS layer, Rust for WASM core

## Architecture

**Two-process model (critical to understand):**

| Process | What it is | What it can do |
|---------|-----------|----------------|
| **Bare** (`index.js`) | Pear's JS runtime, like Node.js | Filesystem, crypto, networking, P2P |
| **WebView** (`dist/index.html`) | Chromium renderer, runs Svelte | DOM, browser APIs, `fetch('file://')` |

Bare runs first, does key management and P2P init, then spawns the WebView via `pear-electron`.
Private key **never leaves Bare**. Public key passed to WebView via `Pear.config.storage/pubkey.json`.

```
index.js              # Bare process — keypair mgmt, P2P init, spawns Electron WebView
index.html            # WebView entry point (served by pear-bridge from dist/)
src/
├── core/              # Rust → WASM (reputation engine)
│   ├── src/
│   │   ├── lib.rs          # WASM entry, expose functions via wasm-bindgen
│   │   ├── reputation.rs   # Trust score calculation
│   │   ├── deal.rs         # Deal struct, validation, serialization
│   │   ├── currency.rs     # Multi-currency conversion, oracle snapshot
│   │   └── antisybil.rs    # Graph analysis, sybil detection (Phase 2)
│   └── Cargo.toml
├── p2p/               # JS — Pear/Hypercore integration (added in Step 4+)
│   ├── store.js       # Hypercore log read/write
│   ├── sync.js        # Hyperswarm discovery, peer connections
│   └── profile.js     # Profile CRUD on Hyperdrive
├── ui/                # Svelte 5 components (runs in WebView)
│   ├── App.svelte
│   ├── views/
│   │   ├── Onboarding.svelte
│   │   ├── Profile.svelte
│   │   ├── NewDeal.svelte
│   │   ├── DealHistory.svelte
│   │   └── ViewProfile.svelte
│   ├── components/
│   │   ├── TrustScore.svelte
│   │   ├── DealCard.svelte
│   │   ├── VerificationBar.svelte
│   │   └── QRCode.svelte
│   └── stores/
│       ├── identity.ts
│       ├── deals.ts
│       └── settings.ts
```

## Data model

### Deal record (stored in Hypercore log)

```rust
struct Deal {
    id: [u8; 32],                // random unique ID
    counterparty_key: [u8; 32],  // public key of the other party
    timestamp: u64,              // unix timestamp
    
    // Original currency
    original_amount: f64,
    original_currency: Currency, // USD, RUB, BTC, EUR, etc.
    
    // Fixed equivalents at deal time (from oracle)
    amount_usd: f64,
    amount_rub: f64,
    amount_btc: f64,
    
    // Verification
    level: VerificationLevel,    // Handshake(0.4) | Review(0.7) | Escrow(1.0)
    outcome: Outcome,           // Positive | Neutral | Negative
    
    // Review data (optional, only for Review level)
    review_text: Option<String>,
    rating_quality: Option<u8>,  // 1-5
    rating_timing: Option<u8>,   // 1-5
    rating_communication: Option<u8>, // 1-5
    
    // Signatures
    initiator_sig: [u8; 64],
    counterparty_sig: Option<[u8; 64]>, // None until confirmed
}
```

### Verification levels

| Level | Coefficient | Description |
|-------|-------------|-------------|
| Handshake | 0.4 | Both parties confirm deal + amount + outcome. 30 seconds. |
| Review | 0.7 | Handshake + text review + criteria ratings. 2-3 minutes. |
| Escrow | 1.0 | **Coming soon.** Smart contract holds funds. Auto-verified. |

### Outcome types

| Outcome | Effect |
|---------|--------|
| Positive | +amount × coefficient |
| Neutral | 0 (recorded but no impact) |
| Negative | −amount × coefficient × 1.5 (penalty multiplier) |

## Reputation formula

```
weighted_contribution(deal) = deal.amount × level_coefficient

For positive deals: add weighted_contribution to trust volume
For negative deals: subtract weighted_contribution × 1.5

success_rate = positive_weighted_sum / (positive_weighted_sum + negative_weighted_sum)

Display: "{total_volume} {currency}, {success_rate}% satisfied"
```

The Rust WASM core calculates all of this. JS layer feeds deal data in, gets computed profile out.

## Multi-currency rules

1. On deal creation: oracle provides exchange rates, system records equivalents in ALL supported currencies (USD, RUB, BTC at minimum)
2. All equivalents are frozen at deal time — never recalculated
3. On profile display: sum deals using the column matching viewer's preferred currency
4. Example: viewer has RUB → system sums all `amount_rub` fields across deals

For MVP oracle: use a simple HTTP fetch to a public rate API at deal confirmation time. Store the snapshot. No live price feeds needed.

## Onboarding flow

1. User opens Pear app → Bare checks if `keypair.json` exists
2. **First launch**: Bare writes `{ status: 'pending' }` to `pubkey.json` → WebView shows welcome screen
3. User clicks "Create your identity" → WebView fetches `/api/create-identity` from pear-bridge
4. Bare generates ed25519 keypair, saves to `keypair.json` (private key stays in Bare forever)
5. Bare initialises Corestore (`corestore/`) + creates Hyperdrive, saves its key to `drive.json`; writes empty `profile.json` into the drive
6. Bare returns public key hex → WebView displays as `0x7f3a...c2d1` + QR code + copy button
7. **Return visits**: Bare finds existing `keypair.json` + `drive.json`, reopens Corestore and Hyperdrive, writes public key to `pubkey.json` → WebView skips to identity screen directly
8. User fills profile (name, bio) via "My Profile" section → saved to Hyperdrive `/profile.json`; avatar saved to Hyperdrive `/avatar`
9. Display currency preference stored in `profile.json` (set via Settings section)
10. Hypercore log created for deal history (Step 5)
11. Ready to transact

No emails, no passwords, no SMS. Key = identity.

## Deal flow

### Initiating a deal
1. User taps "New deal"
2. Enters counterparty public key (paste or scan QR)
3. Enters amount + currency
4. System fetches exchange rates, shows equivalents
5. Selects level: Handshake or Review
6. Signs deal record with private key
7. Sends to counterparty via Hyperswarm

### Confirming a deal
1. Counterparty receives deal request notification
2. Reviews details (amount, currency, level)
3. Confirms or rejects
4. If confirms: selects outcome (positive/neutral/negative)
5. If Review level: writes text + rates criteria
6. Counter-signs deal record
7. Both devices append signed deal to their Hypercore logs

### Viewing someone's profile
1. Enter public key or scan QR
2. App connects to their Hypercore via DHT
3. Downloads deal log
4. WASM core calculates reputation locally
5. Displays in viewer's preferred currency

## P2P implementation notes

- Each user has ONE Hypercore append-only log (their deal history)
- Hypercore is identified by user's public key
- Deals require signatures from BOTH parties to be valid
- When viewing a profile, the app cross-references: for each deal in user A's log, verify counterparty signature exists
- Use Hyperswarm for peer discovery and direct connections
- Hyperdrive stores profile metadata (name, avatar, specialization)

## Coding conventions

- Rust: use `serde` for serialization, `wasm-bindgen` for JS interop, `ed25519-dalek` for deal signing in WASM
- JS/TS: ESM modules, no CommonJS
- Svelte: use Svelte 5 runes syntax (`$state`, `$derived`, `$effect`), not legacy `$:` reactive statements
- CSS: scoped styles in Svelte components, CSS custom properties for theming
- Error handling: Rust `Result<T, E>` types, convert to JS exceptions at WASM boundary
- No `console.log` in production code — use a structured logger
- **Key generation in Bare** (not WASM): use `hypercore-crypto` — `crypto.keyPair()`, `crypto.sign()`, `crypto.verify()`
  - `bare-crypto` does NOT have ed25519 — only hashes and symmetric ciphers
  - `ed25519-dalek` (Rust) is for the WASM signing layer (Step 5+), not for initial key gen

## Pear-specific gotchas

Hard-won lessons — check here before debugging Pear issues.

### pear-electron API
- `PearElectron` has **no `ready()` method**. Correct pattern:
  ```js
  const runtime = new Runtime()
  const pipe = await runtime.start({ bridge })  // ← start(), not ready() + start()
  Pear.teardown(() => pipe.end())
  ```

### pear-bridge must have `mount: 'dist'`
- `new Bridge()` without options serves the **root** `index.html` (Vite source)
- Root `index.html` references `/src/ui/main.ts` → MIME type `video/mp2t` → module load fails
- Correct: `new Bridge({ mount: 'dist' })` → serves compiled `dist/index.html`

### WebView → Bare IPC
- WebView **cannot** call a separate HTTP server — pear-electron's `webRequest.onBeforeRequest` blocks all HTTP requests to origins other than pear-bridge (`ERR_BLOCKED_BY_CLIENT`)
- Solution: inject API routes into pear-bridge's own server (same port = same origin):
  ```js
  const [[bridgeHandler]] = bridge.server.listeners('request')  // ← see gotcha below!
  bridge.server.removeAllListeners('request')
  bridge.server.on('request', (req, res) => {
    if (req.url.split('+')[0] === '/api/my-endpoint') { /* handle */ return }
    bridgeHandler(req, res)  // delegate everything else
  })
  ```
- WebView fetches with **relative URL**: `fetch('/api/my-endpoint')` — not `fetch('http://...')`

### bare-events `listeners()` returns tuples, not functions
- Node.js: `emitter.listeners('event')` → `[fn1, fn2, ...]`
- **bare-events**: `emitter.listeners('event')` → `[[fn1, false], [fn2, true], ...]` (each item is `[fn, once]`)
- Wrong: `const [handler] = server.listeners('request')` → `handler` is `[fn, false]`, NOT a function → `TypeError`
- Correct: `const [[handler]] = server.listeners('request')` — double destructuring

### TypeScript in Svelte
- `declare const Foo` inside `<script lang="ts">` causes IDE error: "Modifiers cannot appear here"
- All global type declarations must go in a separate `src/ui/env.d.ts` file

### Pear window is always frameless
- `pear.gui` options `frame` and `titleBarStyle` are **ignored** by Pear Runtime
- Always creates a frameless Electron window — implement custom titlebar in HTML
- Pattern: fixed div at top, `-webkit-app-region: drag` to allow dragging, buttons with `-webkit-app-region: no-drag`
- Window controls from WebView:
  - Close: `Pear.exit(0)` — confirmed working
  - Minimize: `Pear.Window.self.minimize()` — deprecated but works
  - Fullscreen: `Pear.Window.self.fullscreen()` — deprecated but works
- Traffic lights sizing: 12px circles, 8px gap, 13px from left, 38px bar height (matches macOS)

### Custom fonts
- Place `.ttf` / `.woff2` in `public/` folder — Vite copies it to `dist/` as-is
- Reference in CSS: `url('/FontName.ttf')` (absolute path, pear-bridge resolves to `/dist/FontName.ttf`)
- `<button>`, `<input>`, `<select>` do NOT inherit `font-family` from `body` — add `font-family: inherit` explicitly

### Pear app storage layout
- `Pear.config.storage` resolves to `~/Library/Application Support/pear/app-storage/by-random/<id>/`
- Multiple folders = multiple storage IDs from different launches or app changes
- Find the active folder: `ls ~/Library/.../by-random/*/keypair.json`
- To reset identity for testing: use "Delete My Identity" in the app — it removes `keypair.json`, `pubkey.json`, `drive.json`, and the entire `corestore/` directory
- Manual reset (if app won't start): delete those four items directly from the active storage folder

---

## MVP scope — build THIS first

### Phase 1 (build now)
- [x] Project scaffold: Pear app + Svelte + Rust WASM
- [x] Identity: keypair generation, storage, QR code display, copy key button — **working**
- [x] Profile: create/edit local profile — **working** (Hyperdrive storage, avatar upload, view/edit modes)
- [ ] Handshake deal: create, send to peer, confirm, record
- [ ] Review deal: same as handshake + text/ratings
- [ ] Trust calculation: WASM computes volume + success rate
- [ ] View profile: connect to peer, download log, display reputation
- [ ] Multi-currency: record equivalents at deal time, display in viewer's currency

### Phase 2 (later)
- [ ] Escrow via smart contract
- [ ] Anti-sybil graph analysis
- [ ] Evaluator reputation weight (PageRank-style)
- [ ] Dispute resolution
- [ ] Mobile (Pear mobile)

## IDE setup (RustRover)

- IDE: JetBrains RustRover
- Required plugins from Marketplace: Svelte
- JS/TS support is built-in (IntelliJ platform)
- Open project root as single project — both Rust and JS in one workspace
- Cargo.toml in `src/core/` will be auto-detected by RustRover
- package.json in project root for JS dependencies

## Project init commands

The project is already initialized. These commands are for reference if rebuilding from scratch.

```bash
# 1. Install P2P + Bare runtime dependencies
npm install hypercore hyperdrive hyperswarm corestore b4a \
  bare-crypto bare-fs bare-path \
  hypercore-crypto \
  pear-electron pear-bridge \
  qrcode

# 2. Install Svelte + Vite (dev dependencies)
npm install -D svelte @sveltejs/vite-plugin-svelte@6 vite@6 typescript \
  vite-plugin-wasm vite-plugin-top-level-await \
  @types/qrcode

# 3. IMPORTANT: vite.config.js must have base: './' — Pear opens via file://
# Without this, all /assets/... paths will 404 in the WebView

# 4. Init Rust WASM core
cargo install wasm-pack  # if not installed
# Root Cargo.toml must be a workspace: members = ["src/core"]
# src/core/Cargo.toml: crate-type = ["cdylib"]

# 5. Build WASM
wasm-pack build src/core --target web --out-dir wasm-pkg

# 6. Build Svelte (watch mode for dev)
npm run dev  # runs: vite build --watch

# 7. Run Pear app
pear run --dev .
# Requires Pear Runtime updated to support RTI API (pear update)
```

## Do NOT

- Do not build a server or API backend — this is fully P2P
- Do not use localStorage/sessionStorage — use Hypercore/Hyperdrive
- Do not implement escrow — it's Phase 2
- Do not implement anti-sybil graph analysis — it's Phase 3
- Do not add user authentication beyond keypair — no emails, no OAuth
- Do not recalculate currency equivalents after deal is recorded
