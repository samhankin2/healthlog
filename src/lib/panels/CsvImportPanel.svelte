<script lang="ts">
  import Sheet from '../components/Sheet.svelte'
  import Icon from '../components/Icon.svelte'
  import { api } from '../api'
  import type { FoodCsvMapping, FoodCsvPreview } from '../types'

  const FIELDS = [
    { key: 'name', label: 'Food name', required: true },
    { key: 'kcal', label: 'Calories', required: true },
    { key: 'protein', label: 'Protein (g)', required: false },
    { key: 'carbs', label: 'Carbs (g)', required: false },
    { key: 'fat', label: 'Fat (g)', required: false },
    { key: 'serving', label: 'Serving', required: false },
    { key: 'date', label: 'Date', required: false },
  ] as const

  type Preview = FoodCsvPreview & { totalRows?: number; truncated?: boolean }

  interface Props {
    open: boolean
    onclose: () => void
    oncommitted: () => void | Promise<void>
  }
  let { open, onclose, oncommitted }: Props = $props()
  let csv = $state('')
  let filename = $state('')
  let preview = $state<Preview | null>(null)
  let mapping = $state<FoodCsvMapping>({ name: '', kcal: '', protein: '', carbs: '', fat: '', serving: '', date: '' })
  let summary = $state<{ imported: number; skipped: number } | null>(null)
  let busy = $state(false)
  let error = $state('')
  let fileInput: HTMLInputElement | undefined = $state()

  $effect(() => {
    if (open) {
      preview = null
      summary = null
      busy = false
      error = ''
    }
  })

  function validateSize(text: string): boolean {
    if (new Blob([text]).size <= 1024 * 1024) return true
    error = 'This import is larger than 1 MB. Split it into smaller files.'
    return false
  }

  async function readFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    error = ''
    try {
      const text = await file.text()
      if (!validateSize(text)) return
      csv = text
      filename = file.name
      preview = null
      summary = null
    } catch {
      error = 'Could not read that file.'
    }
  }

  async function loadPreview(): Promise<void> {
    if (busy) return
    if (!csv.trim()) { error = 'Paste CSV text or choose a file first.'; return }
    if (!validateSize(csv)) return
    busy = true
    error = ''
    try {
      const response = await api.previewFoodCsv(csv)
      preview = response
      mapping = {
        name: response.suggestedMapping.name ?? '',
        kcal: response.suggestedMapping.kcal ?? '',
        protein: response.suggestedMapping.protein ?? '',
        carbs: response.suggestedMapping.carbs ?? '',
        fat: response.suggestedMapping.fat ?? '',
        serving: response.suggestedMapping.serving ?? '',
        date: response.suggestedMapping.date ?? '',
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not preview that CSV.'
    } finally {
      busy = false
    }
  }

  async function commit(): Promise<void> {
    if (busy) return
    if (!mapping.name || !mapping.kcal) { error = 'Choose columns for both food name and calories.'; return }
    busy = true
    error = ''
    try {
      const result = await api.commitFoodCsv(csv, mapping)
      summary = { imported: result.imported, skipped: result.skipped }
      preview = null
      await oncommitted()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not import that CSV.'
    } finally {
      busy = false
    }
  }

  function cell(value: unknown): string {
    return value === null || value === undefined || value === '' ? '—' : String(value)
  }
</script>

<Sheet
  {open}
  title="Import food CSV"
  subtitle={summary ? 'Your import is complete.' : preview ? 'Match each nutrition field to a CSV column.' : 'Check the detected columns before creating any meals.'}
  onclose={() => { if (!busy) onclose() }}
>
  {#if summary}
    <div class="import-summary" role="status">
      <span class="summary-icon"><Icon name="check" size={26} /></span>
      <h3>{summary.imported} meal{summary.imported === 1 ? '' : 's'} imported</h3>
      <p>{summary.skipped} row{summary.skipped === 1 ? '' : 's'} skipped. Your History and Dashboard are up to date.</p>
    </div>
  {:else if preview}
    <div class="import-flow">
      <p class="preview-count"><strong>{preview.rows.length} valid rows previewed</strong> · {preview.skipped.length} skipped</p>
      {#if preview.totalRows !== undefined}<p class="field-hint">{preview.totalRows} data rows in this file.</p>{/if}
      <div class="mapping-grid">
        {#each FIELDS as field (field.key)}
          <div class="field">
            <label class="field-label" for={`csv-map-${field.key}`}>{field.label}</label>
            <select class="field-input field-select" id={`csv-map-${field.key}`} bind:value={mapping[field.key]} disabled={busy}>
              <option value="">{field.required ? 'Choose a column' : 'Not mapped'}</option>
              {#each preview.headers as header (header)}<option value={header}>{header}</option>{/each}
            </select>
          </div>
        {/each}
      </div>
      <p class="field-hint">The preview uses the detected columns. Your choices are applied when you import.</p>
      {#if preview.truncated}<p class="field-hint">Only the first 1,000 valid rows are shown. All valid rows will be imported.</p>{/if}
      <div class="preview-table-wrap" role="region" aria-label="CSV row preview, scrollable horizontally">
        <table class="preview-table">
          <thead><tr>{#each ['Line', 'Name', 'kcal', 'Protein', 'Carbs', 'Fat', 'Date'] as label (label)}<th scope="col">{label}</th>{/each}</tr></thead>
          <tbody>
            {#each preview.rows.slice(0, 12) as row (row.line)}
              <tr><td>{row.line}</td><td>{cell(row.parsed.name)}</td><td>{cell(row.parsed.kcal)}</td><td>{cell(row.parsed.proteinG)}</td><td>{cell(row.parsed.carbsG)}</td><td>{cell(row.parsed.fatG)}</td><td>{cell(row.parsed.date)}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if preview.skipped.length > 0}
        <details>
          <summary>Skipped rows ({preview.skipped.length})</summary>
          <ul class="skipped-list">{#each preview.skipped.slice(0, 30) as row (row.line)}<li>Line {row.line}: {row.reason}</li>{/each}</ul>
        </details>
      {/if}
    </div>
  {:else}
    <div class="import-flow">
      <p class="import-help">Include a header row. Quoted fields, commas, and Windows line endings are supported. Files up to 1 MB.</p>
      <div class="field">
        <label class="field-label" for="food-csv">CSV text</label>
        <textarea class="field-input import-textarea" id="food-csv" rows="9" data-autofocus placeholder={'name,calories,protein,carbs,fat,serving,date\nChicken salad,420,35,18,22,1 bowl,2026-10-31'} bind:value={csv} disabled={busy}></textarea>
      </div>
      <input class="sr-only" type="file" accept="text/csv,.csv" aria-label="Choose CSV file" bind:this={fileInput} onchange={readFile} />
      <button class="button button--secondary file-button" type="button" disabled={busy} onclick={() => fileInput?.click()}><Icon name="upload" size={18} /> Choose CSV file</button>
      {#if filename}<p class="field-hint">Loaded {filename}</p>{/if}
    </div>
  {/if}
  {#if error}<p class="field-error" role="alert">{error}</p>{/if}

  {#snippet actions()}
    {#if summary}
      <button class="button button--primary" type="button" onclick={onclose}>Done</button>
    {:else if preview}
      <button class="button button--secondary" type="button" disabled={busy} onclick={() => { preview = null; error = '' }}>Back</button>
      <button class="button button--primary" type="button" disabled={busy} onclick={commit}>{busy ? 'Importing…' : 'Import meals'}</button>
    {:else}
      <button class="button button--secondary" type="button" disabled={busy} onclick={onclose}>Cancel</button>
      <button class="button button--primary" type="button" disabled={busy} onclick={loadPreview}>{busy ? 'Reading…' : 'Preview import'}</button>
    {/if}
  {/snippet}
</Sheet>

<style>
  .import-flow { display: flex; flex-direction: column; gap: var(--space-4); }
  .import-help, .preview-count { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .import-textarea { width: 100%; resize: vertical; font-family: ui-monospace, monospace; font-size: var(--text-sm); }
  .file-button { align-self: flex-start; }
  .mapping-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .preview-table-wrap { max-width: 100%; overflow-x: auto; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
  .preview-table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .preview-table th, .preview-table td { max-width: 12rem; padding: var(--space-2); overflow-wrap: anywhere; border-bottom: 1px solid var(--color-border); text-align: left; white-space: nowrap; }
  details summary { min-height: var(--touch-target); padding: var(--space-3) 0; cursor: pointer; }
  .skipped-list { margin: 0; padding-left: var(--space-5); color: var(--color-text-muted); font-size: var(--text-sm); }
  .import-summary { padding: var(--space-6) 0; text-align: center; }
  .summary-icon { display: grid; width: 3.5rem; height: 3.5rem; margin: 0 auto var(--space-4); place-items: center; border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent); }
  .import-summary h3 { margin-bottom: var(--space-2); }
  .import-summary p { margin: 0; color: var(--color-text-muted); }
  @media (max-width: 22.5rem) { .mapping-grid { grid-template-columns: 1fr; } }
</style>
