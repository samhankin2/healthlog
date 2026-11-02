<script lang="ts">
  import { toast } from '../toast.svelte'

  // The toast fades via a CSS transition (not a Svelte transition), so the
  // `prefers-reduced-motion` media query below is enough to disable it.
</script>

<div
  class="toast"
  class:toast--success={toast.tone === 'success'}
  class:toast--error={toast.tone === 'error'}
  role="status"
  aria-live="polite"
  hidden={!toast.visible}
>
  <span class="toast-message">{toast.message}</span>
</div>

<style>
  .toast {
    transition:
      opacity var(--duration-fast) var(--ease-standard),
      transform var(--duration-fast) var(--ease-standard);
  }

  @media (prefers-reduced-motion: reduce) {
    .toast {
      transition: none;
    }
  }
</style>
