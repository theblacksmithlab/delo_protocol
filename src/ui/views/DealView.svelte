<script lang="ts">
  type Deal = {
    id: string
    title: string
    initiator_key: string
    counterparty_key: string
    original_amount: number
    original_currency: string
    amount_usd: number
    amount_rub: number
    amount_eur: number
    amount_btc: number
    amount_usdt: number
    level: string
    status: string
    timestamp: number
    expires_at: number
    initiator_terms: string
    counterparty_terms: string | null
    initiator_outcome: string | null   // how initiator rated the counterparty
    counterparty_outcome: string | null // how counterparty rated the initiator
    delivered: boolean
  }

  let { deal, myPublicKey, onBack } = $props<{
    deal: Deal
    myPublicKey: string
    onBack: () => void
  }>()

  let now           = $state(Math.floor(Date.now() / 1000))
  let cancelling    = $state(false)
  let confirmCancel = $state(false)
  let cancelError   = $state<string | null>(null)

  let counterpartyTermsInput = $state('')
  let approving              = $state(false)
  let approveError           = $state<string | null>(null)

  let confirming    = $state(false)
  let confirmError  = $state<string | null>(null)

  // Close flow state
  let showClosePanel  = $state(false)
  let selectedOutcome = $state<'positive' | 'neutral' | 'negative' | null>(null)
  let closing         = $state(false)
  let closeError      = $state<string | null>(null)

  const OUTCOMES: { value: 'positive' | 'neutral' | 'negative'; label: string; desc: string }[] = [
    { value: 'positive', label: '👍 Positive', desc: 'Fulfilled as agreed' },
    { value: 'neutral',  label: '😐 Neutral',  desc: 'Partially fulfilled' },
    { value: 'negative', label: '👎 Negative', desc: 'Did not fulfill' },
  ]

  $effect(() => {
    const tick = setInterval(() => { now = Math.floor(Date.now() / 1000) }, 60_000)
    return () => clearInterval(tick)
  })

  const isInitiator = $derived(deal.initiator_key === myPublicKey)
  const otherKey    = $derived(isInitiator ? deal.counterparty_key : deal.initiator_key)

  const isNegotiating = $derived(
    deal.status === 'initiated' ||
    deal.status === 'pending_counterparty' ||
    deal.status === 'pending_initiator'
  )

  // True when the deal is executing — we can close our side.
  const isInProgress = $derived(deal.status === 'in_progress')

  // True when the other party has already closed their side — it's our turn.
  const otherPartyClosed = $derived(
    (isInitiator  && deal.status === 'closed_by_counterparty') ||
    (!isInitiator && deal.status === 'closed_by_initiator')
  )

  // True when WE have closed our side but are waiting for the other party.
  const weWaitingForOther = $derived(
    (isInitiator  && deal.status === 'closed_by_initiator') ||
    (!isInitiator && deal.status === 'closed_by_counterparty')
  )

  // Show close panel when other party has already closed (skip the "initiate close" step).
  $effect(() => {
    if (otherPartyClosed) showClosePanel = true
  })

  function shortKey (hex: string): string {
    return '0x' + hex.slice(0, 6) + '...' + hex.slice(-6)
  }

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

  function formatEquivalents (deal: Deal): string {
    const parts = []
    if (deal.original_currency !== 'USD')  parts.push(`$${deal.amount_usd.toFixed(2)}`)
    if (deal.original_currency !== 'RUB')  parts.push(`₽${Math.round(deal.amount_rub).toLocaleString('ru-RU')}`)
    if (deal.original_currency !== 'EUR')  parts.push(`€${deal.amount_eur.toFixed(2)}`)
    if (deal.original_currency !== 'BTC')  parts.push(`₿${deal.amount_btc.toFixed(8).replace(/\.?0+$/, '')}`)
    return parts.slice(0, 3).join(' · ')
  }

  function formatAmount (deal: Deal): string {
    const cur = deal.original_currency.toUpperCase()
    const amt = deal.original_amount
    if (cur === 'BTC') return amt.toFixed(8).replace(/\.?0+$/, '') + ' BTC'
    return amt.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ' + cur
  }

  const LEVEL_LABEL: Record<string, string> = {
    handshake: 'Handshake  ·  0.4×',
    review:    'Review  ·  0.7×',
    escrow:    'Escrow  ·  1.0×',
  }

  function statusLabel (status: string): string {
    switch (status) {
      case 'initiated':                  return 'Delivering'
      case 'pending_counterparty':       return isInitiator ? 'Awaiting response' : 'Action required'
      case 'pending_initiator':          return isInitiator ? 'Action required'   : 'Awaiting response'
      case 'in_progress':               return 'In progress'
      case 'closed_by_initiator':       return isInitiator ? 'Waiting for counterparty' : 'Action required'
      case 'closed_by_counterparty':    return isInitiator ? 'Action required' : 'Waiting for initiator'
      case 'completed':                 return 'Completed'
      case 'cancelled_by_initiator':    return isInitiator ? 'Cancelled by you'  : 'Cancelled by initiator'
      case 'cancelled_by_counterparty': return isInitiator ? 'Cancelled by counterparty' : 'Cancelled by you'
      case 'expired':                   return 'Not concluded'
      default:                          return status
    }
  }

  async function approveDeal () {
    if (!counterpartyTermsInput.trim()) return
    approving = true
    approveError = null
    try {
      const res = await fetch('/api/approve-deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deal.id, counterparty_terms: counterpartyTermsInput.trim() })
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to approve')
      }
      onBack()
    } catch (e) {
      approveError = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      approving = false
    }
  }

  async function confirmDeal () {
    confirming = true
    confirmError = null
    try {
      const res = await fetch('/api/confirm-deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deal.id })
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to confirm')
      }
      onBack()
    } catch (e) {
      confirmError = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      confirming = false
    }
  }

  async function closeDeal () {
    if (!selectedOutcome) return
    closing = true
    closeError = null
    try {
      const res = await fetch('/api/close-deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id:      deal.id,
          role:    isInitiator ? 'initiator' : 'counterparty',
          outcome: selectedOutcome,
        })
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to close deal')
      }
      onBack()
    } catch (e) {
      closeError = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      closing = false
    }
  }

  async function cancelDeal () {
    cancelling = true
    cancelError = null
    try {
      const res = await fetch('/api/cancel-deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: deal.id, role: isInitiator ? 'initiator' : 'counterparty' })
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Failed to cancel')
      }
      onBack()
    } catch (e) {
      cancelError = e instanceof Error ? e.message : 'Unknown error'
      confirmCancel = false
    } finally {
      cancelling = false
    }
  }
</script>

<div class="deal-view">
  <button class="back-btn" onclick={onBack}>← Back</button>

  <!-- Header -->
  <div class="view-header">
    <h2 class="view-title">{deal.title}</h2>
    <span class="deal-badge status-{deal.status.replace(/_/g, '-')}">
      {statusLabel(deal.status)}
    </span>
  </div>

  <div class="fields">

    <!-- Deal ID -->
    <div class="field">
      <div class="field-label">Deal ID</div>
      <div class="field-mono">{shortKey(deal.id)}</div>
    </div>

    <!-- Role + counterparty -->
    <div class="field">
      <div class="field-label">Your role</div>
      <div class="field-value">{isInitiator ? 'Initiator' : 'Counterparty'}</div>
    </div>

    <div class="field">
      <div class="field-label">Counterparty</div>
      <div class="field-mono">{shortKey(otherKey)}</div>
    </div>

    <!-- Amount -->
    <div class="field">
      <div class="field-label">Amount</div>
      <div class="field-value amount-primary">{formatAmount(deal)}</div>
      <div class="field-equivalents">{formatEquivalents(deal)}</div>
    </div>

    <!-- Level -->
    <div class="field">
      <div class="field-label">Deal Level</div>
      <div class="field-value">{LEVEL_LABEL[deal.level] ?? deal.level}</div>
    </div>

    <!-- Timer (only while negotiating) -->
    {#if isNegotiating}
      <div class="field">
        <div class="field-label">Expires in</div>
        <div class="field-value timer" class:urgent={isUrgent(deal.expires_at)}>
          {timeLeft(deal.expires_at)}
        </div>
      </div>
    {/if}

    <!-- Initiator terms -->
    <div class="field">
      <div class="field-label">Initiator terms</div>
      <div class="field-value field-multiline">{deal.initiator_terms}</div>
    </div>

    <!-- Counterparty terms -->
    <div class="field">
      <div class="field-label">Counterparty terms</div>
      {#if deal.counterparty_terms}
        <div class="field-value field-multiline">{deal.counterparty_terms}</div>
      {:else}
        <div class="field-placeholder">Waiting for counterparty terms</div>
      {/if}
    </div>

    <!-- Outcomes — shown on completed deals -->
    {#if deal.status === 'completed'}
      <div class="field">
        <div class="field-label">Your rating</div>
        <div class="field-value outcome-display outcome-{isInitiator ? (deal.initiator_outcome ?? 'none') : (deal.counterparty_outcome ?? 'none')}">
          {#if isInitiator}
            {deal.initiator_outcome ?? '—'}
          {:else}
            {deal.counterparty_outcome ?? '—'}
          {/if}
        </div>
      </div>
      <div class="field">
        <div class="field-label">Their rating of you</div>
        <div class="field-value outcome-display outcome-{isInitiator ? (deal.counterparty_outcome ?? 'none') : (deal.initiator_outcome ?? 'none')}">
          {#if isInitiator}
            {deal.counterparty_outcome ?? '—'}
          {:else}
            {deal.initiator_outcome ?? '—'}
          {/if}
        </div>
      </div>
    {/if}

  </div>

  <!-- Counterparty approve UI — shown when counterparty views a pending_counterparty incoming deal -->
  {#if !isInitiator && deal.status === 'pending_counterparty'}
    <div class="action-wrap">
      <div class="field">
        <div class="field-label">Your terms</div>
        <textarea
          class="terms-input"
          placeholder="Describe your conditions, deliverables, timeline..."
          bind:value={counterpartyTermsInput}
          rows="4"
        ></textarea>
      </div>

      {#if approveError}
        <div class="action-error">{approveError}</div>
      {/if}

      <div class="action-buttons">
        <button
          class="reject-btn"
          onclick={() => confirmCancel = true}
          disabled={approving}
        >
          Reject
        </button>
        <button
          class="approve-btn"
          onclick={approveDeal}
          disabled={approving || !counterpartyTermsInput.trim()}
        >
          {approving ? 'Sending...' : 'Approve'}
        </button>
      </div>

      {#if confirmCancel}
        <div class="cancel-confirm-stack">
          <button class="keep-deal-btn" onclick={() => confirmCancel = false}>Keep Deal</button>
          <button class="confirm-cancel-btn" onclick={cancelDeal} disabled={cancelling}>
            {cancelling ? 'Rejecting...' : 'Yes, Reject Deal'}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Initiator confirm UI — shown when initiator has pending_initiator status -->
  {#if isInitiator && deal.status === 'pending_initiator'}
    <div class="action-wrap">
      {#if confirmError}
        <div class="action-error">{confirmError}</div>
      {/if}
      <button class="confirm-deal-btn" onclick={confirmDeal} disabled={confirming}>
        {confirming ? 'Confirming...' : 'Confirm Deal'}
      </button>
      <button class="cancel-deal-btn" onclick={() => confirmCancel = true} disabled={confirming}>
        Cancel Deal
      </button>
      {#if confirmCancel}
        <div class="cancel-confirm-stack">
          <button class="keep-deal-btn" onclick={() => confirmCancel = false}>Keep Deal</button>
          <button class="confirm-cancel-btn" onclick={cancelDeal} disabled={cancelling}>
            {cancelling ? 'Cancelling...' : 'Yes, Cancel Deal'}
          </button>
        </div>
      {/if}
    </div>
  {/if}

  <!-- Close Deal — shown for in_progress and partially-closed deals -->
  {#if isInProgress || otherPartyClosed || weWaitingForOther}
    <div class="close-wrap">

      {#if weWaitingForOther}
        <!-- We closed, waiting for the other party -->
        <div class="close-waiting">
          <span class="close-waiting-icon">⏳</span>
          <span>Waiting for the other party to close their side</span>
        </div>

      {:else if !showClosePanel}
        <!-- Initial trigger button -->
        <button class="close-deal-btn" onclick={() => { showClosePanel = true }}>
          Close Deal
        </button>

      {:else}
        <!-- Outcome selector + confirm -->
        {#if otherPartyClosed}
          <div class="close-hint">
            The other party has declared their obligations fulfilled. Rate their performance and close your side.
          </div>
        {/if}

        <div class="field-label" style="margin-bottom: 6px;">How did they perform?</div>
        <div class="outcome-row">
          {#each OUTCOMES as opt}
            <button
              class="outcome-btn"
              class:active={selectedOutcome === opt.value}
              onclick={() => { selectedOutcome = opt.value }}
            >
              <span class="outcome-emoji">{opt.label}</span>
              <span class="outcome-desc">{opt.desc}</span>
            </button>
          {/each}
        </div>

        {#if closeError}
          <div class="action-error">{closeError}</div>
        {/if}

        <div class="close-actions">
          <button
            class="keep-deal-btn"
            onclick={() => { showClosePanel = false; selectedOutcome = null }}
            disabled={closing}
          >
            Back
          </button>
          <button
            class="confirm-close-btn"
            onclick={closeDeal}
            disabled={closing || !selectedOutcome}
          >
            {closing ? 'Closing...' : 'Confirm Close'}
          </button>
        </div>
      {/if}

    </div>
  {/if}

  <!-- Cancel — only for initiated deals (pending_counterparty and pending_initiator
       have cancel embedded in their own action blocks above) -->
  {#if deal.status === 'initiated'}
    <div class="cancel-wrap">
      {#if cancelError}
        <div class="cancel-error">{cancelError}</div>
      {/if}

      {#if !confirmCancel}
        <button class="cancel-deal-btn" onclick={() => confirmCancel = true}>
          Cancel Deal
        </button>
      {:else}
        <div class="cancel-confirm-stack">
          <button class="keep-deal-btn" onclick={() => confirmCancel = false}>
            Keep Deal
          </button>
          <button class="confirm-cancel-btn" onclick={cancelDeal} disabled={cancelling}>
            {cancelling ? 'Cancelling...' : 'Yes, Cancel Deal'}
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .deal-view {
    display: flex;
    flex-direction: column;
    text-align: left;
    background: rgba(255, 255, 255, 0.07);
    backdrop-filter: blur(28px) saturate(180%);
    -webkit-backdrop-filter: blur(28px) saturate(180%);
    border: 1px solid rgba(255, 255, 255, 0.13);
    border-radius: 20px;
    padding: 1.5rem;
    box-shadow:
      0 8px 32px rgba(0, 0, 0, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.2),
      inset 0 -1px 0 rgba(0, 0, 0, 0.15);
  }

  .back-btn {
    background: none;
    border: none;
    color: #64748b;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 0;
    transition: color 0.15s;
  }
  .back-btn:hover { color: #e2e8f0; }

  .view-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 8px 0 20px;
    gap: 12px;
  }

  .view-title {
    font-size: 18px;
    font-weight: 600;
    color: #f0f4f8;
    margin: 0;
    flex: 1;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Status badge — same classes as DealList */
  .deal-badge {
    flex-shrink: 0;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 5px 12px;
    border-radius: 20px;
    border-width: 1px;
    border-style: solid;
    /* border-color lives in App.css — set via .status-* global classes */
  }

  /* status-* classes live in App.css (global) — applied dynamically via string interpolation */

  .fields {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .field-label {
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #64748b;
  }

  .field-value {
    font-size: 14px;
    color: #94a3b8;
  }

  .field-mono {
    font-size: 13px;
    color: #94a3b8;
    font-family: monospace;
    letter-spacing: 0.02em;
  }

  .amount-primary {
    font-size: 16px;
    font-weight: 600;
    color: #f0f4f8;
  }

  .field-equivalents {
    font-size: 12px;
    color: #64748b;
    margin-top: 1px;
  }

  .field-multiline {
    line-height: 1.6;
    white-space: pre-wrap;
  }

  .field-placeholder {
    font-size: 13px;
    color: #64748b;
    font-style: italic;
  }

  .timer { font-size: 15px; font-weight: 600; color: #94a3b8; font-variant-numeric: tabular-nums; }
  .timer.urgent { color: #f59e0b; }

  /* Approve / confirm action blocks */
  .action-wrap {
    margin-top: 28px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .terms-input {
    width: 100%;
    box-sizing: border-box;
    background: #1e2128;
    border: 1px solid #374151;
    border-radius: 8px;
    color: #f0f4f8;
    font-family: inherit;
    font-size: 14px;
    padding: 10px 12px;
    outline: none;
    resize: vertical;
    line-height: 1.55;
    transition: border-color 0.15s;
  }
  .terms-input:focus { border-color: #64748b; }
  .terms-input::placeholder { color: #64748b; }

  .action-buttons {
    display: flex;
    gap: 8px;
  }

  /* Tier 1 glow — Approve / Confirm */
  .approve-btn, .confirm-deal-btn {
    flex: 1;
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
  }
  .approve-btn:hover, .confirm-deal-btn:hover {
    background: rgba(147, 210, 255, 0.18);
    border-color: rgba(147, 210, 255, 0.5);
    box-shadow: 0 0 22px rgba(100, 180, 255, 0.35);
  }
  .approve-btn:disabled, .confirm-deal-btn:disabled {
    opacity: 0.4; box-shadow: none; pointer-events: none;
  }

  /* Tier 3 ghost red — Reject */
  .reject-btn {
    flex: 0 0 auto;
    background: transparent;
    border: 1px solid rgba(248, 113, 113, 0.3);
    border-radius: 7px;
    color: #f87171;
    font-family: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 0.5rem 1.1rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .reject-btn:hover { border-color: rgba(248, 113, 113, 0.55); color: #fca5a5; }
  .reject-btn:disabled { opacity: 0.4; pointer-events: none; }

  .action-error {
    font-size: 12px;
    color: #f87171;
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.2);
    border-radius: 6px;
    padding: 8px 10px;
  }

  /* Cancel section */
  .cancel-wrap {
    margin-top: 28px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Tier 3 ghost — red: initial "Cancel Deal" trigger */
  .cancel-deal-btn {
    width: 100%;
    background: transparent;
    border: 1px solid rgba(248, 113, 113, 0.3);
    border-radius: 7px;
    color: #f87171;
    font-family: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 0.5rem 1.1rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .cancel-deal-btn:hover {
    border-color: rgba(248, 113, 113, 0.55);
    color: #fca5a5;
  }

  /* Confirmation stack: stacked vertically */
  .cancel-confirm-stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Tier 4 neutral — "Keep Deal" */
  .keep-deal-btn {
    width: 100%;
    background: transparent;
    border: 1px solid #374151;
    border-radius: 7px;
    color: #94a3b8;
    font-family: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 0.5rem 1.1rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .keep-deal-btn:hover { border-color: #64748b; color: #e2e8f0; }

  /* Glow red — "Yes, Cancel Deal" */
  .confirm-cancel-btn {
    width: 100%;
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.3);
    border-radius: 14px;
    color: #f87171;
    font-family: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    padding: 0.55rem 1rem;
    cursor: pointer;
    box-shadow: 0 0 14px rgba(248, 113, 113, 0.22);
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
  }
  .confirm-cancel-btn:hover {
    background: rgba(248, 113, 113, 0.18);
    border-color: rgba(248, 113, 113, 0.5);
    box-shadow: 0 0 22px rgba(248, 113, 113, 0.35);
  }
  .confirm-cancel-btn:disabled { opacity: 0.4; box-shadow: none; pointer-events: none; }

  .cancel-error {
    font-size: 12px;
    color: #f87171;
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.2);
    border-radius: 6px;
    padding: 8px 10px;
  }

  /* ─── Close Deal section ─────────────────────────────────── */

  .close-wrap {
    margin-top: 28px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  /* Tier 3 ghost teal — initial "Close Deal" trigger */
  .close-deal-btn {
    width: 100%;
    background: transparent;
    border: 1px solid rgba(52, 211, 153, 0.3);
    border-radius: 7px;
    color: #34d399;
    font-family: inherit;
    font-size: 0.875rem;
    font-weight: 600;
    padding: 0.5rem 1.1rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .close-deal-btn:hover {
    border-color: rgba(52, 211, 153, 0.55);
    color: #6ee7b7;
  }

  /* Hint text when other party has already closed */
  .close-hint {
    font-size: 12px;
    color: #94a3b8;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    padding: 10px 12px;
    line-height: 1.5;
  }

  /* Three outcome buttons side by side */
  .outcome-row {
    display: flex;
    gap: 8px;
  }

  .outcome-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 10px 6px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    color: #94a3b8;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }
  .outcome-btn:hover {
    background: rgba(255,255,255,0.07);
    border-color: rgba(255,255,255,0.2);
    color: #f0f4f8;
  }
  .outcome-btn.active {
    background: rgba(52, 211, 153, 0.1);
    border-color: rgba(52, 211, 153, 0.35);
    color: #34d399;
  }

  .outcome-emoji {
    font-size: 12px;
    font-weight: 600;
  }
  .outcome-desc {
    font-size: 10px;
    opacity: 0.7;
    text-align: center;
  }

  /* Bottom close action row: Back + Confirm Close */
  .close-actions {
    display: flex;
    gap: 8px;
    margin-top: 2px;
  }

  /* Tier 1 glow teal — "Confirm Close" */
  .confirm-close-btn {
    flex: 1;
    background: rgba(52, 211, 153, 0.1);
    border: 1px solid rgba(52, 211, 153, 0.3);
    border-radius: 14px;
    color: #34d399;
    font-family: inherit;
    font-size: 0.88rem;
    font-weight: 600;
    padding: 0.55rem 1rem;
    cursor: pointer;
    box-shadow: 0 0 14px rgba(52, 211, 153, 0.18);
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
  }
  .confirm-close-btn:hover {
    background: rgba(52, 211, 153, 0.18);
    border-color: rgba(52, 211, 153, 0.5);
    box-shadow: 0 0 22px rgba(52, 211, 153, 0.3);
  }
  .confirm-close-btn:disabled { opacity: 0.4; box-shadow: none; pointer-events: none; }

  /* Waiting state */
  .close-waiting {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #64748b;
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .close-waiting-icon { font-size: 14px; }

  /* Completed deal outcomes display */
  .outcome-display {
    font-size: 13px;
    font-weight: 600;
    text-transform: capitalize;
  }
  .outcome-positive { color: #34d399; }
  .outcome-neutral  { color: #94a3b8; }
  .outcome-negative { color: #f87171; }
  .outcome-none     { color: #64748b; }
</style>
