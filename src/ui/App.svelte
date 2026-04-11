<script lang="ts">
  import { onMount } from 'svelte'
  import QRCode from 'qrcode'
  import './App.css'
  import NewDeal from './views/NewDeal.svelte'
  import DealList from './views/DealList.svelte'
  import DealView from './views/DealView.svelte'

  // 'loading'  — reading files on startup
  // 'welcome'  — no identity yet, show onboarding screen
  // 'creating' — waiting for Bare to generate keypair
  // 'identity' — keypair exists, show public key + QR
  type View = 'loading' | 'welcome' | 'creating' | 'identity' | 'findUser' | 'peerProfile' | 'newDeal' | 'dealView'

  let view = $state<View>('loading')
  let publicKey  = $state<string | null>(null)
  let driveKey   = $state<string | null>(null)
  let contactKey = $state<string | null>(null)
  let qrDataUrl  = $state<string | null>(null)
  let error = $state<string | null>(null)

  // Share modal (QR + copy contact key)
  let shareOpen = $state(false)
  let contactCopied = $state(false)

  // Short version of own public key for display
  let shortKey = $derived(
    publicKey ? '0x' + publicKey.slice(0, 4) + '...' + publicKey.slice(-4) : null
  )

  // Membership period (since identity creation)
  function memberSinceDisplay (iso: string | null): string {
    if (!iso) return '—'
    const years = (Date.now() - new Date(iso).getTime()) / (1000 * 60 * 60 * 24 * 365.25)
    if (years < 1 / 12) return '<1mo'
    if (years < 1) return Math.round(years * 12) + 'mo'
    return years.toFixed(1) + 'y'
  }

  async function copyContactInfo () {
    if (!contactKey) return
    await navigator.clipboard.writeText(contactKey)
    contactCopied = true
    setTimeout(() => { contactCopied = false }, 2000)
  }

  // Find user — separate view

  let peerInput = $state('')
  let peerProfile = $state<{ name: string, bio: string, hasAvatar: boolean, memberSince: string | null } | null>(null)
  let peerPublicKey      = $state<string | null>(null)
  let peerFoundDriveKey  = $state<string | null>(null)
  let peerFoundContactKey = $state<string | null>(null)
  let findLoading = $state(false)
  let findError = $state<string | null>(null)

  let peerShortKey = $derived(
    peerPublicKey
      ? '0x' + peerPublicKey.slice(0, 4) + '...' + peerPublicKey.slice(-4)
      : null
  )

  function findReset () {
    view = 'identity'
    peerInput = ''
    peerProfile = null
    peerPublicKey = null
    peerFoundDriveKey = null
    peerFoundContactKey = null
    findError = null
  }

  async function findPeer () {
    findError = null
    peerProfile = null
    findLoading = true
    try {
      const ck = peerInput.trim()
      if (!ck) {
        findError = 'Paste the contact key from the user\'s profile.'
        return
      }

      const resp = await fetch('/api/get-peer-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactKey: ck })
      })

      if (!resp.ok) {
        const err = await resp.json()
        findError = err.error || 'Failed to load profile'
        return
      }

      const data = await resp.json()
      peerProfile = data
      peerPublicKey = null  // not needed separately — contactKey encodes it
      peerFoundDriveKey = data.driveKey ?? null
      peerFoundContactKey = ck
    } catch (e) {
      findError = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      findLoading = false
    }
  }

  // NewDeal navigation state
  let previousView = $state<View>('identity')
  let newDealCounterpartyKey   = $state('')
  let newDealCounterpartyAlias = $state('')

  function openNewDeal (from: View, cpKey = '', cpAlias = '') {
    previousView = from
    newDealCounterpartyKey   = cpKey
    newDealCounterpartyAlias = cpAlias
    view = 'newDeal'
  }

  // DealView navigation state
  let currentDeal = $state<any>(null)
  let dealListRefreshKey = $state(0)

  // Unread deal IDs — persisted in Hyperdrive, restored on startup
  let unreadDealIds = $state(new Set<string>())

  async function loadUnreadDeals () {
    try {
      const ids: string[] = await fetch('/api/get-unread-deals').then(r => r.json())
      unreadDealIds = new Set(ids)
    } catch {}
  }

  function openDealView (deal: any) {
    currentDeal = deal
    previousView = view
    view = 'dealView'
    // Mark as read: remove bell from card + persist to Hyperdrive
    if (unreadDealIds.has(deal.id)) {
      unreadDealIds.delete(deal.id)
      unreadDealIds = new Set(unreadDealIds) // trigger reactivity
      fetch('/api/mark-notification-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deal.id })
      }).catch(() => {})
    }
  }

  // Accordion open/close state
  let activeSection = $state<'profile' | 'deals' | 'settings' | null>(null)

  function toggleSection (section: 'profile' | 'deals' | 'settings') {
    activeSection = activeSection === section ? null : section
  }

  // Delete identity: two-step confirmation
  let confirmDelete = $state(false)

  // Profile — saved state (what's in Hyperdrive)
  let profile = $state({ name: '', bio: '', currency: 'USD', memberSince: null as string | null })

  // Currency symbol for trust volume display — must be after profile declaration
  let currencySymbol = $derived(
    ({ USD: '$', RUB: '₽', BTC: '₿' } as Record<string, string>)[profile.currency] ?? '$'
  )
  let profileLoaded = $state(false)
  let avatarPreviewUrl = $state<string | null>(null)

  // Edit mode — working copy, only committed on Save
  let profileEditing = $state(false)
  let profileDraft = $state({ name: '', bio: '', currency: 'USD' })
  let profileSaving = $state(false)

  function resetProfileState () {
    profile = { name: '', bio: '', currency: 'USD', memberSince: null }
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
      profile.name        = data.name        ?? ''
      profile.bio         = data.bio         ?? ''
      profile.currency    = data.currency    ?? 'USD'
      profile.memberSince = data.memberSince ?? null
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

  // Toast notification
  type ToastNotif = { dealId: string; message: string; visible: boolean }
  let toast = $state<ToastNotif | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let toastFadeTimer: ReturnType<typeof setTimeout> | null = null

  const NOTIF_LABELS: Record<string, string> = {
    new_deal:           'incoming deal',
    deal_response:      'counterparty responded',
    deal_confirmed:     'deal confirmed',
    deal_cancelled:     'deal cancelled',
    deal_closed_partial:'counterparty closed their side',
    deal_completed:     'deal completed',
  }

  function showToast (dealId: string, title: string, type: string) {
    if (toastTimer)      clearTimeout(toastTimer)
    if (toastFadeTimer)  clearTimeout(toastFadeTimer)

    const label = NOTIF_LABELS[type] ?? type
    toast = { dealId, message: `${title} — ${label}`, visible: true }

    // After 5s start fade, then remove
    toastTimer = setTimeout(() => {
      if (toast) toast = { ...toast, visible: false }
      toastFadeTimer = setTimeout(() => { toast = null }, 400)
    }, 5000)
  }

  function dismissToast () {
    if (toastTimer)     clearTimeout(toastTimer)
    if (toastFadeTimer) clearTimeout(toastFadeTimer)
    if (toast) toast = { ...toast, visible: false }
    toastFadeTimer = setTimeout(() => { toast = null }, 400)
  }

  function playNotificationSound () {
    try {
      const ctx = new AudioContext()
      const t = ctx.currentTime

      function tap (startAt: number) {
        const osc  = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.type = 'sine'
        osc.frequency.setValueAtTime(880, startAt)
        gain.gain.setValueAtTime(0.12, startAt)
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + 0.08)
        osc.start(startAt)
        osc.stop(startAt + 0.08)
      }

      tap(t)
      tap(t + 0.13)
    } catch {}
  }

  async function pollNotifications () {
    try {
      const res = await fetch('/api/get-notifications')
      if (!res.ok) return
      const notifications: { type: string; dealId: string; title: string }[] = await res.json()
      if (notifications.length === 0) return

      playNotificationSound()
      dealListRefreshKey++

      // Add all incoming dealIds to unread set
      for (const n of notifications) {
        if (n.dealId) {
          unreadDealIds.add(n.dealId)
        }
      }
      unreadDealIds = new Set(unreadDealIds) // trigger reactivity

      // If DealView is open, refresh the deal data immediately for any relevant notification
      if (view === 'dealView' && currentDeal) {
        const r = await fetch(`/api/get-deal?id=${currentDeal.id}`)
        if (r.ok) {
          const fresh = await r.json()
          if (!fresh.error) currentDeal = fresh
        }
      }

      // Show toast for the last notification — but skip if we're already viewing that deal
      const last = notifications[notifications.length - 1]
      const alreadyViewing = view === 'dealView' && currentDeal?.id === last.dealId
      if (!alreadyViewing) {
        showToast(last.dealId, last.title, last.type)
      }
    } catch {}
  }

  // Start polling as soon as identity is ready, keep running across ALL views.
  // Stopping on non-identity views caused notifications to be missed in DealView.
  $effect(() => {
    if (publicKey) {
      loadUnreadDeals()
      const interval = setInterval(pollNotifications, 10_000)
      return () => clearInterval(interval)
    }
  })

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
      const resp = await fetch('/api/get-identity')
      if (!resp.ok) throw new Error('Failed to read identity')
      const data = await resp.json()

      if (data.status === 'pending') {
        view = 'welcome'
      } else {
        await showIdentity(data.publicKey, data.driveKey, data.contactKey ?? null)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
    }
  })

  // Renders the identity screen for a given public key + drive key + contact key
  async function showIdentity (pubKey: string, dKey: string, ck: string | null) {
    publicKey  = pubKey
    driveKey   = dKey
    contactKey = ck
    // QR encodes the compact contact key — one string contains all three keys
    const qrPayload = ck ?? JSON.stringify({ publicKey: pubKey, driveKey: dKey })
    qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 200,
      margin: 1,
      color: { dark: '#f8fafc', light: '#2a2f3a' }
    })
    view = 'identity'
    await loadProfile()
  }

  // Called when user clicks "Create your identity"
  async function createIdentity () {
    view = 'creating'
    try {
      const resp = await fetch('/api/create-identity')
      if (!resp.ok) throw new Error('Bare API returned ' + resp.status)
      const { publicKey: pubKey, driveKey: dKey, contactKey: ck } = await resp.json()
      await showIdentity(pubKey, dKey, ck ?? null)
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
      activeSection = null
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
    <button class="tl-btn tl-close"    onclick={() => Pear.exit(0)}                title="Close"></button>
    <button class="tl-btn tl-minimize" onclick={() => Pear.Window.self.minimize()} title="Minimize"></button>
    <button class="tl-btn tl-zoom"     title="Fullscreen" disabled></button>
  </div>

</div>

<main>
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
            fill="#93d2ff" fill-opacity="0.12" stroke="#93d2ff" stroke-width="2"/>
          <path d="M23 32l6 6 12-12"
            stroke="#93d2ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
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
    <div class="identity-card-wrap">

    <!-- Toast notification — top-right, auto-dismisses after 5s -->
    {#if toast}
      <div
        class="toast"
        class:toast-visible={toast.visible}
        role="button"
        tabindex="0"
        onclick={() => {
          dismissToast()
          const dealId = toast?.dealId
          if (dealId) {
            fetch(`/api/get-deal?id=${dealId}`).then(r => r.json()).then(deal => {
              if (!deal.error) openDealView(deal)
            }).catch(() => {})
          }
        }}
        onkeydown={(e) => e.key === 'Enter' && (() => {
          dismissToast()
          const dealId = toast?.dealId
          if (dealId) {
            fetch(`/api/get-deal?id=${dealId}`).then(r => r.json()).then(deal => {
              if (!deal.error) openDealView(deal)
            }).catch(() => {})
          }
        })()}
      >
        <svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor">
          <path d="M10 2a6 6 0 00-6 6v2.586l-.707.707A1 1 0 004 13h12a1 1 0 00.707-1.707L16 10.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-2.83-2h5.66A3 3 0 0110 18z"/>
        </svg>
        <span class="toast-message">{toast.message}</span>
        <button class="toast-close" onclick={(e) => { e.stopPropagation(); dismissToast() }}>✕</button>
      </div>
    {/if}

    <div class="identity-card">

      <!-- Header: avatar + name/key left, share button right -->
      <div class="id-header">
        <div class="id-user">
          <div class="id-avatar">
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
          <div class="id-name-block">
            <div class="id-name">{profile.name || 'Smart Peer'}</div>
            {#if shortKey}
              <div class="id-key">{shortKey}</div>
            {/if}
          </div>
        </div>
        <button class="share-btn" onclick={() => shareOpen = true} title="Share contact">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="3" r="1.5"/>
            <circle cx="12" cy="13" r="1.5"/>
            <circle cx="3" cy="8" r="1.5"/>
            <line x1="10.5" y1="3.75" x2="4.5" y2="7.25"/>
            <line x1="4.5" y1="8.75" x2="10.5" y2="12.25"/>
          </svg>
        </button>
      </div>

      <!-- Trust volume block — deal count shown only when > 0 (wired in Step 6) -->
      <div class="trust-block">
        <div class="trust-label">TRUST VOLUME</div>
        <div class="trust-amount">{currencySymbol}0</div>
      </div>

      <!-- Stats row -->
      <div class="stats-row">
        <div class="stat-cell">
          <div class="stat-value">0</div>
          <div class="stat-label">Deals</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">0</div>
          <div class="stat-label">Counterparties</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{memberSinceDisplay(profile.memberSince)}</div>
          <div class="stat-label">Membership</div>
        </div>
      </div>

    </div>
    </div><!-- end identity-card-wrap -->

    <div class="action-bar">
      <button class="find-user-btn" onclick={() => { peerInput = ''; peerProfile = null; peerPublicKey = null; peerFoundDriveKey = null; findError = null; view = 'findUser' }}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round">
          <circle cx="6.5" cy="6.5" r="4"/>
          <path d="M11 11l3 3"/>
        </svg>
        Find user by contact key
      </button>
    </div>

    <div class="sections">

        <!-- My Profile -->
        <div class="section">
          <button class="section-header" onclick={() => toggleSection('profile')}>
            <svg class="chevron" class:open={activeSection === 'profile'} viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>My Profile</span>
          </button>
          {#if activeSection === 'profile'}
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
                  <button class="edit-btn" onclick={startEdit}>Edit</button>
                </div>

                <div class="profile-view-field">
                  <div class="field-label">About</div>
                  {#if profile.bio}
                    <div class="profile-view-value">{profile.bio}</div>
                  {:else}
                    <div class="profile-empty-hint">No info yet</div>
                  {/if}
                </div>

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
          <button class="section-header" onclick={() => toggleSection('deals')}>
            <svg class="chevron" class:open={activeSection === 'deals'} viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Deals</span>
          </button>
          {#if activeSection === 'deals'}
            <div class="section-body">
              <DealList
                myPublicKey={publicKey ?? ''}
                onNewDeal={() => openNewDeal('identity')}
                onViewDeal={openDealView}
                refreshKey={dealListRefreshKey}
                unreadDealIds={unreadDealIds}
              />
            </div>
          {/if}
        </div>

        <!-- Settings -->
        <div class="section">
          <button class="section-header" onclick={() => toggleSection('settings')}>
            <svg class="chevron" class:open={activeSection === 'settings'} viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Settings</span>
          </button>
          {#if activeSection === 'settings'}
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

  {:else if view === 'peerProfile'}
    <div class="find-screen">
      <button class="back-btn" onclick={() => view = 'findUser'}>← Back</button>

      <div class="peer-profile-avatar-row">
        <div class="peer-profile-avatar-wrap">
          {#if peerProfile?.hasAvatar && peerFoundDriveKey}
            <img src={`/api/get-peer-avatar?key=${peerFoundDriveKey}`} alt="Avatar" class="avatar-img" />
          {:else}
            <div class="avatar-placeholder">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="8" r="4"/>
                <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              </svg>
            </div>
          {/if}
        </div>
        <div class="peer-profile-name-block">
          <div class="peer-profile-name">{peerProfile?.name || 'Anonymous'}</div>
          {#if peerShortKey}
            <div class="peer-key-short">{peerShortKey}</div>
          {/if}
        </div>
      </div>

      <div class="profile-view-field">
        <div class="field-label">About</div>
        {#if peerProfile?.bio}
          <div class="profile-view-value">{peerProfile.bio}</div>
        {:else}
          <div class="profile-empty-hint">No info yet</div>
        {/if}
      </div>

      <!-- Trust block — populated in Step 7 when we read peer's Hypercore log -->
      <div class="trust-block trust-block-peer">
        <div class="trust-label">TRUST VOLUME</div>
        <div class="trust-amount trust-amount-peer">{currencySymbol}0</div>
      </div>

      <div class="stats-row">
        <div class="stat-cell">
          <div class="stat-value">0</div>
          <div class="stat-label">Deals</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">0</div>
          <div class="stat-label">Counterparties</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{memberSinceDisplay(peerProfile?.memberSince ?? null)}</div>
          <div class="stat-label">Membership</div>
        </div>
      </div>

      <button
        class="new-deal-from-profile-btn"
        onclick={() => openNewDeal('peerProfile', peerFoundContactKey ?? '', peerProfile?.name || '')}
        disabled={!peerFoundContactKey}
      >
        + New Deal with {peerProfile?.name || 'this user'}
      </button>

    </div>

  {:else if view === 'dealView' && currentDeal}
    <DealView
      deal={currentDeal}
      myPublicKey={publicKey ?? ''}
      onBack={() => view = previousView}
    />

  {:else if view === 'newDeal'}
    <NewDeal
      counterpartyKey={newDealCounterpartyKey}
      counterpartyAlias={newDealCounterpartyAlias}
      onBack={() => view = previousView}
      onSuccess={() => view = 'identity'}
    />

  {:else if view === 'findUser'}
    <div class="find-screen">
      <button class="back-btn" onclick={findReset}>← Back</button>
      <h2>Find User by Contact Key</h2>
      <p class="find-hint">Paste the contact key JSON you received from another user.</p>

      <textarea
        class="field-input field-textarea"
        placeholder="Paste contact key here"
        rows="3"
        bind:value={peerInput}
      ></textarea>

      {#if findError}
        <div class="find-error">{findError}</div>
      {/if}

      <button class="find-submit-btn" onclick={findPeer} disabled={findLoading || !peerInput.trim()}>
        {findLoading ? 'Searching...' : 'Search'}
      </button>

      {#if peerProfile}
        <div class="peer-card" role="button" tabindex="0"
          onclick={() => view = 'peerProfile'}
          onkeydown={(e) => e.key === 'Enter' && (view = 'peerProfile')}
        >
          <div class="peer-avatar-row">
            <div class="avatar-wrap">
              {#if peerProfile.hasAvatar && peerFoundDriveKey}
                <img src={`/api/get-peer-avatar?key=${peerFoundDriveKey}`} alt="Avatar" class="avatar-img" />
              {:else}
                <div class="avatar-placeholder">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <circle cx="12" cy="8" r="4"/>
                    <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
                  </svg>
                </div>
              {/if}
            </div>
            <div>
              <div class="peer-name">{peerProfile.name || 'Anonymous'}</div>
              {#if peerShortKey}
                <div class="peer-key-short">{peerShortKey}</div>
              {/if}
            </div>
          </div>
          {#if peerProfile.bio}
            <div class="peer-bio">{peerProfile.bio}</div>
          {/if}
        </div>
      {/if}
    </div>

  {/if}
</main>

<footer class="app-footer">Trust Protocol · Decentralized reputation, owned by you.</footer>

<!-- Share modal — overlay with QR + copy button -->
{#if shareOpen}
  <div class="share-overlay" onclick={() => shareOpen = false}
    onkeydown={(e) => e.key === 'Escape' && (shareOpen = false)}
    role="presentation">
    <div class="share-modal"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog" aria-modal="true" aria-label="Share contact" tabindex="-1">
      <div class="share-modal-header">
        <span class="share-modal-title">Share contact</span>
        <button class="share-modal-close" onclick={() => shareOpen = false} aria-label="Close">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 3l10 10M13 3L3 13"/>
          </svg>
        </button>
      </div>
      {#if qrDataUrl}
        <img src={qrDataUrl} alt="QR code" class="share-qr-img" />
      {/if}
      <button class="share-copy-btn" class:copied={contactCopied} onclick={copyContactInfo}>
        {#if contactCopied}
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 8l4 4 6-7"/>
          </svg>
          Copied!
        {:else}
          Copy contact key
        {/if}
      </button>
    </div>
  </div>
{/if}

<style>
  @font-face {
    font-family: 'gothampro';
    src: url('/gothampro.ttf') format('truetype');
  }

  :global(body) {
    margin: 0;
    background-color: #1e2128;
    background-image: url('/background_10.png');
    background-size: cover;
    background-position: center top;
    background-attachment: fixed;
    color: #e2e8f0;
    font-family: 'gothampro', system-ui, sans-serif;
    text-align: center;
  }

  /* ─── Toast notification ─────────────────────────────────── */

  .toast {
    position: fixed;
    top: 48px; /* below titlebar */
    right: 12px;
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: 300px;
    padding: 12px 14px;
    background: rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 16px;
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.45),
      0 0 18px rgba(100, 180, 255, 0.1),
      inset 0 1px 0 rgba(255, 255, 255, 0.18),
      inset 0 -1px 0 rgba(0, 0, 0, 0.15);
    cursor: pointer;
    opacity: 0;
    transform: translateX(16px);
    transition: opacity 0.3s ease, transform 0.3s ease;
    pointer-events: none;
  }

  .toast.toast-visible {
    opacity: 1;
    transform: translateX(0);
    pointer-events: auto;
  }

  .toast-icon {
    width: 15px;
    height: 15px;
    color: #93d2ff;
    flex-shrink: 0;
    filter: drop-shadow(0 0 4px rgba(147, 210, 255, 0.5));
  }

  .toast-message {
    font-size: 12px;
    color: #e2e8f0;
    line-height: 1.45;
    flex: 1;
    text-align: left;
  }

  .toast-close {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.3);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
    flex-shrink: 0;
    transition: color 0.15s;
  }
  .toast-close:hover { color: rgba(255, 255, 255, 0.7); }
</style>
