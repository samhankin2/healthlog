<script lang="ts">
  import Sheet from '../components/Sheet.svelte'
  import Icon from '../components/Icon.svelte'
  import Stepper from './Stepper.svelte'
  import { KIND_LABEL, defaultIncrement } from '../lifting'
  import { deleteSet, updateSet } from '../lifting.svelte'
  import type { Exercise, LiftSet, SetKind } from '../types'

  interface Props {
    workoutId: string
    set: LiftSet | null
    exercise: Exercise | null
    onclose: () => void
  }
  let { workoutId, set, exercise, onclose }: Props = $props()

  let weight = $state(0)
  let reps = $state(0)
  let rpe = $state<number | null>(null)
  let kind = $state<SetKind>('working')

  $effect(() => {
    if (set) {
      weight = set.weightKg
      reps = set.reps
      rpe = set.rpe
      kind = set.kind
    }
  })

  function save(): void {
    if (set) updateSet(workoutId, set.id, { weightKg: weight, reps, rpe, kind })
    onclose()
  }
  function remove(): void {
    if (set) deleteSet(workoutId, set.id)
    onclose()
  }
</script>

<Sheet open={Boolean(set)} title="Edit set" subtitle={exercise?.name} {onclose}>
  {#if set && exercise}
    <div class="edit">
      <div class="grid">
        <Stepper label={exercise.equipment === 'bodyweight' ? 'Added kg' : 'Weight'} value={weight} step={defaultIncrement(exercise)} max={1000} unit="kg" unitName="kilograms" decimal onchange={(v) => (weight = v)} />
        <Stepper label="Reps" value={reps} step={1} max={200} unitName="reps" onchange={(v) => (reps = v)} />
      </div>
      <fieldset>
        <legend>Set type</legend>
        <div class="opts">
          {#each Object.entries(KIND_LABEL) as [k, label] (k)}
            <label class="opt"><input type="radio" name="set-kind" value={k} checked={kind === k} onchange={() => (kind = k as SetKind)} /> {label}</label>
          {/each}
        </div>
      </fieldset>
      <fieldset>
        <legend>Effort (RPE)</legend>
        <div class="opts">
          <label class="opt"><input type="radio" name="set-rpe" checked={rpe === null} onchange={() => (rpe = null)} /> None</label>
          {#each [6, 7, 7.5, 8, 8.5, 9, 9.5, 10] as v (v)}
            <label class="opt"><input type="radio" name="set-rpe" checked={rpe === v} onchange={() => (rpe = v)} /> {v}</label>
          {/each}
        </div>
      </fieldset>
    </div>
  {/if}
  {#snippet actions()}
    <button class="button button--secondary danger-text" type="button" onclick={remove}><Icon name="trash" size={18} /> Delete</button>
    <button class="button button--primary" type="button" disabled={reps < 1} onclick={save}>Save</button>
  {/snippet}
</Sheet>

<style>
  .edit { display: flex; flex-direction: column; gap: var(--space-4); }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  fieldset { margin: 0; padding: 0; border: 0; }
  legend { margin-bottom: var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .opts { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .opt { display: inline-flex; min-height: 2.75rem; padding: 0 var(--space-3); align-items: center; gap: var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-pill); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .opt:has(input:checked) { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent); }
  .opt input { accent-color: var(--color-accent); }
  .danger-text { color: var(--color-danger); }
</style>
