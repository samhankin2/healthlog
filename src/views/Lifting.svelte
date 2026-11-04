<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import Sparkline from '../lib/viz/Sparkline.svelte'
  import WorkoutLogger from '../lib/lift/WorkoutLogger.svelte'
  import ExerciseDetail from '../lib/lift/ExerciseDetail.svelte'
  import { app, navigate, subpath } from '../lib/state.svelte'
  import { fmtLong, today } from '../lib/format'
  import {
    MUSCLE_LABEL, STATUS_LABEL, VOLUME_BAND, allExerciseStats, bodyweightLookup, exerciseOrder, fmtSets, fmtTonnage, fmtW,
    muscleAverages, muscleWeeks, sortWorkouts, workoutSummary,
  } from '../lib/lifting'
  import { shiftDay, weekStart } from '../lib/insights'
  import { activeWorkout, lift, loadLifting, startWorkout } from '../lib/lifting.svelte'

  onMount(() => void loadLifting(true))

  const sub = $derived(subpath())
  const page = $derived(sub.split('/')[0] || 'home')
  const pageId = $derived(sub.split('/')[1] ?? '')
  const todayDay = today()

  const bw = $derived(bodyweightLookup(app.weights.map((w) => ({ day: w.date, weightKg: w.weightKg }))))
  const exMap = $derived(new Map(lift.exercises.map((e) => [e.id, e])))
  const stats = $derived(allExerciseStats(lift.exercises, lift.workouts, bw))
  const done = $derived(sortWorkouts(lift.workouts.filter((w) => w.sets.length)).reverse())
  const active = $derived(activeWorkout())
  const used = $derived([...stats.values()].filter((s) => s.sessions.length).sort((a, b) => (b.lastDay ?? '').localeCompare(a.lastDay ?? '')))
  const weeks = $derived(muscleWeeks(lift.workouts, exMap, shiftDay(todayDay, -83), todayDay, bw))
  const thisWeek = $derived(weeks[weeks.length - 1])
  const muscles = $derived(muscleAverages(weeks, 4).filter((m) => m.sets > 0))
  const templates = $derived.by(() => {
    const seen = new Set<string>()
    return done.filter((w) => {
      const k = (w.name || exerciseOrder(w).join(',')).toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }).slice(0, 5)
  })
  const weekDays = $derived(Array.from({ length: 7 }, (_, i) => shiftDay(weekStart(todayDay), i)))
  const liftDays = $derived(new Set(done.map((w) => w.day)))

  function start(plan: string[] = [], name: string | null = null): void {
    const w = startWorkout({ plan, name })
    navigate('lifting', `log/${w.id}`)
  }
  function logPast(): void {
    const w = startWorkout({ live: false, day: shiftDay(todayDay, -1) })
    navigate('lifting', `log/${w.id}`)
  }
  const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
</script>

{#if page === 'log' && pageId}
  <WorkoutLogger workoutId={pageId} {stats} {exMap} {bw} />
{:else if page === 'exercise' && stats.get(pageId)}
  <ExerciseDetail stats={stats.get(pageId)!} />
{:else}
  <div class="view view--lifting">
    <header class="view-header">
      <p class="eyebrow"><Icon name="dumbbell" size={14} /> Lifting</p>
      <h1 class="view-title">{page === 'history' ? 'Every session' : 'Getting stronger'}</h1>
      {#if lift.pending}<p class="view-subtitle"><Icon name="cloud-off" size={14} /> {lift.pending} change{lift.pending === 1 ? '' : 's'} saved on this phone, syncing when online.</p>{/if}
    </header>

    {#if lift.loading && !lift.loaded}
      <div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span> Loading your lifts…</div>
    {:else if lift.error && !lift.loaded}
      <div class="card pad" role="alert"><p>{lift.error}</p><button class="button button--secondary" type="button" onclick={() => loadLifting(true)}>Try again</button></div>
    {:else if page === 'history'}
      <button class="button button--secondary" type="button" onclick={() => navigate('lifting')}><Icon name="chevron-left" size={18} /> Back</button>
      <button class="button button--secondary" type="button" onclick={logPast}><Icon name="plus" size={18} /> Log a past session</button>
      <ul class="hist">
        {#each done as w (w.id)}
          {@const s = workoutSummary(w, exMap, bw)}
          <li>
            <button class="hist-row card" type="button" onclick={() => navigate('lifting', `log/${w.id}`)}>
              <span class="h-top"><b>{w.name || 'Workout'}</b><em>{fmtLong(w.day)}</em></span>
              <span class="h-meta">{Math.round(s.durationS / 60)} min · {s.hardSets} sets · {fmtTonnage(s.volume)}</span>
              <span class="h-ex">{s.exercises.map((id) => exMap.get(id)?.name).filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        {:else}<li class="muted">No sessions yet.</li>{/each}
      </ul>
    {:else}
      {#if active}
        <section class="resume card">
          <div><b>{active.name || 'Workout'} in progress</b><span>{active.sets.length} sets logged</span></div>
          <button class="button button--primary big" type="button" onclick={() => navigate('lifting', `log/${active.id}`)}>Resume</button>
        </section>
      {:else}
        <button class="button button--primary big" type="button" onclick={() => start()}><Icon name="plus" size={22} /> Start workout</button>
        {#if templates.length}
          <section aria-labelledby="repeat-title">
            <h2 class="sec" id="repeat-title"><Icon name="repeat" size={16} /> Repeat a session</h2>
            <div class="tpl">
              {#each templates as w (w.id)}
                <button class="tpl-card card" type="button" onclick={() => start(exerciseOrder(w), w.name)}>
                  <b>{w.name || 'Workout'}</b>
                  <span>{exerciseOrder(w).map((id) => exMap.get(id)?.name).filter(Boolean).slice(0, 4).join(', ')}</span>
                  <em>Last {fmtLong(w.day)}</em>
                </button>
              {/each}
            </div>
          </section>
        {/if}
      {/if}

      <section class="card pad week" aria-labelledby="week-title">
        <h2 class="sec" id="week-title">This week</h2>
        <div class="days" role="img" aria-label="Lifting days this week: {weekDays.filter((d) => liftDays.has(d)).length}">
          {#each weekDays as d, i (d)}<span class="day" class:on={liftDays.has(d)} class:today={d === todayDay}>{WD[i]}</span>{/each}
        </div>
        <div class="stats">
          <div><span>Sessions</span><b>{thisWeek?.sessions ?? 0}</b></div>
          <div><span>Hard sets</span><b>{thisWeek?.total ?? 0}</b></div>
          <div><span>Volume</span><b>{fmtTonnage(thisWeek?.volume ?? 0)}</b></div>
        </div>
      </section>

      {#if used.length}
        <section aria-labelledby="lifts-title">
          <h2 class="sec" id="lifts-title"><Icon name="trending-up" size={16} /> Your lifts</h2>
          <ul class="lifts card">
            {#each used as st (st.exercise.id)}
              <li>
               <button class="lift" type="button" onclick={() => navigate('lifting', `exercise/${st.exercise.id}`)}>
                <span class="l-name"><b>{st.exercise.name}</b><em>{MUSCLE_LABEL[st.exercise.muscle]} · {st.sessions.length} sessions</em></span>
                <Sparkline points={st.sessions.slice(-12).map((s) => ({ day: s.day, value: s.best }))} width={72} height={28} />
                <span class="l-num">
                  <b>{st.best ? (st.metric === 'reps' ? `${st.best.value} reps` : `${Math.round(st.best.value)} kg`) : '—'}</b>
                  <span class="status {st.status}">{STATUS_LABEL[st.status]}{st.change !== null ? ` ${st.change >= 0 ? '+' : ''}${st.change.toFixed(1)}%` : ''}</span>
                </span>
                {#if st.next}<span class="l-next">Next: {st.exercise.equipment === 'bodyweight' ? (st.next.weightKg ? `BW+${fmtW(st.next.weightKg)}` : 'BW') : `${fmtW(st.next.weightKg)} kg`} × {st.next.reps.join(', ')} · last {fmtSets(st.sessions[st.sessions.length - 1].hard, st.exercise)}</span>{/if}
               </button>
              </li>
            {/each}
          </ul>
          <p class="note">Best = estimated one-rep max (Epley). Status compares your last 4 weeks of training with the 4 before.</p>
        </section>
      {/if}

      {#if muscles.length}
        <section class="card pad" aria-labelledby="muscle-title">
          <h2 class="sec" id="muscle-title">Weekly hard sets per muscle <small>(4-week average)</small></h2>
          <ul class="mus">
            {#each muscles as m (m.muscle)}
              <li>
                <span>{m.label}</span>
                <span class="bar" aria-hidden="true"><i class="band" style:left="{(VOLUME_BAND.lo / 25) * 100}%" style:width="{((VOLUME_BAND.hi - VOLUME_BAND.lo) / 25) * 100}%"></i><i class="fill" style:width="{Math.min(100, (m.sets / 25) * 100)}%"></i></span>
                <b>{m.sets.toFixed(1)}</b>
              </li>
            {/each}
          </ul>
          <p class="note">Shaded: {VOLUME_BAND.lo}–{VOLUME_BAND.hi} sets a week, the range most hypertrophy research lands on.</p>
        </section>
      {/if}

      <button class="button button--secondary" type="button" onclick={() => navigate('lifting', 'history')}><Icon name="calendar" size={18} /> All sessions ({done.length})</button>
    {/if}
  </div>
{/if}

<style>
  .eyebrow { display: inline-flex; margin: 0; align-items: center; gap: 6px; color: var(--color-accent); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .card { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .pad { padding: var(--space-4); }
  .skeleton { display: flex; min-height: 10rem; align-items: center; justify-content: center; gap: var(--space-3); color: var(--color-text-muted); }
  .big { width: 100%; min-height: var(--touch-target-primary); font-size: var(--text-lg); }
  .sec { display: flex; margin: 0 0 var(--space-3); align-items: center; gap: var(--space-2); font-size: var(--text-md); }
  .sec small { color: var(--color-text-muted); font-weight: var(--weight-regular); }
  .resume { display: flex; padding: var(--space-4); flex-direction: column; gap: var(--space-3); background: linear-gradient(120deg, var(--color-accent-soft), var(--color-surface) 70%); }
  .resume div { display: flex; flex-direction: column; }
  .resume span, .muted, .note { color: var(--color-text-muted); font-size: var(--text-sm); }
  .note { margin: var(--space-2) 0 0; font-size: var(--text-xs); }
  .tpl { display: flex; padding-bottom: var(--space-2); gap: var(--space-3); overflow-x: auto; scroll-snap-type: x mandatory; }
  .tpl-card { display: flex; min-width: 13rem; max-width: 15rem; padding: var(--space-3) var(--space-4); flex-direction: column; gap: 2px; color: var(--color-text); text-align: left; scroll-snap-align: start; }
  .tpl-card span { color: var(--color-text-muted); font-size: var(--text-sm); }
  .tpl-card em { color: var(--color-text-subtle); font-size: var(--text-xs); font-style: normal; }
  .days { display: grid; margin-bottom: var(--space-3); grid-template-columns: repeat(7, 1fr); gap: var(--space-2); }
  .day { display: grid; height: 2.25rem; place-items: center; border-radius: var(--radius-sm); background: var(--color-surface-sunken); color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .day.on { background: var(--color-accent); color: var(--color-on-accent); }
  .day.today { outline: 2px solid var(--color-accent); outline-offset: -2px; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); }
  .stats div { display: flex; flex-direction: column; }
  .stats span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .stats b { font-size: var(--text-xl); font-variant-numeric: tabular-nums; }
  .lifts { margin: 0; padding: 0; list-style: none; }
  .lifts li { border-bottom: 1px solid var(--color-border); }
  .lifts li:last-child { border-bottom: 0; }
  .lift { display: grid; width: 100%; padding: var(--space-3) var(--space-4); border: 0; background: transparent; color: var(--color-text); text-align: left; align-items: center; grid-template-columns: 1fr auto auto; gap: var(--space-1) var(--space-3); }
  .lift:hover { background: var(--color-surface-sunken); }
  .l-name { display: flex; min-width: 0; flex-direction: column; }
  .l-name em, .l-next { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .l-next { grid-column: 1 / -1; font-variant-numeric: tabular-nums; }
  .l-num { display: flex; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }
  .status { font-size: var(--text-xs); font-weight: var(--weight-semibold); color: var(--color-text-muted); }
  .status.progressing { color: var(--color-up); }
  .status.regressing, .status.stalled { color: var(--color-down); }
  .mus { display: grid; margin: 0; padding: 0; gap: var(--space-2); list-style: none; }
  .mus li { display: grid; align-items: center; grid-template-columns: 6rem 1fr 2.5rem; gap: var(--space-3); font-size: var(--text-sm); }
  .mus b { text-align: right; font-variant-numeric: tabular-nums; }
  .bar { position: relative; height: 10px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); overflow: hidden; }
  .bar i { position: absolute; top: 0; bottom: 0; left: 0; }
  .band { background: color-mix(in oklab, var(--color-accent) 22%, transparent); }
  .fill { border-radius: inherit; background: var(--color-accent); }
  .hist { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-3); list-style: none; }
  .hist-row { display: flex; width: 100%; padding: var(--space-3) var(--space-4); flex-direction: column; gap: 2px; color: var(--color-text); text-align: left; }
  .h-top { display: flex; justify-content: space-between; gap: var(--space-2); }
  .h-top em { color: var(--color-text-muted); font-size: var(--text-sm); font-style: normal; }
  .h-meta, .h-ex { color: var(--color-text-muted); font-size: var(--text-sm); }
</style>
