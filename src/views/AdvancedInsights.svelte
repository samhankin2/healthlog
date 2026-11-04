<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import SegmentedControl from '../lib/components/SegmentedControl.svelte'
  import LineChart from '../lib/viz/LineChart.svelte'
  import MultiLine from '../lib/viz/MultiLine.svelte'
  import BalanceBars from '../lib/viz/BalanceBars.svelte'
  import SegmentBar from '../lib/viz/SegmentBar.svelte'
  import PaceHrLab from '../lib/panels/PaceHrLab.svelte'
  import { api } from '../lib/api'
  import { today } from '../lib/format'
  import { navigate } from '../lib/state.svelte'
  import { activityTypeLabel } from '../lib/activity'
  import { fmtDayLong, fmtDayShort } from '../lib/viz/scale'
  import { RANGES, dayNum, fmtClockMin, fmtHM, fmtKm, fmtRace, fmtSigned, isNum, shiftDay, type RangeKey, type SportGroup } from '../lib/insights'
  import { activityLoad, buildAdvanced, fmtEff, fmtMonth, type RaceKey } from '../lib/advanced'
  import type { InsightsPayload } from '../lib/types'

  const RANGE_KEY = 'healthlog.insights.range'
  const SPORT_KEY = 'healthlog.advanced.sport'
  const todayDay = today()

  let data = $state<InsightsPayload | null>(null)
  let loading = $state(true)
  let loadError = $state('')
  let range = $state<RangeKey>((localStorage.getItem(RANGE_KEY) as RangeKey | null) ?? '90d')
  let sportPick = $state<SportGroup | null>((localStorage.getItem(SPORT_KEY) as SportGroup | null) ?? null)
  let raceKey = $state<RaceKey>('race5kS')

  const first = $derived(data?.coverage.first ?? todayDay)
  const span = $derived(RANGES.find((r) => r.key === range)?.days ?? null)
  const from = $derived(span === null ? first : (() => { const f = shiftDay(todayDay, -(span - 1)); return f < first ? first : f })())
  const adv = $derived(data ? buildAdvanced(data, from, todayDay) : null)
  const sport = $derived(adv ? adv.sports.find((s) => s.key === sportPick) ?? adv.sports.find((s) => s.key === 'run') ?? adv.sports[0] ?? null : null)
  const long = $derived(dayNum(todayDay) - dayNum(from) > 120)

  function setRange(next: string): void {
    range = next as RangeKey
    localStorage.setItem(RANGE_KEY, range)
  }
  function pickSport(key: SportGroup): void {
    sportPick = key
    localStorage.setItem(SPORT_KEY, key)
  }
  async function load(): Promise<void> {
    loading = !data
    loadError = ''
    try {
      data = await api.getInsights({ from: '2000-01-01', to: todayDay })
    } catch (cause) {
      loadError = cause instanceof Error ? cause.message : 'Could not load your data.'
    } finally {
      loading = false
    }
  }
  onMount(load)

  const SPORT_COLORS: Record<string, string> = {
    run: 'var(--viz-run)', ride: 'var(--viz-ride)', swim: 'var(--viz-swim)', strength: 'var(--viz-strength)',
    tennis: 'var(--viz-tennis)', hike: 'var(--viz-hike)', pilates: 'var(--viz-pilates)', other: 'var(--viz-other)',
  }
  const SECTIONS = [
    ['sport', 'Sport deep dive'], ['efficiency', 'Pace vs heart rate'], ['load', 'Training load'], ['races', 'Race predictions'],
    ['recovery', 'Recovery'], ['sleep', 'Sleep'], ['rhythm', 'Weekly rhythm'], ['months', 'Month by month'],
    ['energy', 'Energy & scale'], ['stress', 'Stress'], ['baselines', 'Baselines'],
  ] as const
  const WD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const RACE_OPTIONS = [{ value: 'race5kS', label: '5K' }, { value: 'race10kS', label: '10K' }, { value: 'raceHalfS', label: 'Half' }, { value: 'raceMarathonS', label: 'Marathon' }]

  function jump(id: string): void {
    document.getElementById(`adv-${id}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }
  const hrs = (h: number): string => (h >= 10 ? `${Math.round(h)}h` : h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(h * 60)}m`)
  const sparse = <T extends { day: string }>(xs: T[]): T[] => (long ? xs.filter((p) => new Date(`${p.day}T12:00:00Z`).getUTCDay() === 1) : xs)

  /* sport dive derived */
  const monthMax = $derived(sport ? Math.max(0.1, ...sport.months.map((m) => m.hours)) : 1)
  const sportZones = $derived(sport ? [
    { label: 'Z1', value: sport.zones[1], color: 'color-mix(in oklab, var(--color-accent) 30%, var(--color-surface))', ink: 'dark' as const },
    { label: 'Z2', value: sport.zones[2], color: 'color-mix(in oklab, var(--color-accent) 55%, var(--color-surface))', ink: 'dark' as const },
    { label: 'Z3', value: sport.zones[3], color: 'color-mix(in oklab, var(--color-accent) 80%, var(--color-surface))' },
    { label: 'Z4', value: sport.zones[4], color: 'var(--color-accent)' },
    { label: 'Z5', value: sport.zones[5], color: 'color-mix(in oklab, var(--color-accent) 70%, black)' },
  ] : [])
  const hourMax = $derived(sport ? Math.max(1, ...sport.hours24) : 1)
  const wdMax = $derived(sport ? Math.max(1, ...sport.weekdays) : 1)

  const race = $derived(adv ? adv.races[raceKey] : null)
  const rhythmScale = (vals: (number | null)[], v: number | null): number => {
    const xs = vals.filter(isNum)
    if (!isNum(v) || xs.length < 2) return 0
    const lo = Math.min(...xs)
    const hi = Math.max(...xs)
    return hi === lo ? 0.5 : (v - lo) / (hi - lo)
  }
  const monthsDesc = $derived(adv ? [...adv.months].reverse() : [])
  const lastYear = (m: string): (typeof monthsDesc)[number] | undefined => adv?.months.find((x) => x.month === `${+m.slice(0, 4) - 1}${m.slice(4)}`)
</script>

<div class="view view--advanced">
  <header class="adv-head">
    <div>
      <button class="back" type="button" onclick={() => navigate('insights')}><Icon name="chevron-left" size={18} /> Insights</button>
      <h1 class="view-title">Advanced insights</h1>
      <p class="view-subtitle">Deeper analysis of your Garmin history{adv ? `, ${fmtDayShort(from)} ${from.slice(0, 4)} – today` : ''}. Everything is computed on this device.</p>
    </div>
    {#if adv}
      <div class="range"><SegmentedControl ariaLabel="Date range" options={RANGES.map((r) => ({ value: r.key, label: r.label }))} value={range} onchange={setRange} /></div>
    {/if}
  </header>

  {#if loading}
    <div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Running the numbers…</span></div>
  {:else if loadError}
    <div class="card pad" role="alert"><p>{loadError}</p><button class="button button--secondary" type="button" onclick={load}>Try again</button></div>
  {:else if !adv || !data || (!data.days.length && !data.activities.length)}
    <div class="card pad"><p>No Garmin data yet. Import your export on the Insights tab first.</p><button class="button button--primary" type="button" onclick={() => navigate('insights')}>Go to Insights</button></div>
  {:else}
    <nav class="toc" aria-label="Jump to a section">
      {#each SECTIONS as [id, name] (id)}<button type="button" onclick={() => jump(id)}>{name}</button>{/each}
    </nav>

    <!-- ===================== 13. SPORT DEEP DIVE ===================== -->
    <section class="block" id="adv-sport" aria-labelledby="h-sport">
      <div class="block-head"><h2 id="h-sport">Sport deep dive</h2><p>Pick a sport to see how its volume, intensity and efficiency have moved.</p></div>
      <div class="sport-chips" role="radiogroup" aria-label="Sport">
        {#each adv.sports as s (s.key)}
          <button type="button" role="radio" aria-checked={sport?.key === s.key} class:on={sport?.key === s.key} onclick={() => pickSport(s.key)}>
            <i style:background={SPORT_COLORS[s.key]}></i>{s.label}<span>{s.sessions}</span>
          </button>
        {/each}
      </div>
      {#if sport}
        <article class="card pad sport-card" style:--sc={SPORT_COLORS[sport.key]}>
          {#if sport.headline}<p class="headline"><Icon name="sparkles" size={16} /> {sport.headline}</p>{/if}
          <div class="tiles">
            <div><span>Sessions</span><b>{sport.sessions}</b></div>
            <div><span>Time</span><b>{hrs(sport.hours)}</b><em>avg {fmtHM(sport.avgDurationS)}</em></div>
            {#if sport.distanceM > 0}<div><span>Distance</span><b>{fmtKm(sport.distanceM)}</b></div>{/if}
            <div><span>Avg heart rate</span><b>{isNum(sport.avgHr) ? Math.round(sport.avgHr) : '—'}<small> bpm</small></b></div>
            <div><span>Training effect</span><b>{isNum(sport.avgTe) ? sport.avgTe.toFixed(1) : '—'}</b><em>{isNum(sport.avgAnTe) ? `anaerobic ${sport.avgAnTe.toFixed(1)}` : 'aerobic'}</em></div>
            <div><span>Burn rate</span><b>{isNum(sport.kcalPerHour) ? Math.round(sport.kcalPerHour) : '—'}<small> kcal/h</small></b></div>
          </div>
          <div class="grid-2">
            <div>
              <h3 class="sub">Hours per month</h3>
              <div class="month-bars" role="img" aria-label="{sport.label} hours per month: {sport.months.map((m) => `${fmtMonth(m.key)} ${hrs(m.hours)}`).join(', ')}">
                {#each sport.months as m (m.key)}
                  <div title="{fmtMonth(m.key)} · {m.sessions} sessions{m.distanceKm >= 1 ? ` · ${m.distanceKm.toFixed(0)} km` : ''}">
                    <b>{m.hours > 0 ? hrs(m.hours) : ''}</b>
                    <span class="mb" style:height="{(m.hours / monthMax) * 100}%" style:background={SPORT_COLORS[sport.key]}></span>
                    <em>{fmtMonth(m.key).slice(0, 3)}</em>
                  </div>
                {/each}
              </div>
            </div>
            <div>
              {#if sport.efficiency}
                <h3 class="sub">Speed at {sport.efficiency.refHr} bpm <span class="note">{sport.efficiency.unit === 'speed' ? 'higher is better' : 'lower is faster'}</span></h3>
                <MultiLine label="{sport.label}: speed normalised to {sport.efficiency.refHr} bpm" from={from} to={todayDay} height={180} format={(v) => fmtEff(v, sport.efficiency!.unit)} tickStep={sport.efficiency.unit === 'speed' ? 1 : sport.efficiency.unit === 'pace-100m' ? 5 : 15}
                  series={[
                    { label: 'Session', points: sport.efficiency.runs.map((r) => ({ day: r.day, value: r.adjPaceS })), color: `color-mix(in oklab, ${SPORT_COLORS[sport.key]} 45%, var(--color-surface))`, dots: true },
                    { label: '30-day trend', points: sport.efficiency.trend, color: SPORT_COLORS[sport.key] },
                  ]} />
              {:else}
                <h3 class="sub">Average heart rate, 30-day trend</h3>
                <LineChart label="{sport.label}: average heart rate" {from} to={todayDay} line={sport.hrTrend} format={(v) => `${Math.round(v)}`} lineLabel="Avg HR" height={180} color={SPORT_COLORS[sport.key]} />
              {/if}
            </div>
          </div>
          <div class="grid-3">
            <div>
              <h3 class="sub">Heart-rate zones</h3>
              {#if sport.zones.slice(1).some((z) => z > 0)}<SegmentBar label="{sport.label} time by zone" parts={sportZones} format={(v) => hrs(v / 3600)} />{:else}<p class="note">No zone data.</p>{/if}
            </div>
            <div>
              <h3 class="sub">Which days</h3>
              <div class="mini-bars" role="img" aria-label="Sessions by weekday: {WD.map((d, i) => `${d} ${sport!.weekdays[i]}`).join(', ')}">
                {#each sport.weekdays as c, i (i)}
                  <div><span class="mb" style:height="{(c / wdMax) * 100}%" style:background={SPORT_COLORS[sport.key]}></span><em>{WD[i][0]}</em></div>
                {/each}
              </div>
            </div>
            <div>
              <h3 class="sub">Time of day</h3>
              <div class="mini-bars hours" role="img" aria-label="Sessions by start hour">
                {#each sport.hours24 as c, h (h)}
                  <div title="{String(h).padStart(2, '0')}:00 · {c} sessions"><span class="mb" style:height="{(c / hourMax) * 100}%" style:background={SPORT_COLORS[sport.key]}></span><em>{h % 6 === 0 ? h : ''}</em></div>
                {/each}
              </div>
            </div>
          </div>
          <div class="bests">
            {#if sport.longest}<div><span>Longest</span><b>{fmtHM(sport.longest.durationS)}</b><em>{sport.longest.name ?? activityTypeLabel(sport.longest.type)} · {fmtDayShort(sport.longest.day)}</em></div>{/if}
            {#if sport.fastest}<div><span>Fastest pace</span><b>{fmtRace(sport.fastest.paceS)}<small>{sport.key === 'swim' ? ' /100 m' : ' /km'}</small></b><em>{fmtKm(sport.fastest.distanceM)} · {fmtDayShort(sport.fastest.day)}</em></div>{/if}
            {#if sport.hardest}<div><span>Hardest</span><b>{Math.round(activityLoad(sport.hardest))}<small> load</small></b><em>{sport.hardest.name ?? activityTypeLabel(sport.hardest.type)} · {fmtDayShort(sport.hardest.day)}</em></div>{/if}
          </div>
        </article>
      {/if}
    </section>

    <!-- ===================== 3. PACE VS HEART RATE (lab) ===================== -->
    <section class="block" id="adv-efficiency" aria-labelledby="h-eff">
      <div class="block-head"><h2 id="h-eff">Running: pace vs heart rate lab</h2><p>Every run re-expressed at one heart rate, so easy and hard days compare fairly — the cleanest read of your aerobic engine. Zoom into any stretch, pick any heart rate, and see what breaks cost you.</p></div>
      <PaceHrLab acts={data.activities} today={todayDay} lthr={data.meta.hrZones?.lthr ?? data.meta.thresholds?.lthr ?? null} />
    </section>

    <!-- ===================== 1 + 2. TRAINING LOAD ===================== -->
    <section class="block" id="adv-load" aria-labelledby="h-load">
      <div class="block-head"><h2 id="h-load">Training load</h2><p>How your recent training compares with what your body is used to, and how fit, tired and fresh that leaves you.</p></div>
      <div class="stats">
        <div class="stat"><span>Acute : chronic</span><b>{isNum(adv.load.now.acwr) ? adv.load.now.acwr.toFixed(2) : '—'}</b><em>{adv.load.acwrZone === 'optimal' ? 'in the sweet spot (0.8–1.3)' : adv.load.acwrZone === 'low' ? 'below usual — detraining risk' : adv.load.acwrZone === 'high' ? 'ramping up — watch it' : adv.load.acwrZone === 'danger' ? 'spike — injury risk' : 'not enough history'}</em></div>
        <div class="stat"><span>Fitness</span><b>{isNum(adv.load.now.ctl) ? Math.round(adv.load.now.ctl) : '—'}</b><em>42-day load</em></div>
        <div class="stat"><span>Fatigue</span><b>{isNum(adv.load.now.atl) ? Math.round(adv.load.now.atl) : '—'}</b><em>7-day load</em></div>
        <div class="stat"><span>Form</span><b>{isNum(adv.load.now.tsb) ? fmtSigned(adv.load.now.tsb) : '—'}</b><em>{adv.load.formLabel ?? ''}</em></div>
      </div>
      <div class="grid-2">
        <article class="card pad">
          <div class="chart-head"><h3>Acute : chronic ratio</h3><p class="note">{adv.load.spikes} spike day{adv.load.spikes === 1 ? '' : 's'} over 1.5</p></div>
          <MultiLine label="Acute to chronic workload ratio" {from} to={todayDay} height={200} format={(v) => v.toFixed(1)} zone={{ lo: 0.8, hi: 1.3, label: 'Sweet spot' }} include={[0]}
            series={[{ label: 'Ratio', points: adv.load.acwr, color: 'var(--color-accent)' }]} />
        </article>
        <article class="card pad">
          <div class="chart-head"><h3>Fitness & fatigue</h3><ul class="legend"><li><i style:background="var(--viz-run)"></i>Fitness (42-day)</li><li><i style:background="var(--viz-ride)"></i>Fatigue (7-day)</li></ul></div>
          <MultiLine label="Fitness and fatigue" {from} to={todayDay} height={200} include={[0]}
            series={[{ label: 'Fitness', points: adv.load.ctl, color: 'var(--viz-run)' }, { label: 'Fatigue', points: adv.load.atl, color: 'var(--viz-ride)' }]} />
        </article>
      </div>
      <article class="card pad">
        <div class="chart-head"><h3>Form {long ? '(weekly, Mondays)' : '(daily)'}</h3><ul class="legend"><li><i style:background="var(--viz-swim)"></i>Fresh</li><li><i style:background="var(--viz-ride)"></i>Fatigued</li></ul></div>
        <BalanceBars label="Form: fitness minus fatigue" bars={sparse(adv.load.tsb.filter((p) => isNum(p.value))).map((p) => ({ key: p.day, heading: fmtDayLong(p.day), value: p.value as number }))} {from} to={todayDay} keyDays={long ? 7 : 1} upLabel="Fresh" downLabel="Fatigued" upColor="var(--viz-swim)" downColor="var(--viz-ride)" height={170} />
        <p class="note">Form = fitness − fatigue. Racing is best around +5 to +25; −10 to −30 is productive training; below −30, back off.</p>
      </article>
    </section>

    <!-- ===================== 4. RACE PREDICTIONS ===================== -->
    <section class="block" id="adv-races" aria-labelledby="h-races">
      <div class="block-head row"><div><h2 id="h-races">Race prediction progression</h2><p>What moved your predicted times, and what you were doing when they moved.</p></div>
        <div class="race-pick"><SegmentedControl ariaLabel="Race distance" options={RACE_OPTIONS} value={raceKey} onchange={(v) => (raceKey = v as RaceKey)} /></div></div>
      {#if race && race.series.length >= 2}
        <div class="stats">
          <div class="stat"><span>Predicted now</span><b>{fmtRace(race.now)}</b></div>
          <div class="stat"><span>Start of range</span><b>{fmtRace(race.first)}</b></div>
          <div class="stat"><span>Change</span><b class:good={(race.now ?? 0) < (race.first ?? 0)}>{isNum(race.now) && isNum(race.first) ? `${race.now < race.first ? '−' : '+'}${fmtRace(Math.abs(race.now - race.first))}` : '—'}</b></div>
          <div class="stat"><span>Best prediction</span><b>{fmtRace(race.best)}</b></div>
        </div>
        <article class="card pad">
          <LineChart label="Predicted race time" {from} to={todayDay} line={race.series} step format={(v) => fmtRace(v)} lineLabel="Prediction" height={200} />
          {#if race.windows.length}
            <h3 class="sub top">Biggest moves</h3>
            <ul class="moves">
              {#each race.windows as w (w.from)}
                <li class:good={w.change < 0}>
                  <b>{w.change < 0 ? '−' : '+'}{fmtRace(Math.abs(w.change))}</b>
                  <span>{fmtDayShort(w.from)} – {fmtDayShort(w.to)} {w.to.slice(0, 4)}</span>
                  <em>{w.runKmPerWeek.toFixed(1)} km running/week · {w.hoursPerWeek.toFixed(1)} h training/week{isNum(race.avgRunKmPerWeek) ? ` (range average ${race.avgRunKmPerWeek.toFixed(1)} km)` : ''}</em>
                </li>
              {/each}
            </ul>
          {/if}
        </article>
      {:else}
        <p class="empty">No race predictions in this range.</p>
      {/if}
    </section>

    <!-- ===================== 8. RECOVERY ===================== -->
    <section class="block" id="adv-recovery" aria-labelledby="h-rec">
      <div class="block-head"><h2 id="h-rec">Recovery after hard sessions</h2><p>What happens to your resting heart rate and Body Battery in the days after your hardest {adv.recovery.sessions} sessions (load ≥ {Math.round(adv.recovery.threshold)}), against the week before.</p></div>
      {#if adv.recovery.sessions >= 3}
        <div class="grid-2">
          <article class="card pad scroll-x">
            <h3 class="sub">Days after, vs your previous week</h3>
            <table class="tbl">
              <thead><tr><th scope="col">Day</th><th scope="col" class="num">Resting HR</th><th scope="col" class="num">Body Battery at wake</th></tr></thead>
              <tbody>
                {#each adv.recovery.curve as c (c.day)}
                  <tr><th scope="row">+{c.day}</th>
                    <td class="num" class:bad={(c.rhr ?? 0) > 0.5}>{isNum(c.rhr) ? `${fmtSigned(c.rhr, 1)} bpm` : '—'}</td>
                    <td class="num" class:bad={(c.bb ?? 0) < -5}>{isNum(c.bb) ? fmtSigned(c.bb) : '—'}</td></tr>
                {/each}
              </tbody>
            </table>
          </article>
          <article class="card pad scroll-x">
            <h3 class="sub">By sport</h3>
            <table class="tbl">
              <thead><tr><th scope="col">Sport</th><th scope="col" class="num">Sessions</th><th scope="col" class="num">RHR day after</th><th scope="col" class="num">Battery dip</th><th scope="col" class="num">Days to normal</th></tr></thead>
              <tbody>
                {#each adv.recovery.bySport as s (s.key)}
                  <tr><th scope="row"><i class="sw" style:background={SPORT_COLORS[s.key]}></i>{s.label}</th><td class="num">{s.sessions}</td>
                    <td class="num">{isNum(s.rhrBump) ? fmtSigned(s.rhrBump, 1) : '—'}</td><td class="num">{isNum(s.bbDip) ? fmtSigned(s.bbDip) : '—'}</td><td class="num">{isNum(s.daysToNormal) ? s.daysToNormal.toFixed(1) : '—'}</td></tr>
                {/each}
              </tbody>
            </table>
          </article>
        </div>
      {:else}
        <p class="empty">Needs at least 3 hard sessions in this range.</p>
      {/if}
    </section>

    <!-- ===================== 5 + 6 + 7. SLEEP ===================== -->
    <section class="block" id="adv-sleep" aria-labelledby="h-sleep">
      <div class="block-head"><h2 id="h-sleep">Sleep: debt, consistency and what drives it</h2></div>
      <div class="stats">
        <div class="stat"><span>Your sleep need</span><b>{fmtHM(adv.sleep.needS)}</b><em>from {adv.sleep.needBasis} fully-charged nights</em></div>
        <div class="stat"><span>Debt, last 14 nights</span><b class:bad={(adv.sleep.debtNow ?? 0) > 3600 * 3}>{isNum(adv.sleep.debtNow) ? (adv.sleep.debtNow >= 0 ? fmtHM(adv.sleep.debtNow) : `+${fmtHM(-adv.sleep.debtNow)} banked`) : '—'}</b></div>
        <div class="stat"><span>This week</span><b>{isNum(adv.sleep.weekDebt) ? (adv.sleep.weekDebt >= 0 ? `${fmtHM(adv.sleep.weekDebt)} short` : `${fmtHM(-adv.sleep.weekDebt)} over`) : '—'}</b></div>
        <div class="stat"><span>Consistency</span><b>{isNum(adv.sleep.consistencyNow) ? Math.round(adv.sleep.consistencyNow) : '—'}<small>/100</small></b><em>bedtime ± {isNum(adv.sleep.bedSd) ? Math.round(adv.sleep.bedSd) : '—'} min, wake ± {isNum(adv.sleep.wakeSd) ? Math.round(adv.sleep.wakeSd) : '—'} min</em></div>
      </div>
      <div class="grid-2">
        <article class="card pad">
          <div class="chart-head"><h3>Rolling 14-night sleep debt</h3></div>
          <LineChart label="Sleep debt over the last 14 nights" {from} to={todayDay} line={adv.sleep.debt14.map((p) => ({ day: p.day, value: isNum(p.value) ? p.value / 3600 : null }))} include={[0]} format={(v) => `${v.toFixed(0)}h`} lineLabel="Debt" height={190} />
          <p class="note">Need = your typical night when you wake with Body Battery 90+. Above zero: owed.</p>
        </article>
        <article class="card pad">
          <div class="chart-head"><h3>Bedtime consistency</h3></div>
          <LineChart label="Sleep timing consistency score" {from} to={todayDay} line={adv.sleep.consistency} include={[0, 100]} max={100} format={(v) => `${Math.round(v)}`} lineLabel="Consistency" height={190} />
          {#if isNum(adv.sleep.steadyScore) && isNum(adv.sleep.erraticScore)}
            <p class="note">Bed within 30 min of your usual: sleep score <b>{Math.round(adv.sleep.steadyScore)}</b>. An hour or more off: <b>{Math.round(adv.sleep.erraticScore)}</b>.</p>
          {/if}
        </article>
      </div>
      {#if adv.sleep.predictors.length}
        <article class="card pad">
          <div class="chart-head"><h3>What predicts a great night</h3><p class="note">Correlation with that night’s sleep score (−1 to +1)</p></div>
          <ul class="corr">
            {#each adv.sleep.predictors as p (p.label)}
              <li>
                <span class="c-label">{p.label}</span>
                <span class="c-track" aria-hidden="true"><span class="c-mid"></span><span class="c-fill" class:neg={p.r < 0} style:width="{Math.abs(p.r) * 50}%" style:left={p.r < 0 ? `${50 - Math.abs(p.r) * 50}%` : '50%'}></span></span>
                <span class="c-val">{p.r > 0 ? '+' : p.r < 0 ? '−' : ''}{Math.abs(p.r).toFixed(2)}</span>
                <span class="c-text">{Math.abs(p.r) < 0.1 ? 'no real link' : `${p.detail} → ${p.r > 0 ? 'better' : 'worse'} sleep`}</span>
              </li>
            {/each}
          </ul>
          <p class="note">Correlation, not proof of cause. Over {adv.sleep.predictors[0]?.n ?? 0} nights.</p>
        </article>
      {/if}
    </section>

    <!-- ===================== 9. WEEKLY RHYTHM ===================== -->
    <section class="block" id="adv-rhythm" aria-labelledby="h-rhythm">
      <div class="block-head"><h2 id="h-rhythm">Your weekly rhythm</h2><p>Average by day of the week. Darker = higher within each row.</p></div>
      {#if adv.rhythm.length}
        <article class="card pad scroll-x">
          <table class="heat">
            <thead><tr><th scope="col"><span class="sr-only">Metric</span></th>{#each WD as d (d)}<th scope="col">{d}</th>{/each}</tr></thead>
            <tbody>
              {#each adv.rhythm as row (row.label)}
                <tr>
                  <th scope="row">{row.label}</th>
                  {#each row.values as v, i (i)}
                    {@const t = rhythmScale(row.values, v)}
                    <td style:background="color-mix(in oklab, var(--color-accent) {Math.round(8 + t * 62)}%, var(--color-surface))" class:ink={t > 0.6}>{isNum(v) ? row.format(v) : '—'}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </article>
      {:else}<p class="empty">Not enough days in this range.</p>{/if}
    </section>

    <!-- ===================== 10. MONTH BY MONTH ===================== -->
    <section class="block" id="adv-months" aria-labelledby="h-months">
      <div class="block-head"><h2 id="h-months">Month by month</h2><p>Arrows compare with the month before; “last year” appears once there is a year of history in range.</p></div>
      {#if monthsDesc.length}
        <article class="card pad scroll-x">
          <table class="tbl months">
            <thead><tr><th scope="col">Month</th><th scope="col" class="num">Resting HR</th><th scope="col" class="num">Sleep</th><th scope="col" class="num">Sleep score</th><th scope="col" class="num">Training</th><th scope="col" class="num">Stress</th><th scope="col" class="num">Steps</th><th scope="col" class="num">VO₂ max</th></tr></thead>
            <tbody>
              {#each monthsDesc as m, i (m.month)}
                {@const prev = monthsDesc[i + 1]}
                {@const ly = lastYear(m.month)}
                {@const arrow = (a: number | null | undefined, b: number | null | undefined, goodUp: boolean, eps: number) => (!isNum(a) || !isNum(b) || Math.abs(a - b) < eps ? '' : `${a > b ? 't-up' : 't-down'} ${(a > b) === goodUp ? 't-good' : 't-bad'}`)}
                <tr>
                  <th scope="row">{fmtMonth(m.month)}{#if m.month === todayDay.slice(0, 7)}<em> so far</em>{/if}</th>
                  <td class="num {arrow(m.rhr, prev?.rhr, false, 0.5)}">{isNum(m.rhr) ? m.rhr.toFixed(1) : '—'}{#if ly && isNum(ly.rhr)}<small> ({ly.rhr.toFixed(0)} LY)</small>{/if}</td>
                  <td class="num {arrow(m.sleepS, prev?.sleepS, true, 600)}">{fmtHM(m.sleepS)}</td>
                  <td class="num {arrow(m.score, prev?.score, true, 1.5)}">{isNum(m.score) ? Math.round(m.score) : '—'}</td>
                  <td class="num {arrow(m.trainH, prev?.trainH, true, 1)}">{hrs(m.trainH)}</td>
                  <td class="num {arrow(m.stress, prev?.stress, false, 1.5)}">{isNum(m.stress) ? Math.round(m.stress) : '—'}</td>
                  <td class="num {arrow(m.steps, prev?.steps, true, 500)}">{isNum(m.steps) ? Math.round(m.steps).toLocaleString() : '—'}</td>
                  <td class="num {arrow(m.vo2, prev?.vo2, true, 0.5)}">{m.vo2 ?? '—'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="note">▲▼ = up or down on the month before; <span class="t-good-key">green</span> is better, <span class="t-bad-key">red</span> worse.</p>
        </article>
      {/if}
    </section>

    <!-- ===================== 11 + 12. ENERGY ===================== -->
    <section class="block" id="adv-energy" aria-labelledby="h-energy">
      <div class="block-head"><h2 id="h-energy">Energy vs the scale, and protein</h2><p>Does eaten − burned actually predict your weight? And how much protein do you get on training days?</p></div>
      <div class="grid-2">
        <article class="card pad">
          <h3 class="sub">Calories vs the scale</h3>
          {#if adv.scale.reason}
            <p class="empty">{adv.scale.reason}</p>
          {:else}
            <div class="tiles small">
              <div><span>Watch says you burn</span><b>{Math.round(adv.scale.watchBurn ?? 0).toLocaleString()}</b><em>kcal/day</em></div>
              <div><span>Scale implies</span><b>{isNum(adv.scale.impliedBurn) ? Math.round(adv.scale.impliedBurn).toLocaleString() : '—'}</b><em>kcal/day</em></div>
              <div><span>Watch error</span><b>{isNum(adv.scale.watchErrorKcal) ? fmtSigned(adv.scale.watchErrorKcal) : '—'}</b><em>{(adv.scale.watchErrorKcal ?? 0) > 0 ? 'overestimates' : 'underestimates'}</em></div>
            </div>
            <MultiLine label="Predicted vs actual weight change" {from} to={todayDay} height={190} format={(v) => `${v.toFixed(1)} kg`} include={[0]}
              series={[{ label: 'From calories', points: adv.scale.predicted, color: 'var(--viz-ride)', dashed: true }, { label: 'Scale', points: adv.scale.actual, color: 'var(--viz-run)', dots: true }]} />
            <ul class="legend"><li><i style:background="var(--viz-ride)"></i>Predicted from calories</li><li><i class="dot" style:background="var(--viz-run)"></i>Scale</li></ul>
          {/if}
        </article>
        <article class="card pad">
          <h3 class="sub">Protein</h3>
          {#if adv.protein.reason}
            <p class="empty">{adv.protein.reason}</p>
          {:else}
            <div class="tiles small">
              <div><span>Training days</span><b>{isNum(adv.protein.trainDay) ? Math.round(adv.protein.trainDay) : '—'}<small> g</small></b></div>
              <div><span>Rest days</span><b>{isNum(adv.protein.restDay) ? Math.round(adv.protein.restDay) : '—'}<small> g</small></b></div>
              <div><span>Per kg</span><b>{isNum(adv.protein.perKg) ? adv.protein.perKg.toFixed(1) : '—'}<small> g/kg</small></b><em>{isNum(adv.protein.perKg) ? '1.6–2.2 for training' : 'log a weigh-in to see this'}</em></div>
            </div>
            {#if isNum(adv.protein.highRhr) && isNum(adv.protein.lowRhr)}
              <p class="note">Next-morning resting HR after higher-protein days: <b>{adv.protein.highRhr.toFixed(1)}</b> bpm, after lower: <b>{adv.protein.lowRhr.toFixed(1)}</b> bpm ({adv.protein.days} logged days).</p>
            {/if}
          {/if}
        </article>
      </div>
    </section>

    <!-- ===================== 14. STRESS ===================== -->
    <section class="block" id="adv-stress" aria-labelledby="h-stress">
      <div class="block-head"><h2 id="h-stress">Stress fingerprint</h2><p>How your day splits by stress level, and what tends to come before your most stressful days.</p></div>
      {#if adv.stress}
        {@const st = adv.stress}
        <div class="grid-2">
          <article class="card pad">
            <h3 class="sub">An average day</h3>
            <SegmentBar label="Average day by stress level" format={fmtHM} parts={[
              { label: 'Rest', value: st.perDay.rest, color: 'color-mix(in oklab, var(--viz-run) 45%, var(--color-surface))', ink: 'dark' },
              { label: 'Low', value: st.perDay.low, color: 'color-mix(in oklab, var(--viz-ride) 45%, var(--color-surface))', ink: 'dark' },
              { label: 'Medium', value: st.perDay.medium, color: 'color-mix(in oklab, var(--viz-ride) 75%, var(--color-surface))' },
              { label: 'High', value: st.perDay.high, color: 'var(--viz-ride)' },
            ]} />
            <p class="note">{isNum(st.restRatio) ? `${st.restRatio.toFixed(1)} hours of rest for every hour under stress.` : ''} Typical daily peak {isNum(st.avgMax) ? Math.round(st.avgMax) : '—'}.</p>
            <h3 class="sub top">Most stressful days</h3>
            <ul class="days">{#each st.topDays as d (d.day)}<li><span>{fmtDayLong(d.day)}</span><b>{Math.round(d.stress)}</b><em>{Math.round(d.highMin)} min high</em></li>{/each}</ul>
          </article>
          <article class="card pad">
            <h3 class="sub">Before your top 10% stress days vs the rest</h3>
            <ul class="before">
              {#each st.before as b (b.label)}
                <li class:bad={b.worse === true}><span>{b.label}</span><b>{b.format(b.top)}</b><em>vs {b.format(b.normal)}</em></li>
              {/each}
            </ul>
            <p class="note">Red rows are the ones that look worse before a stressful day.</p>
          </article>
        </div>
      {:else}<p class="empty">Needs 14 days of stress data in this range.</p>{/if}
    </section>

    <!-- ===================== 15. BASELINES ===================== -->
    <section class="block" id="adv-baselines" aria-labelledby="h-base">
      <div class="block-head"><h2 id="h-base">Your normal, and the days that broke it</h2><p>Normal = your middle 80% over the last 90 days. The dot is your latest value.</p></div>
      <div class="grid-2">
        <article class="card pad">
          <ul class="baselines">
            {#each adv.baselines as b (b.label)}
              {@const lo = b.p10 - (b.p90 - b.p10) * 0.35}
              {@const hi = b.p90 + (b.p90 - b.p10) * 0.35}
              {@const pos = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo || 1)) * 100))}
              <li>
                <span class="b-label">{b.label}</span>
                <span class="b-track" aria-hidden="true">
                  <span class="b-band" style:left="{pos(b.p10)}%" style:width="{pos(b.p90) - pos(b.p10)}%"></span>
                  <span class="b-med" style:left="{pos(b.p50)}%"></span>
                  {#if isNum(b.latest)}<span class="b-dot" style:left="{pos(b.latest)}%"></span>{/if}
                </span>
                <span class="b-val">{b.format(b.p10)} – {b.format(b.p90)}</span>
              </li>
            {/each}
          </ul>
        </article>
        <article class="card pad">
          <h3 class="sub">Days that stood out</h3>
          {#if adv.outliers.length}
            <ul class="outliers">
              {#each adv.outliers as o (o.day + o.text)}
                <li class:good={o.good}><span class="o-mark" aria-hidden="true">{o.good ? '▲' : '▼'}</span><span class="o-text">{o.text}</span><em>{fmtDayShort(o.day)}</em></li>
              {/each}
            </ul>
          {:else}<p class="empty">No standout days in this range.</p>{/if}
        </article>
      </div>
    </section>

    <p class="note foot">Bedtimes are local wall-clock ({fmtClockMin(23 * 60)} = 11 pm). Load uses Garmin’s training load per activity, or duration × training effect when missing.</p>
  {/if}
</div>

<style>
  .view--advanced { gap: var(--space-6); }
  .adv-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .back { display: inline-flex; margin: 0 0 var(--space-2) calc(-1 * var(--space-2)); padding: var(--space-1) var(--space-2); align-items: center; gap: 2px; border: 0; border-radius: var(--radius-sm); background: none; color: var(--color-accent); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .back:hover { background: var(--color-accent-soft); }
  .range { min-width: 15rem; }
  .skeleton { display: flex; min-height: 14rem; align-items: center; justify-content: center; gap: var(--space-3); color: var(--color-text-muted); }
  .card { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .pad { padding: var(--space-5); }
  .toc { position: sticky; z-index: 5; top: 0; display: flex; margin-inline: calc(-1 * var(--space-4)); padding: var(--space-2) var(--space-4); gap: var(--space-2); overflow-x: auto; background: color-mix(in srgb, var(--color-bg) 92%, transparent); backdrop-filter: blur(10px); scrollbar-width: none; }
  .toc::-webkit-scrollbar { display: none; }
  .toc button { flex: 0 0 auto; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-surface); color: var(--color-text); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .toc button:hover { border-color: var(--color-accent); color: var(--color-accent); }
  .block { display: flex; flex-direction: column; gap: var(--space-4); scroll-margin-top: 4rem; }
  .block > * { min-width: 0; }
  .block-head h2 { margin: 0; font-size: var(--text-xl); letter-spacing: -0.02em; }
  .block-head p { max-width: 46rem; margin: var(--space-1) 0 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .block-head.row { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .race-pick { min-width: 16rem; }
  .grid-2, .grid-3 { display: grid; gap: var(--space-4); align-items: start; }
  .grid-2 > *, .grid-3 > * { min-width: 0; }
  .chart-head { display: flex; margin-bottom: var(--space-3); align-items: baseline; justify-content: space-between; gap: var(--space-2) var(--space-4); flex-wrap: wrap; }
  .chart-head h3, .sub { margin: 0; font-size: var(--text-md); }
  .sub { margin-bottom: var(--space-3); }
  .sub.top { margin-top: var(--space-5); }
  .note { margin: var(--space-2) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-regular); }
  .sub .note { margin-left: var(--space-2); }
  .empty { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .foot { text-align: center; }
  .legend { display: flex; margin: var(--space-2) 0 0; padding: 0; flex-wrap: wrap; gap: var(--space-1) var(--space-3); list-style: none; color: var(--color-text-muted); font-size: var(--text-xs); }
  .chart-head .legend { margin: 0; }
  .legend li { display: inline-flex; align-items: center; gap: 5px; }
  .legend i { display: inline-block; width: 12px; height: 3px; border-radius: 2px; }
  .legend i.dot { width: 8px; height: 8px; border-radius: 50%; }
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .stat { display: flex; padding: var(--space-4); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
  .stat span, .tiles span, .bests span { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .stat b { font-size: var(--text-2xl); font-weight: var(--weight-bold); letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .stat em, .tiles em, .bests em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  b small { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: 0; }
  .good { color: var(--color-up); }
  .bad { color: var(--color-down); }

  /* sport */
  .sport-chips { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .sport-chips button { display: inline-flex; min-height: 2.5rem; padding: 0 var(--space-3); align-items: center; gap: var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-surface); color: var(--color-text); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .sport-chips button.on { border-color: var(--color-text); box-shadow: inset 0 0 0 1px var(--color-text); }
  .sport-chips i { width: 10px; height: 10px; border-radius: 50%; }
  .sport-chips span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .sport-card { display: flex; flex-direction: column; gap: var(--space-5); border-top: 3px solid var(--sc); background: radial-gradient(90% 60% at 100% 0%, color-mix(in oklab, var(--sc) 10%, transparent), transparent 70%), var(--color-surface); }
  .headline { display: flex; margin: 0; padding: var(--space-3) var(--space-4); align-items: center; gap: var(--space-2); border-radius: var(--radius-md); background: var(--color-accent-soft); color: var(--color-text); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 8.5rem), 1fr)); gap: var(--space-3); }
  .tiles.small { margin-bottom: var(--space-4); grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tiles div, .bests div { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
  .tiles b { font-size: var(--text-xl); font-weight: var(--weight-bold); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .mini-bars { display: grid; height: 6.5rem; grid-template-columns: repeat(7, 1fr); gap: 4px; align-items: end; }
  .mini-bars.hours { grid-template-columns: repeat(24, 1fr); gap: 2px; }
  .mini-bars div { display: flex; height: 100%; flex-direction: column; justify-content: flex-end; align-items: stretch; gap: 3px; }
  .mb { display: block; min-height: 2px; border-radius: 3px 3px 0 0; }
  .mini-bars em { height: 1rem; color: var(--color-text-muted); font-size: 0.625rem; font-style: normal; text-align: center; }
  .bests { display: grid; padding-top: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr)); gap: var(--space-4); border-top: 1px solid var(--color-border); }
  .bests b { font-size: var(--text-xl); font-weight: var(--weight-bold); font-variant-numeric: tabular-nums; }

  /* lists & tables */
  .moves { display: grid; margin: 0; padding: 0; gap: var(--space-2); list-style: none; }
  .moves li { display: grid; padding: var(--space-3); grid-template-columns: 5rem 1fr; gap: 2px var(--space-3); border-radius: var(--radius-md); background: var(--color-surface-sunken); font-size: var(--text-sm); }
  .moves b { grid-row: span 2; align-self: center; color: var(--color-down); font-size: var(--text-lg); font-variant-numeric: tabular-nums; }
  .moves li.good b { color: var(--color-up); }
  .moves em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .tbl th, .tbl td { padding: var(--space-2); border-top: 1px solid var(--color-border); text-align: left; white-space: nowrap; }
  .tbl thead th { border-top: 0; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .tbl .num { text-align: right; }
  .tbl tbody th { font-weight: var(--weight-medium); }
  .tbl th em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .tbl small { color: var(--color-text-subtle); font-size: 0.6875rem; }
  .sw { display: inline-block; width: 9px; height: 9px; margin-right: 6px; border-radius: 50%; }
  .scroll-x { overflow-x: auto; }
  td.t-up::after { content: ' ▲'; font-size: 0.6rem; }
  td.t-down::after { content: ' ▼'; font-size: 0.6rem; }
  td.t-good::after { color: var(--color-up); }
  td.t-bad::after { color: var(--color-down); }
  .t-good-key { color: var(--color-up); }
  .t-bad-key { color: var(--color-down); }
  .month-bars { display: grid; height: 11rem; grid-auto-columns: minmax(0, 1fr); grid-auto-flow: column; gap: var(--space-2); align-items: end; }
  .month-bars div { display: flex; height: 100%; min-width: 0; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px; }
  .month-bars .mb { width: min(100%, 2.75rem); border-radius: 4px 4px 0 0; }
  .month-bars b { font-size: var(--text-xs); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .month-bars em { color: var(--color-text-muted); font-size: 0.6875rem; font-style: normal; }
  .heat { width: 100%; min-width: 36rem; border-collapse: separate; border-spacing: 3px; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .heat th { padding: var(--space-1) var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); text-align: center; }
  .heat tbody th { text-align: left; white-space: nowrap; }
  .heat td { padding: var(--space-2); border-radius: 6px; text-align: center; }
  .heat td.ink { color: var(--color-on-accent); font-weight: var(--weight-semibold); }
  .corr { display: grid; margin: 0; padding: 0; gap: var(--space-2); list-style: none; }
  .corr li { display: grid; align-items: center; grid-template-columns: minmax(8rem, 12rem) minmax(6rem, 1fr) 3rem minmax(8rem, 14rem); gap: var(--space-3); font-size: var(--text-sm); }
  .c-track { position: relative; height: 10px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .c-mid { position: absolute; top: -3px; bottom: -3px; left: 50%; width: 1px; background: var(--color-border-strong); }
  .c-fill { position: absolute; top: 0; bottom: 0; border-radius: var(--radius-pill); background: var(--viz-deficit); }
  .c-fill.neg { background: var(--viz-surplus); }
  .c-val { font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; text-align: right; }
  .c-text { color: var(--color-text-muted); font-size: var(--text-xs); }
  .days, .before, .outliers { display: grid; margin: 0; padding: 0; list-style: none; }
  .days li, .before li, .outliers li { display: flex; padding: var(--space-2) 0; align-items: baseline; gap: var(--space-3); border-top: 1px solid var(--color-border); font-size: var(--text-sm); }
  .days li:first-child, .before li:first-child, .outliers li:first-child { border-top: 0; }
  .days span, .before span, .o-text { flex: 1; min-width: 0; }
  .days b, .before b { font-variant-numeric: tabular-nums; }
  .days em, .before em, .outliers em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .before li.bad b { color: var(--color-down); }
  .o-mark { color: var(--color-down); font-size: 0.7rem; }
  .outliers li.good .o-mark { color: var(--color-up); }
  .baselines { display: grid; margin: 0; padding: 0; gap: var(--space-3); list-style: none; }
  .baselines li { display: grid; align-items: center; grid-template-columns: minmax(7rem, 10rem) 1fr minmax(6.5rem, auto); gap: var(--space-3); font-size: var(--text-sm); }
  .b-track { position: relative; height: 14px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .b-band { position: absolute; top: 3px; bottom: 3px; border-radius: var(--radius-pill); background: color-mix(in oklab, var(--color-accent) 35%, var(--color-surface)); }
  .b-med { position: absolute; top: 1px; bottom: 1px; width: 2px; margin-left: -1px; background: var(--color-accent); }
  .b-dot { position: absolute; top: 50%; width: 12px; height: 12px; margin: -6px 0 0 -6px; border: 2px solid var(--color-surface); border-radius: 50%; background: var(--color-text); }
  .b-val { color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; text-align: right; }

  @media (min-width: 43.75rem) { .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); } .grid-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (min-width: 62rem) { .grid-2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
  @media (max-width: 40rem) {
    .corr li { grid-template-columns: 1fr 3rem; }
    .c-track { grid-column: 1 / -1; grid-row: 2; }
    .c-text { grid-column: 1 / -1; }
    .baselines li { grid-template-columns: 1fr auto; }
    .b-track { grid-column: 1 / -1; grid-row: 2; }
    .range, .race-pick { width: 100%; min-width: 0; }
  }
</style>
