<script lang="ts">
  let { visible = false, message = 'Loading...' } = $props<{
    visible?:  boolean
    message?:  string
  }>()
</script>

{#if visible}
  <div class="overlay" role="status" aria-live="polite">
    <div class="spinner">
      {#each Array(12) as _, i}
        <div class="spoke" style="--i: {i}"></div>
      {/each}
    </div>
    {#if message}
      <div class="message">{message}</div>
    {/if}
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 5000;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(2px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 20px;
  }

  /* --- Spinner --- */
  .spinner {
    position: relative;
    width: 44px;
    height: 44px;
  }

  .spoke {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 3px;
    height: 11px;
    border-radius: 2px;
    background: #e2e8f0;
    /* Rotate each spoke to its clock position, then shift up so it sits on the rim */
    transform-origin: center bottom;
    transform: rotate(calc(var(--i) * 30deg)) translateX(-50%) translateY(-100%);
    /* Staggered fade — each spoke starts its cycle offset by 1/12 of the period */
    animation: spoke-fade 1s linear calc(var(--i) * -0.0833s) infinite;
    opacity: 0.15;
  }

  @keyframes spoke-fade {
    0%   { opacity: 1;    }
    8%   { opacity: 0.15; }
    100% { opacity: 0.15; }
  }

  /* --- Label --- */
  .message {
    font-family: inherit;
    font-size: 13px;
    color: rgba(226, 232, 240, 0.65);
    letter-spacing: 0.04em;
  }
</style>
