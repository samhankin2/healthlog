<script lang="ts">
  import Icon from '../lib/components/Icon.svelte'
  import SegmentedControl from '../lib/components/SegmentedControl.svelte'
  import StatTile from '../lib/components/StatTile.svelte'
  import EmptyState from '../lib/components/EmptyState.svelte'
  import LineChart from '../lib/viz/LineChart.svelte'
  import BalanceBars from '../lib/viz/BalanceBars.svelte'
  import LogWeightPanel from '../lib/panels/LogWeightPanel.svelte'
  import { actions, app, navigate } from '../lib/state.svelte'
  import { addDays, daysApart, fmtKg, fmtNumber, fmtShort, fmtWithDay, today } from '../lib/format'
  import { showToast } from '../lib/toast.svelte'
  import {
    buildTrend, fitRate, goalEta, kcalPerDay, monthlyPeriods, noiseKg, trendChange, trendOn, weekdayBias, weeklyPeriods,
    type Period,
  } from '../lib/weightTrend'
  import type { WeightEntry } from '../lib/types'

  const RANGES = [
    { value: '30', label: '30d' },
    { value: '90', label: '90d' },
    { value: '180', label: '6mo' },
    { value: '365', label: '1y' },
    { value: '0', label: 'All' },
  ]
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
  const ROWS = 12

  let range = $state(90)
  let logOpen = $state(false)
  let editing = $state<WeightEntry | null>(null)
  let allWeeks = $state(false)
  let allMonths = $state(false)

  const now = today()
  const entries = $derived([...app.weights].sort((a, b) => a.date.localeCompare(b.date)))
  const trend = $derived(buildTrend(entries, now))
  const latest = $derived(entries[entries.length - 1] ?? null)
  const trendNow = $derived(trendOn(trend, now))
  const goal = $derived(app.profile?.goalWeightKg ?? null)

  /** Range start: the first weigh-in for "All", never earlier than it. */
  const from = $derived.by(() => {
    const first = trend.first ?? now
    const start = range === 0 ? first : addDays(now, -(range - 1))
    return start < first && range === 0 ? first : start
  })
  const rangeLabel = $derived(RANGES.find((r) => Number(r.value) === range)?.label ?? '')
  const inRange = $derived(entries.filter((e) => e.date >= from))

  const line = $derived(trend.days.filter((d) => d.day >= from).map((d) => ({ day: d.day, value: d.trendKg })))
  const raw = $derived(inRange.map((e) => ({ day: e.date, value: e.weightKg })))

  const rate28 = $derived(fitRate(entries, now, 28))
  const rate14 = $derived(fitRate(entries, now, 14))
  const rate90 = $derived(fitRate(entries, now, 90))
  const change7 = $derived(trendChange(trend, now, 7))
  const change30 = $derived(trendChange(trend, now, 30))
  const change90 = $derived(trendChange(trend, now, 90))
  const changeRange = $derived(range === 0 || !trend.first ? null : trendChange(trend, now, range))
  const sinceStart = $derived(trendNow !== null && trend.first ? trendNow - (trendOn(trend, trend.first) ?? trendNow) : null)
  const noise = $derived(noiseKg(trend, addDays(now, -59), now))
  const weighIns30 = $derived(entries.filter((e) => e.date > addDays(now, -30)).length)
  const lowest = $derived(inRange.length ? inRange.reduce((a, b) => (b.weightKg < a.weightKg ? b : a)) : null)
  const highest = $derived(inRange.length ? inRange.reduce((a, b) => (b.weightKg > a.weightKg ? b : a)) : null)
  const eta = $derived(trendNow !== null && goal !== null ? goalEta(trendNow, goal, rate28?.kgPerWeek ?? null, now) : null)

  const weeks = $derived(weeklyPeriods(entries, trend))
  const months = $derived(monthlyPeriods(entries, trend))
  /** The newest period with a change; "this week" with no weigh-in yet falls back to last week. */
  const lastWithChange = (list: Period[]): Period | null => [...list].reverse().find((p) => p.changeKg !== null) ?? null
  const thisWeek = $derived(lastWithChange(weeks))
  const thisMonth = $derived(lastWithChange(months))
  const staleDays = $derived(latest ? daysApart(latest.date, now) : 0)
  const changeSub = $derived(staleDays >= 3 && latest ? `Trend held since ${fmtShort(latest.date)}` : 'Trend change')

  /** Bar charts show at least 12 weeks / 12 months, more when the range is longer. */
  const weekFrom = $derived(range === 0 ? from : addDays(now, -Math.max(range, 84)))
  const monthFrom = $derived(range === 0 ? from : addDays(now, -Math.max(range, 365)))
  const weekBars = $derived(
    weeks.filter((w) => w.end >= weekFrom && w.changeKg !== null).map((w) => ({
      key: w.key,
      heading: `Week of ${fmtShort(w.key)}${w.current ? ' (so far)' : ''}`,
      value: w.changeKg as number,
      detail: w.weighIns ? `${w.weighIns} weigh-in${w.weighIns === 1 ? '' : 's'} · avg ${fmtNumber(w.avgKg as number)} kg` : 'No weigh-ins — interpolated',
    })),
  )
  const monthBars = $derived(
    months.filter((m) => m.end >= monthFrom && m.changeKg !== null).map((m) => ({
      key: m.key,
      heading: `${monthName(m)}${m.current ? ' (so far)' : ''}`,
      value: m.changeKg as number,
      detail: m.weighIns ? `${m.weighIns} weigh-in${m.weighIns === 1 ? '' : 's'} · avg ${fmtNumber(m.avgKg as number)} kg` : 'No weigh-ins — interpolated',
    })),
  )
  const weekRows = $derived([...weeks].reverse().filter((w) => w.weighIns > 0 || w.changeKg !== null))
  const monthRows = $derived([...months].reverse().filter((m) => m.weighIns > 0 || m.changeKg !== null))

  const bias = $derived(weekdayBias(trend, now, 120))
  const biasReady = $derived(bias.filter((b) => b.n >= 2).length >= 3)
  const biasMax = $derived(Math.max(0.2, ...bias.map((b) => Math.abs(b.meanKg ?? 0))))

  function monthName(m: Period): string {
    const [y, mo] = m.key.split('-').map(Number)
    return `${MONTHS[mo - 1]} ${y}`
  }
  function signed(v: number | null, digits = 1): string {
    if (v === null) return '—'
    const r = Number(v.toFixed(digits))
    return `${r > 0 ? '+' : r < 0 ? '−' : '±'}${fmtNumber(Math.abs(r), digits)}`
  }
  function tone(v: number | null): 'up' | 'down' | 'neutral' | undefined {
    if (v === null) return undefined
    if (Math.abs(v) < 0.05) return 'neutral'
    return v > 0 ? 'up' : 'down'
  }
  function changeTone(v: number | null): string {
    return v === null || Math.abs(v) < 0.05 ? 'flat' : v > 0 ? 'gain' : 'loss'
  }
  const fmt1 = (v: number): string => fmtNumber(v, 1)
  const fmtBar = (v: number): string => fmtNumber(v, Math.abs(v) < 1 && v !== 0 ? 2 : 1)

  function rateSub(r: typeof rate28): string {
    if (!r) return 'Needs 3 weigh-ins over a week'
    const kcal = Math.round(kcalPerDay(r.kgPerWeek) / 10) * 10
    const balance = Math.abs(kcal) < 50 ? 'about maintenance' : `≈ ${fmtNumber(Math.abs(kcal), 0)} kcal/day ${kcal < 0 ? 'deficit' : 'surplus'}`
    return `${balance} · ${r.weighIns} weigh-ins`
  }
  const etaText = $derived.by(() => {
    if (!eta || goal === null) return null
    if (eta.status === 'reached') return { value: 'Reached', sub: `Trend is at ${fmtKg(goal)}` }
    const left = `${signed(eta.remainingKg)} kg to go`
    if (eta.status === 'on-track' && eta.day) {
      const weeksLeft = Math.round(eta.weeks ?? 0)
      return { value: fmtShort(eta.day), sub: `${left} · ~${weeksLeft} week${weeksLeft === 1 ? '' : 's'} at the 4-week pace` }
    }
    if (eta.status === 'wrong-way') return { value: 'Moving away', sub: `${left} · the 4-week pace points the other way` }
    if (eta.status === 'too-far') return { value: '2y+', sub: `${left} · at the 4-week pace` }
    return { value: '—', sub: `${left} · no clear 4-week pace yet` }
  })

  function openLog(entry: WeightEntry | null = null): void {
    editing = entry
    logOpen = true
  }
  async function refreshDashboard(): Promise<void> {
    const days = app.profile?.chartWindowDays ?? 90
    await actions.loadDashboard(days)
  }
  async function saveWeight(date: string, weightKg: number, note: string): Promise<void> {
    const target = editing ?? app.weights.find((e) => e.date === date) ?? null
    if (target) await actions.updateWeight(target.id, { date, weightKg, note: note || null })
    else await actions.createWeight({ date, weightKg, note: note || null })
    logOpen = false
    editing = null
    showToast('Weigh-in saved.', 'success')
    await refreshDashboard().catch(() => {})
  }
  async function deleteWeight(): Promise<void> {
    if (!editing) return
    await actions.deleteWeight(editing.id)
    logOpen = false
    editing = null
    showToast('Weigh-in deleted.', 'success')
    await refreshDashboard().catch(() => {})
  }
</script>

<div class="view view--weight">
  <header class="view-header weight-header">
    <div>
      <h1 class="view-title">Weight</h1>
      <p class="view-subtitle">Trend, pace and week-by-week change.</p>
    </div>
    <button class="button button--primary" type="button" onclick={() => openLog()}><Icon name="plus" size={19} /> Log weight</button>
  </header>

  {#if entries.length === 0}
    <EmptyState icon="scale" title="No weigh-ins yet" message="Log a weight to start your trend. A few weigh-ins a week is plenty." />
  {:else}
    <section class="weight-summary" aria-label="Trend weight">
      <div class="trend-now">
        <span class="summary-label">Trend weight</span>
        <strong>{trendNow === null ? '—' : fmtNumber(trendNow, 1)} <span>kg</span></strong>
        {#if latest}
          <span class="summary-note">
            Last weigh-in {fmtKg(latest.weightKg)} · {fmtShort(latest.date)}
            {#if trendNow !== null}({signed(latest.weightKg - trendNow)} vs trend){/if}
          </span>
        {/if}
      </div>
      <dl class="summary-chips">
        <div data-tone={changeTone(thisWeek?.changeKg ?? null)}><dt>{!thisWeek || thisWeek.current ? 'This week' : 'Last week'}</dt><dd>{thisWeek ? `${signed(thisWeek.changeKg)} kg` : '—'}</dd></div>
        <div data-tone={changeTone(thisMonth?.changeKg ?? null)}><dt>{thisMonth ? MONTHS[Number(thisMonth.key.slice(5, 7)) - 1] : 'This month'}</dt><dd>{thisMonth ? `${signed(thisMonth.changeKg)} kg` : '—'}</dd></div>
        <div data-tone={changeTone(rate28?.kgPerWeek ?? null)}><dt>Pace</dt><dd>{rate28 ? `${signed(rate28.kgPerWeek, 2)} kg/wk` : '—'}</dd></div>
      </dl>
    </section>

    <div class="range-wrap"><SegmentedControl options={RANGES} value={String(range)} ariaLabel="Time range" onchange={(v) => { range = Number(v) }} /></div>

    <section class="metric-card" aria-labelledby="trend-title">
      <div class="metric-card-header">
        <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="activity" size={20} /></span><h2 class="metric-card-title" id="trend-title">Trend</h2></div>
        <span class="badge">{inRange.length} weigh-in{inRange.length === 1 ? '' : 's'}{changeRange !== null ? ` · ${signed(changeRange)} kg` : ''}</span>
      </div>
      <div class="metric-card-content">
        <LineChart
          label="Weight trend and weigh-ins"
          {from}
          to={now}
          {line}
          {raw}
          lineLabel="Trend"
          rawLabel="Weigh-in"
          format={fmt1}
          height={260}
          dotOpacity={0.55}
          reference={goal !== null ? { value: goal, label: `Goal ${fmtNumber(goal, 1)}` } : undefined}
        />
        <ul class="legend" aria-label="Chart legend">
          <li><span class="legend-line" aria-hidden="true"></span>Trend</li>
          <li><span class="legend-dot" aria-hidden="true"></span>Weigh-ins</li>
          {#if goal !== null}<li><span class="legend-ref" aria-hidden="true"></span>Goal</li>{/if}
        </ul>
        <p class="chart-note">
          The trend moves 10% of the way toward each day's weight, and fills gaps between weigh-ins, so one heavy or light morning barely shifts it
          — even when it is your only weigh-in that week.
        </p>
      </div>
    </section>

    <section class="metrics-section" aria-labelledby="change-title">
      <div class="section-heading"><h2 id="change-title">Change</h2><span>Trend to trend, not scale to scale</span></div>
      <div class="stat-grid">
        <StatTile label="Last 7 days" value={signed(change7)} unit={change7 === null ? undefined : 'kg'} sublabel={changeSub} tone={tone(change7)} />
        <StatTile label="Last 30 days" value={signed(change30)} unit={change30 === null ? undefined : 'kg'} sublabel={changeSub} tone={tone(change30)} />
        <StatTile label="Last 90 days" value={signed(change90)} unit={change90 === null ? undefined : 'kg'} sublabel={changeSub} tone={tone(change90)} />
        <StatTile label="Since first weigh-in" value={signed(sinceStart)} unit={sinceStart === null ? undefined : 'kg'} sublabel={trend.first ? `Since ${fmtShort(trend.first)}` : undefined} tone={tone(sinceStart)} />
        <StatTile label="Weekly pace" value={rate28 ? signed(rate28.kgPerWeek, 2) : '—'} unit={rate28 ? 'kg/wk' : undefined} sublabel={`Last 4 weeks · ${rateSub(rate28)}`} tone={tone(rate28?.kgPerWeek ?? null)} />
        <StatTile label="Monthly pace" value={rate28 ? signed((rate28.kgPerWeek * 30.44) / 7) : '—'} unit={rate28 ? 'kg/mo' : undefined} sublabel="Weekly pace × 4.35" tone={tone(rate28?.kgPerWeek ?? null)} />
        <StatTile label="Short vs long pace" value={rate14 ? signed(rate14.kgPerWeek, 2) : '—'} unit={rate14 ? 'kg/wk' : undefined} sublabel={rate90 ? `2 weeks · 90 days: ${signed(rate90.kgPerWeek, 2)} kg/wk` : 'Last 2 weeks'} tone={tone(rate14?.kgPerWeek ?? null)} />
        {#if etaText}<StatTile label="Goal" value={etaText.value} sublabel={etaText.sub} tone="accent" />{/if}
        {#if lowest && highest}
          <StatTile label={`Lowest · ${rangeLabel}`} value={fmtNumber(lowest.weightKg, 1)} unit="kg" sublabel={fmtWithDay(lowest.date)} />
          <StatTile label={`Highest · ${rangeLabel}`} value={fmtNumber(highest.weightKg, 1)} unit="kg" sublabel={fmtWithDay(highest.date)} />
        {/if}
        <StatTile label="Daily noise" value={noise === null ? '—' : `±${fmtNumber(noise, 2)}`} unit={noise === null ? undefined : 'kg'} sublabel="Typical gap between scale and trend" />
        <StatTile label="Weigh-ins" value={weighIns30} unit="of 30 days" sublabel={latest ? `Last ${daysApart(latest.date, now) === 0 ? 'today' : `${daysApart(latest.date, now)}d ago`}` : undefined} />
      </div>
    </section>

    <div class="period-grid">
      <section class="metric-card" aria-labelledby="weekly-title">
        <div class="metric-card-header">
          <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="calendar" size={20} /></span><h2 class="metric-card-title" id="weekly-title">Weekly change</h2></div>
          <span class="badge">Mon – Sun</span>
        </div>
        <div class="metric-card-content">
          {#if weekBars.length}
            <BalanceBars label="Trend change per week" bars={weekBars} from={weekBars[0].key} to={now} keyDays={7} format={fmtBar} upLabel="Gained" downLabel="Lost" minExtent={0.3} height={190} />
          {/if}
          <div class="table-scroll">
            <table class="period-table">
              <caption class="sr-only">Weekly weight change, newest first</caption>
              <thead><tr><th scope="col">Week of</th><th scope="col" class="num">Change</th><th scope="col" class="num">Avg</th><th scope="col" class="num wide-only">Range</th><th scope="col" class="num">Weigh-ins</th></tr></thead>
              <tbody>
                {#each allWeeks ? weekRows : weekRows.slice(0, ROWS) as w (w.key)}
                  <tr>
                    <th scope="row">{fmtShort(w.key)}{w.current ? ' · now' : ''}</th>
                    <td class="num" data-tone={changeTone(w.changeKg)}>{w.changeKg === null ? '—' : `${signed(w.changeKg)}`}{w.partial ? '*' : ''}</td>
                    <td class="num">{w.avgKg === null ? '—' : fmtNumber(w.avgKg, 1)}</td>
                    <td class="num wide-only">{w.minKg === null || w.maxKg === null ? '—' : w.minKg === w.maxKg ? fmtNumber(w.minKg, 1) : `${fmtNumber(w.minKg, 1)}–${fmtNumber(w.maxKg, 1)}`}</td>
                    <td class="num">{w.weighIns}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if weekRows.length > ROWS}
            <button class="button button--secondary show-all" type="button" onclick={() => { allWeeks = !allWeeks }}>{allWeeks ? 'Show fewer' : `Show all ${weekRows.length} weeks`}</button>
          {/if}
        </div>
      </section>

      <section class="metric-card" aria-labelledby="monthly-title">
        <div class="metric-card-header">
          <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="calendar" size={20} /></span><h2 class="metric-card-title" id="monthly-title">Monthly change</h2></div>
          <span class="badge">Calendar months</span>
        </div>
        <div class="metric-card-content">
          {#if monthBars.length}
            <BalanceBars label="Trend change per month" bars={monthBars} from={monthBars[0].key} to={now} keyDays={30} format={fmtBar} upLabel="Gained" downLabel="Lost" minExtent={0.5} height={190} />
          {/if}
          <div class="table-scroll">
            <table class="period-table">
              <caption class="sr-only">Monthly weight change, newest first</caption>
              <thead><tr><th scope="col">Month</th><th scope="col" class="num">Change</th><th scope="col" class="num">Avg</th><th scope="col" class="num wide-only">Range</th><th scope="col" class="num">Weigh-ins</th></tr></thead>
              <tbody>
                {#each allMonths ? monthRows : monthRows.slice(0, ROWS) as m (m.key)}
                  <tr>
                    <th scope="row">{monthName(m)}{m.current ? ' · now' : ''}</th>
                    <td class="num" data-tone={changeTone(m.changeKg)}>{m.changeKg === null ? '—' : signed(m.changeKg)}{m.partial ? '*' : ''}</td>
                    <td class="num">{m.avgKg === null ? '—' : fmtNumber(m.avgKg, 1)}</td>
                    <td class="num wide-only">{m.minKg === null || m.maxKg === null ? '—' : m.minKg === m.maxKg ? fmtNumber(m.minKg, 1) : `${fmtNumber(m.minKg, 1)}–${fmtNumber(m.maxKg, 1)}`}</td>
                    <td class="num">{m.weighIns}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if monthRows.length > ROWS}
            <button class="button button--secondary show-all" type="button" onclick={() => { allMonths = !allMonths }}>{allMonths ? 'Show fewer' : `Show all ${monthRows.length} months`}</button>
          {/if}
        </div>
      </section>
    </div>
    <p class="chart-note">Change is the trend at the end of the period minus the trend at the end of the one before. * from your first weigh-in.</p>

    <section class="metric-card" aria-labelledby="weekday-title">
      <div class="metric-card-header">
        <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="scale" size={20} /></span><h2 class="metric-card-title" id="weekday-title">Day-of-week pattern</h2></div>
        <span class="badge">Last 120 days</span>
      </div>
      <div class="metric-card-content">
        {#if biasReady}
          <p class="card-note">How each day's weigh-ins compare with your average day, once the trend is taken out — weekend meals and salt often show up on Monday.</p>
          <ul class="bias-list">
            {#each bias as b (b.index)}
              <li>
                <span class="bias-day">{b.label}</span>
                <span class="bias-track" aria-hidden="true">
                  {#if b.meanKg !== null && b.n >= 2}
                    <span class="bias-bar" data-tone={changeTone(b.meanKg)} style:left={b.meanKg < 0 ? `${50 - (Math.abs(b.meanKg) / biasMax) * 50}%` : '50%'} style:width={`${(Math.abs(b.meanKg) / biasMax) * 50}%`}></span>
                  {/if}
                </span>
                <span class="bias-value">{b.meanKg === null || b.n < 2 ? '—' : `${signed(b.meanKg, 2)} kg`}<span class="bias-n"> · {b.n}</span></span>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="quiet-empty">Needs at least two weigh-ins on three different weekdays in the last 120 days.</p>
        {/if}
      </div>
    </section>

    <section class="history-link-card">
      <div><h2>Every weigh-in</h2><p>Correct an entry, add a note, or delete one.</p></div>
      <button class="button button--secondary" type="button" onclick={() => navigate('history')}>Open History <Icon name="chevron-right" size={18} /></button>
    </section>
  {/if}
</div>

<LogWeightPanel
  open={logOpen}
  initialDate={editing?.date ?? now}
  existing={editing}
  prefillKg={latest?.weightKg ?? 0}
  onclose={() => { logOpen = false; editing = null }}
  onsave={saveWeight}
  ondelete={editing ? deleteWeight : undefined}
/>

<style>
  .weight-header { flex-direction: row; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .weight-header .button { flex: 0 0 auto; }
  .weight-summary {
    display: grid; gap: var(--space-4); padding: var(--space-5);
    border: 1px solid var(--color-border); border-radius: var(--radius-card);
    background: linear-gradient(135deg, var(--color-accent-soft), var(--color-surface) 65%);
    box-shadow: var(--shadow-card);
  }
  .trend-now { display: flex; min-width: 0; flex-direction: column; }
  .summary-label { color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .trend-now strong { font-size: var(--text-number); font-variant-numeric: tabular-nums; letter-spacing: -0.045em; line-height: 1.15; }
  .trend-now strong span { color: var(--color-text-muted); font-size: var(--text-lg); font-weight: var(--weight-medium); letter-spacing: 0; }
  .summary-note { color: var(--color-text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .summary-chips { display: grid; margin: 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
  .summary-chips div { display: flex; min-width: 0; padding: var(--space-2) var(--space-3); flex-direction: column; border-radius: var(--radius-sm); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
  .summary-chips dt { color: var(--color-text-muted); font-size: var(--text-xs); }
  .summary-chips dd { margin: 0; font-size: var(--text-base); font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); white-space: nowrap; }
  [data-tone='gain'] { color: var(--viz-surplus); }
  [data-tone='loss'] { color: var(--viz-deficit); }
  .summary-chips div[data-tone] { color: inherit; }
  .summary-chips div[data-tone='gain'] dd { color: var(--viz-surplus); }
  .summary-chips div[data-tone='loss'] dd { color: var(--viz-deficit); }

  .range-wrap { min-width: 0; }
  .legend { display: flex; margin: var(--space-3) 0 0; padding: 0; flex-wrap: wrap; justify-content: center; gap: var(--space-4); color: var(--color-text-muted); font-size: var(--text-xs); list-style: none; }
  .legend li { display: flex; align-items: center; gap: var(--space-2); }
  .legend-line { width: 1.25rem; height: 3px; border-radius: 2px; background: var(--viz-line); }
  .legend-dot { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: var(--viz-line); opacity: 0.55; }
  .legend-ref { width: 1.25rem; border-top: 1px dashed var(--color-text-muted); }
  .chart-note { margin: var(--space-3) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); line-height: 1.5; }
  .card-note, .quiet-empty { margin: 0 0 var(--space-4); color: var(--color-text-muted); font-size: var(--text-sm); }

  .metrics-section { display: flex; min-width: 0; flex-direction: column; gap: var(--space-3); }
  .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); }
  .section-heading h2 { margin: 0; font-size: var(--text-lg); }
  .section-heading span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }

  .period-grid { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .period-grid > * { min-width: 0; }
  .table-scroll { margin-top: var(--space-3); overflow-x: auto; }
  .period-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .period-table th, .period-table td { padding: var(--space-2); border-top: 1px solid var(--color-border); text-align: left; white-space: nowrap; }
  .period-table thead th { border-top: 0; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .period-table tbody th { font-weight: var(--weight-medium); }
  .period-table .num { text-align: right; }
  .period-table td[data-tone] { font-weight: var(--weight-semibold); }
  .period-table td[data-tone='flat'] { color: var(--color-text-muted); }
  .show-all { width: 100%; margin-top: var(--space-3); }

  .bias-list { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-2); list-style: none; }
  .bias-list li { display: grid; align-items: center; grid-template-columns: 2.5rem minmax(0, 1fr) 6.5rem; gap: var(--space-3); font-size: var(--text-sm); }
  .bias-day { color: var(--color-text-muted); }
  .bias-track { position: relative; height: 0.75rem; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .bias-track::after { position: absolute; top: -2px; bottom: -2px; left: 50%; width: 1px; background: var(--color-border-strong); content: ''; }
  .bias-bar { position: absolute; top: 0; bottom: 0; border-radius: var(--radius-pill); }
  .bias-bar[data-tone='gain'] { background: var(--viz-surplus); }
  .bias-bar[data-tone='loss'] { background: var(--viz-deficit); }
  .bias-bar[data-tone='flat'] { background: var(--color-border-strong); }
  .bias-value { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .bias-n { color: var(--color-text-subtle); font-size: var(--text-xs); }

  .history-link-card { display: flex; padding: var(--space-5); align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
  .history-link-card h2 { margin: 0 0 var(--space-1); font-size: var(--text-lg); }
  .history-link-card p { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }

  @media (max-width: 30rem) {
    .weight-header { align-items: flex-start; flex-direction: column; }
    .weight-header .button { width: 100%; }
    .section-heading span { display: none; }
    .period-table .wide-only { display: none; }
    .period-table th, .period-table td { padding: var(--space-2) var(--space-1); }
    .summary-chips dd { font-size: var(--text-sm); }
  }
  @media (min-width: 43.75rem) {
    .weight-summary { grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); align-items: center; }
    .stat-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  @media (min-width: 70rem) {
    .stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .period-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
