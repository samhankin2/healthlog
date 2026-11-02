<script lang="ts">
  import Sheet from '../components/Sheet.svelte'
  import { fmtRange, today } from '../format'
  import type { Phase, PhaseInput } from '../types'

  const COLORS = [
    { value: '#2f6f5e', name: 'Forest green' },
    { value: '#6b5b95', name: 'Purple' },
    { value: '#9a6b2f', name: 'Ochre' },
    { value: '#456c86', name: 'Blue' },
    { value: '#87516e', name: 'Plum' },
    { value: '#64745b', name: 'Olive' },
  ] as const

  interface Props {
    open: boolean
    phase?: Phase | null
    colorIndex?: number
    onclose: () => void
    onsave: (input: PhaseInput) => Promise<void>
  }
  let { open, phase = null, colorIndex = 0, onclose, onsave }: Props = $props()
  let name = $state('')
  let startDate = $state(today())
  let endDate = $state(today())
  let ongoing = $state(true)
  let color = $state<string>(COLORS[0].value)
  let saving = $state(false)
  let error = $state('')

  $effect(() => {
    if (open) {
      name = phase?.name ?? ''
      startDate = phase?.startDate ?? today()
      endDate = phase?.endDate ?? today()
      ongoing = phase ? phase.endDate === null : true
      color = phase?.color ?? COLORS[colorIndex % COLORS.length].value
      saving = false
      error = ''
    }
  })

  async function save(): Promise<void> {
    if (saving) return
    if (!name.trim()) { error = 'Give this phase a name.'; return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) { error = 'Choose a valid start date.'; return }
    if (!ongoing && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate)) {
      error = 'Choose an end date on or after the start date.'
      return
    }
    saving = true
    error = ''
    try {
      await onsave({ name: name.trim(), startDate, endDate: ongoing ? null : endDate, color })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this phase.'
      saving = false
    }
  }
</script>

<Sheet
  {open}
  title={phase ? 'Edit phase' : 'New phase'}
  subtitle={phase ? fmtRange(phase.startDate, phase.endDate) : 'Mark a stage such as build, cut, or maintenance.'}
  onclose={() => { if (!saving) onclose() }}
>
  <div class="phase-form">
    <div class="field">
      <label class="field-label" for="phase-name">Name</label>
      <input class="field-input" id="phase-name" data-autofocus maxlength="100" placeholder="e.g. Build, Cut, Maintenance" bind:value={name} disabled={saving} />
    </div>
    <div class="date-grid">
      <div class="field">
        <label class="field-label" for="phase-start">Start date</label>
        <input class="field-input" id="phase-start" type="date" bind:value={startDate} disabled={saving} />
      </div>
      <div class="field">
        <label class="field-label" for="phase-end">End date</label>
        <input class="field-input" id="phase-end" type="date" min={startDate} bind:value={endDate} disabled={saving || ongoing} />
      </div>
    </div>
    <label class="ongoing-label">
      <input type="checkbox" bind:checked={ongoing} disabled={saving} />
      <span>Still ongoing</span>
    </label>
    <fieldset class="color-field" disabled={saving}>
      <legend class="field-label">Colour</legend>
      <div class="swatches">
        {#each COLORS as entry (entry.value)}
          <button
            class="color-swatch"
            class:selected={color === entry.value}
            style:background-color={entry.value}
            type="button"
            aria-label={`${entry.name} phase colour`}
            aria-pressed={color === entry.value}
            onclick={() => { color = entry.value }}
          >{#if color === entry.value}<span aria-hidden="true">✓</span>{/if}</button>
        {/each}
      </div>
    </fieldset>
    {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  </div>
  {#snippet actions()}
    <button class="button button--secondary" type="button" disabled={saving} onclick={onclose}>Cancel</button>
    <button class="button button--primary" type="button" disabled={saving} onclick={save}>{saving ? 'Saving…' : phase ? 'Save changes' : 'Add phase'}</button>
  {/snippet}
</Sheet>

<style>
  .phase-form { display: flex; flex-direction: column; gap: var(--space-4); }
  .date-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .ongoing-label { display: flex; min-height: var(--touch-target); align-items: center; gap: var(--space-3); }
  .ongoing-label input { width: 1.4rem; height: 1.4rem; accent-color: var(--color-accent); }
  .color-field { min-width: 0; margin: 0; padding: 0; border: 0; }
  .color-field legend { margin-bottom: var(--space-2); }
  .swatches { display: flex; flex-wrap: wrap; gap: var(--space-3); }
  .color-swatch {
    display: grid;
    width: var(--touch-target);
    height: var(--touch-target);
    padding: 0;
    place-items: center;
    border: 3px solid transparent;
    border-radius: var(--radius-pill);
    box-shadow: 0 0 0 1px var(--color-border-strong);
    color: white;
    font-weight: var(--weight-bold);
  }
  .color-swatch.selected { border-color: var(--color-text); }
  @media (max-width: 22.5rem) { .date-grid { grid-template-columns: 1fr; } }
</style>
