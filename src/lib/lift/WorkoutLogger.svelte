<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import ExerciseCard from './ExerciseCard.svelte'
  import ExercisePicker from './ExercisePicker.svelte'
  import SetEditSheet from './SetEditSheet.svelte'
  import RestTimer from './RestTimer.svelte'
  import { navigate } from '../state.svelte'
  import { showToast } from '../toast.svelte'
  import { fmtLong } from '../format'
  import { PR_LABEL, fmtTonnage, fmtW, workoutSummary, type BodyweightAt, type ExerciseStats } from '../lifting'
  import {
    alternativesFor, swapExercise, addPlanned, deleteWorkout, finishWorkout, lift, moveExercise, removeExercise, retryFailed, updateWorkout, workoutById, workoutExercises,
  } from '../lifting.svelte'
  import type { Exercise, LiftSet } from '../types'

  interface Props {
    workoutId: string
    stats: Map<string, ExerciseStats>
    exMap: Map<string, Exercise>
    bw: BodyweightAt
  }
  let { workoutId, stats, exMap, bw }: Props = $props()

  const workout = $derived(workoutById(workoutId))
  const live = $derived(Boolean(workout && !workout.endedAt && lift.activeId === workoutId))
  const order = $derived(workout ? workoutExercises(workout) : [])
  const summary = $derived(workout ? workoutSummary(workout, exMap, bw) : null)

  let openId = $state<string | null>(null)
  $effect(() => {
    if (openId && order.includes(openId)) return
    if (!workout) return
    const lastLogged = workout.sets[workout.sets.length - 1]?.exerciseId
    openId = order.find((id) => !workout.sets.some((s) => s.exerciseId === id)) && !lastLogged ? order[0] ?? null : lastLogged ?? order[0] ?? null
  })

  /* ---------- clock + wake lock ---------- */
  let now = $state(Date.now())
  const clock = window.setInterval(() => (now = Date.now()), 1000)
  const elapsed = $derived(workout?.startedAt ? Math.max(0, Math.floor((now - Date.parse(workout.startedAt)) / 1000)) : 0)
  const hms = (s: number): string => (s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`)

  type WakeLockLike = { release: () => Promise<void> }
  let wake: WakeLockLike | null = null
  async function holdScreen(): Promise<void> {
    if (!live || document.visibilityState !== 'visible' || wake) return
    try {
      const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLockLike> } }
      wake = (await nav.wakeLock?.request('screen')) ?? null
    } catch { wake = null }
  }
  function onVisible(): void {
    if (document.visibilityState === 'visible') { wake = null; void holdScreen() }
  }
  onMount(() => {
    void holdScreen()
    document.addEventListener('visibilitychange', onVisible)
  })
  onDestroy(() => {
    window.clearInterval(clock)
    document.removeEventListener('visibilitychange', onVisible)
    void wake?.release().catch(() => {})
  })

  /* ---------- sheets ---------- */
  let pickerOpen = $state(false)
  let menuFor = $state<string | null>(null)
  function swap(from: string, to: string): void {
    if (!workout || !swapExercise(workout.id, from, to)) { showToast('Sets are already logged for this one. Remove them first.', 'error'); return }
    if (openId === from) openId = to
    menuFor = null
  }
  const swapsFor = (id: string): Exercise[] => alternativesFor(id).map((a) => exMap.get(a)).filter((e): e is Exercise => Boolean(e && !e.archived))
  let editing = $state<LiftSet | null>(null)
  let finishOpen = $state(false)
  let detailsOpen = $state(false)
  let confirmDelete = $state(false)
  let notes = $state('')
  let nameDraft = $state('')
  let dayDraft = $state('')

  function addExercise(ex: Exercise): void {
    pickerOpen = false
    if (!workout) return
    addPlanned(workout.id, ex.id)
    openId = ex.id
  }
  const prs = $derived.by(() => {
    if (!workout) return []
    const out: { name: string; label: string; set: string }[] = []
    for (const id of order) {
      const st = stats.get(id)
      const line = st?.sessions.find((s) => s.workoutId === workout.id)
      for (const p of line?.prs ?? []) {
        const set = workout.sets.find((s) => s.id === p.setId)
        if (set) out.push({ name: st!.exercise.name, label: PR_LABEL[p.kinds[0]], set: `${fmtW(set.weightKg)} × ${set.reps}` })
      }
    }
    return out
  })

  function openFinish(): void {
    notes = workout?.notes ?? ''
    finishOpen = true
  }
  function finish(): void {
    if (!workout) return
    const result = finishWorkout(workout.id, notes.trim() || null)
    finishOpen = false
    showToast(result === 'saved' ? 'Workout saved. Nice work.' : 'Empty workout discarded.', result === 'saved' ? 'success' : 'default')
    navigate('lifting')
  }
  function openDetails(): void {
    nameDraft = workout?.name ?? ''
    dayDraft = workout?.day ?? ''
    notes = workout?.notes ?? ''
    detailsOpen = true
  }
  function saveDetails(): void {
    if (!workout) return
    updateWorkout(workout.id, { name: nameDraft.trim() || null, day: /^\d{4}-\d{2}-\d{2}$/.test(dayDraft) ? dayDraft : workout.day, notes: live ? workout.notes : notes.trim() || null })
    detailsOpen = false
  }
  function remove(): void {
    if (!workout) return
    deleteWorkout(workout.id)
    confirmDelete = false
    detailsOpen = false
    showToast('Workout deleted.')
    navigate('lifting')
  }
  const menuEx = $derived(menuFor ? exMap.get(menuFor) ?? null : null)
</script>

{#if !workout}
  <div class="view">
    <div class="card-empty" role="alert">
      <p>This workout is not on this device.</p>
      <button class="button button--primary" type="button" onclick={() => navigate('lifting')}>Back to Lifting</button>
    </div>
  </div>
{:else}
  <div class="view view--log" class:has-rest={live}>
    <header class="log-head">
      <button class="icon-button" type="button" aria-label="Back to Lifting{live ? ' (the workout keeps running)' : ''}" onclick={() => navigate('lifting')}><Icon name="chevron-left" size={22} /></button>
      <button class="log-title" type="button" onclick={openDetails} aria-label="Workout details: {workout.name || 'Workout'}">
        <span class="lt-name">{workout.name || (live ? 'Workout' : 'Past workout')}<Icon name="edit" size={14} /></span>
        <span class="lt-meta">
          {#if live}<span class="lt-clock">{hms(elapsed)}</span> · {:else}{fmtLong(workout.day)} · {/if}
          {summary?.hardSets ?? 0} sets
          <span class="sync {lift.sync}">
            {#if lift.sync === 'offline'}<Icon name="cloud-off" size={14} /> saved on phone
            {:else if lift.sync === 'saving'}<Icon name="cloud" size={14} /> saving…
            {:else if lift.sync === 'error'}<Icon name="alert" size={14} /> not saved
            {:else}<Icon name="check" size={14} /> saved{/if}
          </span>
        </span>
      </button>
      {#if live}
        <button class="button button--primary finish" type="button" onclick={openFinish}>Finish</button>
      {:else}
        <button class="button button--secondary finish" type="button" onclick={() => navigate('lifting', 'history')}>Done</button>
      {/if}
    </header>

    {#if lift.sync === 'error'}
      <div class="sync-banner" role="alert">
        <span>{lift.syncError || 'The server rejected a save.'}</span>
        <button class="button button--secondary" type="button" onclick={retryFailed}>Retry</button>
      </div>
    {/if}

    {#each order as id (id)}
      {@const ex = exMap.get(id)}
      {@const st = stats.get(id)}
      {#if ex && st}
        <ExerciseCard
          {workout} exercise={ex} stats={st} {bw} {live}
          expanded={openId === id}
          onexpand={() => (openId = openId === id ? null : id)}
          onmenu={() => (menuFor = id)}
          onedit={(s) => (editing = s)}
          swaps={workout.sets.some((s) => s.exerciseId === id) ? [] : swapsFor(id)}
          onswap={(to) => swap(id, to)}
        />
      {/if}
    {/each}

    {#if !order.length}
      <div class="first">
        <span class="first-icon" aria-hidden="true"><Icon name="dumbbell" size={28} /></span>
        <p>Add your first exercise. Your last session’s numbers and a target show up as soon as you pick it.</p>
      </div>
    {/if}

    <button class="add-ex" type="button" onclick={() => (pickerOpen = true)}><Icon name="plus" size={22} /> Add exercise</button>
  </div>

  {#if live}<RestTimer />{/if}

  <ExercisePicker open={pickerOpen} taken={order} onpick={addExercise} onclose={() => (pickerOpen = false)} />
  <SetEditSheet workoutId={workout.id} set={editing} exercise={editing ? exMap.get(editing.exerciseId) ?? null : null} onclose={() => (editing = null)} />

  <Sheet open={Boolean(menuFor)} title={menuEx?.name ?? 'Exercise'} onclose={() => (menuFor = null)}>
    {#if menuFor}
      {@const id = menuFor}
      <div class="menu">
        <button class="menu-row" type="button" disabled={order.indexOf(id) <= 0} onclick={() => moveExercise(workout.id, id, -1)}><Icon name="arrow-up" size={18} /> Move up</button>
        <button class="menu-row" type="button" disabled={order.indexOf(id) >= order.length - 1} onclick={() => moveExercise(workout.id, id, 1)}><Icon name="arrow-down" size={18} /> Move down</button>
        {#if !workout.sets.some((s) => s.exerciseId === id)}
          {#each swapsFor(id) as alt (alt.id)}
            <button class="menu-row" type="button" onclick={() => swap(id, alt.id)}><Icon name="repeat" size={18} /> Swap for {alt.name}</button>
          {/each}
        {/if}
        <button class="menu-row" type="button" onclick={() => { menuFor = null; navigate('lifting', `exercise/${id}`) }}><Icon name="trending-up" size={18} /> Progress and history</button>
        <button class="menu-row danger" type="button" onclick={() => { removeExercise(workout.id, id); menuFor = null }}><Icon name="trash" size={18} /> Remove from this workout{workout.sets.some((s) => s.exerciseId === id) ? ' (deletes its sets)' : ''}</button>
      </div>
    {/if}
  </Sheet>

  <Sheet open={finishOpen} title="Finish workout?" onclose={() => (finishOpen = false)}>
    {#if summary}
      <div class="sum">
        <div class="sum-grid">
          <div><span>Time</span><b>{hms(Math.round(summary.durationS))}</b></div>
          <div><span>Sets</span><b>{summary.hardSets}</b></div>
          <div><span>Volume</span><b>{fmtTonnage(summary.volume)}</b></div>
          <div><span>Load</span><b>{summary.load}</b></div>
        </div>
        {#if prs.length}
          <h3><Icon name="award" size={16} /> {prs.length} personal record{prs.length === 1 ? '' : 's'}</h3>
          <ul class="prs">{#each prs as p, i (i)}<li><b>{p.name}</b> {p.set} <em>{p.label}</em></li>{/each}</ul>
        {/if}
        {#if !summary.hardSets}<p class="muted">No working sets logged, so this workout will be discarded.</p>{/if}
        <label class="notes"><span>Notes (optional)</span><textarea rows="3" bind:value={notes} placeholder="How did it feel? Sleep, niggles, gym was busy…"></textarea></label>
      </div>
    {/if}
    {#snippet actions()}
      <button class="button button--secondary" type="button" onclick={() => (finishOpen = false)}>Keep going</button>
      <button class="button button--primary" type="button" onclick={finish}>{summary?.hardSets ? 'Save workout' : 'Discard'}</button>
    {/snippet}
  </Sheet>

  <Sheet open={detailsOpen} title="Workout details" onclose={() => (detailsOpen = false)}>
    <div class="details">
      <label class="notes"><span>Name</span><input type="text" maxlength="80" bind:value={nameDraft} placeholder="e.g. Push, Legs, Upper A" /></label>
      {#if !live}
        <label class="notes"><span>Date</span><input type="date" bind:value={dayDraft} /></label>
        <label class="notes"><span>Notes</span><textarea rows="3" bind:value={notes}></textarea></label>
      {/if}
      <button class="button button--secondary danger-text" type="button" onclick={() => (confirmDelete = true)}><Icon name="trash" size={18} /> Delete workout</button>
    </div>
    {#snippet actions()}
      <button class="button button--secondary" type="button" onclick={() => (detailsOpen = false)}>Cancel</button>
      <button class="button button--primary" type="button" onclick={saveDetails}>Save</button>
    {/snippet}
  </Sheet>

  <Sheet open={confirmDelete} title="Delete this workout?" subtitle="All of its sets are removed. This cannot be undone." onclose={() => (confirmDelete = false)}>
    <p class="muted">{workout.name || 'Workout'} · {fmtLong(workout.day)} · {summary?.hardSets ?? 0} sets</p>
    {#snippet actions()}
      <button class="button button--secondary" type="button" onclick={() => (confirmDelete = false)}>Keep it</button>
      <button class="button button--danger" type="button" onclick={remove}>Delete</button>
    {/snippet}
  </Sheet>
{/if}

<style>
  .view--log { gap: var(--space-3); }
  .view--log.has-rest { padding-bottom: calc(var(--tab-bar-height) + var(--safe-bottom) + 9rem); }
  .log-head { position: sticky; z-index: 5; top: 0; display: flex; margin: calc(-1 * var(--space-3)) calc(-1 * var(--space-4)) 0; padding: var(--space-2) var(--space-3); align-items: center; gap: var(--space-2); border-bottom: 1px solid var(--color-border); background: color-mix(in srgb, var(--color-bg) 92%, transparent); backdrop-filter: blur(14px); }
  .log-title { display: flex; min-width: 0; min-height: var(--touch-target); flex: 1; flex-direction: column; justify-content: center; border: 0; background: transparent; color: var(--color-text); text-align: left; }
  .lt-name { display: inline-flex; overflow: hidden; align-items: center; gap: var(--space-2); font-size: var(--text-lg); font-weight: var(--weight-bold); text-overflow: ellipsis; white-space: nowrap; }
  .lt-name :global(.icon) { flex: 0 0 auto; color: var(--color-text-subtle); }
  .lt-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--space-1); color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .lt-clock { color: var(--color-accent); font-weight: var(--weight-bold); }
  .sync { display: inline-flex; margin-left: var(--space-2); align-items: center; gap: 3px; }
  .sync.offline { color: var(--color-warning); }
  .sync.error { color: var(--color-danger); }
  .finish { flex: 0 0 auto; padding-inline: var(--space-4); }
  .sync-banner { display: flex; padding: var(--space-3); align-items: center; justify-content: space-between; gap: var(--space-3); border-radius: var(--radius-md); background: var(--color-danger-soft); color: var(--color-danger); font-size: var(--text-sm); }
  .first { display: flex; padding: var(--space-6) var(--space-4); flex-direction: column; align-items: center; gap: var(--space-3); color: var(--color-text-muted); text-align: center; }
  .first p { max-width: 22rem; margin: 0; }
  .first-icon { display: grid; width: 3.5rem; height: 3.5rem; place-items: center; border-radius: 50%; background: var(--color-accent-soft); color: var(--color-accent); }
  .add-ex { display: flex; min-height: var(--touch-target-primary); align-items: center; justify-content: center; gap: var(--space-2); border: 2px dashed var(--color-border-strong); border-radius: var(--radius-card); background: transparent; color: var(--color-accent); font-size: var(--text-lg); font-weight: var(--weight-bold); }
  .add-ex:hover { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .menu { display: flex; flex-direction: column; }
  .menu-row { display: flex; min-height: 3.25rem; padding: 0 var(--space-2); align-items: center; gap: var(--space-3); border: 0; border-bottom: 1px solid var(--color-border); background: transparent; color: var(--color-text); font-size: var(--text-md); text-align: left; }
  .menu-row:disabled { color: var(--color-text-subtle); }
  .menu-row.danger, .danger-text { color: var(--color-danger); }
  .sum { display: flex; flex-direction: column; gap: var(--space-3); }
  .sum-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-2); }
  .sum-grid div { display: flex; padding: var(--space-3) var(--space-2); flex-direction: column; align-items: center; border-radius: var(--radius-md); background: var(--color-surface-sunken); }
  .sum-grid span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .sum-grid b { font-size: var(--text-lg); font-variant-numeric: tabular-nums; }
  .sum h3 { display: flex; margin: 0; align-items: center; gap: var(--space-2); color: var(--color-warning); font-size: var(--text-md); }
  .prs { margin: 0; padding-left: var(--space-5); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .prs em { color: var(--color-text-muted); font-style: normal; }
  .muted { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .notes { display: flex; flex-direction: column; gap: var(--space-1); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .notes textarea, .notes input { min-height: var(--touch-target); padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font: inherit; font-size: 1rem; font-weight: var(--weight-regular); }
  .details { display: flex; flex-direction: column; gap: var(--space-4); }
  .card-empty { display: flex; padding: var(--space-6); flex-direction: column; align-items: center; gap: var(--space-3); }
  @media (min-width: 43.75rem) { .log-head { margin-inline: calc(-1 * var(--space-6)); padding-inline: var(--space-6); } }
  @media (min-width: 56.25rem) {
    .log-head { margin-top: calc(-1 * var(--space-10)); }
    .view--log.has-rest { padding-bottom: 10rem; }
  }
</style>
