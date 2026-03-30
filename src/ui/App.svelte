<script lang="ts">
  import { onMount } from 'svelte'
  import QRCode from 'qrcode'

  // 'loading'  — reading files on startup
  // 'welcome'  — no identity yet, show onboarding screen
  // 'creating' — waiting for Bare to generate keypair
  // 'identity' — keypair exists, show public key + QR
  type View = 'loading' | 'welcome' | 'creating' | 'identity'

  let view = $state<View>('loading')
  let publicKey = $state<string | null>(null)
  let qrDataUrl = $state<string | null>(null)
  let error = $state<string | null>(null)

  // Truncate public key for display: 0x1a2b...ef90
  let shortKey = $derived(
    publicKey
      ? '0x' + publicKey.slice(0, 4) + '...' + publicKey.slice(-4)
      : null
  )

  // Copy key to clipboard
  let keyCopied = $state(false)

  async function copyPublicKey () {
    if (!publicKey) return
    await navigator.clipboard.writeText(publicKey)
    keyCopied = true
    setTimeout(() => { keyCopied = false }, 2000)
  }

  // Accordion open/close state
  let profileOpen = $state(false)
  let dealsOpen = $state(false)
  let settingsOpen = $state(false)

  // Delete identity: two-step confirmation
  let confirmDelete = $state(false)

  // Profile — saved state (what's in Hyperdrive)
  let profile = $state({ name: '', bio: '', currency: 'USD' })
  let profileLoaded = $state(false)
  let avatarPreviewUrl = $state<string | null>(null)

  // Edit mode — working copy, only committed on Save
  let profileEditing = $state(false)
  let profileDraft = $state({ name: '', bio: '', currency: 'USD' })
  let profileSaving = $state(false)

  function resetProfileState () {
    profile = { name: '', bio: '', currency: 'USD' }
    profileLoaded = false
    profileEditing = false
    avatarPreviewUrl = null
  }

  async function loadProfile () {
    if (profileLoaded) return
    try {
      const resp = await fetch('/api/get-profile')
      if (!resp.ok) return
      const data = await resp.json()
      profile.name     = data.name     ?? ''
      profile.bio      = data.bio      ?? ''
      profile.currency = data.currency ?? 'USD'
      if (data.hasAvatar) avatarPreviewUrl = '/api/get-avatar'
      profileLoaded = true
    } catch {}
  }

  function startEdit () {
    // Copy saved state into draft — user edits draft, not profile directly
    profileDraft = { name: profile.name, bio: profile.bio, currency: profile.currency }
    profileEditing = true
  }

  function cancelEdit () {
    profileEditing = false
  }

  async function saveProfileEdit () {
    profileSaving = true
    try {
      await fetch('/api/save-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(profileDraft)
      })
      // Commit draft → saved state only after successful write
      profile.name     = profileDraft.name
      profile.bio      = profileDraft.bio
      profile.currency = profileDraft.currency
      profileEditing = false
    } finally {
      profileSaving = false
    }
  }

  // Saves currency immediately when user changes the select in Settings
  let currencySaved = $state(false)

  async function saveCurrency () {
    await fetch('/api/save-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: profile.name, bio: profile.bio, currency: profile.currency })
    })
    currencySaved = true
    setTimeout(() => { currencySaved = false }, 2000)
  }

  async function uploadAvatar (e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    // Show local preview immediately
    avatarPreviewUrl = URL.createObjectURL(file)
    // Upload binary to Bare — Content-Type carries the mime type
    await fetch('/api/upload-avatar', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'image/jpeg' },
      body: file
    })
  }

  onMount(async () => {
    try {
      const storage = Pear.config.storage

      // Check identity status written by Bare before WebView opened
      const resp = await fetch('file://' + storage + '/pubkey.json')
      if (!resp.ok) throw new Error('Failed to read identity file')
      const data = await resp.json()

      if (data.status === 'pending') {
        view = 'welcome'
      } else {
        await showIdentity(data.publicKey)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
    }
  })

  // Renders the identity screen for a given public key hex string
  async function showIdentity (pubKey: string) {
    publicKey = pubKey
    qrDataUrl = await QRCode.toDataURL(pubKey, {
      width: 200,
      margin: 1,
      color: { dark: '#f8fafc', light: '#2a2f3a' }
    })
    view = 'identity'
    // Load profile in background — non-blocking
    loadProfile()
  }

  // Called when user clicks "Create your identity"
  async function createIdentity () {
    view = 'creating'
    try {
      const resp = await fetch('/api/create-identity')
      if (!resp.ok) throw new Error('Bare API returned ' + resp.status)
      const { publicKey: pubKey } = await resp.json()
      await showIdentity(pubKey)
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
      view = 'welcome'
    }
  }

  // Deletes keypair + drive from disk via Bare, resets app to onboarding
  async function deleteIdentity () {
    try {
      const resp = await fetch('/api/delete-identity')
      if (!resp.ok) throw new Error('Bare API returned ' + resp.status)
      publicKey = null
      qrDataUrl = null
      confirmDelete = false
      settingsOpen = false
      profileOpen = false
      resetProfileState()
      view = 'welcome'
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
    }
  }
</script>

<!-- Custom titlebar: frameless Pear window, drag region + macOS-style traffic lights -->
<div class="titlebar">
  <div class="traffic-lights">
    <button class="tl-btn tl-close"    onclick={() => Pear.exit(0)}                    title="Close"></button>
    <button class="tl-btn tl-minimize" onclick={() => Pear.Window.self.minimize()}     title="Minimize"></button>
    <button class="tl-btn tl-zoom"     onclick={() => Pear.Window.self.fullscreen()}   title="Fullscreen"></button>
  </div>
</div>

<main>
  <h1>Trust Protocol</h1>
  <p class="subtitle">Decentralized reputation, owned by you.</p>

  {#if error}
    <div class="card error">Error: {error}</div>

  {:else if view === 'loading'}
    <div class="card muted">Loading...</div>

  {:else if view === 'welcome'}
    <div class="welcome-card">
      <div class="logo-wrap">
        <!-- Shield icon representing trust/identity -->
        <svg class="logo" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M32 6L10 16v16c0 14.4 9.6 25.6 22 29.2C44.4 57.6 54 46.4 54 32V16L32 6z"
            fill="#34d399" fill-opacity="0.12" stroke="#34d399" stroke-width="2"/>
          <path d="M23 32l6 6 12-12"
            stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
      <h2>Your identity, your rules</h2>
      <p class="description">
        Trust Protocol creates a cryptographic key on your device.
        No accounts. No passwords. No servers.
        Your reputation belongs to you.
      </p>
      <button class="create-btn" onclick={createIdentity}>
        Create your identity
      </button>
    </div>

  {:else if view === 'creating'}
    <div class="card muted">Generating your identity...</div>

  {:else if view === 'identity'}
    <div class="identity-card">
      <div class="qr-block">
        {#if qrDataUrl}
          <img src={qrDataUrl} alt="Public key QR code" class="qr" />
        {/if}
      </div>
      <div class="key-block">
        <div class="label">Your public key</div>
        <div class="short-key">{shortKey}</div>
        <div class="key-copy-row">
          <div class="full-key">{publicKey}</div>
          <button
            class="copy-btn"
            onclick={copyPublicKey}
            title="Copy full key"
            aria-label="Copy public key"
          >
            {#if keyCopied}
              <!-- Checkmark -->
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 8l3.5 3.5L13 4.5"/>
              </svg>
            {:else}
              <!-- Copy icon -->
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round">
                <rect x="5" y="5" width="8" height="9" rx="1.5"/>
                <path d="M3 11V3a1 1 0 011-1h7"/>
              </svg>
            {/if}
          </button>
        </div>
        {#if keyCopied}
          <div class="copy-hint">Copied!</div>
        {/if}
      </div>
    </div>

    <!-- Expandable sections -->
    <div class="sections">

      <!-- My Profile -->
      <div class="section">
        <button class="section-header" onclick={() => profileOpen = !profileOpen}>
          <svg class="chevron" class:open={profileOpen} viewBox="0 0 16 16" fill="none">
            <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>My Profile</span>
        </button>
        {#if profileOpen}
          <div class="section-body">
            {#if !profileEditing}
              <!-- VIEW MODE -->
              <div class="avatar-row">
                <div class="avatar-wrap">
                  {#if avatarPreviewUrl}
                    <img src={avatarPreviewUrl} alt="Avatar" class="avatar-img" />
                  {:else}
                    <div class="avatar-placeholder">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="8" r="4"/>
                        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                      </svg>
                    </div>
                  {/if}
                </div>
                <div class="profile-name-view">
                  {#if profile.name}
                    <span class="profile-name-text">{profile.name}</span>
                  {:else}
                    <span class="profile-empty-hint">No name set</span>
                  {/if}
                </div>
              </div>

              <div class="profile-view-field">
                <div class="field-label">About</div>
                {#if profile.bio}
                  <div class="profile-view-value">{profile.bio}</div>
                {:else}
                  <div class="profile-empty-hint">No info yet</div>
                {/if}
              </div>

              <button class="edit-btn" onclick={startEdit}>Edit profile</button>

            {:else}
              <!-- EDIT MODE -->
              <div class="avatar-row">
                <div class="avatar-wrap">
                  {#if avatarPreviewUrl}
                    <img src={avatarPreviewUrl} alt="Avatar" class="avatar-img" />
                  {:else}
                    <div class="avatar-placeholder">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="8" r="4"/>
                        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                      </svg>
                    </div>
                  {/if}
                </div>
                <label class="avatar-btn">
                  {avatarPreviewUrl ? 'Change photo' : 'Upload photo'}
                  <input type="file" accept="image/*" onchange={uploadAvatar} hidden />
                </label>
              </div>

              <div class="field">
                <label class="field-label" for="profile-name">Name / Alias</label>
                <input
                  id="profile-name"
                  type="text"
                  class="field-input"
                  placeholder="How others will see you"
                  bind:value={profileDraft.name}
                />
              </div>

              <div class="field">
                <label class="field-label" for="profile-bio">About</label>
                <textarea
                  id="profile-bio"
                  class="field-input field-textarea"
                  placeholder="Describe what you do and what kind of deals you make"
                  rows="3"
                  bind:value={profileDraft.bio}
                ></textarea>
              </div>

              <div class="edit-actions">
                <button class="cancel-btn" onclick={cancelEdit}>Cancel</button>
                <button class="save-btn" onclick={saveProfileEdit} disabled={profileSaving}>
                  {profileSaving ? 'Saving...' : 'Save'}
                </button>
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <!-- Deals -->
      <div class="section">
        <button class="section-header" onclick={() => dealsOpen = !dealsOpen}>
          <svg class="chevron" class:open={dealsOpen} viewBox="0 0 16 16" fill="none">
            <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Deals</span>
        </button>
        {#if dealsOpen}
          <div class="section-body muted">
            Deal history coming soon.
          </div>
        {/if}
      </div>

      <!-- Settings -->
      <div class="section">
        <button class="section-header" onclick={() => settingsOpen = !settingsOpen}>
          <svg class="chevron" class:open={settingsOpen} viewBox="0 0 16 16" fill="none">
            <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
              stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          <span>Settings</span>
        </button>
        {#if settingsOpen}
          <div class="section-body">
            <!-- Display currency -->
            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-name">Display currency</div>
                <div class="setting-desc">How deal amounts are shown across the app.</div>
              </div>
              <div class="currency-wrap">
                <select
                  class="field-input field-select currency-select"
                  class:currency-saved={currencySaved}
                  bind:value={profile.currency}
                  onchange={saveCurrency}
                >
                  <option value="USD">USD</option>
                  <option value="RUB">RUB</option>
                  <option value="BTC">BTC</option>
                </select>
              </div>
            </div>

            <div class="setting-divider"></div>

            <div class="setting-row">
              <div class="setting-info">
                <div class="setting-name">Delete My Identity</div>
                <div class="setting-desc">Permanently removes your keypair and all your data from this device.</div>
              </div>
              {#if !confirmDelete}
                <button class="danger-btn" onclick={() => confirmDelete = true}>
                  Delete
                </button>
              {:else}
                <div class="confirm-row">
                  <span class="confirm-label">This cannot be undone.</span>
                  <button class="cancel-btn" onclick={() => confirmDelete = false}>Cancel</button>
                  <button class="confirm-btn" onclick={deleteIdentity}>Delete</button>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>

    </div>
  {/if}
</main>

<style>
  @font-face {
    font-family: 'gothampro';
    src: url('/gothampro.ttf') format('truetype');
  }

  :global(body) {
    margin: 0;
    background: #1e2128;
    color: #e2e8f0;
    font-family: 'gothampro', system-ui, sans-serif;
    text-align: center;
  }

  main {
    max-width: 600px;
    margin: 0 auto;
    padding: 0 1.5rem 2rem;
    padding-top: calc(38px + 2.5rem);
  }

  h1 {
    font-size: 2rem;
    font-weight: 700;
    margin: 0 0 0.25rem;
    color: #f8fafc;
  }

  .subtitle {
    color: #94a3b8;
    margin: 0 0 2rem;
  }

  /* Shared card base */
  .card {
    background: #2a2f3a;
    border: 1px solid #374151;
    border-radius: 12px;
    padding: 1.5rem;
  }

  .muted { color: #94a3b8; }

  .error {
    background: #2a2f3a;
    border: 1px solid #7f1d1d;
    border-radius: 8px;
    padding: 1.5rem;
    color: #f87171;
  }

  /* Welcome / onboarding */
  .welcome-card {
    background: #2a2f3a;
    border: 1px solid #374151;
    border-radius: 12px;
    padding: 2.5rem 2rem;
    text-align: center;
  }

  .logo-wrap {
    margin-bottom: 1.5rem;
  }

  .logo {
    width: 72px;
    height: 72px;
  }

  h2 {
    font-size: 1.4rem;
    font-weight: 600;
    color: #f8fafc;
    margin: 0 0 1rem;
  }

  .description {
    color: #94a3b8;
    line-height: 1.7;
    margin: 0 0 2rem;
    font-size: 0.95rem;
  }

  .create-btn {
    background: #34d399;
    color: #0f1117;
    border: none;
    border-radius: 8px;
    padding: 0.75rem 1.75rem;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s;
  }

  .create-btn:hover {
    background: #6ee7b7;
  }

  /* Identity card */
  .identity-card {
    background: #2a2f3a;
    border: 1px solid #374151;
    border-radius: 12px;
    padding: 1.5rem;
    display: flex;
    gap: 1.5rem;
    align-items: flex-start;
  }

  .qr-block { flex-shrink: 0; }

  .qr {
    border-radius: 8px;
    display: block;
  }

  .key-block {
    flex: 1;
    min-width: 0;
  }

  .label {
    font-size: 0.75rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.5rem;
  }

  .short-key {
    font-family: monospace;
    font-size: 1.25rem;
    color: #34d399;
    margin-bottom: 0.75rem;
  }

  .full-key {
    font-family: monospace;
    font-size: 0.65rem;
    color: #64748b;
    word-break: break-all;
    line-height: 1.5;
  }

  /* Expandable sections */
  .sections {
    margin-top: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .section {
    background: #2a2f3a;
    border: 1px solid #374151;
    border-radius: 10px;
    overflow: hidden;
  }

  .section-header {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.85rem 1rem;
    background: none;
    border: none;
    color: #cbd5e1;
    font-size: 0.95rem;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    text-align: left;
    transition: color 0.15s;
  }

  .section-header:hover {
    color: #f8fafc;
  }

  /* Chevron rotates 90° when section is open */
  .chevron {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
    color: #64748b;
    transition: transform 0.2s ease;
  }

  .chevron.open {
    transform: rotate(90deg);
  }

  .section-body {
    padding: 0 1rem 1rem;
    font-size: 0.9rem;
    border-top: 1px solid #374151;
    padding-top: 0.85rem;
    text-align: left;
  }

  /* Settings */
  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .setting-info {
    flex: 1;
    min-width: 0;
  }

  .setting-name {
    color: #e2e8f0;
    font-size: 0.9rem;
    font-weight: 500;
    margin-bottom: 0.2rem;
  }

  .setting-desc {
    color: #64748b;
    font-size: 0.8rem;
  }

  .danger-btn {
    background: transparent;
    border: 1px solid #7f1d1d;
    color: #f87171;
    border-radius: 6px;
    padding: 0.4rem 0.9rem;
    font-size: 0.85rem;
    cursor: pointer;
    white-space: nowrap;
    transition: background 0.15s, border-color 0.15s;
  }

  .danger-btn:hover {
    background: #7f1d1d22;
    border-color: #ef4444;
  }

  /* Inline confirmation */
  .confirm-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .confirm-label {
    font-size: 0.8rem;
    color: #f87171;
    white-space: nowrap;
  }

  .cancel-btn {
    background: transparent;
    border: 1px solid #374151;
    color: #94a3b8;
    border-radius: 6px;
    padding: 0.35rem 0.75rem;
    font-size: 0.82rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }

  .cancel-btn:hover {
    border-color: #64748b;
    color: #e2e8f0;
  }

  .confirm-btn {
    background: #7f1d1d;
    border: 1px solid #991b1b;
    color: #fca5a5;
    border-radius: 6px;
    padding: 0.35rem 0.75rem;
    font-size: 0.82rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .confirm-btn:hover {
    background: #991b1b;
  }

  /* Custom titlebar for frameless Pear window */
  .titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: 38px;
    background: #1a1e26;
    border-bottom: 1px solid #2a2f3a;
    display: flex;
    align-items: center;
    padding: 0 13px;
    -webkit-app-region: drag;
    -webkit-user-select: none;
    z-index: 100;
  }

  .traffic-lights {
    display: flex;
    gap: 8px;
    -webkit-app-region: no-drag;
  }

  /* Base circle */
  .tl-btn {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    padding: 0;
    position: relative;
    transition: filter 0.1s;
  }

  .tl-close    { background: #ff5f57; }
  .tl-minimize { background: #febc2e; }
  .tl-zoom     { background: #28c840; }

  .tl-btn:hover { filter: brightness(0.85); }

  /* Profile form */
  .avatar-row {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1.25rem;
  }

  .avatar-wrap {
    width: 56px;
    height: 56px;
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
    background: #1e2128;
    border: 1px solid #374151;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .avatar-placeholder {
    width: 28px;
    height: 28px;
    color: #4b5563;
  }

  .avatar-placeholder svg {
    width: 100%;
    height: 100%;
  }

  .avatar-btn {
    font-size: 0.82rem;
    color: #34d399;
    cursor: pointer;
    padding: 0.35rem 0.75rem;
    border: 1px solid #34d39944;
    border-radius: 6px;
    transition: background 0.15s, border-color 0.15s;
    font-family: inherit;
  }

  .avatar-btn:hover {
    background: #34d39911;
    border-color: #34d399;
  }

  .field {
    margin-bottom: 1rem;
  }

  .field-label {
    display: block;
    font-size: 0.75rem;
    color: #64748b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.4rem;
  }

  .field-input {
    width: 100%;
    box-sizing: border-box;
    background: #1e2128;
    border: 1px solid #374151;
    border-radius: 7px;
    color: #e2e8f0;
    font-size: 0.9rem;
    font-family: inherit;
    padding: 0.55rem 0.75rem;
    outline: none;
    transition: border-color 0.15s;
  }

  .field-input:focus {
    border-color: #34d399;
  }

  .field-input::placeholder {
    color: #4b5563;
  }

  .field-textarea {
    resize: vertical;
    min-height: 72px;
    line-height: 1.5;
  }

  .field-select {
    appearance: none;
    cursor: pointer;
  }

  .save-btn {
    margin-top: 0.25rem;
    background: #34d399;
    color: #0f1117;
    border: none;
    border-radius: 7px;
    padding: 0.6rem 1.4rem;
    font-size: 0.9rem;
    font-weight: 600;
    font-family: inherit;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }

  .save-btn:hover { background: #6ee7b7; }
  .save-btn:disabled { opacity: 0.5; cursor: default; }

  /* Profile view mode */
  .profile-name-view {
    flex: 1;
  }

  .profile-name-text {
    font-size: 1rem;
    font-weight: 600;
    color: #f8fafc;
  }

  .profile-empty-hint {
    font-size: 0.85rem;
    color: #4b5563;
    font-style: italic;
  }

  .profile-view-field {
    margin-bottom: 0.85rem;
  }

  .profile-view-value {
    color: #cbd5e1;
    font-size: 0.9rem;
    line-height: 1.55;
    white-space: pre-wrap;
  }

  .edit-btn {
    margin-top: 0.5rem;
    background: transparent;
    border: 1px solid #374151;
    color: #94a3b8;
    border-radius: 7px;
    padding: 0.5rem 1.1rem;
    font-size: 0.85rem;
    font-family: inherit;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }

  .edit-btn:hover {
    border-color: #64748b;
    color: #e2e8f0;
  }

  .edit-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.25rem;
  }

  /* Wrapper positions the custom chevron over the select */
  .currency-wrap {
    position: relative;
    display: inline-block;
  }

  /* Chevron drawn via ::after — pointer-events: none so clicks pass through */
  .currency-wrap::after {
    content: '';
    position: absolute;
    right: 8px;
    top: 50%;
    transform: translateY(-50%);
    width: 10px;
    height: 10px;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 6' fill='none' stroke='%2364748b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1 1l4 4 4-4'/%3E%3C%2Fsvg%3E");
    background-repeat: no-repeat;
    background-size: contain;
    pointer-events: none;
  }

  .currency-select {
    width: auto;
    min-width: 90px;
    padding: 0.35rem 1.6rem 0.35rem 0.6rem; /* right padding for chevron */
    font-size: 0.85rem;
    text-align: center;
    text-align-last: center;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }

  /* Green flash on save — fades out over 2s */
  @keyframes saved-flash {
    0%   { border-color: #34d399; box-shadow: 0 0 0 2px #34d39933; background-color: #34d39918; }
    100% { border-color: #374151; box-shadow: none;                 background-color: #1e2128;   }
  }

  .currency-saved {
    animation: saved-flash 2s ease-out forwards;
  }

  /* Key copy row */
  .key-copy-row {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
  }

  .copy-btn {
    flex-shrink: 0;
    background: transparent;
    border: none;
    padding: 2px;
    cursor: pointer;
    color: #64748b;
    line-height: 0;
    border-radius: 4px;
    transition: color 0.15s;
    margin-top: 1px;
  }

  .copy-btn:hover { color: #34d399; }

  .copy-btn svg {
    width: 13px;
    height: 13px;
  }

  .copy-hint {
    font-size: 0.7rem;
    color: #34d399;
    margin-top: 0.3rem;
  }

  .setting-divider {
    border: none;
    border-top: 1px solid #2d3340;
    margin: 0.85rem 0;
  }
</style>
