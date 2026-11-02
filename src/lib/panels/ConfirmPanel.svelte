<script lang="ts">
  import Sheet from '../components/Sheet.svelte'

  interface Props {
    open: boolean
    title: string
    message: string
    confirmLabel?: string
    danger?: boolean
    onconfirm: () => void | Promise<void>
    oncancel: () => void
  }
  let { open, title, message, confirmLabel = 'Confirm', danger = false, onconfirm, oncancel }: Props = $props()
  let busy = $state(false)
  let error = $state('')

  async function confirm(): Promise<void> {
    if (busy) return
    busy = true
    error = ''
    try { await onconfirm() } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not complete that action.'
      busy = false
    }
  }
</script>

<Sheet {open} {title} onclose={() => { if (!busy) oncancel() }}>
  <p class="confirm-message">{message}</p>
  {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  {#snippet actions()}
    <button class="button button--secondary" type="button" data-autofocus={danger} disabled={busy} onclick={oncancel}>Cancel</button>
    <button class:button--danger={danger} class:button--primary={!danger} class="button" type="button" data-autofocus={!danger} disabled={busy} onclick={confirm}>
      {busy ? 'Working…' : confirmLabel}
    </button>
  {/snippet}
</Sheet>
