<script lang="ts">
  import Sheet from '../components/Sheet.svelte'
  import BigNumberInput from './BigNumberInput.svelte'
  import Icon from '../components/Icon.svelte'
  import { fmtWithDay, today } from '../format'
  import { showToast } from '../toast.svelte'
  import type { WeightEntry } from '../types'

  export const MIN_PLAUSIBLE_KG = 20
  export const MAX_PLAUSIBLE_KG = 400

  /** Recover an obvious missing decimal point such as 745 → 74.5. */
  export function normalizeWeightInput(raw: number): number | null {
    if (!Number.isFinite(raw)) return null
    if (raw >= MIN_PLAUSIBLE_KG && raw <= MAX_PLAUSIBLE_KG) return raw
    for (const shift of [1, 2]) {
      const scaled = raw / 10 ** shift
      if (scaled >= MIN_PLAUSIBLE_KG && scaled <= MAX_PLAUSIBLE_KG) return Math.round(scaled * 10) / 10
    }
    return null
  }

  interface Props {
    open: boolean
    initialDate?: string
    existing?: WeightEntry | null
    prefillKg?: number
    onclose: () => void
    onsave: (date: string, weightKg: number, note: string) => Promise<void>
    ondelete?: () => Promise<void>
  }

  let {
    open,
    initialDate = today(),
    existing = null,
    prefillKg = 0,
    onclose,
    onsave,
    ondelete,
  }: Props = $props()

  let date = $state(today())
  let weightKg = $state(0)
  let note = $state('')
  let saving = $state(false)
  let error = $state('')

  $effect(() => {
    if (open) {
      date = initialDate
      weightKg = existing?.weightKg ?? prefillKg
      note = existing?.note ?? ''
      saving = false
      error = ''
    }
  })

  async function save(): Promise<void> {
    if (saving) return
    const normalized = normalizeWeightInput(weightKg)
    if (normalized === null) {
      error = `Enter a weight between ${MIN_PLAUSIBLE_KG} and ${MAX_PLAUSIBLE_KG} kg.`
      return
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today()) {
      error = 'Choose a valid date, today or earlier.'
      return
    }
    if (normalized !== weightKg) showToast(`Read that as ${normalized.toFixed(1)} kg.`)
    saving = true
    error = ''
    try {
      await onsave(date, Math.round(normalized * 10) / 10, note.trim())
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this weigh-in.'
      saving = false
    }
  }

  async function remove(): Promise<void> {
    if (!ondelete || saving) return
    saving = true
    error = ''
    try {
      await ondelete()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not delete this weigh-in.'
      saving = false
    }
  }
</script>

<Sheet
  {open}
  title={existing ? 'Edit weigh-in' : 'Log weight'}
  subtitle={existing ? fmtWithDay(date) : 'A small daily note, not a judgement.'}
  onclose={() => { if (!saving) onclose() }}
>
  <div class="log-sheet">
    <BigNumberInput value={weightKg} onchange={(value) => { weightKg = value; error = '' }} onsubmit={save} />

    <div class="log-date-row">
      <div class="log-date-info">
        <span class="field-label">Date</span>
        <span class="field-label-text">{fmtWithDay(date)}</span>
      </div>
      <input
        class="field-input"
        type="date"
        aria-label="Date of weigh-in"
        max={today()}
        bind:value={date}
        disabled={saving}
      />
    </div>

    <div class="field">
      <label class="field-label" for="weight-note">Note</label>
      <input
        class="field-input"
        id="weight-note"
        type="text"
        placeholder="Optional note (e.g. after gym)"
        maxlength="120"
        bind:value={note}
        disabled={saving}
      />
    </div>

    {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  </div>

  {#snippet actions()}
    {#if existing && ondelete}
      <button class="button button--danger" type="button" disabled={saving} onclick={remove}>
        <Icon name="trash" size={19} /> Delete
      </button>
    {/if}
    <button class="button button--primary" type="button" disabled={saving} onclick={save}>
      {#if saving}
        <span class="spinner-wrap" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Saving weigh-in</span></span>
        Saving…
      {:else}
        <Icon name="check" size={19} /> Save weigh-in
      {/if}
    </button>
  {/snippet}
</Sheet>

<style>
  .log-sheet { display: flex; flex-direction: column; gap: var(--space-4); }
  .log-date-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(9rem, 1fr);
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-sunken);
  }
  .log-date-info { display: flex; min-width: 0; flex-direction: column; }
  @media (max-width: 22.5rem) {
    .log-date-row { grid-template-columns: 1fr; }
  }
</style>
