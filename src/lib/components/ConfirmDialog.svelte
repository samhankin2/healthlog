<script lang="ts">
  import Sheet from './Sheet.svelte'

  interface Props {
    open: boolean
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
    onconfirm: () => void
    oncancel: () => void
  }

  let {
    open,
    title,
    message,
    confirmLabel = 'Confirm',
    danger = false,
    onconfirm,
    oncancel,
  }: Props = $props()
</script>

<Sheet {open} {title} onclose={oncancel}>
  <p class="confirm-message">{message}</p>
  {#snippet actions()}
    <button
      class="button button--secondary"
      type="button"
      data-autofocus={danger ? 'true' : undefined}
      onclick={oncancel}
    >
      Cancel
    </button>
    <button
      class="button {danger ? 'button--danger' : 'button--primary'}"
      type="button"
      data-autofocus={!danger ? 'true' : undefined}
      onclick={onconfirm}
    >
      {confirmLabel}
    </button>
  {/snippet}
</Sheet>
