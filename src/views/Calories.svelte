<script lang="ts" module>
  // Survives tab switches within a session; the weight chart keeps its own range.
  let rememberedRange = 30
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import SegmentedControl from '../lib/components/SegmentedControl.svelte'
  import StatTile from '../lib/components/StatTile.svelte'
  import MacroBar from '../lib/components/MacroBar.svelte'
  import IntakeCarousel, { type CarouselSlide } from '../lib/panels/IntakeCarousel.svelte'
  import { actions, app, navigate } from '../lib/state.svelte'
  import { fmtNumber, fmtShort, fmtTime, fmtWithDay, today } from '../lib/format'
  import { KCAL_PER_KG, ON_TARGET_TOLERANCE, summarize, trimLeadingEmpty, weekStartOf, weeklyRollups } from '../lib/intakeStats'
  import type { Intake, IntakeHistoryDay } from '../lib/types'

  const RANGES = [
    { value: '7', label: '7d' },
    { value: '30', label: '30d' },
    { value: '90', label: '90d' },
    { value: '365', label: '1y' },
    { value: '0', label: 'All' },
  ]

  const todayDay = today()
  const thisWeek = weekStartOf(todayDay)
  let range = $state(rememberedRange)
  let intake = $state<Intake | null>(null)
  let history = $state<IntakeHistoryDay[]>([])
  let loading = $state(true)
  let error = $state('')
  let requestId = 0

  let profile = $derived(app.profile)
  let target = $derived(intake?.kcalTarget ?? profile?.kcalTarget ?? null)
  let todayMeals = $derived(app.meals.filter((meal) => meal.day === todayDay).sort((a, b) => a.eatenAt.localeCompare(b.eatenAt)))
  let remaining = $derived(intake && target !== null ? Math.round(target - intake.kcal) : null)
  let todayPct = $derived(intake && target ? Math.round((intake.kcal / target) * 100) : null)

  /** The window shown: N completed days + today, or everything since the first log. */
  let series = $derived(range === 0 ? trimLeadingEmpty(history) : history)
  let summary = $derived(summarize(series, target, todayDay))
  let weeks = $derived(weeklyRollups(series, target))
  let rangeLabel = $derived(range === 0 ? 'all time' : `the last ${range} days`)

  let slides = $derived<CarouselSlide[]>([
    { metric: 'kcal', label: 'Calories', unit: 'kcal', target, average: summary.avgKcal, colorVar: '--color-accent', softVar: '--color-accent-soft' },
    { metric: 'proteinG', label: 'Protein', unit: 'g', target: profile?.proteinG ?? null, average: summary.avgProteinG, colorVar: '--color-protein', softVar: '--color-protein-soft' },
    { metric: 'carbsG', label: 'Carbs', unit: 'g', target: profile?.carbG ?? null, average: summary.avgCarbsG, colorVar: '--color-carb', softVar: '--color-carb-soft' },
    { metric: 'fatG', label: 'Fat', unit: 'g', target: profile?.fatG ?? null, average: summary.avgFatG, colorVar: '--color-fat', softVar: '--color-fat-soft' },
  ])

  let macroTargets = $derived.by(() => {
    if (!intake) return []
    return [
      { key: 'protein', label: 'Protein', eaten: intake.proteinG, goal: profile?.proteinG ?? null },
      { key: 'carb', label: 'Carbs', eaten: intake.carbG, goal: profile?.carbG ?? null },
      { key: 'fat', label: 'Fat', eaten: intake.fatG, goal: profile?.fatG ?? null },
    ]
  })
  let hasMacroTargets = $derived(macroTargets.some((macro) => macro.goal !== null && macro.goal > 0))

  onMount(() => {
    void load()
    void actions.loadMeals(todayDay).catch(() => { /* The meal list shows what the shell already holds. */ })
  })

  async function load(): Promise<void> {
    const id = ++requestId
    loading = true
    error = ''
    try {
      const result = await actions.loadIntakeHistory(range === 0 ? 3650 : range + 1)
      if (id !== requestId) return
      intake = result.intake
      history = result.history
    } catch (cause) {
      if (id !== requestId) return
      error = cause instanceof Error ? cause.message : 'Could not load your calorie history.'
    } finally {
      if (id === requestId) loading = false
    }
  }

  function changeRange(value: string): void {
    range = Number(value)
    rememberedRange = range
    void load()
  }

  function signedKcal(value: number | null): string {
    if (value === null) return '—'
    const rounded = Math.round(value)
    return `${rounded > 0 ? '+' : rounded < 0 ? '−' : ''}${fmtNumber(Math.abs(rounded), 0)}`
  }

  function pct(value: number, goal: number | null): number {
    return goal && goal > 0 ? Math.min(100, Math.max(0, (value / goal) * 100)) : 0
  }

  function sourceLabel(source: string): string {
    if (source === 'ai') return 'AI estimate'
    if (source === 'import') return 'Imported'
    if (source === 'saved_food') return 'Saved food'
    return 'Manual'
  }
</script>

<div class="view view--calories">
  <header class="view-header calories-header">
    <div>
      <h1 class="view-title">Calories</h1>
      <p class="view-subtitle">Today in detail, and how your intake adds up over time.</p>
    </div>
    <button class="button button--primary" type="button" onclick={() => navigate('chat')}><Icon name="chat" size={19} /> Log food</button>
  </header>

  {#if error && !intake}
    <div class="form-error" role="alert"><Icon name="alert" size={19} /><span>{error}</span></div>
    <button class="button button--secondary retry" type="button" onclick={load}>Try again</button>
  {:else if !intake}
    <div class="placeholder-panel loading-panel" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading calories</span></div>
  {:else}
    <!-- ───────────── Today ───────────── -->
    <section class="today-summary" aria-labelledby="today-title">
      <div class="today-main">
        <h2 class="summary-label" id="today-title">Today · {fmtWithDay(todayDay)}</h2>
        <strong class="today-kcal">{fmtNumber(intake.kcal, 0)} <span>kcal{target !== null ? ` of ${fmtNumber(target, 0)}` : ''}</span></strong>
        {#if remaining !== null && todayPct !== null}
          <div
            class="progress-track"
            class:over={remaining < 0}
            role="progressbar"
            aria-label="Calories eaten against today's target"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={Math.min(100, todayPct)}
            aria-valuetext={`${todayPct}% of target`}
          >
            <span style:width={`${Math.min(100, todayPct)}%`}></span>
          </div>
          <p class="summary-note">
            {#if remaining >= 0}
              <strong>{fmtNumber(remaining, 0)} kcal</strong> remaining · {todayPct}% of target
            {:else}
              <Icon name="alert" size={15} /> <strong>{fmtNumber(Math.abs(remaining), 0)} kcal</strong> over target · {todayPct}%
            {/if}
          </p>
        {:else}
          <p class="summary-note">Set a daily calorie target in Settings to track what remains.</p>
        {/if}
      </div>

      <div class="today-macros">
        {#if hasMacroTargets}
          <ul class="macro-targets" aria-label="Macros against today's targets">
            {#each macroTargets as macro (macro.key)}
              <li>
                <div class="macro-target-head">
                  <span><span class="macro-dot macro-segment--{macro.key}" aria-hidden="true"></span>{macro.label}</span>
                  <span class="macro-target-value">
                    {fmtNumber(macro.eaten, 0)}{macro.goal ? ` / ${fmtNumber(macro.goal, 0)}` : ''} g
                  </span>
                </div>
                {#if macro.goal}
                  <div class="macro-target-track" aria-hidden="true"><span class="macro-segment--{macro.key}" style:width={`${pct(macro.eaten, macro.goal)}%`}></span></div>
                  <span class="macro-target-note">
                    {macro.eaten >= macro.goal ? `Target reached${macro.eaten > macro.goal ? ` (+${fmtNumber(macro.eaten - macro.goal, 0)} g)` : ''}` : `${fmtNumber(macro.goal - macro.eaten, 0)} g to go`}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <MacroBar protein={intake.proteinG} carbs={intake.carbG} fat={intake.fatG} />
          <p class="card-note">Add macro targets in Settings to track each one against a goal.</p>
        {/if}
      </div>
    </section>

    <section class="metric-card meals-card" aria-labelledby="today-meals-title">
      <div class="metric-card-header">
        <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="food" size={20} /></span><h2 class="metric-card-title" id="today-meals-title">Today’s meals</h2></div>
        <span class="badge">{todayMeals.length} logged</span>
      </div>
      <div class="metric-card-content">
        {#if todayMeals.length === 0}
          <p class="quiet-empty">Nothing logged yet today. Describe a meal in Chat and save it to see it here.</p>
        {:else}
          <ul class="today-meal-list">
            {#each todayMeals as meal (meal.id)}
              <li>
                <span class="meal-time">{fmtTime(meal.eatenAt) || '—'}</span>
                <span class="meal-copy">
                  <strong>{meal.name}</strong>
                  <span>P {fmtNumber(meal.proteinG, 0)} g · C {fmtNumber(meal.carbsG, 0)} g · F {fmtNumber(meal.fatG, 0)} g · {sourceLabel(meal.source)}</span>
                </span>
                <span class="meal-kcal">{fmtNumber(meal.kcal, 0)} <span>kcal</span></span>
              </li>
            {/each}
          </ul>
          <button class="button button--secondary edit-link" type="button" onclick={() => navigate('history')}>Edit meals in History <Icon name="chevron-right" size={17} /></button>
        {/if}
      </div>
    </section>

    <!-- ───────────── History ───────────── -->
    <section class="metric-card history-card" aria-labelledby="intake-history-title">
      <div class="metric-card-header chart-header">
        <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="activity" size={20} /></span><h2 class="metric-card-title" id="intake-history-title">Intake history</h2></div>
        <span class="badge">{summary.loggedDays} of {summary.windowDays} days logged</span>
      </div>
      <div class="metric-card-content">
        <div class="range-wrap"><SegmentedControl options={RANGES} value={String(range)} ariaLabel="Calorie history range" onchange={changeRange} /></div>
        {#if error}<div class="form-error" role="alert"><Icon name="alert" size={19} /><span>{error}</span></div>{/if}
        <div class="chart-wrap" aria-busy={loading}>
          {#if series.length === 0}
            <p class="quiet-empty centered">No meals logged yet. Your history will build up here.</p>
          {:else}
            <IntakeCarousel days={series} {slides} {todayDay} />
          {/if}
        </div>
      </div>
    </section>

    <section class="metrics-section" aria-labelledby="intake-metrics-title">
      <div class="section-heading"><h2 id="intake-metrics-title">Over {rangeLabel}</h2><span>Completed days only — today is excluded</span></div>
      {#if summary.loggedDays === 0}
        <p class="quiet-empty">No completed days with meals in this range yet.</p>
      {:else}
        <div class="stat-grid">
          <StatTile label="Average intake" value={fmtNumber(summary.avgKcal ?? 0, 0)} unit="kcal/day" sublabel="On days you logged" tone="accent" />
          {#if summary.avgVsTarget !== null}
            <StatTile label="Versus target" value={signedKcal(summary.avgVsTarget)} unit="kcal/day" sublabel={summary.avgVsTarget <= 0 ? 'Under target on average' : 'Over target on average'} />
          {/if}
          <StatTile label="Days logged" value={summary.loggedDays} unit={`of ${summary.windowDays}`} sublabel={`${Math.round((summary.loggedDays / Math.max(1, summary.windowDays)) * 100)}% coverage`} />
          {#if target !== null}
            <StatTile label="On target" value={summary.onTargetDays} unit={summary.onTargetDays === 1 ? 'day' : 'days'} sublabel={`Within ±${ON_TARGET_TOLERANCE * 100}% · ${summary.overDays} over · ${summary.underDays} under`} />
          {/if}
          {#if summary.netBalanceKcal !== null}
            <StatTile
              label="Net vs target"
              value={signedKcal(summary.netBalanceKcal)}
              unit="kcal"
              sublabel={`≈ ${summary.netBalanceKcal > 0 ? '+' : '−'}${fmtNumber(Math.abs(summary.netBalanceKcal) / KCAL_PER_KG, 2)} kg of body mass`}
            />
          {/if}
          <StatTile
            label="Average protein"
            value={fmtNumber(summary.avgProteinG ?? 0, 0)}
            unit="g/day"
            sublabel={profile?.proteinG ? `Target ${fmtNumber(profile.proteinG, 0)} g` : `Carbs ${fmtNumber(summary.avgCarbsG ?? 0, 0)} g · Fat ${fmtNumber(summary.avgFatG ?? 0, 0)} g`}
          />
          {#if profile?.proteinG}
            <StatTile label="Carbs · Fat" value={`${fmtNumber(summary.avgCarbsG ?? 0, 0)} · ${fmtNumber(summary.avgFatG ?? 0, 0)}`} unit="g/day" sublabel={`Targets ${profile.carbG ?? '—'} · ${profile.fatG ?? '—'} g`} />
          {/if}
          {#if summary.avgWeekday !== null && summary.avgWeekend !== null}
            <StatTile label="Weekend average" value={fmtNumber(summary.avgWeekend, 0)} unit="kcal" sublabel={`${signedKcal(summary.avgWeekend - summary.avgWeekday)} vs weekdays (${fmtNumber(summary.avgWeekday, 0)})`} />
          {/if}
          {#if summary.highest}
            <StatTile label="Highest day" value={fmtNumber(summary.highest.kcal, 0)} unit="kcal" sublabel={fmtWithDay(summary.highest.day)} />
          {/if}
          {#if summary.lowest && summary.loggedDays > 1}
            <StatTile label="Lowest day" value={fmtNumber(summary.lowest.kcal, 0)} unit="kcal" sublabel={fmtWithDay(summary.lowest.day)} />
          {/if}
          <StatTile label="Logging streak" value={summary.currentStreak} unit={summary.currentStreak === 1 ? 'day' : 'days'} sublabel={`Best ${summary.longestStreak} in this range`} />
        </div>
      {/if}
    </section>

    {#if weeks.length > 0}
      <section class="metric-card weeks-card" aria-labelledby="weeks-title">
        <div class="metric-card-header">
          <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="calendar" size={20} /></span><h2 class="metric-card-title" id="weeks-title">Week by week</h2></div>
          <span class="badge">Mon – Sun</span>
        </div>
        <div class="metric-card-content">
          <div class="table-scroll">
            <table class="weeks-table">
              <caption class="sr-only">Weekly calorie averages for {rangeLabel}, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">Week of</th>
                  <th scope="col" class="num">Avg kcal</th>
                  {#if target !== null}<th scope="col" class="num">vs target</th>{/if}
                  <th scope="col" class="num wide-only">Protein</th>
                  <th scope="col" class="num">Days</th>
                </tr>
              </thead>
              <tbody>
                {#each weeks as week (week.weekStart)}
                  <tr>
                    <th scope="row">{fmtShort(week.weekStart)}{week.weekStart === thisWeek ? ' · this week' : ''}</th>
                    <td class="num">{fmtNumber(week.avgKcal ?? 0, 0)}</td>
                    {#if target !== null}<td class="num" data-tone={week.avgVsTarget !== null && week.avgVsTarget > 0 ? 'over' : 'under'}>{signedKcal(week.avgVsTarget)}</td>{/if}
                    <td class="num wide-only">{fmtNumber(week.avgProteinG ?? 0, 0)} g</td>
                    <td class="num">{week.loggedDays}/7</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .calories-header { flex-direction: row; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .calories-header .button { flex: 0 0 auto; }
  .view--calories { display: flex; flex-direction: column; gap: var(--space-4); }
  .retry { align-self: flex-start; }
  .loading-panel { min-height: 14rem; }

  .today-summary {
    display: grid;
    gap: var(--space-5);
    padding: var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-card);
    background: linear-gradient(135deg, var(--color-accent-soft), var(--color-surface) 65%);
    box-shadow: var(--shadow-card);
  }
  .today-main { display: flex; min-width: 0; flex-direction: column; gap: var(--space-2); }
  .summary-label { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .today-kcal { font-size: var(--text-number); font-variant-numeric: tabular-nums; letter-spacing: -0.045em; line-height: 1.15; }
  .today-kcal span { color: var(--color-text-muted); font-size: var(--text-lg); font-weight: var(--weight-medium); letter-spacing: 0; }
  .summary-note { display: flex; margin: 0; align-items: center; flex-wrap: wrap; gap: var(--space-1); color: var(--color-text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .summary-note strong { color: var(--color-text); }
  .progress-track { height: 0.65rem; overflow: hidden; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); }
  .progress-track.over span { background: var(--color-warning); }

  .today-macros { display: flex; min-width: 0; flex-direction: column; justify-content: center; }
  .macro-targets { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-3); list-style: none; }
  .macro-target-head { display: flex; justify-content: space-between; gap: var(--space-3); font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .macro-target-head > span:first-child { display: inline-flex; align-items: center; gap: var(--space-2); }
  .macro-target-value { font-variant-numeric: tabular-nums; }
  .macro-dot { width: 0.6rem; height: 0.6rem; border-radius: 50%; }
  .macro-target-track { height: 0.45rem; margin: var(--space-1) 0; overflow: hidden; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .macro-target-track span { display: block; height: 100%; border-radius: inherit; }
  .macro-target-note { color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }

  .card-note, .quiet-empty { margin: var(--space-3) 0 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .quiet-empty { margin: 0; }
  .centered { display: flex; min-height: 10rem; align-items: center; justify-content: center; text-align: center; }

  .today-meal-list { display: flex; margin: 0; padding: 0; flex-direction: column; list-style: none; }
  .today-meal-list li { display: flex; min-height: 3.5rem; padding: var(--space-2) 0; align-items: center; gap: var(--space-3); border-top: 1px solid var(--color-border); }
  .today-meal-list li:first-child { border-top: 0; }
  .meal-time { width: 4.25rem; flex: 0 0 auto; color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .meal-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
  .meal-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meal-copy span { color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .meal-kcal { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); }
  .meal-kcal span { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-regular); }
  .edit-link { margin-top: var(--space-3); }

  .chart-header { flex-wrap: wrap; }
  .range-wrap { margin-bottom: var(--space-4); }
  .chart-wrap[aria-busy='true'] { opacity: 0.55; transition: opacity 120ms; }

  .metrics-section { display: flex; min-width: 0; flex-direction: column; gap: var(--space-3); }
  .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
  .section-heading h2 { margin: 0; font-size: var(--text-lg); }
  .section-heading span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }

  .table-scroll { overflow-x: auto; }
  .weeks-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .weeks-table th, .weeks-table td { padding: var(--space-2) var(--space-2); border-top: 1px solid var(--color-border); text-align: left; white-space: nowrap; }
  .weeks-table thead th { border-top: 0; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .weeks-table tbody th { font-weight: var(--weight-medium); }
  .weeks-table .num { text-align: right; }
  .weeks-table td[data-tone='over'] { color: var(--color-warning); }

  @media (max-width: 30rem) {
    .calories-header { align-items: flex-start; flex-direction: column; }
    .calories-header .button { width: 100%; }
    .section-heading span { display: none; }
    .weeks-table .wide-only { display: none; }
    .weeks-table th, .weeks-table td { padding: var(--space-2) var(--space-1); }
  }
  @media (min-width: 43.75rem) {
    .today-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; }
    .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (min-width: 70rem) {
    .stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
</style>
