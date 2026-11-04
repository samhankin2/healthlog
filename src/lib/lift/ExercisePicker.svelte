<script lang="ts">
  import Sheet from '../components/Sheet.svelte'
  import Icon from '../components/Icon.svelte'
  import { EQUIPMENT, EQUIPMENT_LABEL, MUSCLES, MUSCLE_LABEL } from '../lifting'
  import { createExercise, lift } from '../lifting.svelte'
  import type { Equipment, Exercise, Muscle } from '../types'

  interface Props {
    open: boolean
    /** Exercises already in the workout (shown ticked). */
    taken?: string[]
    onpick: (exercise: Exercise) => void
    onclose: () => void
  }
  let { open, taken = [], onpick, onclose }: Props = $props()

  let query = $state('')
  let muscle = $state<Muscle>('chest')
  let equipment = $state<Equipment>('barbell')

  $effect(() => {
    if (!open) query = ''
  })

  const active = $derived(lift.exercises.filter((e) => !e.archived))
  const recent = $derived.by(() => {
    const seen: string[] = []
    const ordered = [...lift.workouts].sort((a, b) => (b.day + (b.startedAt ?? '')).localeCompare(a.day + (a.startedAt ?? '')))
    for (const w of ordered) for (const s of w.sets) if (!seen.includes(s.exerciseId)) seen.push(s.exerciseId)
    return seen.map((id) => active.find((e) => e.id === id)).filter((e): e is Exercise => Boolean(e)).slice(0, 8)
  })
  const q = $derived(query.trim().toLowerCase())
  const matches = $derived(q ? active.filter((e) => e.name.toLowerCase().includes(q) || MUSCLE_LABEL[e.muscle].toLowerCase().includes(q) || EQUIPMENT_LABEL[e.equipment].toLowerCase().includes(q)) : [])
  const exact = $derived(active.some((e) => e.name.toLowerCase() === q))
  const groups = $derived(MUSCLES.map((m) => ({ ...m, list: active.filter((e) => e.muscle === m.key) })).filter((g) => g.list.length))

  function pick(ex: Exercise): void {
    onpick(ex)
  }
  function create(): void {
    const name = query.trim()
    if (!name) return
    pick(createExercise({ name, muscle, equipment }))
  }
</script>

{#snippet row(ex: Exercise)}
  <li>
    <button class="ex-row" type="button" onclick={() => pick(ex)} aria-pressed={taken.includes(ex.id)}>
      <span class="ex-name">{ex.name}</span>
      <span class="ex-meta">{MUSCLE_LABEL[ex.muscle]} · {EQUIPMENT_LABEL[ex.equipment]}</span>
      {#if taken.includes(ex.id)}<Icon name="check" size={18} label="In this workout" />{:else}<Icon name="plus" size={18} />{/if}
    </button>
  </li>
{/snippet}

<Sheet {open} title="Add exercise" {onclose}>
  <div class="picker">
    <label class="search">
      <Icon name="search" size={18} />
      <span class="sr-only">Search exercises</span>
      <input type="search" placeholder="Search or name a new exercise" autocomplete="off" enterkeyhint="search" bind:value={query} />
    </label>

    {#if q}
      {#if matches.length}
        <ul class="list" aria-label="Matching exercises">{#each matches as ex (ex.id)}{@render row(ex)}{/each}</ul>
      {/if}
      {#if !exact}
        <form class="create" onsubmit={(e) => { e.preventDefault(); create() }}>
          <p class="create-title">New exercise: <b>{query.trim()}</b></p>
          <div class="create-grid">
            <label class="mini"><span>Muscle</span>
              <select bind:value={muscle}>{#each MUSCLES as m (m.key)}<option value={m.key}>{m.label}</option>{/each}</select>
            </label>
            <label class="mini"><span>Equipment</span>
              <select bind:value={equipment}>{#each EQUIPMENT as e (e.key)}<option value={e.key}>{e.label}</option>{/each}</select>
            </label>
          </div>
          <button class="button button--primary" type="submit"><Icon name="plus" size={18} /> Create and add</button>
        </form>
      {/if}
    {:else}
      {#if recent.length}
        <h3 class="group">Recent</h3>
        <ul class="list" aria-label="Recent exercises">{#each recent as ex (ex.id)}{@render row(ex)}{/each}</ul>
      {/if}
      {#each groups as g (g.key)}
        <h3 class="group">{g.label}</h3>
        <ul class="list" aria-label="{g.label} exercises">{#each g.list as ex (ex.id)}{@render row(ex)}{/each}</ul>
      {/each}
    {/if}
  </div>
</Sheet>

<style>
  .picker { display: flex; flex-direction: column; gap: var(--space-2); }
  .search { position: sticky; z-index: 1; top: 0; display: flex; min-height: 3rem; padding: 0 var(--space-3); align-items: center; gap: var(--space-2); border: 1px solid var(--color-border-strong); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-text-muted); }
  .search:focus-within { border-color: var(--color-focus); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-focus) 22%, transparent); }
  .search input { min-width: 0; flex: 1; height: 2.9rem; border: 0; background: transparent; color: var(--color-text); font-size: 1rem; }
  .search input:focus { outline: none; }
  .group { margin: var(--space-3) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .list { display: flex; margin: 0; padding: 0; flex-direction: column; list-style: none; }
  .ex-row { display: grid; width: 100%; min-height: 3.25rem; padding: var(--space-2) var(--space-2); align-items: center; grid-template-columns: 1fr auto; grid-template-areas: 'name icon' 'meta icon'; column-gap: var(--space-3); border: 0; border-bottom: 1px solid var(--color-border); background: transparent; color: var(--color-text); text-align: left; }
  .ex-row:hover { background: var(--color-surface-sunken); }
  .ex-row[aria-pressed='true'] { color: var(--color-accent); }
  .ex-row :global(.icon) { grid-area: icon; color: var(--color-accent); }
  .ex-name { grid-area: name; font-weight: var(--weight-semibold); }
  .ex-meta { grid-area: meta; color: var(--color-text-muted); font-size: var(--text-xs); }
  .create { display: flex; margin-top: var(--space-2); padding: var(--space-4); flex-direction: column; gap: var(--space-3); border: 1px dashed var(--color-border-strong); border-radius: var(--radius-md); }
  .create-title { margin: 0; }
  .create-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .mini { display: flex; flex-direction: column; gap: var(--space-1); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .mini select { min-height: var(--touch-target); padding: 0 var(--space-2); border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font-size: 1rem; }
</style>
