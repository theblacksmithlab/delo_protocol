<script lang="ts">
  import { onMount } from 'svelte'
  import { slide } from 'svelte/transition'
  import QRCode from 'qrcode'
  import './App.css'
  import NewDeal from './views/NewDeal.svelte'
  import DealList from './views/DealList.svelte'
  import DealView from './views/DealView.svelte'
  import ContactRow from './views/ContactRow.svelte'
  import LoadingOverlay from './components/LoadingOverlay.svelte'
  import init, { calculate_reputation } from '../../wasm-pkg/trust_core.js'

  // 'loading'  — reading files on startup
  // 'welcome'  — no identity yet, show onboarding screen
  // 'creating' — waiting for Bare to generate keypair
  // 'identity' — keypair exists, show public key + QR
  type View = 'loading' | 'welcome' | 'creating' | 'identity' | 'findUser' | 'peerProfile' | 'newDeal' | 'dealView'

  let view = $state<View>('loading')

  // Splash screen
  let splashVisible    = $state(true)
  let splashFadingOut  = $state(false)
  let splashContentOut = $state(false)
  let splashTimers: ReturnType<typeof setTimeout>[] = []

  function skipSplash () {
    if (!splashVisible || splashFadingOut) return
    splashTimers.forEach(clearTimeout)
    splashFadingOut = true
    setTimeout(() => { splashVisible = false }, 600)
  }

  let publicKey  = $state<string | null>(null)
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

  function formatVolume (volume: number, currency: string): string {
    if (currency === 'BTC') return volume.toFixed(4).replace(/\.?0+$/, '') + ' BTC'
    if (currency === 'RUB') return '₽' + Math.round(volume).toLocaleString('ru-RU')
    if (currency === 'EUR') return '€' + volume.toLocaleString('en-US', { maximumFractionDigits: 2 })
    if (currency === 'USDT') return '₮' + volume.toLocaleString('en-US', { maximumFractionDigits: 2 })
    return '$' + volume.toLocaleString('en-US', { maximumFractionDigits: 2 })
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
  let peerPublicKey       = $state<string | null>(null)
  let peerFoundDriveKey   = $state<string | null>(null)
  let peerFoundContactKey = $state<string | null>(null)
  let peerDealLogKey      = $state<string | null>(null)
  let peerFromCache       = $state(false)
  let findLoading = $state(false)
  let findError = $state<string | null>(null)

  // Peer reputation — loaded after findPeer() succeeds
  let peerReputation        = $state<ReputationStats | null>(null)
  let peerReputationLoading = $state(false)
  let peerReputationFailed  = $state(false)   // true only on timeout/error (vs. no deals)
  let peerDeals             = $state<any[]>([])  // cached raw deals for currency recalculation

  let peerShortKey = $derived(
    peerPublicKey
      ? '0x' + peerPublicKey.slice(0, 4) + '...' + peerPublicKey.slice(-4)
      : null
  )

  function findReset () {
    resetView('identity')
    peerInput = ''
    peerProfile = null
    peerPublicKey = null
    peerFoundDriveKey = null
    peerFoundContactKey = null
    peerDealLogKey = null
    peerFromCache = false
    peerReputation = null
    peerReputationFailed = false
    peerDeals = []
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
      peerPublicKey       = data.publicKey   ?? null
      peerFoundDriveKey   = data.driveKey    ?? null
      peerFoundContactKey = ck
      peerDealLogKey      = data.dealLogKey  ?? null
      peerFromCache       = data.fromCache   ?? false

      // Start loading reputation in background — runs while user reviews the result
      if (peerPublicKey && peerDealLogKey) void loadPeerReputation()
    } catch (e) {
      findError = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      findLoading = false
    }
  }

  // Opens the full peerProfile view for a contact (no search screen needed)
  async function openContactProfile (contact: Contact) {
    findError = null
    peerProfile = null
    findLoading = true
    try {
      const resp = await fetch('/api/get-peer-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactKey: contact.contactKey })
      })
      if (!resp.ok) {
        const err = await resp.json()
        findError = err.error || 'Failed to load profile'
        return
      }
      const data = await resp.json()
      peerProfile         = data
      peerPublicKey       = data.publicKey  ?? null
      peerFoundDriveKey   = data.driveKey   ?? null
      peerFoundContactKey = contact.contactKey
      peerDealLogKey      = data.dealLogKey ?? null
      peerFromCache       = data.fromCache  ?? false
      pushView('peerProfile')
      if (peerPublicKey && peerDealLogKey) void loadPeerReputation()
    } catch (e) {
      findError = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      findLoading = false
    }
  }

  async function loadPeerReputation () {
    if (!peerPublicKey || !peerDealLogKey || !wasmReady) { peerReputation = null; return }
    peerReputationLoading = true
    peerReputation = null
    peerReputationFailed = false
    peerDeals = []
    try {
      const resp = await fetch('/api/get-peer-deal-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dealLogKey: peerDealLogKey, publicKey: peerPublicKey })
      })
      const data = await resp.json()
      // Non-array response means timeout or server error — show "Unavailable"
      if (!Array.isArray(data)) { peerReputationFailed = true; return }
      // Empty array is valid — peer has no completed deals yet, show $0
      if (data.length === 0) return
      peerDeals = data
      const result = calculate_reputation(JSON.stringify(data), peerPublicKey, profile.currency.toLowerCase())
      peerReputation = result ?? null
    } catch {
      peerReputationFailed = true
    } finally {
      peerReputationLoading = false
    }
  }

  // Recalculate peer reputation when display currency changes (no extra network call)
  $effect(() => {
    void profile.currency
    if (wasmReady && peerDeals.length > 0 && peerPublicKey) {
      const result = calculate_reputation(JSON.stringify(peerDeals), peerPublicKey, profile.currency.toLowerCase())
      peerReputation = result ?? null
    }
  })

  // Navigation stack — push on forward navigation, pop on Back
  let navStack = $state<View[]>([])

  function pushView (v: View) {
    navStack = [...navStack, view]
    view = v
  }

  function popView () {
    if (navStack.length > 0) {
      view = navStack[navStack.length - 1]
      navStack = navStack.slice(0, -1)
    }
  }

  function resetView (v: View) {
    navStack = []
    view = v
  }

  // NewDeal state
  let newDealCounterpartyKey   = $state('')
  let newDealCounterpartyAlias = $state('')

  function openNewDeal (cpKey = '', cpAlias = '') {
    newDealCounterpartyKey   = cpKey
    newDealCounterpartyAlias = cpAlias
    pushView('newDeal')
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
    pushView('dealView')
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
  let activeSection = $state<'profile' | 'contacts' | 'deals' | 'settings' | null>(null)

  function toggleSection (section: 'profile' | 'contacts' | 'deals' | 'settings') {
    activeSection = activeSection === section ? null : section
  }

  // Delete identity: two-step confirmation
  let confirmDelete = $state(false)

  // ─── Contacts ────────────────────────────────────────────────────────────

  type Contact = { contactKey: string; publicKey: string; driveKey: string; name: string; addedAt: number }
  let contacts    = $state<Contact[]>([])
  let addingContact = $state(false)

  const isInContacts = $derived(
    peerPublicKey !== null && contacts.some(c => c.publicKey === peerPublicKey)
  )

  async function loadContacts () {
    try {
      contacts = await fetch('/api/get-contacts').then(r => r.json())
    } catch { contacts = [] }
  }

  async function addToContacts () {
    if (!peerFoundContactKey || !peerPublicKey || !peerFoundDriveKey) return
    addingContact = true
    try {
      await fetch('/api/add-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contactKey: peerFoundContactKey,
          publicKey:  peerPublicKey,
          driveKey:   peerFoundDriveKey,
          name:       peerProfile?.name || 'Anonymous'
        })
      })
      await loadContacts()
    } finally {
      addingContact = false
    }
  }

  async function removeFromContacts () {
    if (!peerFoundContactKey) return
    addingContact = true
    try {
      await fetch('/api/remove-contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactKey: peerFoundContactKey })
      })
      await loadContacts()
    } finally {
      addingContact = false
    }
  }

  // Profile — saved state (what's in Hyperdrive)
  let profile = $state({ name: '', bio: '', currency: 'USD', memberSince: null as string | null })

  // Currency symbol for trust volume display — must be after profile declaration
  let currencySymbol = $derived(
    ({ USD: '$', RUB: '₽', BTC: '₿', EUR: '€', USDT: '₮' } as Record<string, string>)[profile.currency] ?? '$'
  )
  let profileLoaded = $state(false)

  // ─── Reputation ──────────────────────────────────────────────────────────────

  type ReputationStats = {
    total_volume: number
    positive_volume: number
    negative_volume: number
    success_rate: number | null
    sentiment: number          // 0.0 = red, 0.5 = neutral/white, 1.0 = green
    deal_count: number
    positive_count: number
    neutral_count: number
    negative_count: number
  }

  // Shared sentiment color stops.
  const SENTIMENT_NEUTRAL: [number, number, number] = [240, 244, 248]  // #f0f4f8
  const SENTIMENT_RED:     [number, number, number] = [248, 113, 113]  // #f87171
  const SENTIMENT_BLUE:    [number, number, number] = [147, 210, 255]  // brand ice blue

  function sentimentRGB (s: number): [number, number, number] {
    if (s <= 0.5) {
      const t = s * 2
      return [
        Math.round(SENTIMENT_RED[0] + t * (SENTIMENT_NEUTRAL[0] - SENTIMENT_RED[0])),
        Math.round(SENTIMENT_RED[1] + t * (SENTIMENT_NEUTRAL[1] - SENTIMENT_RED[1])),
        Math.round(SENTIMENT_RED[2] + t * (SENTIMENT_NEUTRAL[2] - SENTIMENT_RED[2])),
      ]
    } else {
      const t = (s - 0.5) * 2
      return [
        Math.round(SENTIMENT_NEUTRAL[0] + t * (SENTIMENT_BLUE[0] - SENTIMENT_NEUTRAL[0])),
        Math.round(SENTIMENT_NEUTRAL[1] + t * (SENTIMENT_BLUE[1] - SENTIMENT_NEUTRAL[1])),
        Math.round(SENTIMENT_NEUTRAL[2] + t * (SENTIMENT_BLUE[2] - SENTIMENT_NEUTRAL[2])),
      ]
    }
  }

  // Returns CSS color string for the trust volume number.
  function sentimentColor (s: number): string {
    const [r, g, b] = sentimentRGB(s)
    return `rgb(${r}, ${g}, ${b})`
  }

  // Returns text-shadow glow matching the sentiment color.
  // Intensity scales with distance from neutral (0.5) — no glow at neutral, max at extremes.
  function sentimentGlow (s: number): string {
    const [r, g, b] = sentimentRGB(s)
    const intensity = Math.abs(s - 0.5) * 2  // 0 at neutral, 1 at extremes
    const a1 = (intensity * 0.55).toFixed(2)  // outer layer
    const a2 = (intensity * 0.30).toFixed(2)  // inner tight layer
    return `0 0 18px rgba(${r}, ${g}, ${b}, ${a1}), 0 0 7px rgba(${r}, ${g}, ${b}, ${a2})`
  }
  let reputation = $state<ReputationStats | null>(null)
  let wasmReady  = $state(false)

  // Initialize WASM once on mount
  onMount(async () => {
    await init()
    wasmReady = true
  })

  onMount(() => {
    // bg: 0–2s, logo: 2–4s, tagline: 4–6s
    // at 6s: logo+tagline fade out together (2s)
    // at 8s: whole splash fades out (0.6s)
    splashTimers = [
      setTimeout(() => {
        splashContentOut = true
        splashTimers.push(
          setTimeout(() => {
            splashFadingOut = true
            setTimeout(() => { splashVisible = false }, 600)
          }, 2000)
        )
      }, 6000)
    ]
    return () => splashTimers.forEach(clearTimeout)
  })

  async function loadReputation () {
    if (!wasmReady || !publicKey) return
    try {
      const deals = await fetch('/api/get-deal-log').then(r => r.json())
      if (!Array.isArray(deals) || deals.length === 0) { reputation = null; return }
      const result = calculate_reputation(
        JSON.stringify(deals),
        publicKey,
        profile.currency.toLowerCase()
      )
      reputation = result ?? null
    } catch {
      reputation = null
    }
  }

  // Reload reputation when WASM is ready, identity is loaded, or currency changes
  $effect(() => {
    void profile.currency  // track currency as dependency
    if (wasmReady && publicKey) loadReputation()
  })
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
  type ToastNotif = { dealId: string; title: string; label: string; visible: boolean }
  let toast = $state<ToastNotif | null>(null)
  let toastTimer: ReturnType<typeof setTimeout> | null = null
  let toastFadeTimer: ReturnType<typeof setTimeout> | null = null

  const NOTIF_LABELS: Record<string, string> = {
    new_deal:           'New incoming deal',
    deal_response:      'Counterparty responded',
    deal_confirmed:     'Deal confirmed',
    deal_cancelled:     'Deal cancelled',
    deal_closed_partial:'Counterparty closed their side',
    deal_completed:     'Deal completed',
  }

  function showToast (dealId: string, title: string, type: string) {
    if (toastTimer)      clearTimeout(toastTimer)
    if (toastFadeTimer)  clearTimeout(toastFadeTimer)

    const label = NOTIF_LABELS[type] ?? type
    toast = { dealId, title, label, visible: true }

    // After 8s start fade, then remove
    toastTimer = setTimeout(() => {
      if (toast) toast = { ...toast, visible: false }
      toastFadeTimer = setTimeout(() => { toast = null }, 400)
    }, 8000)
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

      // Refresh reputation when a deal reaches completed state via peer's close
      if (notifications.some(n => n.type === 'deal_completed')) void loadReputation()

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
      if (!resp.ok) { error = 'Failed to read identity'; return }
      const data = await resp.json()

      if (data.status === 'pending') {
        resetView('welcome')
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
    contactKey = ck
    // QR encodes the compact contact key — one string contains all three keys
    const qrPayload = ck ?? JSON.stringify({ publicKey: pubKey, driveKey: dKey })
    qrDataUrl = await QRCode.toDataURL(qrPayload, {
      width: 200,
      margin: 1,
      color: { dark: '#f8fafc', light: '#2a2f3a' }
    })
    resetView('identity')
    await loadProfile()
    void loadContacts()
  }

  // Called when user clicks "Create your identity"
  async function createIdentity () {
    resetView('creating')
    try {
      const resp = await fetch('/api/create-identity')
      if (!resp.ok) { error = 'Bare API returned ' + resp.status; resetView('welcome'); return }
      const { publicKey: pubKey, driveKey: dKey, contactKey: ck } = await resp.json()
      await showIdentity(pubKey, dKey, ck ?? null)
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
      resetView('welcome')
    }
  }

  // Deletes keypair + drive from disk via Bare, resets app to onboarding
  async function deleteIdentity () {
    try {
      const resp = await fetch('/api/delete-identity')
      if (!resp.ok) { error = 'Bare API returned ' + resp.status; return }
      publicKey = null
      qrDataUrl = null
      confirmDelete = false
      activeSection = null
      contacts = []
      resetProfileState()
      view = 'welcome'
    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
    }
  }
</script>

{#if splashVisible}
  <div class="splash" class:splash-out={splashFadingOut} onclick={skipSplash} onkeydown={skipSplash} role="button" tabindex="-1">
    <div class="splash-bg"></div>
    <div class="splash-content" class:out={splashContentOut}>
      <svg class="splash-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 424 158">
      <path fill-rule="evenodd" fill="#e2e8f0" fill-opacity="0.75"
        d="M416.522,130.212 C411.653,138.681 405.022,145.347 396.622,150.213 C388.222,155.081 378.688,157.513 368.022,157.513 C357.353,157.513 347.788,155.081 339.322,150.213 C330.853,145.347 324.187,138.681 319.322,130.212 C314.453,121.747 312.022,112.247 312.022,101.712 C312.022,91.047 314.453,81.481 319.322,73.012 C324.187,64.547 330.853,57.881 339.322,53.012 C347.788,48.147 357.353,45.713 368.022,45.713 C378.688,45.713 388.222,48.147 396.622,53.012 C405.022,57.881 411.653,64.547 416.522,73.012 C421.388,81.481 423.822,91.047 423.822,101.712 C423.822,112.247 421.388,121.747 416.522,130.212 ZM406.122,78.812 C402.322,72.081 397.122,66.747 390.522,62.812 C383.922,58.881 376.422,56.912 368.022,56.912 C359.753,56.912 352.288,58.881 345.622,62.812 C338.953,66.747 333.687,72.081 329.822,78.812 C325.953,85.547 324.022,93.181 324.022,101.712 C324.022,110.112 325.953,117.681 329.822,124.413 C333.687,131.147 338.953,136.481 345.622,140.412 C352.288,144.347 359.753,146.313 368.022,146.313 C376.422,146.313 383.922,144.347 390.522,140.412 C397.122,136.481 402.322,131.147 406.122,124.413 C409.922,117.681 411.822,110.047 411.822,101.513 C411.822,93.112 409.922,85.547 406.122,78.812 ZM296.022,156.312 L292.022,156.312 C286.953,156.312 282.453,154.912 278.522,152.112 C274.587,149.313 271.522,145.447 269.322,140.512 C267.122,135.581 266.022,129.847 266.022,123.313 L266.022,6.113 C266.022,4.247 266.587,2.781 267.722,1.712 C268.853,0.647 270.288,0.113 272.022,0.113 C273.888,0.113 275.353,0.647 276.422,1.712 C277.488,2.781 278.022,4.247 278.022,6.113 L278.022,123.313 C278.022,129.447 279.322,134.481 281.922,138.413 C284.522,142.347 287.888,144.313 292.022,144.313 L297.022,144.313 C298.488,144.313 299.688,144.847 300.622,145.912 C301.553,146.981 302.022,148.447 302.022,150.313 C302.022,152.047 301.488,153.481 300.422,154.612 C299.353,155.747 297.888,156.312 296.022,156.312 ZM238.222,105.313 L154.339,105.313 C154.774,112.517 156.529,118.986 159.622,124.712 C163.222,131.381 168.222,136.612 174.622,140.412 C181.022,144.212 188.353,146.113 196.622,146.113 C201.822,146.113 207.053,145.212 212.322,143.412 C217.588,141.613 221.753,139.247 224.822,136.312 C225.887,135.247 227.188,134.681 228.722,134.612 C230.253,134.547 231.553,134.981 232.622,135.913 C234.088,137.112 234.853,138.447 234.922,139.913 C234.988,141.381 234.353,142.712 233.022,143.912 C228.753,147.781 223.188,150.981 216.322,153.513 C209.453,156.047 202.887,157.312 196.622,157.312 C186.088,157.312 176.722,154.947 168.522,150.213 C160.322,145.481 153.887,138.913 149.222,130.512 C144.553,122.112 142.222,112.513 142.222,101.712 C142.222,90.781 144.422,81.147 148.822,72.813 C153.222,64.481 159.288,57.912 167.022,53.112 C174.753,48.312 183.622,45.912 193.622,45.912 C203.488,45.912 212.222,48.213 219.822,52.813 C227.422,57.412 233.353,63.747 237.622,71.813 C241.887,79.881 244.022,89.181 244.022,99.712 C244.022,101.447 243.488,102.812 242.422,103.812 C241.353,104.812 239.953,105.313 238.222,105.313 ZM228.222,78.512 C225.022,71.847 220.453,66.612 214.522,62.812 C208.588,59.012 201.622,57.112 193.622,57.112 C186.022,57.112 179.253,59.012 173.322,62.812 C167.387,66.612 162.722,71.847 159.322,78.512 C156.828,83.405 155.257,88.874 154.593,94.912 L232.467,94.912 C231.994,88.903 230.584,83.434 228.222,78.512 ZM84.722,150.313 C76.388,155.113 66.953,157.513 56.422,157.513 C45.753,157.513 36.187,155.081 27.722,150.213 C19.253,145.347 12.587,138.681 7.722,130.212 C2.853,121.747 0.422,112.181 0.422,101.513 C0.422,90.847 2.853,81.313 7.722,72.912 C12.587,64.512 19.253,57.881 27.722,53.012 C36.187,48.147 45.753,45.713 56.422,45.713 C66.022,45.713 74.653,47.781 82.322,51.912 C89.988,56.047 95.953,61.581 100.222,68.512 L100.222,6.113 C100.222,4.247 100.787,2.781 101.922,1.712 C103.053,0.647 104.488,0.113 106.222,0.113 C108.088,0.113 109.553,0.647 110.622,1.712 C111.687,2.781 112.222,4.247 112.222,6.113 L112.222,102.712 C112.088,113.112 109.553,122.447 104.622,130.712 C99.687,138.981 93.053,145.512 84.722,150.313 ZM94.522,78.713 C90.722,72.047 85.522,66.747 78.922,62.812 C72.322,58.881 64.822,56.912 56.422,56.912 C48.153,56.912 40.687,58.881 34.022,62.812 C27.353,66.747 22.088,72.047 18.222,78.713 C14.353,85.381 12.422,92.981 12.422,101.513 C12.422,110.047 14.353,117.681 18.222,124.413 C22.088,131.147 27.353,136.481 34.022,140.412 C40.687,144.347 48.153,146.313 56.422,146.313 C64.822,146.313 72.322,144.347 78.922,140.412 C85.522,136.481 90.722,131.147 94.522,124.413 C98.322,117.681 100.222,110.047 100.222,101.513 C100.222,92.981 98.322,85.381 94.522,78.713 Z"/>
    </svg>
      <svg class="splash-tagline" viewBox="0 0 220 18" width="220" height="18" xmlns="http://www.w3.org/2000/svg">
        <text x="0" y="14" textLength="220" lengthAdjust="spacing"
          fill="#e2e8f0" fill-opacity="0.75" font-family="comfortaa, system-ui" font-size="13">
          own your reputation
        </text>
      </svg>
    </div>
    <div class="splash-skip">click anywhere to skip</div>
  </div>
{/if}

<!-- Custom titlebar: frameless Pear window, drag region + macOS-style traffic lights -->
<div class="titlebar">
  <div class="traffic-lights">
    <button class="tl-btn tl-close"    onclick={() => Pear.exit(0)}                title="Close"></button>
    <button class="tl-btn tl-minimize" onclick={() => Pear.Window.self.minimize()} title="Minimize"></button>
    <button class="tl-btn tl-zoom"     title="Fullscreen" disabled></button>
  </div>

  <span class="beta-badge">BETA</span>
</div>

<LoadingOverlay visible={findLoading} message="Connecting to peer..." />

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
        Delo Protocol creates a cryptographic key on your device.<br><br>
        No accounts. No passwords. No servers.<br><br>
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
        <div class="toast-header">
          <svg class="toast-icon" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 2a6 6 0 00-6 6v2.586l-.707.707A1 1 0 004 13h12a1 1 0 00.707-1.707L16 10.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-2.83-2h5.66A3 3 0 0110 18z"/>
          </svg>
          <span class="toast-header-label">New event</span>
          <button class="toast-close" onclick={(e) => { e.stopPropagation(); dismissToast() }}>✕</button>
        </div>
        <div class="toast-deal-title">"{toast.title}"</div>
        <div class="toast-event-label">{toast.label}</div>
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

      <!-- Trust volume block -->
      <div class="trust-block">
        <div class="trust-label">TRUST VOLUME</div>
        {#if reputation && reputation.deal_count > 0}
          <div class="trust-amount" style="color: {sentimentColor(reputation.sentiment)}; text-shadow: {sentimentGlow(reputation.sentiment)}">{formatVolume(reputation.total_volume, profile.currency)}</div>
        {:else}
          <div class="trust-amount trust-amount-empty">{currencySymbol}0</div>
        {/if}
      </div>

      <!-- Outcome bar: count-based segments — positive / neutral / negative -->
      {#if reputation && reputation.deal_count > 0}
        {@const total = reputation.deal_count}
        {@const posPercent = (reputation.positive_count / total) * 100}
        {@const neuPercent = (reputation.neutral_count  / total) * 100}
        {@const negPercent = (reputation.negative_count / total) * 100}
        <div class="outcome-bar">
          {#if posPercent > 0}<div class="outcome-bar-pos" style="width: {posPercent}%"></div>{/if}
          {#if neuPercent > 0}<div class="outcome-bar-neu" style="width: {neuPercent}%"></div>{/if}
          {#if negPercent > 0}<div class="outcome-bar-neg" style="width: {negPercent}%"></div>{/if}
        </div>
      {:else}
        <div class="outcome-bar outcome-bar-empty"></div>
      {/if}

      <!-- Stats row -->
      <div class="stats-row">
        <div class="stat-cell">
          <div class="stat-value">{reputation?.deal_count ?? 0}</div>
          <div class="stat-label">Deals</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">
            {#if reputation?.success_rate !== null && reputation?.success_rate !== undefined}
              {reputation.success_rate.toFixed(0)}%
            {:else}
              —
            {/if}
          </div>
          <div class="stat-label">Satisfied</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{memberSinceDisplay(profile.memberSince)}</div>
          <div class="stat-label">Membership</div>
        </div>
      </div>

    </div>
    </div><!-- end identity-card-wrap -->

    <div class="action-bar">
      <button class="find-user-btn" onclick={() => { peerInput = ''; peerProfile = null; peerPublicKey = null; peerFoundDriveKey = null; findError = null; pushView('findUser') }}>
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
            <div class="section-body" transition:slide={{ duration: 350 }}>
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

        <!-- Contacts -->
        <div class="section">
          <button class="section-header" onclick={() => toggleSection('contacts')}>
            <svg class="chevron" class:open={activeSection === 'contacts'} viewBox="0 0 16 16" fill="none">
              <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.5"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>Contacts</span>
          </button>
          {#if activeSection === 'contacts'}
            <div class="section-body" transition:slide={{ duration: 350 }}>
              {#if contacts.length === 0}
                <div class="contacts-empty">
                  No contacts yet.<br>Find a user and tap "Add to Contacts".
                </div>
              {:else}
                <div class="contacts-list">
                  {#each contacts as contact (contact.publicKey)}
                    <ContactRow
                      {contact}
                      onViewContact={openContactProfile}
                    />
                  {/each}
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
            <div class="section-body" transition:slide={{ duration: 350 }}>
              <DealList
                myPublicKey={publicKey ?? ''}
                onNewDeal={() => openNewDeal()}
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
            <div class="section-body" transition:slide={{ duration: 350 }}>
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
      <button class="back-btn" onclick={popView}>← Back</button>

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
          <div class="peer-profile-name-row">
            <div class="peer-profile-name">{peerProfile?.name || 'Anonymous'}</div>
            {#if peerFromCache}
              <span class="cached-badge" title="Peer is offline — showing cached data">cached</span>
            {/if}
          </div>
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

      <!-- Trust volume -->
      <div class="trust-block trust-block-peer">
        <div class="trust-label">TRUST VOLUME</div>
        {#if peerReputationLoading}
          <div class="inline-spinner">
            {#each Array(12) as _, i}
              <div class="inline-spoke" style="--i: {i}"></div>
            {/each}
          </div>
        {:else if peerReputation && peerReputation.deal_count > 0}
          <div class="trust-amount" style="color: {sentimentColor(peerReputation.sentiment)}; text-shadow: {sentimentGlow(peerReputation.sentiment)}">{formatVolume(peerReputation.total_volume, profile.currency)}</div>
        {:else if peerReputationFailed}
          <div class="trust-amount trust-amount-empty">Unavailable</div>
        {:else}
          <div class="trust-amount trust-amount-empty">{currencySymbol}0</div>
        {/if}
      </div>

      <!-- Outcome bar: count-based segments — positive / neutral / negative -->
      {#if peerReputation && peerReputation.deal_count > 0}
        {@const total = peerReputation.deal_count}
        {@const posPercent = (peerReputation.positive_count / total) * 100}
        {@const neuPercent = (peerReputation.neutral_count  / total) * 100}
        {@const negPercent = (peerReputation.negative_count / total) * 100}
        <div class="outcome-bar">
          {#if posPercent > 0}<div class="outcome-bar-pos" style="width: {posPercent}%"></div>{/if}
          {#if neuPercent > 0}<div class="outcome-bar-neu" style="width: {neuPercent}%"></div>{/if}
          {#if negPercent > 0}<div class="outcome-bar-neg" style="width: {negPercent}%"></div>{/if}
        </div>
      {:else}
        <div class="outcome-bar outcome-bar-empty"></div>
      {/if}

      <div class="stats-row">
        <div class="stat-cell">
          <div class="stat-value">{peerReputation?.deal_count ?? 0}</div>
          <div class="stat-label">Deals</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">
            {#if peerReputation?.success_rate !== null && peerReputation?.success_rate !== undefined}
              {peerReputation.success_rate.toFixed(0)}%
            {:else}
              —
            {/if}
          </div>
          <div class="stat-label">Satisfied</div>
        </div>
        <div class="stat-cell">
          <div class="stat-value">{memberSinceDisplay(peerProfile?.memberSince ?? null)}</div>
          <div class="stat-label">Membership</div>
        </div>
      </div>

      {#if !isInContacts}
        <button
          class="add-to-contacts-btn"
          onclick={addToContacts}
          disabled={addingContact}
        >
          {addingContact ? 'Adding...' : '+ Add to Contacts'}
        </button>
      {:else}
        <button
          class="remove-from-contacts-btn"
          onclick={removeFromContacts}
          disabled={addingContact}
        >
          {addingContact ? 'Removing...' : 'Remove from Contacts'}
        </button>
      {/if}

      <button
        class="new-deal-from-profile-btn"
        onclick={() => openNewDeal(peerFoundContactKey ?? '', peerProfile?.name || '')}
        disabled={!peerFoundContactKey}
      >
        + New Deal with {peerProfile?.name || 'this user'}
      </button>

    </div>

  {:else if view === 'dealView' && currentDeal}
    <DealView
      deal={currentDeal}
      myPublicKey={publicKey ?? ''}
      onBack={popView}
      onDealCompleted={loadReputation}
    />

  {:else if view === 'newDeal'}
    <NewDeal
      counterpartyKey={newDealCounterpartyKey}
      counterpartyAlias={newDealCounterpartyAlias}
      onBack={popView}
      onSuccess={() => resetView('identity')}
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
          onclick={() => pushView('peerProfile')}
          onkeydown={(e) => e.key === 'Enter' && pushView('peerProfile')}
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

  <footer class="app-footer">Delo Protocol · Decentralized reputation, owned by you.</footer>
</main>

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
    font-family: 'comfortaa';
    src: url('/comfortaa.ttf') format('truetype');
  }

  :global(body) {
    margin: 0;
    background-color: #1e2128;
    background-image: url('/background_10.png');
    background-size: cover;
    background-position: center top;
    background-attachment: fixed;
    color: #e2e8f0;
    font-family: 'comfortaa', system-ui, sans-serif;
    text-align: center;
  }

  /* ─── Toast notification ─────────────────────────────────── */

  .toast {
    position: fixed;
    top: 48px; /* below titlebar */
    right: 12px;
    z-index: 1000;
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 248px;
    padding: 10px 12px 12px;
    background: rgba(10, 14, 22, 0.55);
    backdrop-filter: blur(52px) saturate(180%);
    -webkit-backdrop-filter: blur(52px) saturate(180%);
    border: 1px solid rgba(147, 210, 255, 0.12);
    border-radius: 14px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3);
    cursor: pointer;
    opacity: 0;
    transform: translateX(20px) scale(0.97);
    transition: opacity 0.25s ease, transform 0.25s ease;
    pointer-events: none;
  }

  /* Accent line on the right edge */
  .toast::before {
    content: '';
    position: absolute;
    right: 0;
    top: 14px;
    bottom: 14px;
    width: 2px;
    background: linear-gradient(to bottom, #93d2ff, rgba(147, 210, 255, 0.3));
    border-radius: 2px 0 0 2px;
  }

  .toast.toast-visible {
    opacity: 1;
    transform: translateX(0) scale(1);
    pointer-events: auto;
  }

  /* Header row: bell + "New event" label + close */
  .toast-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .toast-icon {
    width: 12px;
    height: 12px;
    color: #93d2ff;
    flex-shrink: 0;
    opacity: 0.75;
  }

  .toast-header-label {
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: rgba(147, 210, 255, 0.55);
    flex: 1;
  }

  .toast-close {
    background: none;
    border: none;
    color: rgba(255, 255, 255, 0.2);
    font-size: 11px;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
    flex-shrink: 0;
    line-height: 1;
    transition: color 0.15s;
  }
  .toast-close:hover { color: rgba(255, 255, 255, 0.6); }

  /* Deal title — quoted, slightly highlighted */
  .toast-deal-title {
    font-size: 13px;
    font-weight: 500;
    color: #f0f6ff;
    line-height: 1.3;
    padding-left: 2px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Event description — muted label below */
  .toast-event-label {
    font-size: 11px;
    color: rgba(226, 232, 240, 0.5);
    padding-left: 2px;
    line-height: 1.3;
  }

  /* ─── Contacts section ───────────────────────────────────────────────── */


  .contacts-empty {
    font-size: 13px;
    color: #64748b;
    text-align: center;
    padding: 12px 0;
    line-height: 1.55;
  }

  .contacts-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* ─── Add to Contacts button ─────────────────────────────────────────── */

  .add-to-contacts-btn {
    margin-top: 1.25rem;
    width: 100%;
    background: transparent;
    border: 1px solid #374151;
    border-radius: 14px;
    color: #94a3b8;
    font-family: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    padding: 0.55rem 1rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .add-to-contacts-btn:hover {
    border-color: #64748b;
    color: #f0f4f8;
  }
  .add-to-contacts-btn:disabled {
    opacity: 0.4;
    pointer-events: none;
  }

  .remove-from-contacts-btn {
    margin-top: 1.25rem;
    width: 100%;
    background: transparent;
    border: 1px solid rgba(248, 113, 113, 0.25);
    border-radius: 14px;
    color: #f87171;
    font-family: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    padding: 0.55rem 1rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .remove-from-contacts-btn:hover {
    border-color: rgba(248, 113, 113, 0.5);
    color: #fca5a5;
  }
  .remove-from-contacts-btn:disabled {
    opacity: 0.4;
    pointer-events: none;
  }

  /* ─── Splash screen ──────────────────────────────────────────────────────── */

  .splash {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: #000;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: opacity 0.6s ease;
    cursor: pointer;
  }

  .splash.splash-out {
    opacity: 0;
    pointer-events: none;
  }

  .splash-bg {
    position: absolute;
    inset: 0;
    background: url('/background_10.png') center top / cover no-repeat;
    opacity: 0;
    animation: splash-fadein 2s ease forwards;
  }

  .splash-content {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
  }

  .splash-logo {
    width: 220px;
    height: auto;
    opacity: 0;
    animation: splash-fadein 2s ease 2s forwards;
    filter:
      drop-shadow(0 0 18px rgba(147, 210, 255, 0.55))
      drop-shadow(0 0 7px rgba(147, 210, 255, 0.30));
  }

  .splash-tagline {
    opacity: 0;
    animation: splash-fadein 2s ease 4s forwards;
    overflow: visible;
  }

  .splash-skip {
    position: absolute;
    bottom: 28px;
    left: 50%;
    transform: translateX(-50%);
    opacity: 0;
    animation: splash-fadein 1.5s ease 2s forwards;
    font-size: 11px;
    letter-spacing: 0.06em;
    color: rgba(240, 244, 248, 0.3);
    font-family: inherit;
    white-space: nowrap;
  }

  @keyframes splash-fadein {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  @keyframes splash-fadeout {
    from { opacity: 1; }
    to   { opacity: 0; }
  }

  .splash-content.out .splash-logo,
  .splash-content.out .splash-tagline {
    animation: splash-fadeout 2s ease forwards;
  }

  /* Inline spinner — same spokes as LoadingOverlay but small, no overlay */
  .inline-spinner {
    position: relative;
    width: 24px;
    height: 24px;
    margin: 4px auto;
  }
  .inline-spoke {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 2px;
    height: 6px;
    border-radius: 1px;
    background: #e2e8f0;
    transform-origin: center bottom;
    transform: rotate(calc(var(--i) * 30deg)) translateX(-50%) translateY(-100%);
    animation: spoke-fade 1s linear calc(var(--i) * -0.0833s) infinite;
    opacity: 0.15;
  }
  @keyframes spoke-fade {
    0%   { opacity: 1;    }
    8%   { opacity: 0.15; }
    100% { opacity: 0.15; }
  }
</style>
