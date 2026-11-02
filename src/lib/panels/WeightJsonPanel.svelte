<script lang="ts">
  import Sheet from '../components/Sheet.svelte'
  import Icon from '../components/Icon.svelte'

  interface ImportResult {
    imported: { entries: number; phases: number }
    skipped: { entries: number; phases: number }
  }
  interface Props {
    open: boolean
    onclose: () => void
    onimport: (json: unknown) => Promise<ImportResult>
  }
  let { open, onclose, onimport }: Props = $props()
  let text = $state('')
  let result = $state<ImportResult | null>(null)
  let busy = $state(false)
  let error = $state('')
  let fileInput: HTMLInputElement | undefined = $state()

  $effect(() => {
    if (open) {
      result = null
      busy = false
      error = ''
    }
  })

  async function readFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    try {
      const next = await file.text()
      if (new Blob([next]).size > 1024 * 1024) { error = 'This backup is larger than 1 MB.'; return }
      text = next
      result = null
      error = ''
    } catch {
      error = 'Could not read that file.'
    }
  }

  async function runImport(): Promise<void> {
    if (busy) return
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch {
      error = 'Paste a valid JSON backup or choose a JSON file.'
      return
    }
    if (new Blob([text]).size > 1024 * 1024) { error = 'This backup is larger than 1 MB.'; return }
    busy = true
    error = ''
    try { result = await onimport(parsed) } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not import that backup.'
    } finally {
      busy = false
    }
  }
</script>

<Sheet {open} title="Import weight tracker backup" subtitle="Existing weigh-ins on the same date are updated, not duplicated." onclose={() => { if (!busy) onclose() }}>
  {#if result}
    <div class="import-summary" role="status">
      <span class="summary-icon"><Icon name="check" size={26} /></span>
      <h3>Backup imported</h3>
      <p>{result.imported.entries} weigh-ins and {result.imported.phases} phases imported.</p>
      <p>{result.skipped.entries + result.skipped.phases} items skipped.</p>
    </div>
  {:else}
    <div class="import-flow">
      <div class="field">
        <label class="field-label" for="weight-json">Weight tracker JSON</label>
        <textarea class="field-input import-textarea" id="weight-json" rows="10" data-autofocus placeholder={'{ "entries": [...], "phases": [...] }'} bind:value={text} disabled={busy}></textarea>
      </div>
      <input class="sr-only" type="file" accept="application/json,.json" aria-label="Choose JSON file" bind:this={fileInput} onchange={readFile} />
      <button class="button button--secondary file-button" type="button" disabled={busy} onclick={() => fileInput?.click()}><Icon name="upload" size={18} /> Choose JSON file</button>
    </div>
  {/if}
  {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  {#snippet actions()}
    {#if result}
      <button class="button button--primary" type="button" onclick={onclose}>Done</button>
    {:else}
      <button class="button button--secondary" type="button" disabled={busy} onclick={onclose}>Cancel</button>
      <button class="button button--primary" type="button" disabled={busy} onclick={runImport}>{busy ? 'Importing…' : 'Import backup'}</button>
    {/if}
  {/snippet}
</Sheet>

<style>
  .import-flow { display: flex; flex-direction: column; gap: var(--space-4); }
  .import-textarea { width: 100%; resize: vertical; font-family: ui-monospace, monospace; font-size: var(--text-sm); }
  .file-button { align-self: flex-start; }
  .import-summary { padding: var(--space-6) 0; text-align: center; }
  .summary-icon { display: grid; width: 3.5rem; height: 3.5rem; margin: 0 auto var(--space-4); place-items: center; border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent); }
  .import-summary h3 { margin-bottom: var(--space-2); }
  .import-summary p { margin: 0 0 var(--space-2); color: var(--color-text-muted); }
</style>
