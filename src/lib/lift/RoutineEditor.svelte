<script lang="ts">
  import { untrack } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import ExercisePicker from './ExercisePicker.svelte'
  import { navigate } from '../state.svelte'
  import { showToast } from '../toast.svelte'
  import { deleteRoutine, lift, saveRoutine } from '../lifting.svelte'
  import type { Exercise, Routine, RoutineItem } from '../types'

  interface Props { routine: Routine | null; exMap: Map<string, Exercise> }
  let { routine, exMap }: Props = $props()

  // A copy to edit, taken once (the parent remounts this per routine); saved as a whole.
  const initial = untrack(() => routine)
  let name = $state(initial?.name ?? '')
  let items = $state<RoutineItem[]>(initial ? initial.items.map((i) => ({ exerciseId: i.exerciseId, alternatives: [...i.alternatives] })) : [])
  let saving = $state(false)
  let confirmDelete = $state(false)

  /** null = adding an exercise; a number = picking a stand-in for that row. */
  let pickFor = $state<number | null>(null)
  let pickerOpen = $state(false)
  const exName = (id: string): string => exMap.get(id)?.name ?? 'Unknown exercise'

  function openPicker(row: number | null): void {
    pickFor = row
    pickerOpen = true
  }
  function picked(ex: Exercise): void {
    pickerOpen = false
    if (pickFor === null) {
      if (!items.some((i) => i.exerciseId === ex.id)) items = [...items, { exerciseId: ex.id, alternatives: [] }]
    } else {
      const row = items[pickFor]
      if (row && ex.id !== row.exerciseId && !row.alternatives.includes(ex.id)) row.alternatives = [...row.alternatives, ex.id]
    }
  }
  function move(i: number, by: -1 | 1): void {
    const j = i + by
    if (j < 0 || j >= items.length) return
    const next = [...items]
    ;[next[i], next[j]] = [next[j], next[i]]
    items = next
  }
  const removeAt = (i: number): void => { items = items.filter((_, k) => k !== i) }
  const dropAlt = (i: number, id: string): void => { items[i].alternatives = items[i].alternatives.filter((a) => a !== id) }

  async function save(): Promise<void> {
    saving = true
    try {
      await saveRoutine({ id: routine?.id, name: name.trim() || 'Routine', items: $state.snapshot(items), position: routine?.position })
      showToast('Routine saved.', 'success')
      navigate('lifting')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not save. Are you online?', 'error')
    } finally {
      saving = false
    }
  }
  async function remove(): Promise<void> {
    if (!routine) return
    try {
      await deleteRoutine(routine.id)
      showToast('Routine deleted.', 'success')
      navigate('lifting')
    } catch {
      showToast('Could not delete. Are you online?', 'error')
    }
  }
</script>

<div class="view view--routine">
  <button class="button button--secondary back" type="button" onclick={() => navigate('lifting')}><Icon name="chevron-left" size={18} /> Back</button>
  <header class="view-header">
    <p class="eyebrow"><Icon name="repeat" size={14} /> Routine</p>
    <h1 class="view-title">{routine ? 'Edit routine' : 'New routine'}</h1>
  </header>

  <label class="f"><span>Name</span><input type="text" maxlength="60" placeholder="Upper body" bind:value={name} /></label>

  <section aria-labelledby="items-title">
    <h2 class="sec" id="items-title">Exercises, in order</h2>
    {#if items.length}
      <ol class="items">
        {#each items as item, i (item.exerciseId)}
          <li class="item card">
            <div class="i-top">
              <span class="i-n" aria-hidden="true">{i + 1}</span>
              <b class="i-name">{exName(item.exerciseId)}</b>
              <div class="i-tools">
                <button class="icon-button" type="button" aria-label="Move {exName(item.exerciseId)} up" disabled={i === 0} onclick={() => move(i, -1)}><Icon name="arrow-up" size={18} /></button>
                <button class="icon-button" type="button" aria-label="Move {exName(item.exerciseId)} down" disabled={i === items.length - 1} onclick={() => move(i, 1)}><Icon name="arrow-down" size={18} /></button>
                <button class="icon-button" type="button" aria-label="Remove {exName(item.exerciseId)}" onclick={() => removeAt(i)}><Icon name="trash" size={18} /></button>
              </div>
            </div>
            <div class="alts">
              {#each item.alternatives as alt (alt)}
                <span class="alt">or {exName(alt)}<button type="button" aria-label="Remove {exName(alt)} as a stand-in" onclick={() => dropAlt(i, alt)}><Icon name="x" size={14} /></button></span>
              {/each}
              <button class="add-alt" type="button" onclick={() => openPicker(i)}><Icon name="plus" size={14} /> Stand-in{item.alternatives.length ? '' : ' (if the kit is taken)'}</button>
            </div>
          </li>
        {/each}
      </ol>
    {:else}
      <p class="muted">No exercises yet.</p>
    {/if}
    <button class="button button--secondary wide" type="button" onclick={() => openPicker(null)}><Icon name="plus" size={18} /> Add exercise</button>
  </section>

  <div class="actions">
    <button class="button button--primary wide" type="button" disabled={saving || !items.length} onclick={save}>{saving ? 'Saving…' : 'Save routine'}</button>
    {#if routine}<button class="button button--secondary wide danger" type="button" onclick={() => (confirmDelete = true)}><Icon name="trash" size={18} /> Delete routine</button>{/if}
  </div>
</div>

<ExercisePicker
  open={pickerOpen}
  taken={pickFor === null ? items.map((i) => i.exerciseId) : [items[pickFor]?.exerciseId, ...(items[pickFor]?.alternatives ?? [])].filter(Boolean) as string[]}
  onpick={picked}
  onclose={() => (pickerOpen = false)}
/>

<Sheet open={confirmDelete} title="Delete this routine?" subtitle="Your workouts and exercises stay. Only the routine goes." onclose={() => (confirmDelete = false)}>
  <p class="muted">{lift.routines.length <= 1 ? 'This is your only routine. You can still start empty workouts or repeat past sessions.' : ''}</p>
  {#snippet actions()}
    <button class="button button--secondary" type="button" onclick={() => (confirmDelete = false)}>Cancel</button>
    <button class="button button--primary danger" type="button" onclick={remove}>Delete</button>
  {/snippet}
</Sheet>

<style>
  .back { align-self: flex-start; }
  .eyebrow { display: inline-flex; margin: 0 0 var(--space-1); align-items: center; gap: 6px; color: var(--color-accent); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .card { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .sec { margin: 0 0 var(--space-3); font-size: var(--text-md); }
  .muted { margin: 0 0 var(--space-3); color: var(--color-text-muted); font-size: var(--text-sm); }
  .f { display: flex; flex-direction: column; gap: var(--space-1); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .f input { min-height: var(--touch-target); padding: 0 var(--space-3); border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font-size: 1rem; font-weight: var(--weight-regular); }
  .items { display: flex; margin: 0 0 var(--space-3); padding: 0; flex-direction: column; gap: var(--space-2); list-style: none; }
  .item { display: flex; padding: var(--space-2) var(--space-2) var(--space-3) var(--space-3); flex-direction: column; gap: var(--space-2); }
  .i-top { display: flex; align-items: center; gap: var(--space-2); }
  .i-n { display: grid; width: 1.75rem; height: 1.75rem; flex: 0 0 auto; place-items: center; border-radius: 50%; background: var(--color-surface-sunken); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-bold); }
  .i-name { min-width: 0; flex: 1; overflow-wrap: anywhere; }
  .i-tools { display: flex; flex: 0 0 auto; }
  .alts { display: flex; padding-left: calc(1.75rem + var(--space-2)); flex-wrap: wrap; gap: var(--space-2); }
  .alt { display: inline-flex; min-height: 2.25rem; padding-left: var(--space-3); align-items: center; gap: 2px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); font-size: var(--text-sm); }
  .alt button { display: grid; width: 2.25rem; height: 2.25rem; place-items: center; border: 0; background: transparent; color: var(--color-text-muted); }
  .add-alt { display: inline-flex; min-height: 2.25rem; padding: 0 var(--space-3); align-items: center; gap: 4px; border: 1px dashed var(--color-border-strong); border-radius: var(--radius-pill); background: transparent; color: var(--color-text-muted); font-size: var(--text-sm); }
  .wide { width: 100%; }
  .actions { display: flex; flex-direction: column; gap: var(--space-2); }
  .danger { color: var(--color-danger); }
  .button--primary.danger { background: var(--color-danger); color: var(--color-on-accent); }
</style>
