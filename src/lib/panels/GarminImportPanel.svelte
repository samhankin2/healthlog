<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import { api } from '../api'
  import { listZip, readZipText } from '../zip'
  import { EXPORT_FILE_PATTERN, parseGarminExport, summariseImport, type GarminImportPayload } from '../garminExport'
  import { showToast } from '../toast.svelte'
  import type { GarminImportResult } from '../types'

  interface Props {
    /** Big call-to-action layout (no data yet) vs a compact row. */
    hero?: boolean
    onimported: (result: GarminImportResult) => void
  }
  let { hero = false, onimported }: Props = $props()

  type Stage = 'idle' | 'reading' | 'ready' | 'uploading' | 'done' | 'error'
  let stage = $state<Stage>('idle')
  let progress = $state('')
  let error = $state('')
  let payload = $state<GarminImportPayload | null>(null)
  let fileName = $state('')
  let dragging = $state(false)
  let input = $state<HTMLInputElement | null>(null)

  const summary = $derived(payload ? summariseImport(payload) : null)

  async function readFile(file: File): Promise<void> {
    stage = 'reading'
    error = ''
    fileName = file.name
    try {
      progress = 'Opening the archive…'
      const entries = (await listZip(file)).filter((e) => EXPORT_FILE_PATTERN.test(e.name))
      if (!entries.length) throw new Error('No Garmin data found in this ZIP. Use the export from Garmin Connect → Account → Export your data.')
      const files: Record<string, unknown> = {}
      let i = 0
      for (const entry of entries) {
        i++
        progress = `Reading ${i} of ${entries.length} files…`
        try {
          files[entry.name] = JSON.parse(await readZipText(file, entry))
        } catch {
          /* one unreadable file should not sink the import */
        }
      }
      progress = 'Analysing…'
      const parsed = parseGarminExport(files)
      if (!parsed.days.length && !parsed.sleep.length && !parsed.activities.length) throw new Error('The export did not contain any daily, sleep or activity data.')
      payload = parsed
      stage = 'ready'
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not read that file.'
      stage = 'error'
    }
  }

  async function upload(): Promise<void> {
    if (!payload) return
    stage = 'uploading'
    try {
      const { imported } = await api.importGarminExport(payload)
      stage = 'done'
      showToast(`Imported ${imported.days} days, ${imported.sleep} nights and ${imported.activities} activities.`, 'success')
      payload = null
      onimported(imported)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The upload failed.'
      stage = 'error'
    }
  }

  function pick(event: Event): void {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]
    if (file) void readFile(file)
    ;(event.currentTarget as HTMLInputElement).value = ''
  }
  function drop(event: DragEvent): void {
    event.preventDefault()
    dragging = false
    const file = event.dataTransfer?.files?.[0]
    if (file) void readFile(file)
  }
  function reset(): void {
    stage = 'idle'
    payload = null
    error = ''
  }
  const fmtRange = (r: GarminImportPayload['range']): string => {
    if (!r) return ''
    const f = (d: string): string => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
    return `${f(r.from)} – ${f(r.to)}`
  }
</script>

<div class="import" class:hero class:dragging role="group" aria-label="Import a Garmin data export"
  ondragover={(e) => { e.preventDefault(); dragging = true }}
  ondragleave={() => (dragging = false)}
  ondrop={drop}
>
  <input bind:this={input} class="sr-only" type="file" accept=".zip,application/zip" aria-label="Garmin export ZIP file" onchange={pick} />

  {#if stage === 'idle' || stage === 'done'}
    <div class="copy">
      <span class="badge-icon"><Icon name="upload" size={hero ? 26 : 20} /></span>
      <div>
        <h3>{hero ? 'Bring in your Garmin history' : 'Import a Garmin export'}</h3>
        <p>
          {hero ? 'Drop the ZIP from Garmin Connect → Account → Export your data. It is unpacked here in your browser; only the daily numbers are uploaded — no GPS tracks, no profile.' : 'Add or refresh history from a Garmin Connect data export. Safe to repeat: rows are updated, never duplicated.'}
        </p>
      </div>
    </div>
    <button class="button button--{hero ? 'primary' : 'secondary'}" type="button" onclick={() => input?.click()}>
      <Icon name="upload" size={18} /> Choose ZIP
    </button>
  {:else if stage === 'reading' || stage === 'uploading'}
    <div class="copy" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <div>
        <h3>{stage === 'reading' ? fileName : 'Uploading…'}</h3>
        <p>{stage === 'reading' ? progress : 'Saving your history. This takes a few seconds.'}</p>
      </div>
    </div>
  {:else if stage === 'ready' && summary && payload}
    <div class="ready">
      <h3>Ready to import <span>{fmtRange(payload.range)}</span></h3>
      <dl class="counts">
        <div><dt>Days</dt><dd>{summary.days.toLocaleString()}</dd></div>
        <div><dt>Nights</dt><dd>{summary.nights.toLocaleString()}</dd></div>
        <div><dt>Activities</dt><dd>{summary.activities.toLocaleString()}</dd></div>
        <div><dt>Records</dt><dd>{summary.records}</dd></div>
      </dl>
      <div class="actions">
        <button class="button button--primary" type="button" onclick={upload}><Icon name="check" size={18} /> Import</button>
        <button class="button button--secondary" type="button" onclick={reset}>Cancel</button>
      </div>
    </div>
  {:else if stage === 'error'}
    <div class="copy" role="alert">
      <span class="badge-icon danger"><Icon name="alert" size={20} /></span>
      <div><h3>That didn’t work</h3><p>{error}</p></div>
    </div>
    <button class="button button--secondary" type="button" onclick={reset}>Try again</button>
  {/if}
</div>

<style>
  .import { display: flex; padding: var(--space-4) var(--space-5); align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-card); background: var(--color-surface); transition: border-color var(--duration-fast), background var(--duration-fast); }
  .import.hero { padding: var(--space-8) var(--space-6); flex-direction: column; align-items: flex-start; background: linear-gradient(135deg, var(--color-accent-soft), var(--color-surface) 70%); }
  .import.dragging { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .copy { display: flex; min-width: 0; align-items: flex-start; gap: var(--space-3); flex: 1 1 18rem; }
  .copy h3, .ready h3 { margin: 0 0 2px; font-size: var(--text-md); }
  .hero .copy h3 { font-size: var(--text-xl); letter-spacing: -0.02em; }
  .copy p { max-width: 38rem; margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .badge-icon { display: grid; width: 2.5rem; height: 2.5rem; flex: 0 0 auto; place-items: center; border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-accent); }
  .hero .badge-icon { width: 3rem; height: 3rem; }
  .hero .copy { flex: none; }
  .badge-icon.danger { background: var(--color-danger-soft); color: var(--color-danger); }
  .ready { display: flex; width: 100%; flex-direction: column; gap: var(--space-3); }
  .ready h3 span { margin-left: var(--space-2); color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .counts { display: grid; margin: 0; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2); }
  .counts div { padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--color-surface-sunken); }
  .counts dt { color: var(--color-text-muted); font-size: var(--text-xs); }
  .counts dd { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold); }
  .actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  @media (max-width: 30rem) { .counts { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
