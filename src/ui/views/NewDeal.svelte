<script lang="ts">
  import { untrack } from 'svelte'

  type DealLevel = 'handshake' | 'review' | 'escrow'

  let {
    counterpartyKey = '',
    onBack
  } = $props<{
    counterpartyKey?: string
    onBack: () => void
  }>()

  // untrack: we intentionally capture only the initial prop value.
  // The component is recreated on every navigation, so this is correct.
  const initialKey = untrack(() => counterpartyKey)

  // Form fields
  let title      = $state('')
  let cpKey      = $state(initialKey)
  let terms      = $state('')
  let amount     = $state('')
  let currency   = $state('USD')
  let level      = $state<DealLevel>('handshake')

  // Submission state
  let loading    = $state(false)
  let error      = $state<string | null>(null)

  const isKeyReadonly = initialKey.length > 0

  const CURRENCIES = ['USD', 'RUB', 'EUR', 'BTC', 'USDT']

  const LEVELS: { value: DealLevel; label: string; desc: string; disabled?: boolean }[] = [
    { value: 'handshake', label: 'Handshake', desc: '0.4×' },
    { value: 'review',    label: 'Review',    desc: '0.7×' },
    { value: 'escrow',    label: 'Escrow',    desc: '1.0× — coming soon', disabled: true }
  ]

  // Accepts either a raw hex public key or a contact JSON { publicKey, driveKey }
  function parseCounterpartyKey (input: string): string | null {
    const trimmed = input.trim()
    try {
      const parsed = JSON.parse(trimmed)
      return parsed.publicKey ?? null
    } catch {
      // Not JSON — treat as raw hex key
      return trimmed.length > 0 ? trimmed : null
    }
  }

  function validate (): string | null {
    if (!title.trim())                return 'Deal title is required'
    if (!parseCounterpartyKey(cpKey)) return 'Counterparty key is required'
    if (!terms.trim())                return 'Your terms are required'
    const amt = parseFloat(amount)
    if (!amount || isNaN(amt) || amt <= 0) return 'Enter a valid amount'
    return null
  }

  async function createDeal () {
    error = null
    const validationError = validate()
    if (validationError) { error = validationError; return }

    loading = true
    try {
      const ratesRes = await fetch(`/api/get-rates?amount=${encodeURIComponent(amount)}&currency=${currency}`)
      if (!ratesRes.ok) throw new Error('Failed to fetch exchange rates')
      const rates = await ratesRes.json()

      const now = Math.floor(Date.now() / 1000)
      const deal = {
        title:             title.trim(),
        initiator_terms:   terms.trim(),
        counterparty_key:  parseCounterpartyKey(cpKey)!,
        original_amount:   parseFloat(amount),
        original_currency: currency.toLowerCase(),
        amount_usd:        rates.amount_usd,
        amount_rub:        rates.amount_rub,
        amount_eur:        rates.amount_eur,
        amount_btc:        rates.amount_btc,
        amount_usdt:       rates.amount_usdt,
        level,
        status:            'initiated',
        timestamp:         now,
        expires_at:        now + 86400
      }

      // Transport not yet implemented — log for now
      console.log('[NewDeal] deal object ready:', deal)

      // TODO: POST to /api/create-deal in next step
      alert('Deal object created — check console. Transport coming next.')

    } catch (e) {
      error = e instanceof Error ? e.message : 'Unknown error'
    } finally {
      loading = false
    }
  }
</script>

<div class="new-deal-screen">
  <button class="back-btn" onclick={onBack}>← Back</button>
  <div class="screen-header">
    <h2 class="screen-title">New Deal</h2>
    <div class="status-badge">Initializing...</div>
  </div>

  <div class="form">

    <!-- Deal title -->
    <div class="field">
      <label class="field-label" for="deal-title">Deal Title</label>
      <input
        id="deal-title"
        type="text"
        class="field-input"
        placeholder="e.g. BMW wheels, Website design"
        bind:value={title}
      />
    </div>

    <!-- Counterparty key -->
    <div class="field">
      <label class="field-label" for="cp-key">Counterparty Key</label>
      {#if isKeyReadonly}
        <div class="field-readonly">{cpKey}</div>
      {:else}
        <input
          id="cp-key"
          type="text"
          class="field-input"
          placeholder="Paste counterparty public key"
          bind:value={cpKey}
        />
      {/if}
    </div>

    <!-- Initiator terms -->
    <div class="field">
      <label class="field-label" for="terms">Your Terms</label>
      <textarea
        id="terms"
        class="field-input field-textarea"
        placeholder="Describe what you commit to do in this deal"
        rows="3"
        bind:value={terms}
      ></textarea>
    </div>

    <!-- Counterparty terms — read-only placeholder -->
    <div class="field">
      <div class="field-label">Counterparty Terms</div>
      <div class="field-readonly field-readonly-muted">
        Counterparty will specify their terms when they respond
      </div>
    </div>

    <!-- Amount + currency -->
    <div class="field">
      <label class="field-label" for="amount">Amount</label>
      <div class="amount-row">
        <input
          id="amount"
          type="number"
          class="field-input amount-input"
          placeholder="0.00"
          min="0"
          step="any"
          bind:value={amount}
        />
        <select class="field-input currency-select" bind:value={currency}>
          {#each CURRENCIES as c}
            <option value={c}>{c}</option>
          {/each}
        </select>
      </div>
    </div>

    <!-- Deal level -->
    <div class="field">
      <div class="field-label">Deal Level</div>
      <div class="level-row">
        {#each LEVELS as l}
          <button
            class="level-btn"
            class:active={level === l.value}
            disabled={l.disabled}
            onclick={() => !l.disabled && (level = l.value)}
          >
            <span class="level-name">{l.label}</span>
            <span class="level-desc">{l.desc}</span>
          </button>
        {/each}
      </div>
    </div>

    {#if error}
      <div class="form-error">{error}</div>
    {/if}

    <button class="submit-btn" onclick={createDeal} disabled={loading}>
      {loading ? 'Creating...' : 'Create Deal'}
    </button>

  </div>
</div>

<style>
  .new-deal-screen {
    padding: 16px;
    text-align: left;
  }

  .screen-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin: 8px 0 20px;
  }

  .screen-title {
    font-size: 18px;
    font-weight: 600;
    margin: 0;
    color: #e2e8f0;
    text-align: left;
  }

  .status-badge {
    background: rgba(147,210,255,0.12);
    border: 1px solid rgba(147,210,255,0.3);
    border-radius: 20px;
    color: #93d2ff;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    padding: 5px 12px;
  }

  .form {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
  }

  .field-label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #7a8599;
  }

  .field-input {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    color: #e2e8f0;
    font-family: inherit;
    font-size: 14px;
    padding: 10px 12px;
    outline: none;
    transition: border-color 0.15s;
    width: 100%;
    box-sizing: border-box;
  }

  .field-input:focus {
    border-color: rgba(147,210,255,0.4);
  }

  .field-textarea {
    resize: vertical;
    min-height: 72px;
  }

  .field-readonly {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 8px;
    color: #e2e8f0;
    font-size: 13px;
    padding: 10px 12px;
    word-break: break-all;
    text-align: left;
  }

  .field-readonly-muted {
    color: #4a5568;
    font-style: italic;
  }

  .amount-row {
    display: flex;
    gap: 8px;
  }

  .amount-input {
    flex: 1;
  }

  .currency-select {
    width: 90px;
    flex-shrink: 0;
    cursor: pointer;
  }

  /* Deal level buttons */
  .level-row {
    display: flex;
    gap: 8px;
  }

  .level-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 10px 8px;
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 8px;
    color: #94a3b8;
    font-family: inherit;
    cursor: pointer;
    transition: all 0.15s;
  }

  .level-btn:hover:not(:disabled) {
    background: rgba(147,210,255,0.07);
    border-color: rgba(147,210,255,0.25);
    color: #e2e8f0;
  }

  .level-btn.active {
    background: rgba(147, 210, 255, 0.12);
    border-color: rgba(147, 210, 255, 0.28);
    color: #93d2ff;
  }

  .level-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }

  .level-name {
    font-size: 13px;
    font-weight: 600;
  }

  .level-desc {
    font-size: 10px;
    opacity: 0.7;
  }

  .form-error {
    background: rgba(255, 80, 80, 0.1);
    border: 1px solid rgba(255, 80, 80, 0.25);
    border-radius: 8px;
    color: #fc8181;
    font-size: 13px;
    padding: 10px 12px;
    text-align: left;
  }

  .submit-btn {
    background: rgba(147, 210, 255, 0.1);
    border: 1px solid rgba(147, 210, 255, 0.3);
    border-radius: 14px;
    color: #93d2ff;
    font-family: inherit;
    font-size: 14px;
    font-weight: 600;
    padding: 12px;
    cursor: pointer;
    box-shadow: 0 0 14px rgba(100, 180, 255, 0.22);
    transition: background 0.15s, border-color 0.15s, box-shadow 0.15s;
    margin-top: 4px;
  }

  .submit-btn:hover:not(:disabled) {
    background: rgba(147, 210, 255, 0.18);
    border-color: rgba(147, 210, 255, 0.5);
    box-shadow: 0 0 22px rgba(100, 180, 255, 0.35);
  }

  .submit-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: none;
  }

  .back-btn {
    background: none;
    border: none;
    color: #7a8599;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
    padding: 0;
    text-align: left;
    transition: color 0.15s;
  }

  .back-btn:hover {
    color: #e2e8f0;
  }
</style>
