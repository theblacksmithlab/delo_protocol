<script lang="ts">
  type Deal = {
    id: string
    title: string
    initiator_key: string
    counterparty_key: string
    original_amount: number
    original_currency: string
    level: string
    status: string
    timestamp: number
    expires_at: number
    delivered: boolean
  }

  let { myPublicKey, onNewDeal, onViewDeal, refreshKey = 0, unreadDealIds = new Set<string>() } = $props<{
    myPublicKey: string
    onNewDeal: () => void
    onViewDeal: (deal: Deal) => void
    refreshKey?: number
    unreadDealIds?: Set<string>
  }>()

  let deals   = $state<Deal[]>([])
  let loading = $state(true)
  let now     = $state(Math.floor(Date.now() / 1000))

  async function loadDeals () {
    try {
      const [outgoing, incoming, history] = await Promise.all([
        fetch('/api/get-outgoing-deals').then(r => r.json()),
        fetch('/api/get-incoming-deals').then(r => r.json()),
        fetch('/api/get-history-deals').then(r => r.json())
      ])
      deals = [...outgoing, ...incoming, ...history].sort((a, b) => b.timestamp - a.timestamp)
    } catch {}
    loading = false
  }

  $effect(() => {
    const refresh = setInterval(loadDeals, 30_000)
    const tick = setInterval(() => { now = Math.floor(Date.now() / 1000) }, 60_000)
    return () => { clearInterval(refresh); clearInterval(tick) }
  })

  // Load on mount and whenever parent signals a refresh (e.g. on notification)
  $effect(() => {
    void refreshKey
    loadDeals()
  })

  function isOutgoing (deal: Deal): boolean {
    return deal.initiator_key === myPublicKey
  }

  function shortKey (hex: string): string {
    return '0x' + hex.slice(0, 4) + '...' + hex.slice(-4)
  }

  function formatAmount (deal: Deal): string {
    const cur = deal.original_currency.toUpperCase()
    const amt = deal.original_amount
    if (cur === 'BTC') return amt.toFixed(8).replace(/\.?0+$/, '') + ' BTC'
    return amt.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + cur
  }

  function isNegotiating (status: string): boolean {
    return status === 'initiated' || status === 'pending_counterparty' || status === 'pending_initiator'
  }

  // Countdown showing Xh Ym — updates every minute
  function timeLeft (expiresAt: number): string {
    const secs = expiresAt - now
    if (secs <= 0) return 'Expired'
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    if (h > 0) return `${h}h ${m}m`
    return `${m}m`
  }

  function isUrgent (expiresAt: number): boolean {
    return (expiresAt - now) < 3600
  }

  function statusLabel (deal: Deal): string {
    const out = isOutgoing(deal)
    switch (deal.status) {
      case 'initiated':                  return 'Delivering'
      case 'pending_counterparty':       return out ? 'Awaiting response' : 'Action required'
      case 'pending_initiator':          return out ? 'Action required'   : 'Awaiting response'
      case 'in_progress':                return 'In progress'
      case 'closed_by_initiator':        return out ? 'Waiting for counterparty' : 'Action required'
      case 'closed_by_counterparty':     return out ? 'Action required' : 'Waiting for initiator'
      case 'completed':                  return 'Completed'
      case 'cancelled_by_initiator':     return out ? 'Cancelled by you'  : 'Cancelled by initiator'
      case 'cancelled_by_counterparty':  return out ? 'Cancelled by counterparty' : 'Cancelled by you'
      case 'expired':                    return 'Not concluded'
      default:                           return deal.status
    }
  }

  // CSS class for the badge — direction-aware for negotiation statuses.
  // "You wait" → orange (pending-counterparty), "Your turn" → blue (pending-initiator).
  function statusClass (deal: Deal): string {
    const out = isOutgoing(deal)
    if (deal.status === 'pending_counterparty')
      return out ? 'status-pending-initiator' : 'status-pending-counterparty'
    if (deal.status === 'pending_initiator')
      return out ? 'status-pending-counterparty' : 'status-pending-initiator'
    return 'status-' + deal.status.replace(/_/g, '-')
  }

  // Only truly "negative" endings get muted — completed stays bright (positive outcome)
  function isClosedDeal (status: string): boolean {
    return status === 'expired' ||
           status === 'cancelled_by_initiator' ||
           status === 'cancelled_by_counterparty'
  }
</script>

<div class="deal-list-wrap">
  {#if loading}
    <div class="deals-state">Loading...</div>

  {:else if deals.length === 0}
    <div class="deals-state">No deals yet. Create your first one.</div>

  {:else}
    <div class="deals-list">
      {#each deals as deal (deal.id)}
        <div
          class="deal-card"
          class:action-required={
            deal.status === 'pending_initiator' ||
            (deal.status === 'closed_by_initiator' && !isOutgoing(deal)) ||
            (deal.status === 'closed_by_counterparty' && isOutgoing(deal))
          }
          class:sending={deal.status === 'initiated' && !deal.delivered}
          class:closed={isClosedDeal(deal.status)}
          role="button"
          tabindex="0"
          onclick={() => onViewDeal(deal)}
          onkeydown={(e) => e.key === 'Enter' && onViewDeal(deal)}
        >
          <!-- Top row: direction + unread bell + status badge -->
          <div class="deal-top">
            <span class="deal-direction">
              {isOutgoing(deal) ? '↑ Outgoing' : '↓ Incoming'}
            </span>
            <div class="deal-top-right">
              {#if unreadDealIds.has(deal.id)}
                <span class="deal-unread-bell" title="Unread update">
                  <svg viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10 2a6 6 0 00-6 6v2.586l-.707.707A1 1 0 004 13h12a1 1 0 00.707-1.707L16 10.586V8a6 6 0 00-6-6zM10 18a3 3 0 01-2.83-2h5.66A3 3 0 0110 18z"/>
                  </svg>
                </span>
              {/if}
              <span class="deal-badge {statusClass(deal)}">
                {statusLabel(deal)}
              </span>
            </div>
          </div>

          <!-- Title → deal ID → counterparty (mirrors: name → key → context) -->
          <div class="deal-title">{deal.title}</div>
          <div class="deal-id">{shortKey(deal.id)}</div>
          <div class="deal-counterparty">
            with {shortKey(isOutgoing(deal) ? deal.counterparty_key : deal.initiator_key)}
          </div>

          <!-- Bottom row: amount + countdown timer -->
          <div class="deal-bottom">
            <span class="deal-amount">{formatAmount(deal)}</span>
            {#if isNegotiating(deal.status)}
              <span class="deal-timer" class:urgent={isUrgent(deal.expires_at)}>
                ⏱ {timeLeft(deal.expires_at)}
              </span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

  <button class="new-deal-btn" onclick={onNewDeal}>+ New Deal</button>
</div>

<style>
  .deal-list-wrap {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .deals-state {
    font-size: 13px;
    color: #64748b;
    padding: 8px 0 4px;
    text-align: left;
  }

  .deals-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Matches peer-card style: same bg, border, radius, inset shadow */
  .deal-card {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 16px;
    padding: 1rem 1.1rem;
    display: flex;
    flex-direction: column;
    gap: 3px;
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.1),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08);
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
    cursor: pointer;
  }

  .deal-card:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.15);
  }

  /* Action required — blue glow, overrides base shadow */
  .deal-card.action-required {
    border-color: rgba(147, 210, 255, 0.3);
    box-shadow:
      0 0 14px rgba(100, 180, 255, 0.14),
      inset 0 1px 0 rgba(255, 255, 255, 0.1),
      inset 0 -1px 0 rgba(0, 0, 0, 0.08);
  }

  /* Not yet delivered — slightly muted */
  .deal-card.sending {
    opacity: 0.65;
  }

  /* Top row */
  .deal-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .deal-direction {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #64748b;
  }

  /* Status badge */
  .deal-badge {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 2px 8px;
    border-radius: 20px;
    border-width: 1px;
    border-style: solid;
    /* border-color lives in App.css — set via .status-* global classes */
  }

  /* status-* classes live in App.css (global) — applied dynamically via string interpolation */

  /* Closed deals — completed, expired, cancelled — visually muted */
  .deal-card.closed {
    opacity: 0.5;
  }

  /* Deal title — mirrors .id-name */
  .deal-title {
    font-size: 14px;
    font-weight: 600;
    color: #f0f4f8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Counterparty — one step below title, above deal ID */
  .deal-counterparty {
    font-size: 11px;
    color: #64748b;
    margin-top: 4px;
  }

  /* Deal ID — mirrors .id-key, most muted */
  .deal-id {
    font-size: 10px;
    color: #64748b;
    letter-spacing: 0.02em;
  }

  /* Bottom row */
  .deal-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 6px;
  }

  .deal-amount {
    font-size: 13px;
    color: #94a3b8;
    font-weight: 500;
  }

  .deal-timer {
    font-size: 11px;
    color: #64748b;
    font-variant-numeric: tabular-nums;
  }

  .deal-timer.urgent { color: #f59e0b; }

  /* New deal button — Tier 1 glow */
  .new-deal-btn {
    background: rgba(147, 210, 255, 0.1);
    border: 1px solid rgba(147, 210, 255, 0.3);
    border-radius: 14px;
    color: #93d2ff;
    font-family: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    padding: 0.55rem 1rem;
    cursor: pointer;
    box-shadow: 0 0 14px rgba(100, 180, 255, 0.22);
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
    width: 100%;
    margin-top: 4px;
  }

  .new-deal-btn:hover {
    background: rgba(147, 210, 255, 0.18);
    border-color: rgba(147, 210, 255, 0.5);
    box-shadow: 0 0 22px rgba(100, 180, 255, 0.35);
  }

  /* Top-right slot: bell + badge aligned together */
  .deal-top-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /* Unread bell icon on deal card */
  .deal-unread-bell {
    display: flex;
    align-items: center;
    color: #93d2ff;
    opacity: 0.85;
  }
  .deal-unread-bell svg {
    width: 13px;
    height: 13px;
  }
</style>
