<script lang="ts">
  import { untrack } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import Stepper from './Stepper.svelte'
  import { showToast } from '../toast.svelte'
  import {
    EQUIPMENT_LABEL, KIND_LABEL, KIND_SHORT, MUSCLE_LABEL, PR_LABEL, defaultIncrement, e1rm, exerciseStats, fmtSets, fmtW,
    isHard, setLoad, type BodyweightAt, type ExerciseStats,
  } from '../lifting'
  import { PLAN_LABEL, fmtPlan, nextSet, planNext, repRange } from '../progression'
  import { addSet, lift, startRest } from '../lifting.svelte'
  import type { Exercise, LiftSet, SetKind, Workout } from '../types'

  interface Props {
    workout: Workout
    exercise: Exercise
    stats: ExerciseStats
    bw: BodyweightAt
    expanded: boolean
    live: boolean
    onexpand: () => void
    onmenu: () => void
    onedit: (set: LiftSet) => void
    /** Stand-ins from a routine (e.g. barbell bench for incline dumbbell); empty once sets are logged. */
    swaps?: Exercise[]
    onswap?: (exerciseId: string) => void
  }
  let { workout, exercise, stats, bw, expanded, live, onexpand, onmenu, onedit, swaps = [], onswap }: Props = $props()

  const bodyweight = $derived(exercise.equipment === 'bodyweight')
  const mySets = $derived(workout.sets.filter((s) => s.exerciseId === exercise.id))
  const idx = $derived(stats.sessions.findIndex((s) => s.workoutId === workout.id))
  const current = $derived(idx >= 0 ? stats.sessions[idx] : null)
  const last = $derived.by(() => {
    if (idx > 0) return stats.sessions[idx - 1]
    if (idx === 0) return null
    const before = stats.sessions.filter((s) => s.day <= workout.day)
    return before[before.length - 1] ?? null
  })
  /** Sessions before this workout: the plan is built from these. */
  const prior = $derived(idx >= 0 ? stats.sessions.slice(0, idx) : stats.sessions.filter((s) => s.day <= workout.day))
  const target = $derived(prior.length ? planNext(exercise, prior, stats.metric, bw, workout.day) : null)
  const range = $derived(repRange(exercise, prior).range)
  const liveNext = $derived(nextSet(exercise, target, mySets, range))
  const prBySet = $derived(new Map((current?.prs ?? []).map((p) => [p.setId, p.kinds])))
  const step = $derived(defaultIncrement(exercise))
  const panelId = `ex-panel-${Math.random().toString(36).slice(2, 9)}`

  /* ---------- entry pad ---------- */
  const START: Record<Exercise['equipment'], number> = { barbell: 20, dumbbell: 10, machine: 20, cable: 10, bodyweight: 0, kettlebell: 12, other: 10 }
  let weight = $state(0)
  let reps = $state(8)
  let rpe = $state<number | null>(null)
  let kind = $state<SetKind>('working')
  let showRpe = $state(false)

  function prefill(): void {
    const lastMine = mySets[mySets.length - 1]
    if (lastMine?.kind === 'warmup') {
      // Still warming up: keep the warm-up weight until a working set is logged.
      weight = lastMine.weightKg
      reps = lastMine.reps
      kind = 'warmup'
      return
    }
    kind = 'working'
    const next = nextSet(exercise, target, mySets, range)
    if (next) { weight = next.weightKg; reps = next.reps; return }
    const firstHard = last?.hard[0]
    if (firstHard) { weight = firstHard.weightKg; reps = firstHard.reps; return }
    weight = START[exercise.equipment]
    reps = range.lo
  }
  $effect(() => {
    void mySets.length
    void exercise.id
    untrack(prefill)
  })

  function log(): void {
    if (reps < 1) return
    const set = addSet(workout.id, { exerciseId: exercise.id, weightKg: weight, reps, rpe, kind })
    rpe = null
    showRpe = false
    const after = exerciseStats(exercise, lift.workouts, bw).sessions.find((s) => s.workoutId === workout.id)
    const kinds = after?.prs.find((p) => p.setId === set.id)?.kinds ?? []
    if (kinds.length) {
      const est = e1rm(setLoad(set, exercise, bw(workout.day)), set.reps)
      showToast(`${PR_LABEL[kinds[0]]}! ${exercise.name} ${bodyweight ? `BW+${fmtW(set.weightKg)}` : fmtW(set.weightKg)} × ${set.reps}${kinds.includes('e1rm') && est ? ` · e1RM ${Math.round(est)} kg` : ''}`, 'success')
      try { navigator.vibrate?.(60) } catch { /* unsupported */ }
    }
    if (live) startRest()
  }

  /* ---------- vs last time ---------- */
  function hardIndex(set: LiftSet): number {
    return mySets.filter(isHard).indexOf(set)
  }
  function versus(set: LiftSet): { tone: 'up' | 'down' | 'same'; text: string } | null {
    if (!isHard(set) || !last) return null
    const prev = last.hard[hardIndex(set)]
    if (!prev) return null
    const b = bw(workout.day)
    const now = stats.metric === 'reps' ? set.reps : e1rm(setLoad(set, exercise, b), set.reps)
    const then = stats.metric === 'reps' ? prev.reps : e1rm(setLoad(prev, exercise, bw(last.day)), prev.reps)
    const text = `${bodyweight ? (prev.weightKg ? `+${fmtW(prev.weightKg)}` : 'BW') : fmtW(prev.weightKg)}×${prev.reps}`
    if (now === null || then === null) return { tone: 'same', text }
    const diff = now - then
    return { tone: Math.abs(diff) < 0.01 ? 'same' : diff > 0 ? 'up' : 'down', text }
  }
  const TONE_WORD = { up: 'better than', down: 'below', same: 'level with' }
</script>

<article class="ex-card" class:open={expanded}>
  <div class="ex-head">
    <button class="ex-toggle" type="button" aria-expanded={expanded} aria-controls={panelId} onclick={onexpand}>
      <span class="ex-title">{exercise.name}</span>
      <span class="ex-sub">
        {#if mySets.length}{mySets.filter(isHard).length} set{mySets.filter(isHard).length === 1 ? '' : 's'} · {fmtSets(mySets, exercise)}
        {:else}{MUSCLE_LABEL[exercise.muscle]} · {EQUIPMENT_LABEL[exercise.equipment]}{/if}
      </span>
    </button>
    <button class="icon-button" type="button" aria-label="Options for {exercise.name}" onclick={onmenu}><Icon name="more" size={20} /></button>
  </div>

  {#if expanded}
    <div class="ex-body" id={panelId}>
      {#if swaps.length && onswap}
        <div class="swaps">
          {#each swaps as alt (alt.id)}
            <button class="swap" type="button" onclick={() => onswap(alt.id)}><Icon name="repeat" size={16} /> Or do {alt.name} instead</button>
          {/each}
        </div>
      {/if}
      {#if last || target}
        <div class="hints">
          {#if last}<p class="hint"><span>Last time</span><b>{fmtSets(last.hard.length ? last.hard : last.sets, exercise)}</b></p>{/if}
          {#if target}
            <p class="hint target"><span>Try</span><b>{fmtPlan(target, exercise)}</b><em>{target.note}</em></p>
            <details class="why">
              <summary>Why? · {PLAN_LABEL[target.kind]} · {range.lo}–{range.hi} reps</summary>
              <ul>{#each target.why as line, i (i)}<li>{line}</li>{/each}</ul>
            </details>
          {/if}
        </div>
      {/if}

      {#if mySets.length}
        <ol class="sets" aria-label="Sets logged for {exercise.name}">
          {#each mySets as s, i (s.id)}
            {@const vs = versus(s)}
            {@const prs = prBySet.get(s.id)}
            <li>
              <button class="set-row" class:warm={!isHard(s)} type="button" onclick={() => onedit(s)} aria-label="Set {i + 1}: {bodyweight ? `bodyweight plus ${fmtW(s.weightKg)}` : fmtW(s.weightKg)} kg for {s.reps} reps{s.kind !== 'working' ? `, ${KIND_LABEL[s.kind]}` : ''}{s.rpe ? `, RPE ${s.rpe}` : ''}{prs ? `, ${prs.map((k) => PR_LABEL[k]).join(', ')}` : ''}{vs ? `, ${TONE_WORD[vs.tone]} last time (${vs.text})` : ''}. Edit">
                <span class="set-n" aria-hidden="true">{KIND_SHORT[s.kind] || i + 1 - mySets.slice(0, i).filter((x) => !isHard(x)).length}</span>
                <span class="set-main" aria-hidden="true"><b>{bodyweight ? (s.weightKg ? `+${fmtW(s.weightKg)}` : 'BW') : fmtW(s.weightKg)}</b><small>{bodyweight && !s.weightKg ? '' : 'kg'}</small> × <b>{s.reps}</b>{#if s.rpe}<em>@{s.rpe}</em>{/if}</span>
                <span class="set-side" aria-hidden="true">
                  {#if prs}<span class="pr-badge"><Icon name="award" size={13} /> PR</span>{/if}
                  {#if vs}<span class="vs {vs.tone}">{vs.tone === 'up' ? '▲' : vs.tone === 'down' ? '▼' : '='} {vs.text}</span>{/if}
                </span>
              </button>
            </li>
          {/each}
        </ol>
      {/if}

      <div class="pad">
        <div class="pad-grid">
          <Stepper label={bodyweight ? 'Added kg' : 'Weight'} value={weight} {step} min={0} max={1000} unit="kg" unitName="kilograms" decimal onchange={(v) => (weight = v)} />
          <Stepper label="Reps" value={reps} step={1} min={0} max={200} unitName="reps" onchange={(v) => (reps = v)} />
        </div>
        <div class="pad-opts">
          <button class="chip-toggle" type="button" aria-pressed={kind === 'warmup'} onclick={() => (kind = kind === 'warmup' ? 'working' : 'warmup')}>Warm-up</button>
          <button class="chip-toggle" type="button" aria-pressed={kind === 'drop'} onclick={() => (kind = kind === 'drop' ? 'working' : 'drop')}>Drop set</button>
          <button class="chip-toggle" type="button" aria-pressed={kind === 'failure'} onclick={() => (kind = kind === 'failure' ? 'working' : 'failure')}>Failure</button>
          <button class="chip-toggle" type="button" aria-expanded={showRpe} onclick={() => (showRpe = !showRpe)}>{rpe ? `RPE ${rpe}` : 'RPE'}</button>
        </div>
        {#if showRpe}
          <div class="rpe" role="radiogroup" aria-label="Effort (RPE): 10 is all-out, 8 is two reps left">
            {#each [6, 7, 7.5, 8, 8.5, 9, 9.5, 10] as v (v)}
              <button type="button" role="radio" aria-checked={rpe === v} onclick={() => (rpe = rpe === v ? null : v)}>{v}</button>
            {/each}
          </div>
        {/if}
        {#if liveNext?.note && kind !== 'warmup'}<p class="adjust" role="status">{liveNext.note}</p>{/if}
        <button class="log-btn" type="button" disabled={reps < 1} onclick={log}>
          <Icon name="check" size={22} />
          Log {kind === 'warmup' ? 'warm-up' : `set ${mySets.filter(isHard).length + 1}`}
          <span class="log-sum">{bodyweight ? (weight ? `BW+${fmtW(weight)}` : 'BW') : `${fmtW(weight)} kg`} × {reps}</span>
        </button>
      </div>
    </div>
  {/if}
</article>

<style>
  .ex-card { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .ex-card.open { border-color: color-mix(in oklab, var(--color-accent) 45%, var(--color-border)); }
  .ex-head { display: flex; padding: var(--space-1) var(--space-1) var(--space-1) 0; align-items: center; }
  .ex-toggle { display: flex; min-width: 0; min-height: 3.5rem; padding: var(--space-2) var(--space-4); flex: 1; flex-direction: column; justify-content: center; gap: 2px; border: 0; background: transparent; color: var(--color-text); text-align: left; }
  .ex-title { font-size: var(--text-lg); font-weight: var(--weight-bold); letter-spacing: -0.01em; }
  .ex-sub { overflow: hidden; color: var(--color-text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }
  .ex-body { display: flex; padding: 0 var(--space-4) var(--space-4); flex-direction: column; gap: var(--space-3); }
  .hints { display: grid; gap: var(--space-1); }
  .hint { display: flex; margin: 0; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-2); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .hint span { min-width: 4.5rem; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .hint.target b { color: var(--color-accent); }
  .hint em { flex-basis: 100%; padding-left: calc(4.5rem + var(--space-2)); color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .swaps { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .swap { display: inline-flex; min-height: 2.75rem; padding: 0 var(--space-3); align-items: center; gap: var(--space-2); border: 1px dashed var(--color-border-strong); border-radius: var(--radius-pill); background: transparent; color: var(--color-text); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .why { font-size: var(--text-xs); color: var(--color-text-muted); }
  .why summary { display: inline-flex; min-height: 2.75rem; align-items: center; cursor: pointer; font-weight: var(--weight-semibold); }
  .why ul { display: flex; margin: 0 0 var(--space-1); padding-left: 1.1rem; flex-direction: column; gap: 4px; font-size: var(--text-sm); }
  .adjust { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-sm); background: var(--color-warning-soft); color: var(--color-text); font-size: var(--text-sm); }
  .sets { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-1); list-style: none; }
  .set-row { display: grid; width: 100%; min-height: 3rem; padding: var(--space-2) var(--space-3); align-items: center; grid-template-columns: 1.75rem auto 1fr; gap: var(--space-3); border: 0; border-radius: var(--radius-sm); background: var(--color-surface-sunken); color: var(--color-text); font-variant-numeric: tabular-nums; text-align: left; }
  .set-row.warm { opacity: 0.75; }
  .set-n { display: grid; width: 1.75rem; height: 1.75rem; place-items: center; border-radius: 50%; background: var(--color-surface); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-bold); }
  .set-main { font-size: var(--text-lg); white-space: nowrap; }
  .set-main small { margin-left: 2px; color: var(--color-text-muted); font-size: var(--text-xs); }
  .set-main em { margin-left: var(--space-2); color: var(--color-text-muted); font-size: var(--text-sm); font-style: normal; }
  .set-side { display: flex; min-width: 0; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: var(--space-2); font-size: var(--text-xs); }
  .pr-badge { display: inline-flex; padding: 2px 8px; align-items: center; gap: 3px; border-radius: var(--radius-pill); background: var(--color-warning-soft); color: var(--color-warning); font-weight: var(--weight-bold); }
  .vs { color: var(--color-text-muted); white-space: nowrap; }
  .vs.up { color: var(--color-up); }
  .vs.down { color: var(--color-down); }
  .pad { display: flex; padding-top: var(--space-2); flex-direction: column; gap: var(--space-3); border-top: 1px solid var(--color-border); }
  .pad-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
  .pad-opts { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .chip-toggle { min-height: 2.75rem; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-surface); color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .chip-toggle[aria-pressed='true'], .chip-toggle[aria-expanded='true'] { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent); }
  .rpe { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-2); }
  .rpe button { min-height: 2.75rem; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .rpe button[aria-checked='true'] { border-color: var(--color-accent); background: var(--color-accent); color: var(--color-on-accent); }
  .log-btn { display: flex; width: 100%; min-height: var(--touch-target-primary); padding: 0 var(--space-5); align-items: center; justify-content: center; gap: var(--space-2); border: 0; border-radius: var(--radius-md); background: var(--color-accent); color: var(--color-on-accent); font-size: var(--text-lg); font-weight: var(--weight-bold); touch-action: manipulation; }
  .log-btn:active { transform: scale(0.98); background: var(--color-accent-hover); }
  .log-btn:disabled { opacity: 0.5; }
  .log-sum { margin-left: auto; font-size: var(--text-md); font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); opacity: 0.9; }
  @media (max-width: 22.5rem) { .pad-grid { grid-template-columns: 1fr; } }
</style>
