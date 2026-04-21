<script lang="ts">
  type Contact = {
    contactKey: string
    publicKey:  string
    driveKey:   string
    name:       string
    addedAt:    number
  }

  let { contact, onViewContact } = $props<{
    contact:       Contact
    onViewContact: (contact: Contact) => void
  }>()

  let avatarError = $state(false)

  function onAvatarError () { avatarError = true }

  const shortKey = $derived('0x' + contact.publicKey.slice(0, 4) + '...' + contact.publicKey.slice(-4))
</script>

<div
  class="contact-row"
  role="button"
  tabindex="0"
  onclick={() => onViewContact(contact)}
  onkeydown={(e) => e.key === 'Enter' && onViewContact(contact)}
>
  <div class="contact-avatar">
    {#if !avatarError}
      <img
        src={`/api/get-peer-avatar?key=${contact.driveKey}`}
        alt="Avatar"
        class="contact-avatar-img"
        onerror={onAvatarError}
      />
    {:else}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <circle cx="12" cy="8" r="4"/>
        <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
      </svg>
    {/if}
  </div>

  <div class="contact-info">
    <div class="contact-name">{contact.name || 'Anonymous'}</div>
    <div class="contact-key">{shortKey}</div>
  </div>

  <svg class="contact-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M6 4l4 4-4 4"/>
  </svg>
</div>

<style>
  .contact-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.15s;
    user-select: none;
  }
  .contact-row:hover {
    background: rgba(255, 255, 255, 0.05);
  }

  .contact-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    overflow: hidden;
    flex-shrink: 0;
    background: #1e2128;
    border: 1px solid #374151;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #64748b;
  }
  .contact-avatar svg { width: 18px; height: 18px; }

  .contact-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .contact-info {
    flex: 1;
    min-width: 0;
    text-align: left;
  }

  .contact-name {
    font-size: 13px;
    font-weight: 600;
    color: #e2e8f0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .contact-key {
    font-family: monospace;
    font-size: 11px;
    color: #64748b;
    margin-top: 1px;
  }

  .contact-arrow {
    width: 14px;
    height: 14px;
    color: #475569;
    flex-shrink: 0;
  }
</style>
