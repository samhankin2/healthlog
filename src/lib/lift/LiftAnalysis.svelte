<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import LineChart from '../viz/LineChart.svelte'
  import StackedBars from '../viz/StackedBars.svelte'
  import Calendar from '../viz/Calendar.svelte'
  import SegmentBar from '../viz/SegmentBar.svelte'
  import Sparkline from '../viz/Sparkline.svelte'
  import EffectPlot from '../viz/EffectPlot.svelte'
  import Heatmap from '../viz/Heatmap.svelte'
  import { api } from '../api'
  import { app, navigate } from '../state.svelte'
  import { fmtLong, today } from '../format'
  import { shiftDay, weekStart } from '../insights'
  import { fmtDayLong } from '../viz/scale'
  import { PR_LABEL, fmtW, type BodyweightAt, type ExerciseStats } from '../lifting'
  import {
    VERDICT_LABEL, composition, consistency, factorReport, liftTrend, muscleHeat, recordEvents, restReport, routineUse, sessionForms, strengthIndex,
  } from '../liftAnalysis'
  import { lift } from '../lifting.svelte'
  import type { Exercise, InsightsPayload } from '../types'

  interface Props { stats: Map<string, ExerciseStats>; exMap: Map<string, Exercise>; bw: BodyweightAt }
  let { stats, exMap, bw }: Props = $props()

  const todayDay = today()
  const all = $derived([...stats.values()])

  // Sleep, HRV, calories etc. for "what moves your numbers" (optional).
  let insights = $state<InsightsPayload | null>(null)
  let insightsState = $state<'loading' | 'ready' | 'none'>('loading')
  onMount(async () => {
    try {
      const first = lift.workouts.filter((w) => w.sets.length).map((w) => w.day).sort()[0] ?? todayDay
      insights = await api.getInsights({ from: shiftDay(first, -45), to: todayDay })
      insightsState = 'ready'
    } catch {
      insightsState = 'none'
    }
  })

  const weights = $derived(app.weights.map((w) => ({ day: w.date, weightKg: w.weightKg })))
  const trends = $derived(all.map((s) => liftTrend(s, bw, todayDay)).filter((t): t is NonNullable<typeof t> => t !== null).sort((a, b) => b.sessions - a.sessions))
  const index = $derived(strengthIndex(all, todayDay))
  const forms = $derived(sessionForms(all, lift.workouts))
  const factors = $derived(factorReport(forms, lift.workouts, insights, weights))
  const rest = $derived(restReport(lift.workouts, exMap))
  const cons = $derived(consistency(lift.workouts, todayDay))
  const routines = $derived(routineUse(lift.routines, lift.workouts))
  const comp = $derived(composition(lift.workouts, exMap, shiftDay(todayDay, -27), todayDay))
  const heat = $derived(muscleHeat(lift.workouts, exMap, todayDay))
  const records = $derived(recordEvents(all))
  const prs30 = $derived(records.filter((r) => r.day > shiftDay(todayDay, -30)).length)
  const setsPerWeek = $derived(Math.round(heat.rows.reduce((a, r) => a + r.cells.slice(-4).reduce((b, c) => b + c.sets, 0), 0) / 4))
  const prWeeks = $derived.by(() => {
    const start = shiftDay(weekStart(todayDay), -7 * 25)
    return Array.from({ length: 26 }, (_, i) => {
      const wk = shiftDay(start, 7 * i)
      const n = records.filter((r) => r.day >= wk && r.day <= shiftDay(wk, 6)).length
      return { key: wk, heading: `Week of ${fmtDayLong(wk)}`, values: [n] }
    })
  })

  const pct = (v: number, d = 1): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}%`
  const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
  const hasLifts = $derived(lift.workouts.some((w) => w.sets.length))
</script>

<div class="view view--analysis">
  <button class="button button--secondary back" type="button" onclick={() => navigate('lifting')}><Icon name="chevron-left" size={18} /> Back</button>
  <header class="view-header">
    <p class="eyebrow"><Icon name="trending-up" size={14} /> Lifting analysis</p>
    <h1 class="view-title">How you're progressing</h1>
    <p class="view-subtitle">Built from every set you've logged. Ranges show how sure each number is.</p>
  </header>

  {#if !hasLifts}
    <p class="muted">Log a few sessions and your analysis builds up here.</p>
  {:else}
    <!-- Headline -->
    <div class="tiles">
      <div class="tile"><span>Strength index, {index?.sinceStart ? 'since you started' : '12 weeks'}</span><b>{index?.change12w !== null && index?.change12w !== undefined ? pct(index.change12w) : '—'}</b><em>{index ? `${index.lifts} lifts combined` : 'Needs 3+ sessions of a lift'}</em></div>
      <div class="tile"><span>Sessions / week</span><b>{cons.perWeek8.toFixed(1)}</b><em>last 8 weeks · {cons.weekStreak}-week streak</em></div>
      <div class="tile"><span>Hard sets / week</span><b>{setsPerWeek}</b><em>last 4 weeks</em></div>
      <div class="tile"><span>Records</span><b>{prs30}</b><em>last 30 days · {records.length} all time</em></div>
    </div>

    <!-- Strength index -->
    {#if index && index.points.length >= 2}
      <section class="card pad" aria-labelledby="idx-title">
        <h2 class="sec" id="idx-title">Strength index</h2>
        <p class="lede">Every lift's level compared with where it started (100), averaged so a small lift counts as much as a big one.</p>
        <LineChart label="Strength index per week, 100 = where each lift started" from={index.points[0].day} to={todayDay} line={index.points.map((p) => ({ day: p.day, value: p.value }))} lineLabel="Strength index" include={[100]} format={(v) => String(Math.round(v))} height={190} />
      </section>
    {/if}

    <!-- Per lift -->
    <section class="card pad" aria-labelledby="lifts-title">
      <h2 class="sec" id="lifts-title">Progress by lift</h2>
      <p class="lede">Rate of change of your estimated max over the last 4 months, from a trend that ignores one-off good or bad days. The range is 90 % sure.</p>
      {#if trends.length}
        <ul class="trends">
          {#each trends as t (t.exercise.id)}
            <li>
              <button class="trend" type="button" onclick={() => navigate('lifting', `exercise/${t.exercise.id}`)}>
                <span class="t-head">
                  <b>{t.exercise.name}</b>
                  <span class="pill {t.verdict}">{VERDICT_LABEL[t.verdict]}</span>
                </span>
                <span class="t-body">
                  <span class="t-rate"><b>{pct(t.rate)}</b> / month{#if t.ci}<em>range {pct(t.ci[0])} to {pct(t.ci[1])}</em>{/if}</span>
                  <Sparkline points={t.points.slice(-16)} width={84} height={30} />
                </span>
                <span class="t-facts">
                  {#if t.noise !== null}<span>Sessions swing ±{t.noise.toFixed(1)}%</span>{/if}
                  {#if t.relative !== null}<span>{t.relative.toFixed(2)}× bodyweight</span>{/if}
                  {#if t.projection}<span>8 weeks: ~{Math.round(t.projection.value)} {t.unit} ({Math.round(t.projection.lo)}–{Math.round(t.projection.hi)})</span>{/if}
                  {#if t.change}<span class="chg">{t.change.after < t.change.before ? 'Slowed' : 'Sped up'} from {fmtLong(t.change.day)}: {pct(t.change.before)} → {pct(t.change.after)} / month</span>{/if}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="muted">A lift needs 4 sessions over at least 2 weeks for a trend.</p>
      {/if}
    </section>

    <!-- Factors -->
    <section class="card pad" aria-labelledby="fx-title">
      <h2 class="sec" id="fx-title">What moves your numbers</h2>
      <p class="lede">Each session's lifts compared with what your trend expected that day ("form"), split by what was going on. A dot right of zero means you lifted better on those days.</p>
      {#if factors.effects.length}
        <EffectPlot
          label="Difference in session form by factor, with 90 % ranges"
          rows={factors.effects.map((e) => ({ key: e.key, label: e.label, detail: `${e.highLabel} (${e.nHigh}) vs ${e.lowLabel} (${e.nLow})`, diff: e.diff, lo: e.ci?.[0] ?? e.diff, hi: e.ci?.[1] ?? e.diff, clear: e.clear }))}
        />
        <p class="note">From {factors.sessions} sessions. Highlighted rows are unlikely to be chance, but this is correlation, not proof: a busy week can cut both sleep and performance.</p>
      {:else}
        <p class="muted">Not enough sessions yet. Each comparison needs at least 5 sessions on each side, and only lifts with 5+ sessions count.</p>
      {/if}
      {#if factors.waiting.length}
        <p class="note">Waiting for more data: {factors.waiting.map((w) => w.label.toLowerCase()).join(', ')}.</p>
      {/if}
      {#if insightsState === 'none'}<p class="note">Couldn't load sleep, HRV and calorie data, so only training factors are shown.</p>{/if}
    </section>

    <!-- Rest -->
    <section class="card pad" aria-labelledby="rest-title">
      <h2 class="sec" id="rest-title">Rest between sets</h2>
      <p class="lede">Time between logging one set and the next of the same lift, and how many of your reps you kept on the next set at the same weight.</p>
      {#if rest.pairs >= 6}
        <ul class="bars">
          {#each rest.buckets as b (b.label)}
            <li>
              <span class="b-label">{b.label}</span>
              <span class="b-track" aria-hidden="true"><span style:width="{b.kept === null ? 0 : Math.min(100, b.kept)}%"></span></span>
              <span class="b-val">{b.kept === null ? '—' : `${Math.round(b.kept)}% kept`}<em>{b.n} sets</em></span>
            </li>
          {/each}
        </ul>
        {#if rest.byLift.length}
          <p class="note">Typical rest: {rest.byLift.slice(0, 6).map((r) => `${r.exercise.name} ${mmss(r.medianS)}`).join(' · ')}</p>
        {/if}
      {:else}
        <p class="muted">Needs a few more sessions logged live (sets logged as you go) to measure rest.</p>
      {/if}
    </section>

    <!-- Consistency -->
    <section class="card pad" aria-labelledby="cons-title">
      <h2 class="sec" id="cons-title">Consistency</h2>
      <p class="lede">{Math.round(cons.activeWeeksPct)}% of weeks with at least one session since you started logging.</p>
      <StackedBars label="Lifting sessions per week, last 26 weeks" bars={cons.weeks.map((w) => ({ key: w.week, heading: `Week of ${fmtDayLong(w.week)}`, values: [w.sessions] }))} series={[{ label: 'Sessions', color: 'var(--viz-strength)' }]} from={cons.weeks[0].week} to={todayDay} keyDays={7} height={150} />
      <h3 class="sub">Training days</h3>
      <Calendar label="Hard sets per lifting day, last 6 months" values={cons.calendar} from={shiftDay(todayDay, -181)} to={todayDay} format={(v) => `${v} sets`} />
      {#each routines as r (r.routine.id)}
        <h3 class="sub">{r.routine.name}: {Math.round(r.completion)}% done on average</h3>
        <p class="note">Last {r.sessions} session{r.sessions === 1 ? '' : 's'} named "{r.routine.name}". Stand-ins count as done.</p>
        <ul class="bars">
          {#each r.slots as s (s.exerciseId)}
            <li>
              <span class="b-label">{exMap.get(s.exerciseId)?.name ?? 'Exercise'}</span>
              <span class="b-track" aria-hidden="true"><span style:width="{(s.done / r.sessions) * 100}%"></span></span>
              <span class="b-val">{s.done}/{r.sessions}{#if s.swapped}<em>{s.swapped} swapped</em>{/if}</span>
            </li>
          {/each}
        </ul>
      {/each}
    </section>

    <!-- Composition -->
    <section class="card pad" aria-labelledby="comp-title">
      <h2 class="sec" id="comp-title">What you train</h2>
      {#if heat.rows.length}
        <Heatmap label="Hard sets per muscle per week, last 12 weeks" weeks={heat.weeks} rows={heat.rows.map((r) => ({ key: r.muscle, label: r.label, values: r.cells.map((c) => c.sets) }))} />
        <p class="note">10–20 hard sets a week per muscle is where most hypertrophy research lands.</p>
      {/if}
      {#if comp.sets}
        <h3 class="sub">Last 4 weeks · {comp.sets} hard sets</h3>
        <div class="segs">
          <div><span class="seg-label">Rep ranges</span><SegmentBar label="Hard sets by reps" parts={[{ label: '1–5 reps (strength)', value: comp.zones.strength, color: 'var(--viz-run)', ink: 'light' }, { label: '6–12 reps (hypertrophy)', value: comp.zones.hypertrophy, color: 'var(--viz-strength)', ink: 'dark' }, { label: '13+ reps (endurance)', value: comp.zones.endurance, color: 'var(--viz-swim)', ink: 'dark' }]} format={(v) => `${v} sets`} /></div>
          {#if comp.push + comp.pull}
            <div><span class="seg-label">Push vs pull · {comp.pull ? (comp.push / comp.pull).toFixed(1) : '∞'} : 1</span><SegmentBar label="Push vs pull sets" parts={[{ label: 'Push (chest, shoulders, triceps)', value: comp.push, color: 'var(--viz-run)', ink: 'light' }, { label: 'Pull (back, biceps)', value: comp.pull, color: 'var(--viz-ride)', ink: 'dark' }]} format={(v) => `${v} sets`} /></div>
          {/if}
          {#if comp.upper + comp.lower}
            <div><span class="seg-label">Upper vs lower body</span><SegmentBar label="Upper vs lower body sets" parts={[{ label: 'Upper', value: comp.upper, color: 'var(--viz-run)', ink: 'light' }, { label: 'Lower', value: comp.lower, color: 'var(--viz-ride)', ink: 'dark' }]} format={(v) => `${v} sets`} /></div>
          {/if}
        </div>
        <p class="note">
          {#if comp.pull && comp.push / comp.pull > 1.3}You do noticeably more pushing than pulling. Matching them roughly 1:1 is the usual advice for shoulder health.{:else if comp.push + comp.pull}Push and pull are reasonably balanced.{/if}
          Effort logged on {Math.round(comp.rpeShare)}% of sets{comp.rpeMean !== null ? ` (average RPE ${comp.rpeMean.toFixed(1)})` : ''}{comp.rpeShare < 50 ? '. Logging RPE more often sharpens your targets' : ''}. {Math.round(comp.failureShare)}% taken to failure.
        </p>
      {/if}
    </section>

    <!-- Records -->
    <section class="card pad" aria-labelledby="rec-title">
      <h2 class="sec" id="rec-title">Records</h2>
      {#if records.length}
        <StackedBars label="Records per week, last 26 weeks" bars={prWeeks} series={[{ label: 'Records', color: 'var(--viz-strength)' }]} from={prWeeks[0].key} to={todayDay} keyDays={7} height={120} />
        <ul class="recs">
          {#each records.slice(0, 8) as r, i (i)}
            <li><b>{r.exercise.name}</b> {r.exercise.equipment === 'bodyweight' ? (r.weightKg ? `BW+${fmtW(r.weightKg)}` : 'BW') : `${fmtW(r.weightKg)} kg`} × {r.reps}<em>{r.kinds.map((k) => PR_LABEL[k as keyof typeof PR_LABEL]).join(', ')} · {fmtLong(r.day)}</em></li>
          {/each}
        </ul>
      {:else}
        <p class="muted">Records start counting from your second session of a lift.</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .back { align-self: flex-start; }
  .eyebrow { display: inline-flex; margin: 0 0 var(--space-1); align-items: center; gap: 6px; color: var(--color-accent); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .card { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .pad { display: flex; padding: var(--space-4); flex-direction: column; gap: var(--space-3); }
  .sec { margin: 0; font-size: var(--text-md); }
  .sub { margin: var(--space-2) 0 0; font-size: var(--text-sm); }
  .lede, .muted, .note { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .note { font-size: var(--text-xs); }
  .tiles { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .tile { display: flex; padding: var(--space-3) var(--space-4); flex-direction: column; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
  .tile span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .tile b { font-size: var(--text-2xl); font-variant-numeric: tabular-nums; letter-spacing: -0.03em; }
  .tile em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .trends { display: flex; margin: 0; padding: 0; flex-direction: column; list-style: none; }
  .trends li + li { border-top: 1px solid var(--color-border); }
  .trend { display: flex; width: 100%; padding: var(--space-3) 0; flex-direction: column; gap: 4px; border: 0; background: transparent; color: var(--color-text); text-align: left; font-variant-numeric: tabular-nums; }
  .t-head, .t-body { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .t-rate { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-2); font-size: var(--text-sm); }
  .t-rate b { font-size: var(--text-lg); }
  .t-rate em, .t-facts { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .t-facts { display: flex; flex-wrap: wrap; gap: 2px var(--space-3); }
  .chg { color: var(--color-text); }
  .pill { padding: 2px 8px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); font-size: var(--text-xs); font-weight: var(--weight-bold); white-space: nowrap; }
  .pill.gaining { background: var(--color-up-soft); color: var(--color-up); }
  .pill.losing { background: var(--color-down-soft); color: var(--color-down); }
  .bars { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-2); list-style: none; }
  .bars li { display: grid; grid-template-columns: minmax(0, 7.5rem) 1fr auto; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
  .b-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .b-track { height: 10px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .b-track span { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--viz-strength); }
  .b-val { display: flex; min-width: 4.5rem; flex-direction: column; align-items: flex-end; font-variant-numeric: tabular-nums; }
  .b-val em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .segs { display: flex; flex-direction: column; gap: var(--space-3); }
  .seg-label { display: block; margin-bottom: 4px; color: var(--color-text-muted); font-size: var(--text-xs); }
  .recs { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-2); list-style: none; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .recs em { display: block; color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  @media (min-width: 43.75rem) { .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
</style>
