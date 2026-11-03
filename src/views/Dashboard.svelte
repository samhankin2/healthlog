<script lang="ts">
  import Icon from '../lib/components/Icon.svelte'
  import WeightChart from '../lib/panels/WeightChart.svelte'
  import IntakeChart from '../lib/panels/IntakeChart.svelte'
  import SegmentedControl from '../lib/components/SegmentedControl.svelte'
  import StatTile from '../lib/components/StatTile.svelte'
  import MacroBar from '../lib/components/MacroBar.svelte'
  import LogWeightPanel from '../lib/panels/LogWeightPanel.svelte'
  import PhasePanel from '../lib/panels/PhasePanel.svelte'
  import ConfirmPanel from '../lib/panels/ConfirmPanel.svelte'
  import { actions, app, navigate } from '../lib/state.svelte'
  import { fmtKg, fmtKcal, fmtNumber, today } from '../lib/format'
  import { showToast } from '../lib/toast.svelte'
  import type { Phase, PhaseInput, WeightEntry } from '../lib/types'

  const RANGES = [
    { value: '30', label: '30d' },
    { value: '90', label: '90d' },
    { value: '180', label: '6mo' },
    { value: '365', label: '1y' },
    { value: '0', label: 'All' },
  ]

  let initialWindow = app.profile?.chartWindowDays ?? 90
  let range = $state(initialWindow >= 3650 ? 0 : initialWindow)
  let logOpen = $state(false)
  let editingWeight = $state<WeightEntry | null>(null)
  let phaseOpen = $state(false)
  let editingPhase = $state<Phase | null>(null)
  let deletingPhase = $state<Phase | null>(null)
  let metrics = $derived(app.metrics)
  let remainingKcal = $derived(
    metrics && metrics.intake.kcalTarget !== null ? Math.round(metrics.intake.kcalTarget - metrics.intake.kcal) : null,
  )
  let latestWeight = $derived([...app.weights].sort((a, b) => b.date.localeCompare(a.date))[0])

  function direction(value: number | null): 'up' | 'down' | 'neutral' {
    if (value === null || Math.abs(value) <= 0.05) return 'neutral'
    return value > 0 ? 'up' : 'down'
  }

  function signed(value: number | null, digits = 1): string {
    if (value === null) return '—'
    return `${value > 0 ? '+' : ''}${fmtNumber(value, digits)}`
  }

  async function changeRange(value: string): Promise<void> {
    range = Number(value)
    const apiDays = range === 0 ? 3650 : range
    try {
      await Promise.all([
        actions.updateProfile({ chartWindowDays: apiDays }),
        actions.loadDashboard(apiDays),
      ])
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not change the chart range.', 'error')
    }
  }

  function openLog(entry: WeightEntry | null = null): void {
    editingWeight = entry
    logOpen = true
  }

  async function saveWeight(date: string, weightKg: number, note: string): Promise<void> {
    const target = editingWeight ?? app.weights.find((entry) => entry.date === date) ?? null
    if (target) await actions.updateWeight(target.id, { date, weightKg, note: note || null })
    else await actions.createWeight({ date, weightKg, note: note || null })
    await actions.loadDashboard(range === 0 ? 3650 : range)
    logOpen = false
    editingWeight = null
    showToast('Weigh-in saved.', 'success')
  }

  async function deleteWeight(): Promise<void> {
    if (!editingWeight) return
    await actions.deleteWeight(editingWeight.id)
    await actions.loadDashboard(range === 0 ? 3650 : range)
    logOpen = false
    editingWeight = null
    showToast('Weigh-in deleted.', 'success')
  }

  function openPhase(phase: Phase | null = null): void {
    editingPhase = phase
    phaseOpen = true
  }

  async function savePhase(input: PhaseInput): Promise<void> {
    if (editingPhase) await actions.updatePhase(editingPhase.id, input)
    else await actions.createPhase(input)
    phaseOpen = false
    editingPhase = null
    showToast('Phase saved.', 'success')
  }

  async function deletePhase(): Promise<void> {
    if (!deletingPhase) return
    await actions.deletePhase(deletingPhase.id)
    deletingPhase = null
    showToast('Phase deleted.', 'success')
  }
</script>

<div class="view view--dashboard">
  <header class="view-header dashboard-header">
    <div>
      <h1 class="view-title">Dashboard</h1>
      <p class="view-subtitle">The trend matters more than any single day.</p>
    </div>
    <button class="button button--primary" type="button" onclick={() => openLog()}><Icon name="plus" size={19} /> Log weight</button>
  </header>

  {#if metrics}
    <section class="dashboard-summary" aria-label="Current weight and goal progress">
      <div class="current-weight">
        <span class="summary-label">Current weight</span>
        <strong>{metrics.currentWeightKg === null ? '—' : fmtNumber(metrics.currentWeightKg)} <span>kg</span></strong>
        <span class="summary-note">{metrics.avg7d === null ? 'Log a weight to begin your trend.' : `7-day average ${fmtKg(metrics.avg7d)}`}</span>
      </div>
      {#if metrics.goalProgressPct !== null}
        <div class="goal-progress">
          <div class="goal-heading"><span>Goal progress</span><strong>{metrics.goalProgressPct}%</strong></div>
          <div class="progress-track" role="progressbar" aria-label="Progress toward goal" aria-valuemin="0" aria-valuemax="100" aria-valuenow={Math.min(100, Math.max(0, metrics.goalProgressPct))}>
            <span style:width={`${Math.min(100, Math.max(0, metrics.goalProgressPct))}%`}></span>
          </div>
          <span class="summary-note">{metrics.goalWeightKg === null ? 'Set a goal in Settings.' : `Goal ${fmtKg(metrics.goalWeightKg)}`}</span>
        </div>
      {/if}
    </section>
  {/if}

  <div class="dashboard-grid">
    <section class="metric-card chart-card">
      <div class="metric-card-header chart-header">
        <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="activity" size={20} /></span><h2 class="metric-card-title">Weight trend</h2></div>
        <span class="badge">{app.weights.length} weigh-in{app.weights.length === 1 ? '' : 's'}</span>
      </div>
      <div class="metric-card-content">
        <div class="range-wrap"><SegmentedControl options={RANGES} value={String(range)} ariaLabel="Chart time range" onchange={changeRange} /></div>
        <WeightChart entries={app.weights} phases={app.phases} windowDays={range} />
        <ul class="chart-legend" aria-label="Chart legend">
          <li><span class="legend-line" aria-hidden="true"></span>7-day average</li>
          <li><span class="legend-dot" aria-hidden="true"></span>Weigh-ins</li>
          {#if app.phases.length > 0}<li><span class="legend-band" aria-hidden="true"></span>Training phases</li>{/if}
        </ul>
      </div>
    </section>

    {#if metrics}
      <section class="metric-card calorie-card">
        <div class="metric-card-header">
          <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="flame" size={20} /></span><h2 class="metric-card-title">Today’s calories</h2></div>
          <button class="button button--secondary compact-button" type="button" onclick={() => navigate('calories')}>Details <Icon name="chevron-right" size={17} /></button>
        </div>
        <div class="metric-card-content">
          <div class="calorie-summary">
            <strong class="macro-kcal">{fmtKcal(metrics.intake.kcal)}</strong>
            {#if metrics.intake.kcalTarget !== null}<span class="macro-target">of {fmtKcal(metrics.intake.kcalTarget)}</span>{/if}
          </div>
          {#if remainingKcal !== null}
            <p class="calorie-remaining">
              {remainingKcal >= 0 ? `${remainingKcal.toLocaleString()} kcal remaining today` : `${Math.abs(remainingKcal).toLocaleString()} kcal above today's target`}
            </p>
          {/if}
          <MacroBar protein={metrics.intake.proteinG} carbs={metrics.intake.carbG} fat={metrics.intake.fatG} />
          {#if metrics.intake.kcalTarget === null}<p class="card-note">Set a daily calorie target in Settings to see what remains.</p>{/if}
        </div>
      </section>
    {/if}

    <section class="metrics-section" aria-labelledby="metrics-title">
      <div class="section-heading"><h2 id="metrics-title">Key metrics</h2><span>From your saved entries</span></div>
      {#if metrics}
        <div class="stat-grid">
          <StatTile label="7-day average" value={metrics.avg7d === null ? '—' : fmtNumber(metrics.avg7d)} unit={metrics.avg7d === null ? undefined : 'kg'} sublabel="Smoothed trend" />
          <StatTile label="Total change" value={signed(metrics.totalChangeKg)} unit={metrics.totalChangeKg === null ? undefined : 'kg'} sublabel="Since first entry" tone={direction(metrics.totalChangeKg)} />
          <StatTile label="Weekly rate" value={signed(metrics.weeklyRateKg)} unit={metrics.weeklyRateKg === null ? undefined : 'kg/wk'} sublabel="Recent pace" tone={direction(metrics.weeklyRateKg)} />
          <StatTile label="Streak" value={metrics.streakDays} unit={metrics.streakDays === 1 ? 'day' : 'days'} sublabel={`Best ${metrics.bestStreakDays} days`} />
          {#if metrics.bmi !== null}<StatTile label="BMI" value={fmtNumber(metrics.bmi)} sublabel="From your saved height" />{/if}
          {#if metrics.dailySwingKg !== null}<StatTile label="Daily swing" value={fmtNumber(metrics.dailySwingKg, 2)} unit="kg" sublabel="Average movement" />{/if}
          {#if metrics.goalProgressPct !== null}<StatTile label="Goal progress" value={`${metrics.goalProgressPct}%`} sublabel={metrics.goalWeightKg === null ? 'No goal weight set' : `Toward ${fmtKg(metrics.goalWeightKg)}`} />{/if}
        </div>
      {:else}
        <div class="placeholder-panel loading-panel"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading metrics</span></div>
      {/if}
    </section>

    {#if metrics}
      <section class="metric-card intake-card">
        <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="activity" size={20} /></span><h2 class="metric-card-title">Last 7 days</h2></div><button class="button button--secondary compact-button" type="button" aria-label="Open calorie history" onclick={() => navigate('calories')}>History <Icon name="chevron-right" size={17} /></button></div>
        <div class="metric-card-content"><IntakeChart days={metrics.intakeHistory} target={metrics.intake.kcalTarget} /></div>
      </section>
    {/if}

    <section class="metric-card phases-card">
      <div class="metric-card-header">
        <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="flag" size={20} /></span><h2 class="metric-card-title">Training phases</h2></div>
        <button class="button button--secondary compact-button" type="button" onclick={() => openPhase()}><Icon name="plus" size={17} /> New</button>
      </div>
      <div class="metric-card-content">
        <p class="card-note">Shade stages such as build, cut, or maintenance on the chart.</p>
        {#if app.phases.length === 0}
          <p class="quiet-empty">No phases yet. Add one when your training focus changes.</p>
        {:else}
          <ul class="phase-list">
            {#each [...app.phases].sort((a, b) => b.startDate.localeCompare(a.startDate)) as phase (phase.id)}
              <li>
                <span class="phase-swatch" style:background-color={phase.color} aria-hidden="true"></span>
                <span class="phase-copy"><strong>{phase.name}</strong><span>{phase.startDate} → {phase.endDate ?? 'ongoing'}</span></span>
                <button class="icon-button" type="button" aria-label={`Edit ${phase.name} phase`} onclick={() => openPhase(phase)}><Icon name="edit" size={18} /></button>
                <button class="icon-button danger-icon" type="button" aria-label={`Delete ${phase.name} phase`} onclick={() => { deletingPhase = phase }}><Icon name="trash" size={18} /></button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </section>
  </div>

  <section class="history-link-card">
    <div><h2>Every entry, in one place</h2><p>Review weigh-ins and meals, make corrections, or add a note.</p></div>
    <button class="button button--secondary" type="button" onclick={() => navigate('history')}>Open History <Icon name="chevron-right" size={18} /></button>
  </section>
</div>

<LogWeightPanel
  open={logOpen}
  initialDate={editingWeight?.date ?? today()}
  existing={editingWeight}
  prefillKg={latestWeight?.weightKg ?? 0}
  onclose={() => { logOpen = false; editingWeight = null }}
  onsave={saveWeight}
  ondelete={editingWeight ? deleteWeight : undefined}
/>
<PhasePanel open={phaseOpen} phase={editingPhase} colorIndex={app.phases.length} onclose={() => { phaseOpen = false; editingPhase = null }} onsave={savePhase} />
<ConfirmPanel
  open={deletingPhase !== null}
  title="Delete this phase?"
  message={deletingPhase ? `${deletingPhase.name} will be removed from the chart. Your weigh-ins will stay.` : ''}
  confirmLabel="Delete phase"
  danger
  oncancel={() => { deletingPhase = null }}
  onconfirm={deletePhase}
/>

<style>
  .dashboard-header { flex-direction: row; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .dashboard-header .button { flex: 0 0 auto; }
  .dashboard-summary {
    display: grid;
    gap: var(--space-5);
    padding: var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-card);
    background: linear-gradient(135deg, var(--color-accent-soft), var(--color-surface) 65%);
    box-shadow: var(--shadow-card);
  }
  .current-weight { display: flex; min-width: 0; flex-direction: column; }
  .summary-label, .goal-heading { color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .current-weight strong { font-size: var(--text-number); font-variant-numeric: tabular-nums; letter-spacing: -0.045em; line-height: 1.15; }
  .current-weight strong span { color: var(--color-text-muted); font-size: var(--text-lg); font-weight: var(--weight-medium); letter-spacing: 0; }
  .summary-note { color: var(--color-text-muted); font-size: var(--text-sm); }
  .goal-progress { display: flex; justify-content: center; flex-direction: column; gap: var(--space-2); }
  .goal-heading { display: flex; justify-content: space-between; gap: var(--space-3); }
  .goal-heading strong { color: var(--color-text); font-variant-numeric: tabular-nums; }
  .progress-track { height: 0.65rem; overflow: hidden; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); }
  .dashboard-grid { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .chart-card, .calorie-card, .intake-card, .phases-card, .metrics-section { min-width: 0; }
  .chart-header { flex-wrap: wrap; }
  .range-wrap { margin-bottom: var(--space-4); }
  .chart-legend { display: flex; margin: var(--space-3) 0 0; padding: 0; flex-wrap: wrap; justify-content: center; gap: var(--space-4); color: var(--color-text-muted); font-size: var(--text-xs); list-style: none; }
  .chart-legend li { display: flex; align-items: center; gap: var(--space-2); }
  .legend-line { width: 1.25rem; height: 3px; border-radius: 2px; background: var(--color-accent); }
  .legend-dot { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--color-text-muted); }
  .legend-band { width: 0.8rem; height: 0.8rem; border: 1px dashed var(--color-border-strong); background: var(--color-surface-sunken); }
  .card-note, .quiet-empty { margin: 0 0 var(--space-4); color: var(--color-text-muted); font-size: var(--text-sm); }
  .card-note:last-child { margin: var(--space-4) 0 0; }
  .calorie-summary { display: flex; align-items: baseline; gap: var(--space-2); font-variant-numeric: tabular-nums; }
  .calorie-remaining { margin: 0 0 var(--space-3); color: var(--color-text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .metrics-section { display: flex; flex-direction: column; gap: var(--space-3); }
  .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
  .section-heading h2 { margin: 0; font-size: var(--text-lg); }
  .section-heading span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .phase-list { display: flex; margin: 0; padding: 0; flex-direction: column; list-style: none; }
  .phase-list li { display: flex; min-height: 3.75rem; align-items: center; gap: var(--space-2); border-top: 1px solid var(--color-border); }
  .phase-list li:first-child { border-top: 0; }
  .phase-swatch { width: 0.8rem; height: 0.8rem; flex: 0 0 auto; border-radius: 50%; box-shadow: 0 0 0 1px var(--color-border-strong); }
  .phase-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
  .phase-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .phase-copy span { color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .danger-icon:hover { color: var(--color-danger); }
  .compact-button { min-height: var(--touch-target); padding: var(--space-2) var(--space-3); }
  .history-link-card { display: flex; padding: var(--space-5); align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
  .history-link-card h2 { margin: 0 0 var(--space-1); font-size: var(--text-lg); }
  .history-link-card p { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .loading-panel { min-height: 10rem; }
  @media (max-width: 30rem) {
    .dashboard-header { align-items: flex-start; flex-direction: column; }
    .dashboard-header .button { width: 100%; }
    .section-heading span { display: none; }
  }
  @media (min-width: 43.75rem) {
    .dashboard-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; }
    .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (min-width: 70rem) {
    .dashboard-grid { grid-template-columns: repeat(12, minmax(0, 1fr)); }
    .chart-card { grid-column: span 8; }
    .calorie-card { grid-column: span 4; }
    .metrics-section { grid-column: 1 / -1; }
    .intake-card { grid-column: span 5; }
    .phases-card { grid-column: span 7; }
    .stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
</style>
