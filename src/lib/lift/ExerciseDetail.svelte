<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import Sheet from '../components/Sheet.svelte'
  import SegmentedControl from '../components/SegmentedControl.svelte'
  import LineChart from '../viz/LineChart.svelte'
  import StackedBars from '../viz/StackedBars.svelte'
  import { navigate } from '../state.svelte'
  import { showToast } from '../toast.svelte'
  import { fmtLong, today } from '../format'
  import { shiftDay } from '../insights'
  import { fmtDayLong } from '../viz/scale'
  import {
    EQUIPMENT, EQUIPMENT_LABEL, MUSCLES, MUSCLE_LABEL, PR_LABEL, STATUS_LABEL, defaultIncrement, fmtSets, fmtTonnage, fmtW,
    type ExerciseStats,
  } from '../lifting'
  import { editExercise, setArchived } from '../lifting.svelte'
  import type { Equipment, Muscle } from '../types'

  interface Props { stats: ExerciseStats }
  let { stats }: Props = $props()

  const ex = $derived(stats.exercise)
  const todayDay = today()
  const RANGES = [{ value: '90', label: '3M' }, { value: '182', label: '6M' }, { value: '365', label: '1Y' }, { value: '0', label: 'All' }]
  let range = $state(localStorage.getItem('healthlog.lifting.range') ?? '182')
  function setRange(v: string): void {
    range = v
    localStorage.setItem('healthlog.lifting.range', v)
  }
  const firstDay = $derived(stats.sessions[0]?.day ?? todayDay)
  const from = $derived.by(() => {
    const span = Number(range)
    if (!span) return firstDay < todayDay ? firstDay : shiftDay(todayDay, -30)
    const f = shiftDay(todayDay, -(span - 1))
    return f
  })
  const shown = $derived(stats.sessions.filter((s) => s.day >= from))
  const isReps = $derived(stats.metric === 'reps')
  const unit = $derived(isReps ? 'reps' : 'kg')
  const raw = $derived(shown.map((s) => ({ day: s.day, value: s.best })))
  const prLine = $derived.by(() => {
    let best = 0
    const before = stats.sessions.filter((s) => s.day < from)
    for (const s of before) best = Math.max(best, s.best ?? 0)
    return shown.map((s) => { best = Math.max(best, s.best ?? 0); return { day: s.day, value: best || null } })
  })
  const volumeBars = $derived(shown.filter((s) => s.volume > 0).map((s) => ({ key: s.day + s.workoutId, heading: `${fmtDayLong(s.day)} · ${s.hard.length} sets`, values: [s.volume] })))
  const history = $derived([...stats.sessions].reverse())
  const fmtBest = (v: number): string => String(Math.round(v))

  /* ---------- edit ---------- */
  let editOpen = $state(false)
  let name = $state('')
  let muscle = $state<Muscle>('other')
  let equipment = $state<Equipment>('barbell')
  let increment = $state('')
  let saving = $state(false)
  function openEdit(): void {
    name = ex.name
    muscle = ex.muscle
    equipment = ex.equipment
    increment = ex.incrementKg === null ? '' : String(ex.incrementKg)
    editOpen = true
  }
  async function save(): Promise<void> {
    saving = true
    try {
      const inc = increment.trim() === '' ? null : Number(increment.replace(',', '.'))
      if (inc !== null && !(inc >= 0.25 && inc <= 50)) throw new Error('Weight step must be between 0.25 and 50 kg.')
      await editExercise(ex.id, { name: name.trim(), muscle, equipment, incrementKg: inc })
      editOpen = false
      showToast('Exercise updated.', 'success')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not save. Are you online?', 'error')
    } finally {
      saving = false
    }
  }
  async function toggleArchive(): Promise<void> {
    try {
      await setArchived(ex.id, !ex.archived)
      editOpen = false
      showToast(ex.archived ? 'Hidden from the exercise list. History is kept.' : 'Back in the exercise list.')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not save. Are you online?', 'error')
    }
  }
</script>

<div class="view view--exercise">
  <button class="button button--secondary back" type="button" onclick={() => navigate('lifting')}><Icon name="chevron-left" size={18} /> Back</button>
  <header class="view-header head">
    <div>
      <p class="eyebrow"><Icon name="dumbbell" size={14} /> {MUSCLE_LABEL[ex.muscle]} · {EQUIPMENT_LABEL[ex.equipment]}{ex.archived ? ' · hidden' : ''}</p>
      <h1 class="view-title">{ex.name}</h1>
    </div>
    <button class="button button--secondary" type="button" onclick={openEdit}><Icon name="edit" size={16} /> Edit</button>
  </header>

  {#if !stats.sessions.length}
    <p class="muted">No sets logged for this exercise yet. Add it to a workout and its progress builds up here.</p>
  {:else}
    <div class="kpis">
      <div class="kpi"><span>{isReps ? 'Best reps' : 'Best e1RM'}</span><b>{stats.best ? fmtBest(stats.best.value) : '—'}<small>{unit}</small></b>{#if stats.best}<em>{isReps ? '' : `${fmtW(stats.best.weightKg)} × ${stats.best.reps} · `}{fmtLong(stats.best.day)}</em>{/if}</div>
      {#if stats.heaviest}<div class="kpi"><span>Heaviest</span><b>{fmtW(stats.heaviest.weightKg)}<small>kg</small></b><em>× {stats.heaviest.reps} · {fmtLong(stats.heaviest.day)}</em></div>{/if}
      {#if stats.bestVolume}<div class="kpi"><span>Best session</span><b>{fmtTonnage(stats.bestVolume.value)}</b><em>{fmtLong(stats.bestVolume.day)}</em></div>{/if}
      <div class="kpi"><span>Sessions</span><b>{stats.sessions.length}</b><em>last {stats.lastDay ? fmtLong(stats.lastDay) : '—'}</em></div>
    </div>

    <section class="card pad status-card" data-status={stats.status}>
      <div class="st-top">
        <span class="st-pill">{STATUS_LABEL[stats.status]}</span>
        {#if stats.change !== null}<span class="st-change">{stats.change >= 0 ? '+' : ''}{stats.change.toFixed(1)}% vs the 4 weeks before</span>{/if}
      </div>
      <p class="st-copy">
        {#if stats.status === 'stalled'}No new best in your last {stats.sessionsSinceBest} sessions. Try a different rep range for a few weeks, check sleep and food, or take a lighter week.
        {:else if stats.status === 'regressing'}Your best this month is below last month. Usually fatigue, a cut, or time off — it comes back.
        {:else if stats.status === 'progressing'}Still climbing. Keep doing what you are doing.
        {:else if stats.status === 'steady'}Holding. {stats.sessionsSinceBest} session{stats.sessionsSinceBest === 1 ? '' : 's'} since your best.
        {:else}Log a couple more sessions to see a trend.{/if}
      </p>
      {#if stats.next}
        <p class="st-next"><span>Next time</span><b>{ex.equipment === 'bodyweight' ? (stats.next.weightKg ? `BW+${fmtW(stats.next.weightKg)}` : 'BW') : `${fmtW(stats.next.weightKg)} kg`} × {stats.next.reps.join(', ')}</b><em>{stats.next.note}</em></p>
      {/if}
    </section>

    <section class="card pad">
      <div class="chart-head">
        <h2>{isReps ? 'Best set (reps)' : 'Estimated 1RM'}</h2>
        <div class="range"><SegmentedControl ariaLabel="Chart range" options={RANGES} value={range} onchange={setRange} /></div>
      </div>
      {#if raw.length >= 2}
        <LineChart label="{ex.name}: {isReps ? 'best reps' : 'estimated one-rep max'} per session" {from} to={todayDay} {raw} line={prLine} step rawLabel="Session best" lineLabel="All-time best" format={(v) => `${Math.round(v)} ${unit}`} height={200} />
        <p class="note">Dots: each session’s best set. Line: your all-time best, stepping up at every record.</p>
      {:else}
        <p class="muted">Two sessions in this range are needed for a chart.</p>
      {/if}
    </section>

    {#if volumeBars.length >= 2}
      <section class="card pad">
        <div class="chart-head"><h2>Volume per session</h2></div>
        <StackedBars label="{ex.name}: kilograms lifted per session" bars={volumeBars} series={[{ label: 'Volume', color: 'var(--viz-strength)' }]} {from} to={todayDay} format={(v) => fmtTonnage(v)} height={170} />
        <p class="note">Weight × reps over the hard sets (warm-ups excluded).</p>
      </section>
    {/if}

    {#if stats.repMaxes.length && !isReps}
      <section class="card pad">
        <div class="chart-head"><h2>Best weight for reps</h2></div>
        <table class="rm">
          <caption class="sr-only">Heaviest weight lifted for at least this many reps</caption>
          <thead><tr><th scope="col">Reps</th><th scope="col" class="num">Best</th><th scope="col" class="num">When</th></tr></thead>
          <tbody>
            {#each stats.repMaxes as r (r.reps)}<tr><th scope="row">{r.reps}+</th><td class="num">{fmtW(r.weightKg)} kg</td><td class="num">{fmtLong(r.day)}</td></tr>{/each}
          </tbody>
        </table>
      </section>
    {/if}

    <section aria-labelledby="sessions-title">
      <h2 class="sec" id="sessions-title">Sessions</h2>
      <ul class="sessions">
        {#each history as s (s.workoutId)}
          <li>
            <button class="sess card" type="button" onclick={() => navigate('lifting', `log/${s.workoutId}`)}>
              <span class="s-top"><b>{fmtLong(s.day)}</b>{#if s.best !== null}<em>{isReps ? `${s.best} reps` : `e1RM ${Math.round(s.best)} kg`}</em>{/if}</span>
              <span class="s-sets">{fmtSets(s.hard.length ? s.hard : s.sets, ex)}</span>
              {#if s.prs.length}<span class="s-pr"><Icon name="award" size={13} /> {[...new Set(s.prs.flatMap((p) => p.kinds))].map((k) => PR_LABEL[k]).join(' · ')}</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<Sheet open={editOpen} title="Edit exercise" onclose={() => (editOpen = false)}>
  <div class="form">
    <label class="f"><span>Name</span><input type="text" maxlength="80" bind:value={name} /></label>
    <label class="f"><span>Muscle</span><select bind:value={muscle}>{#each MUSCLES as m (m.key)}<option value={m.key}>{m.label}</option>{/each}</select></label>
    <label class="f"><span>Equipment</span><select bind:value={equipment}>{#each EQUIPMENT as e (e.key)}<option value={e.key}>{e.label}</option>{/each}</select></label>
    <label class="f"><span>Weight step (kg)</span><input type="text" inputmode="decimal" placeholder="Default {fmtW(defaultIncrement({ equipment, incrementKg: null }))}" bind:value={increment} /><em>Used by the −/+ buttons and the next-time target.</em></label>
    <button class="button button--secondary" type="button" onclick={toggleArchive}>{ex.archived ? 'Show in the exercise list again' : 'Hide from the exercise list'}</button>
  </div>
  {#snippet actions()}
    <button class="button button--secondary" type="button" onclick={() => (editOpen = false)}>Cancel</button>
    <button class="button button--primary" type="button" disabled={saving || !name.trim()} onclick={save}>Save</button>
  {/snippet}
</Sheet>

<style>
  .back { align-self: flex-start; }
  .head { flex-direction: row; align-items: flex-end; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .eyebrow { display: inline-flex; margin: 0 0 var(--space-1); align-items: center; gap: 6px; color: var(--color-accent); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .card { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .pad { padding: var(--space-4); }
  .muted, .note { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .note { margin-top: var(--space-2); font-size: var(--text-xs); }
  .kpis { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .kpi { display: flex; padding: var(--space-3) var(--space-4); flex-direction: column; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
  .kpi span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .kpi b { font-size: var(--text-2xl); font-variant-numeric: tabular-nums; letter-spacing: -0.03em; }
  .kpi small { margin-left: 3px; color: var(--color-text-muted); font-size: var(--text-xs); letter-spacing: 0; }
  .kpi em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; font-variant-numeric: tabular-nums; }
  .status-card { display: flex; flex-direction: column; gap: var(--space-2); }
  .st-top { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .st-pill { padding: 3px 10px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); font-size: var(--text-sm); font-weight: var(--weight-bold); }
  [data-status='progressing'] .st-pill { background: var(--color-up-soft); color: var(--color-up); }
  [data-status='stalled'] .st-pill, [data-status='regressing'] .st-pill { background: var(--color-down-soft); color: var(--color-down); }
  .st-change { color: var(--color-text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .st-copy { margin: 0; font-size: var(--text-sm); }
  .st-next { display: flex; margin: 0; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-2); font-variant-numeric: tabular-nums; }
  .st-next span { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); text-transform: uppercase; letter-spacing: var(--tracking-label); }
  .st-next b { color: var(--color-accent); }
  .st-next em { flex-basis: 100%; color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .chart-head { display: flex; margin-bottom: var(--space-3); align-items: center; justify-content: space-between; gap: var(--space-2); flex-wrap: wrap; }
  .chart-head h2, .sec { margin: 0; font-size: var(--text-md); }
  .sec { margin-bottom: var(--space-3); }
  .range { min-width: 12rem; }
  .rm { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; font-size: var(--text-sm); }
  .rm th, .rm td { padding: var(--space-2) 0; border-bottom: 1px solid var(--color-border); text-align: left; }
  .rm thead th { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .rm .num { text-align: right; }
  .sessions { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-2); list-style: none; }
  .sess { display: flex; width: 100%; padding: var(--space-3) var(--space-4); flex-direction: column; gap: 2px; color: var(--color-text); text-align: left; font-variant-numeric: tabular-nums; }
  .s-top { display: flex; justify-content: space-between; gap: var(--space-2); }
  .s-top em, .s-sets { color: var(--color-text-muted); font-size: var(--text-sm); font-style: normal; }
  .s-pr { display: inline-flex; align-items: center; gap: 4px; color: var(--color-warning); font-size: var(--text-xs); font-weight: var(--weight-bold); }
  .form { display: flex; flex-direction: column; gap: var(--space-4); }
  .f { display: flex; flex-direction: column; gap: var(--space-1); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .f input, .f select { min-height: var(--touch-target); padding: 0 var(--space-3); border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font-size: 1rem; font-weight: var(--weight-regular); }
  .f em { font-style: normal; font-weight: var(--weight-regular); }
  @media (min-width: 43.75rem) { .kpis { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
</style>
