# ROADMAP.md — Trust Protocol

> Living document. Update checkboxes as steps are completed.
> At the start of each session, Claude reads this file to understand current progress.

## Current status: Step 4 — P2P connection

---

## Step 1: Project scaffold
**Goal:** Empty app that launches — Pear + Svelte + Rust WASM all connected.

**You do:**
- Create project directory, run init commands from CLAUDE.md
- Configure Cargo.toml, package.json, vite.config.js
- Write a minimal Rust function, compile to WASM, call it from Svelte
- Verify Pear app launches with `pear run --dev .`

**Claude helps with:**
- Debugging config issues (wasm-pack target, Vite WASM plugin, Pear entry point)
- Explaining how Pear app lifecycle works
- Explaining Vite + WASM integration if unclear

**Definition of done:**
- [x] Project structure matches architecture in CLAUDE.md
- [x] `wasm-pack build` succeeds
- [x] Svelte app renders "Hello Trust Protocol" in Pear window
- [x] Rust WASM function is callable from Svelte (e.g., `greet("world")` returns string)
- [ ] Hot reload works for Svelte changes (using `vite build --watch` + manual Pear reload)

**Key files created:**
- [x] package.json
- [x] vite.config.js
- [x] src/core/Cargo.toml
- [x] src/core/src/lib.rs
- [x] src/ui/App.svelte
- [x] index.html
- [x] index.js (Pear entry)

**Notes from session:**
- `@sveltejs/vite-plugin-svelte@6` required for Vite 6 (v4 only supports Vite 5)
- Pear loads via `file://` — Vite needs `base: './'` for relative asset paths, otherwise 404
- Pear dependency versions in CLAUDE.md were outdated (bare-crypto ^3.0.4 doesn't exist, actual: ^1.13.4)
- Dev workflow: `npm run dev` (vite build --watch) in one terminal, `pear run --dev .` in another
- Migrated to pear-electron v2 architecture (Bare process + WebView) already in Step 2, not Step 4

---

## Step 2: Identity
**Goal:** App generates a keypair on first launch, stores it, displays public key + QR.

**Architecture decision (settled in session):**
Keypair generation and storage happens in the **Bare process** (`index.js`), NOT in WASM.
- Bare uses `hypercore-crypto` (libsodium) for `keyPair()` — `bare-crypto` does NOT have ed25519
- Private key saved to `Pear.config.storage/keypair.json` — never leaves Bare
- Public key written to `Pear.config.storage/pubkey.json` — WebView reads it via `fetch('file://...')`
- WebView displays public key + QR code (using `qrcode` npm package)
- Rust WASM will be used for signing deals (Step 5), not for key generation

**Definition of done:**
- [x] First launch generates keypair and saves it
- [x] Subsequent launches load existing keypair
- [x] Public key displayed as `0x7f3a...c2d1` format
- [x] QR code shows full public key
- [x] Private key stored securely on device (Bare only, never in WebView)
- [x] **Verified working** — onboarding flow and identity screen tested end-to-end

**Key files written:**
- [x] `index.js` — full Bare process: keypair gen, storage, pear-electron + pear-bridge startup
- [x] `src/ui/App.svelte` — 4-state onboarding: loading → welcome → creating → identity
- [x] `src/ui/env.d.ts` — global `Pear` type declaration for WebView TypeScript

**Notes from session:**
- `bare-crypto` does NOT have ed25519 — use `hypercore-crypto` in Bare for keypair operations
- `hypercore-crypto` wraps libsodium: `crypto.keyPair()`, `crypto.sign()`, `crypto.verify()`
- pear-electron v2 architecture: `index.js` (Bare) spawns Electron via `pear-electron` + `pear-bridge`
- `pear-electron@1.7.28` requires Pear Runtime with RTI API — Pear v0.9609 is too old → `pear update`
- `PearElectron` has no `ready()` method — correct pattern: `const pipe = await runtime.start({ bridge })`
- `pear-bridge` must be created with `{ mount: 'dist' }` — without it, serves root `index.html` (Vite source with `.ts` ref → `video/mp2t` MIME type error in browser)
- **WebView→Bare IPC**: pear-electron blocks HTTP to any origin other than pear-bridge (`ERR_BLOCKED_BY_CLIENT`). Solution: inject API routes into pear-bridge's own HTTP server (same-origin)
- **`bare-events` gotcha**: `server.listeners('event')` returns `[[fn, once], ...]` tuples — NOT plain `[fn, ...]` like Node.js. Must double-destructure: `const [[handler]] = server.listeners('request')`
- Keypair generated **only on button click** ("Create your identity"), not on first launch. First launch writes `{ status: 'pending' }` to `pubkey.json`; WebView reads this to decide whether to show onboarding
- TypeScript: `declare const Pear` inside Svelte `<script lang="ts">` causes IDE error "Modifiers cannot appear here" — must go in a separate `env.d.ts` file

---

## Step 3: Profile
**Goal:** User can create and edit their profile. Profile saved locally.

**UI shell already built (this session):**
- [x] "My Profile" accordion section exists in `App.svelte` — placeholder content, ready for real form
- [x] "Deals" accordion section exists — placeholder, ready for Step 5
- [x] "Settings" section with "Delete My Identity" — fully working (deletes keypair, resets to onboarding)
- [x] Custom macOS-style titlebar — traffic lights (close/minimize/fullscreen) + drag region
- [x] Custom font (Retrocide.ttf) — loaded from `public/` via `@font-face`, applied globally

**You do:**
- Design profile data structure (name, specialization, preferred currency)
- Write Svelte form inside the "My Profile" accordion section
- Save profile to Hyperdrive (first time working with Pear storage)
- Load profile on startup and populate the form

**Claude helps with:**
- Hyperdrive API — how to read/write files from Bare
- Deciding where profile lives (Bare writes via API endpoint, or WebView writes directly?)

**Definition of done:**
- [x] "My Profile" section shows editable form: name, bio (description/specialization)
- [x] Profile saved to Hyperdrive (`/profile.json`)
- [x] Profile loads on app restart
- [x] Currency selector: USD / RUB / BTC — moved to Settings section, saves on change
- [x] Avatar upload: binary stored in Hyperdrive (`/avatar`), preview shown immediately
- [x] View mode / Edit mode: profile displayed as read-only, "Edit profile" switches to form, Cancel discards draft
- [x] Delete identity also wipes Corestore + drive.json (full reset)

**Architecture decisions (this session):**
- Corestore + Hyperdrive created at keypair generation time, not lazily
- Drive key saved to `drive.json`; reopened on every subsequent launch
- Hyperdrive structure: `/profile.json` (name, bio, currency, hasAvatar, avatarMime), `/avatar` (binary)
- Hypercore deal log deferred to Step 5 — separate from Hyperdrive
- Currency preference stored in `profile.json` (not a separate settings file)

**Notes from this session:**
- Pear Runtime **ignores** `frame` and `titleBarStyle` in `pear.gui` — always creates frameless window
- Custom titlebar: HTML div + `-webkit-app-region: drag` + `-webkit-app-region: no-drag` on buttons
- `Pear.exit(0)` closes app from WebView (confirmed working)
- `Pear.Window.self.minimize()` / `.fullscreen()` available in WebView (deprecated API, but works)
- Custom fonts: put `.ttf` in `public/` → Vite copies to `dist/` → reference as `url('/Font.ttf')` in CSS
- `<button>` does NOT inherit `font-family` from body — must add `font-family: inherit` explicitly

---

## Step 4: P2P connection
**Goal:** Two instances of the app can find each other and exchange messages.

**You do:**
- Learn Hyperswarm API (topics, peer discovery)
- Write connection module: join swarm, discover peers by public key
- Build simple test: send a "ping" message between two instances
- Handle connection errors, NAT traversal edge cases

**Claude helps with:**
- Hyperswarm concepts (topics, DHT, hole-punching)
- Debugging connectivity issues
- Testing strategy (how to run two instances locally)

**Definition of done:**
- [ ] App joins Hyperswarm on startup
- [ ] Can connect to another instance by entering public key
- [ ] Successful ping/pong between two instances
- [ ] Connection status indicator in UI
- [ ] Handles offline/unreachable peers gracefully

**⚠️ This is the riskiest step technically. Don't skip testing.**

---

## Step 5: Handshake deal
**Goal:** Two users can create and confirm a simple deal (handshake level).

**You do:**
- Define Deal struct in Rust (from CLAUDE.md data model)
- Write serialization/deserialization (serde)
- Write deal signing logic in Rust (sign with ed25519)
- Build "New Deal" UI in Svelte
- Implement deal exchange protocol over Hyperswarm connection
- Write Hypercore append logic (store signed deals)

**Claude helps with:**
- Multi-currency: fetching exchange rates from public API
- Hypercore append-only log patterns
- Deal validation logic (verify both signatures)

**Definition of done:**
- [ ] "New deal" screen: enter counterparty key, amount, currency
- [ ] System fetches exchange rates, records USD/RUB/BTC equivalents
- [ ] Deal sent to counterparty
- [ ] Counterparty sees incoming deal request
- [ ] Counterparty confirms + selects outcome (positive/neutral/negative)
- [ ] Both sides sign, deal recorded in both Hypercore logs
- [ ] Deal appears in history on both sides

---

## Step 6: Reputation calculation
**Goal:** WASM core computes trust volume and success rate from deal history.

**You do:**
- Write Rust functions: calculate weighted volume, success rate, deal count
- Apply verification coefficients (handshake = 0.4, review = 0.7)
- Apply negative multiplier (1.5x for negative outcomes)
- Sum deals in viewer's preferred currency
- Export computed profile via wasm-bindgen

**Claude helps with:**
- Edge cases in the formula (zero deals, all neutral, etc.)
- Performance considerations for large deal histories
- Testing strategy for calculation correctness

**Definition of done:**
- [ ] Rust functions compute: total volume, success rate, deal count, unique counterparties
- [ ] Negative deals weighted x1.5
- [ ] Calculation uses correct currency column based on viewer preference
- [ ] Profile screen shows computed stats
- [ ] Unit tests for calculation logic in Rust

---

## Step 7: View someone's profile
**Goal:** Enter a public key → connect to their Hypercore → see their reputation.

**You do:**
- Connect to remote Hypercore by public key via DHT
- Download and validate deal log (verify signatures)
- Feed deals to WASM calculator
- Display profile in viewer's currency

**Claude helps with:**
- Hypercore replication patterns (sparse sync vs full download)
- Signature verification across peers
- Handling incomplete or corrupted logs

**Definition of done:**
- [ ] "View profile" screen: enter key or scan QR
- [ ] App connects to remote peer's Hypercore
- [ ] Downloads deal history
- [ ] Validates all deal signatures
- [ ] Displays reputation in viewer's preferred currency
- [ ] Works even if the profile owner is offline (if data was previously cached)

---

## Step 8: Review deal
**Goal:** Extend handshake deal with text review and criteria ratings.

**You do:**
- Extend Deal struct with optional review fields
- Update "New Deal" UI with review form (text + 3 criteria ratings)
- Update deal display to show review content
- Apply review coefficient (0.7) in calculator

**Claude helps with:**
- UI/UX for rating input (stars? slider? buttons?)
- Displaying reviews in profile view

**Definition of done:**
- [ ] Deal creation offers "Handshake" or "Review" toggle
- [ ] Review form: text field + quality/timing/communication ratings (1-5)
- [ ] Reviews visible in deal history and profile view
- [ ] Review deals weighted at 0.7 in reputation calculation

---

## Step 9: UI polish
**Goal:** App looks and feels like the prototype we designed.

**You do:**
- Style profile page (trust volume, verification bar, stats grid)
- Style deal history with proper cards
- Onboarding flow polish
- Loading states, error messages, empty states
- Responsive layout (prep for future mobile)

**Claude helps with:**
- CSS patterns, animation ideas
- UX feedback on flow and clarity

**Definition of done:**
- [ ] Profile matches the visual prototype from concept phase
- [ ] Verification bar (handshake vs review proportions)
- [ ] Deal cards with proper formatting
- [ ] Smooth onboarding flow
- [ ] All error states handled with clear messages
- [ ] No broken layouts or visual glitches

---

## After MVP

These are NOT part of the current build. Listed for reference only.

- Escrow (smart contract)
- Anti-sybil graph analysis
- Evaluator reputation weight
- Dispute resolution / arbitrage
- Mobile app (Pear mobile)
- Proof of Humanity verification
- Vouching mechanism
- Time decay on negative deals
- External platform API
