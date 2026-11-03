<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import SegmentedControl from '../lib/components/SegmentedControl.svelte'
  import GarminImportPanel from '../lib/panels/GarminImportPanel.svelte'
  import LineChart from '../lib/viz/LineChart.svelte'
  import StackedBars from '../lib/viz/StackedBars.svelte'
  import RangeBars from '../lib/viz/RangeBars.svelte'
  import Calendar from '../lib/viz/Calendar.svelte'
  import Ring from '../lib/viz/Ring.svelte'
  import Sparkline from '../lib/viz/Sparkline.svelte'
  import SegmentBar from '../lib/viz/SegmentBar.svelte'
  import { api } from '../lib/api'
  import { today } from '../lib/format'
  import { activityTypeLabel } from '../lib/activity'
  import { fmtDayLong, fmtDayShort } from '../lib/viz/scale'
  import {
    RANGES, SPORTS, buildInsights, dayNum, fmtClockMin, fmtHM, fmtKm, fmtPaceSec, fmtRace, fmtRecord, fmtSigned, isNum,
    shiftDay, sportGroup, statusLabel, weekStart, type Finding, type RangeKey, type Vital,
  } from '../lib/insights'
  import type { InsightsPayload } from '../lib/types'

  const RANGE_KEY = 'healthlog.insights.range'
  const todayDay = today()

  let data = $state<InsightsPayload | null>(null)
  let loading = $state(true)
  let loadError = $state('')
  let range = $state<RangeKey>((localStorage.getItem(RANGE_KEY) as RangeKey | null) ?? '90d')

  const first = $derived(data?.coverage.first ?? todayDay)
  const span = $derived(RANGES.find((r) => r.key === range)?.days ?? null)
  const from = $derived(span === null ? first : (() => { const f = shiftDay(todayDay, -(span - 1)); return f < first ? first : f })())
  const ins = $derived(data ? buildInsights(data, from, todayDay) : null)
  const daily = $derived(dayNum(todayDay) - dayNum(from) <= 120)

  function setRange(next: string): void {
    range = next as RangeKey
    localStorage.setItem(RANGE_KEY, range)
  }

  async function load(): Promise<void> {
    loading = !data
    loadError = ''
    try {
      data = await api.getInsights({ from: '2000-01-01', to: todayDay })
    } catch (cause) {
      loadError = cause instanceof Error ? cause.message : 'Could not load your insights.'
    } finally {
      loading = false
    }
  }
  onMount(load)

  /* ---------------- presentation helpers ---------------- */

  const SPORT_COLORS: Record<string, string> = { run: 'var(--viz-run)', ride: 'var(--viz-ride)', swim: 'var(--viz-swim)', strength: 'var(--viz-strength)', other: 'var(--viz-other)' }
  const STAGES = [
    { key: 'deepS', label: 'Deep', color: 'var(--viz-deep)' },
    { key: 'remS', label: 'REM', color: 'var(--viz-rem)' },
    { key: 'lightS', label: 'Light', color: 'var(--viz-light)' },
    { key: 'awakeS', label: 'Awake', color: 'var(--viz-awake)' },
  ] as const
  const STATUS_COLORS: Record<string, string> = {
    PRODUCTIVE: 'var(--color-accent)', PEAKING: 'var(--viz-deep)', MAINTAINING: 'var(--viz-run)', RECOVERY: 'var(--viz-swim)',
    UNPRODUCTIVE: 'var(--viz-ride)', OVERREACHING: 'var(--color-danger)', STRAINED: 'var(--color-danger)', DETRAINING: 'var(--viz-strength)', NO_STATUS: 'var(--color-surface-sunken)',
  }
  const CATEGORY: Record<Finding['category'], { label: string; icon: 'moon' | 'zap' | 'heart' | 'activity' | 'trending-up' }> = {
    sleep: { label: 'Sleep', icon: 'moon' }, training: { label: 'Training', icon: 'zap' }, recovery: { label: 'Recovery', icon: 'heart' },
    stress: { label: 'Stress', icon: 'activity' }, trend: { label: 'Trend', icon: 'trending-up' },
  }
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

  function deltaTone(v: Vital): 'good' | 'bad' | 'flat' {
    if (!isNum(v.delta) || Math.abs(v.delta) < (v.key === 'rhr' ? 1 : 2)) return 'flat'
    return (v.delta > 0) === v.higherIsBetter ? 'good' : 'bad'
  }
  function deltaText(v: Vital): string {
    if (!isNum(v.delta)) return 'Not enough history yet'
    if (deltaTone(v) === 'flat') return 'In line with your norm'
    return `${fmtSigned(v.delta, v.key === 'rhr' ? 1 : 0)}${v.unit ? ` ${v.unit}` : ''} vs 30-day norm`
  }

  const hrsFmt = (v: number): string => (v <= 0 ? '0' : v >= 10 ? `${Math.round(v)}h` : v >= 1 ? `${v.toFixed(1)}h` : `${Math.round(v * 60)}m`)
  const sleepHrs = (v: number): string => `${Math.round((v / 3600) * 10) / 10}h`

  const sleepBars = $derived.by(() => {
    if (!ins) return []
    if (daily) {
      return ins.sleep.nights.map((n) => ({ key: n.day, heading: `Night to ${fmtDayLong(n.day)}${isNum(n.score) ? ` · score ${n.score}` : ''}`, values: STAGES.map((s) => n[s.key] ?? 0) }))
    }
    const weeks = new Map<string, number[][]>()
    for (const n of ins.sleep.nights) {
      const w = weekStart(n.day)
      const list = weeks.get(w) ?? []
      list.push(STAGES.map((s) => n[s.key] ?? 0))
      weeks.set(w, list)
    }
    return [...weeks.entries()].map(([w, list]) => ({
      key: w, heading: `Week of ${fmtDayShort(w)} · ${list.length} nights (average)`,
      values: STAGES.map((_, i) => list.reduce((a, r) => a + r[i], 0) / list.length),
    }))
  })
  const sleepWindow = $derived(ins ? ins.sleep.nights.filter((n) => n.startLocal && n.endLocal).map((n) => {
    const bed = (+n.startLocal!.slice(11, 13) * 60 + +n.startLocal!.slice(14, 16) + 720) % 1440 // minutes after noon
    const wake = (+n.endLocal!.slice(11, 13) * 60 + +n.endLocal!.slice(14, 16) + 720) % 1440
    return { day: n.day, lo: bed, hi: wake }
  }) : [])
  const fmtNoonClock = (m: number): string => fmtClockMin(m + 720)
  const statusSegments = $derived.by(() => {
    if (!ins) return []
    const out: { status: string; from: string; to: string }[] = []
    for (const s of ins.fitness.status) {
      const lastSeg = out[out.length - 1]
      if (lastSeg && lastSeg.status === s.status && dayNum(s.day) - dayNum(lastSeg.to) <= 3) lastSeg.to = s.day
      else out.push({ status: s.status, from: s.day, to: s.day })
    }
    return out
  })
  const statusesPresent = $derived([...new Set(statusSegments.map((s) => s.status))])
  const sportBars = $derived(ins ? ins.training.weeks.map((w) => ({ key: w.week, heading: `Week of ${fmtDayShort(w.week)} · ${w.sessions} sessions`, values: SPORTS.map((s) => w.hours[s.key]) })) : [])
  const zoneParts = $derived.by(() => {
    if (!ins) return []
    const z = ins.training.zones
    const floors = data?.meta.hrZones
    const lbl = (i: number, name: string): string => (floors ? `${name}${floors[`z${i}` as 'z1'] ? ` ${floors[`z${i}` as 'z1']}+` : ''}` : name)
    return [
      { label: lbl(1, 'Z1 Warm-up'), value: z[1], color: 'color-mix(in oklab, var(--color-accent) 30%, var(--color-surface))', ink: 'dark' as const },
      { label: lbl(2, 'Z2 Easy'), value: z[2], color: 'color-mix(in oklab, var(--color-accent) 55%, var(--color-surface))', ink: 'dark' as const },
      { label: lbl(3, 'Z3 Aerobic'), value: z[3], color: 'color-mix(in oklab, var(--color-accent) 80%, var(--color-surface))' },
      { label: lbl(4, 'Z4 Threshold'), value: z[4], color: 'var(--color-accent)' },
      { label: lbl(5, 'Z5 Max'), value: z[5], color: 'color-mix(in oklab, var(--color-accent) 70%, black)' },
    ]
  })
  const GROUP_ORDER = ['run', 'ride', 'swim', 'steps', 'other']
  const DIST_ORDER = [/400m|1km/i, /750m|1 ?mile/i, /1000m|5 ?km/i, /1500m|10 ?km|40 ?km/i, /half/i, /^marathon/i, /farthest|longest/i, /power|elevation/i]
  const rank = (label: string): number => { const i = DIST_ORDER.findIndex((re) => re.test(label)); return i < 0 ? 99 : i }
  const records = $derived(ins ? ins.records.map((r) => ({ ...r, ...fmtRecord(r) })).sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || rank(a.label) - rank(b.label)) : [])
  const balanceSeries = $derived(ins?.energy ? ins.energy.weeks.map((w) => ({ day: w.week, value: isNum(w.intake) && isNum(w.burn) ? w.intake - w.burn : null })) : [])
  const recentActs = $derived(ins ? [...ins.training.activities].reverse().slice(0, 6) : [])
  const lastImport = $derived(data?.meta.lastImport ?? null)
  const stressDays = $derived(Math.max(1, ins ? ins.stress.series.filter((p) => isNum(p.value)).length : 1))
</script>

<div class="view view--insights">
  <header class="ins-head">
    <div>
      <p class="eyebrow"><Icon name="insights" size={14} /> Garmin insights</p>
      <h1 class="view-title">How you’re really doing</h1>
      {#if ins?.hasData && data?.coverage.first}
        <p class="view-subtitle">{fmtDayShort(from)} {from.slice(0, 4)} – today · {Math.round((dayNum(todayDay) - dayNum(from) + 1)).toLocaleString()} days of watch data, analysed on this device.</p>
      {/if}
    </div>
    {#if ins?.hasData}
      <div class="range"><SegmentedControl ariaLabel="Date range" options={RANGES.map((r) => ({ value: r.key, label: r.label }))} value={range} onchange={setRange} /></div>
    {/if}
  </header>

  {#if loading}
    <div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Crunching your watch data…</span></div>
  {:else if loadError}
    <div class="card pad" role="alert"><p>{loadError}</p><button class="button button--secondary" type="button" onclick={load}>Try again</button></div>
  {:else if !ins || !ins.hasData}
    <GarminImportPanel hero onimported={load} />
    <ul class="promise">
      <li><Icon name="heart" size={18} /><span><b>Recovery</b> from sleep, Body Battery and resting heart rate, against your own norm.</span></li>
      <li><Icon name="zap" size={18} /><span><b>Fitness</b>: VO₂ max, race predictions, training status and load.</span></li>
      <li><Icon name="moon" size={18} /><span><b>Sleep</b> stages, timing and consistency — and what changes them.</span></li>
      <li><Icon name="sparkles" size={18} /><span><b>Findings</b> tested on your own data: what actually moves your sleep, stress and heart rate.</span></li>
    </ul>
  {:else}
    <!-- ============================ HERO ============================ -->
    <section class="hero card" aria-labelledby="hero-title">
      <div class="hero-main">
        {#if ins.recovery}
          <Ring value={ins.recovery.score} label="Recovery" caption={ins.recovery.label} />
        {/if}
        <div class="hero-copy">
          <p class="eyebrow">{ins.heroDay === todayDay ? 'This morning' : ins.heroDay ? fmtDayLong(ins.heroDay) : ''}</p>
          <h2 id="hero-title">{ins.recovery ? `${ins.recovery.label}.` : 'Your latest numbers'}</h2>
          {#if ins.recovery}
            <p class="hero-sub">Recovery {ins.recovery.score}/100, built from what your watch saw overnight:</p>
            <ul class="parts">
              {#each ins.recovery.parts as p (p.label)}
                <li>
                  <span class="part-bar" aria-hidden="true"><span style:width="{p.score}%"></span></span>
                  <span class="part-label">{p.label}</span>
                  <span class="part-detail">{p.detail}</span>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      </div>
      <div class="vitals">
        {#each ins.vitals as v (v.key)}
          <article class="vital">
            <span class="vital-label">{v.label}</span>
            <div class="vital-row">
              <span class="vital-value">{isNum(v.value) ? v.format(v.value) : '—'}{#if v.unit && isNum(v.value)}<small>{v.unit}</small>{/if}</span>
              <Sparkline points={v.spark} width={84} height={30} />
            </div>
            <span class="delta {deltaTone(v)}">
              {#if deltaTone(v) !== 'flat'}<span aria-hidden="true">{(v.delta ?? 0) > 0 ? '▲' : '▼'}</span>{/if}
              {deltaText(v)}
            </span>
          </article>
        {/each}
      </div>
    </section>

    <!-- ============================ FINDINGS ============================ -->
    {#if ins.findings.length}
      <section class="block" aria-labelledby="findings-title">
        <div class="block-head">
          <h2 id="findings-title">What your data says</h2>
          <p>Patterns tested on your own days in this range — shown only when the difference is bigger than day-to-day noise.</p>
        </div>
        <div class="findings" role="list" aria-label="Findings">
          {#each ins.findings as f (f.id)}
            <article class="finding card" role="listitem" data-positive={f.positive}>
              <div class="finding-top">
                <span class="cat"><Icon name={CATEGORY[f.category].icon} size={14} />{CATEGORY[f.category].label}</span>
                <span class="conf conf-{f.confidence}" title="Based on effect size and sample">{f.confidence}</span>
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              {#if f.a && f.b}
                {@const lo = f.unit === 'clock' ? Math.min(f.a.value, f.b.value) - 60 : 0}
                {@const hi = Math.max(f.a.value, f.b.value) - lo}
                <div class="compare">
                  {#each [f.a, f.b] as side, i (i)}
                    <div class="cmp-row" class:lead={i === 0}>
                      <span class="cmp-label">{side.label}</span>
                      <span class="cmp-track"><span class="cmp-fill" style:width="{Math.max(6, ((side.value - lo) / hi) * 100)}%"></span></span>
                      <span class="cmp-value">{f.format(side.value)}</span>
                    </div>
                  {/each}
                  <span class="cmp-n">{f.a.n} vs {f.b.n} days</span>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      </section>
    {/if}

    <!-- ============================ FITNESS ============================ -->
    {#if ins.fitness.vo2.length || ins.fitness.races.some((r) => r.now)}
      <section class="block" aria-labelledby="fitness-title">
        <div class="block-head"><h2 id="fitness-title">Fitness</h2></div>
        <div class="grid-2">
          <article class="card pad">
            <div class="kpi-head">
              <span class="kpi-label"><Icon name="zap" size={16} /> VO₂ max</span>
              {#if isNum(ins.fitness.vo2Change) && ins.fitness.vo2Change !== 0}<span class="pill {ins.fitness.vo2Change > 0 ? 'good' : 'bad'}">{fmtSigned(ins.fitness.vo2Change)} in range</span>{/if}
            </div>
            <div class="kpi-big">{ins.fitness.vo2Now ?? '—'}<small>ml/kg/min</small></div>
            {#if ins.fitness.vo2.length >= 2}
              <LineChart label="Running VO₂ max" {from} to={todayDay} line={ins.fitness.vo2} step minStep={1} height={150} lineLabel="VO₂ max" format={(v) => v.toFixed(0)} />
            {/if}
            <div class="kpi-foot">
              {#if ins.fitness.fitnessAge}<span><b>{ins.fitness.fitnessAge.toFixed(1)}</b> fitness age{isNum(ins.fitness.fitnessAgeChange) && Math.abs(ins.fitness.fitnessAgeChange) >= 0.5 ? ` (${fmtSigned(ins.fitness.fitnessAgeChange, 1)})` : ''}</span>{/if}
              {#if ins.fitness.vo2Peak}<span>Peak <b>{ins.fitness.vo2Peak}</b></span>{/if}
              {#if data?.meta.thresholds?.ltPaceSPerKm}<span>Threshold <b>{fmtPaceSec(data.meta.thresholds.ltPaceSPerKm)}</b></span>{/if}
            </div>
          </article>
          <article class="card pad">
            <div class="kpi-head"><span class="kpi-label"><Icon name="flag" size={16} /> Race predictions</span></div>
            <div class="races">
              {#each ins.fitness.races.filter((r) => r.now) as r (r.key)}
                <div class="race">
                  <span class="race-label">{r.label}</span>
                  <span class="race-time">{fmtRace(r.now)}</span>
                  {#if isNum(r.change) && Math.abs(r.change) >= 1}
                    <span class="race-delta {r.change < 0 ? 'good' : 'bad'}">{r.change < 0 ? '▼' : '▲'} {fmtRace(Math.abs(r.change))}</span>
                  {:else}<span class="race-delta flat">—</span>{/if}
                  <Sparkline points={r.series} width={72} height={24} />
                </div>
              {/each}
            </div>
            {#if statusSegments.length}
              <div class="status">
                <div class="status-head"><span>Training status</span><b>{statusLabel(ins.fitness.statusNow)}</b></div>
                <div class="status-strip" role="img" aria-label="Training status over time: {statusSegments.map((s) => `${statusLabel(s.status)} ${fmtDayShort(s.from)}–${fmtDayShort(s.to)}`).join('; ')}">
                  {#each statusSegments as s (s.from)}
                    <span style:flex-grow={dayNum(s.to) - dayNum(s.from) + 1} style:background={STATUS_COLORS[s.status] ?? 'var(--viz-other)'} title="{statusLabel(s.status)} · {fmtDayShort(s.from)} – {fmtDayShort(s.to)}"></span>
                  {/each}
                </div>
                <ul class="status-legend">
                  {#each statusesPresent as st (st)}<li><i style:background={STATUS_COLORS[st] ?? 'var(--viz-other)'}></i>{statusLabel(st)}</li>{/each}
                </ul>
              </div>
            {/if}
          </article>
        </div>
      </section>
    {/if}

    <!-- ============================ SLEEP ============================ -->
    {#if ins.sleep.nights.length}
      <section class="block" aria-labelledby="sleep-title">
        <div class="block-head"><h2 id="sleep-title">Sleep</h2></div>
        <div class="stats">
          <div class="stat"><span>Average night</span><b>{fmtHM(ins.sleep.avgDuration)}</b></div>
          <div class="stat"><span>Sleep score</span><b>{isNum(ins.sleep.avgScore) ? Math.round(ins.sleep.avgScore) : '—'}</b></div>
          <div class="stat"><span>Bedtime</span><b>{fmtClockMin(ins.sleep.avgBed)}</b><em>± {isNum(ins.sleep.bedSd) ? Math.round(ins.sleep.bedSd) : '—'} min</em></div>
          <div class="stat"><span>Wake</span><b>{fmtClockMin(ins.sleep.avgWake)}</b></div>
        </div>
        <article class="card pad">
          <div class="chart-head">
            <h3>{daily ? 'Every night, by stage' : 'Weekly average night, by stage'}</h3>
            <ul class="legend">{#each STAGES as s (s.key)}<li><i style:background={s.color}></i>{s.label}</li>{/each}</ul>
          </div>
          <StackedBars label="Sleep stages per {daily ? 'night' : 'week'}" bars={sleepBars} series={STAGES.map((s) => ({ label: s.label, color: s.color }))} {from} to={todayDay} keyDays={daily ? 1 : 7} format={sleepHrs} unit={3600} reference={{ value: 8 * 3600, label: '8h' }} height={210} />
          <div class="sub-grid">
            <div>
              <h4>Where the night goes</h4>
              <SegmentBar label="Share of time in bed" parts={[
                { label: 'Deep', value: ins.sleep.stages.deep, color: 'var(--viz-deep)' },
                { label: 'REM', value: ins.sleep.stages.rem, color: 'var(--viz-rem)', ink: 'dark' },
                { label: 'Light', value: ins.sleep.stages.light, color: 'var(--viz-light)' },
                { label: 'Awake', value: ins.sleep.stages.awake, color: 'var(--viz-awake)', ink: 'dark' },
              ]} />
            </div>
            <div>
              <h4>By night of the week</h4>
              <div class="weekdays" role="img" aria-label="Average sleep by night: {ins.sleep.byWeekday.map((w) => `${WEEKDAYS[w.weekday]} ${fmtHM(w.duration)}`).join(', ')}">
                {#each ins.sleep.byWeekday as w (w.weekday)}
                  {@const all = ins.sleep.byWeekday.map((x) => x.duration).filter(isNum)}
                  {@const lo = Math.min(...all) * 0.75}
                  {@const hi = Math.max(...all)}
                  <div class="wd">
                    <span class="wd-bar"><span style:height="{isNum(w.duration) ? Math.max(8, ((w.duration - lo) / (hi - lo || 1)) * 100) : 0}%" class:weekend={w.weekday === 4 || w.weekday === 5}></span></span>
                    <span class="wd-val">{isNum(w.duration) ? (w.duration / 3600).toFixed(1) : '—'}</span>
                    <span class="wd-day">{WEEKDAYS[w.weekday]}</span>
                  </div>
                {/each}
              </div>
            </div>
          </div>
        </article>
        <article class="card pad">
          <div class="chart-head"><h3>When you sleep</h3><p class="chart-note">Each bar runs from falling asleep to waking.</p></div>
          <RangeBars label="Sleep window per night" ranges={sleepWindow} {from} to={todayDay} format={fmtNoonClock} unit={60} invert loLabel="Asleep" hiLabel="Awake" color="var(--viz-deep)" height={200} />
          {#if isNum(ins.sleep.weekdayBed) && isNum(ins.sleep.weekendBed)}
            <p class="chart-note">Weeknights {fmtClockMin(ins.sleep.weekdayBed)} → {fmtHM(ins.sleep.weekdayDuration)} · Fri & Sat {fmtClockMin(ins.sleep.weekendBed)} → {fmtHM(ins.sleep.weekendDuration)}{ins.sleep.best ? ` · best night ${fmtDayShort(ins.sleep.best.day)} (${ins.sleep.best.score})` : ''}</p>
          {/if}
        </article>
      </section>
    {/if}

    <!-- ============================ HEART & STRESS ============================ -->
    <section class="block" aria-labelledby="recovery-title">
      <div class="block-head"><h2 id="recovery-title">Heart, stress & energy</h2></div>
      <div class="grid-2">
        <article class="card pad">
          <div class="chart-head">
            <h3><Icon name="heart" size={16} /> Resting heart rate</h3>
            <span class="head-num">{isNum(ins.heart.avg) ? Math.round(ins.heart.avg) : '—'}<small> bpm avg</small></span>
          </div>
          <LineChart label="Resting heart rate" {from} to={todayDay} raw={ins.heart.rhr} line={ins.heart.rhr7} band={ins.heart.band} bandLabel="Your 30-day norm" format={(v) => `${Math.round(v)}`} rawLabel="That morning" height={190} />
          <p class="chart-note">Shaded: your 30-day norm ± 1 SD. {#if isNum(ins.heart.slopePerMonth)}Trend {fmtSigned(ins.heart.slopePerMonth, 1)} bpm/month{#if isNum(ins.heart.min)}, lowest {ins.heart.min}{/if}.{/if}</p>
        </article>
        <article class="card pad">
          <div class="chart-head">
            <h3><Icon name="battery" size={16} /> Body Battery</h3>
            <span class="head-num">{isNum(ins.stress.avgWake) ? Math.round(ins.stress.avgWake) : '—'}<small> avg at wake</small></span>
          </div>
          <RangeBars label="Daily Body Battery range" ranges={ins.stress.battery.map((b) => ({ day: b.day, lo: b.low, hi: b.high, mark: b.wake }))} {from} to={todayDay} domain={[0, 100]} loLabel="Lowest" hiLabel="Highest" markLabel="At wake" height={190} />
          <p class="chart-note">Bar: the day’s low to high. Dot: where you woke up.</p>
        </article>
        <article class="card pad span-2">
          <div class="chart-head">
            <h3><Icon name="activity" size={16} /> Stress</h3>
            <span class="head-num">{isNum(ins.stress.avg) ? Math.round(ins.stress.avg) : '—'}<small> avg</small></span>
          </div>
          <LineChart label="Average daily stress" {from} to={todayDay} raw={ins.stress.series} line={ins.stress.series7} format={(v) => `${Math.round(v)}`} rawLabel="That day" height={170} include={[0]} />
          {#if ins.stress.breakdown.rest + ins.stress.breakdown.low > 0}
            <div class="breakdown">
              <SegmentBar label="Time by stress level" format={(v) => fmtHM(v / stressDays)} parts={[
                { label: 'Rest', value: ins.stress.breakdown.rest, color: 'color-mix(in oklab, var(--viz-run) 45%, var(--color-surface))', ink: 'dark' },
                { label: 'Low', value: ins.stress.breakdown.low, color: 'color-mix(in oklab, var(--viz-ride) 45%, var(--color-surface))', ink: 'dark' },
                { label: 'Medium', value: ins.stress.breakdown.medium, color: 'color-mix(in oklab, var(--viz-ride) 75%, var(--color-surface))' },
                { label: 'High', value: ins.stress.breakdown.high, color: 'var(--viz-ride)' },
              ]} />
              <p class="chart-note">Per-day average shown beside each level.</p>
            </div>
          {/if}
        </article>
      </div>
    </section>

    <!-- ============================ TRAINING ============================ -->
    {#if ins.training.sessions}
      <section class="block" aria-labelledby="training-title">
        <div class="block-head"><h2 id="training-title">Training</h2></div>
        <div class="stats">
          <div class="stat"><span>Sessions</span><b>{ins.training.sessions}</b><em>{ins.training.activeDays} active days</em></div>
          <div class="stat"><span>Time</span><b>{hrsFmt(ins.training.durationS / 3600)}</b>{#if isNum(ins.training.avgWeeklyHours)}<em>{hrsFmt(ins.training.avgWeeklyHours)}/week</em>{/if}</div>
          <div class="stat"><span>Distance</span><b>{fmtKm(ins.training.distanceM)}</b></div>
          <div class="stat"><span>Steps / day</span><b>{isNum(ins.training.steps.avg) ? Math.round(ins.training.steps.avg).toLocaleString() : '—'}</b><em>goal hit {ins.training.steps.goalDays}/{ins.training.steps.days}</em></div>
        </div>
        <article class="card pad">
          <div class="chart-head">
            <h3>Hours per week, by sport</h3>
            <ul class="legend">{#each SPORTS as s (s.key)}<li><i style:background={SPORT_COLORS[s.key]}></i>{s.key === 'other' && ins.training.otherBreakdown ? `Other (${ins.training.otherBreakdown})` : s.label}</li>{/each}</ul>
          </div>
          <StackedBars label="Training hours per week by sport" bars={sportBars} series={SPORTS.map((s) => ({ label: s.label, color: SPORT_COLORS[s.key] }))} {from} to={todayDay} keyDays={7} format={hrsFmt} height={200} />
          <table class="sport-table">
            <caption class="sr-only">Training totals by sport for this range</caption>
            <thead><tr><th scope="col">Sport</th><th scope="col" class="num">Sessions</th><th scope="col" class="num">Time</th><th scope="col" class="num">Distance</th><th scope="col" class="num wide">kcal</th></tr></thead>
            <tbody>
              {#each ins.training.totals.filter((t) => t.sessions) as t (t.key)}
                <tr>
                  <th scope="row"><i style:background={SPORT_COLORS[t.key]}></i>{t.label}</th>
                  <td class="num">{t.sessions}</td>
                  <td class="num">{hrsFmt(t.durationS / 3600)}</td>
                  <td class="num">{t.distanceM > 0 ? fmtKm(t.distanceM) : '—'}</td>
                  <td class="num wide">{Math.round(t.kcal).toLocaleString()}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </article>
        <div class="grid-2">
          <article class="card pad">
            <div class="chart-head"><h3>Training calendar</h3></div>
            <Calendar label="Training minutes per day" values={ins.training.calendar.map((c) => ({ day: c.day, value: c.minutes, detail: c.load ? `load ${Math.round(c.load)}` : undefined }))} {from} to={todayDay} format={(v) => `${Math.round(v)} min`} />
          </article>
          <article class="card pad">
            <div class="chart-head"><h3>Heart-rate zones</h3></div>
            <SegmentBar label="Training time by heart-rate zone" parts={zoneParts} format={(v) => hrsFmt(v / 3600)} />
            {#if ins.training.zones[1] + ins.training.zones[2] > 0}
              {@const easy = (ins.training.zones[1] + ins.training.zones[2]) / Math.max(1, ins.training.zones.slice(1).reduce((a, b) => a + b, 0))}
              <p class="chart-note">{Math.round(easy * 100)}% of your zoned time is easy (Z1–Z2). Endurance coaches usually aim for about 80%.</p>
            {/if}
            <h4 class="recent-title">Latest sessions</h4>
            <ul class="recent">
              {#each recentActs as a (a.id)}
                <li>
                  <i style:background={SPORT_COLORS[sportGroup(a.type)]}></i>
                  <span class="r-name">{a.name ?? activityTypeLabel(a.type)}<em>{fmtDayShort(a.day)}</em></span>
                  <span class="r-num">{a.distanceM ? fmtKm(a.distanceM) : fmtHM(a.durationS)}</span>
                </li>
              {/each}
            </ul>
          </article>
        </div>
      </section>
    {/if}

    <!-- ============================ ENERGY ============================ -->
    {#if ins.energy}
      <section class="block" aria-labelledby="energy-title">
        <div class="block-head"><h2 id="energy-title">Energy in vs out</h2><p>Your logged meals against the watch’s total burn, on {ins.energy.loggedDays} logged days.</p></div>
        <div class="stats">
          <div class="stat"><span>Eaten / day</span><b>{isNum(ins.energy.avgIntake) ? Math.round(ins.energy.avgIntake).toLocaleString() : '—'}</b><em>kcal</em></div>
          <div class="stat"><span>Burned / day</span><b>{isNum(ins.energy.avgBurn) ? Math.round(ins.energy.avgBurn).toLocaleString() : '—'}</b><em>kcal (watch)</em></div>
          <div class="stat"><span>Balance</span><b>{isNum(ins.energy.balance) ? fmtSigned(ins.energy.balance) : '—'}</b><em>kcal / day</em></div>
          <div class="stat"><span>Scale says</span><b>{isNum(ins.energy.weightChange) ? `${fmtSigned(ins.energy.weightChange, 1)} kg` : '—'}</b><em>{isNum(ins.energy.impliedKg) ? `maths says ${fmtSigned(ins.energy.impliedKg, 1)} kg` : ''}</em></div>
        </div>
        {#if balanceSeries.length >= 2}
          <article class="card pad">
            <div class="chart-head"><h3>Weekly average balance</h3><p class="chart-note">Above zero: eating more than the watch says you burn.</p></div>
            <LineChart label="Weekly calorie balance" {from} to={todayDay} line={balanceSeries} raw={balanceSeries} include={[0]} format={(v) => fmtSigned(v)} lineLabel="Balance" rawLabel="Week" height={170} />
          </article>
        {/if}
      </section>
    {/if}

    <!-- ============================ RECORDS ============================ -->
    {#if records.length}
      <section class="block" aria-labelledby="records-title">
        <div class="block-head"><h2 id="records-title"><Icon name="award" size={20} /> Personal records</h2></div>
        <div class="records">
          {#each records as r (r.type)}
            <article class="record">
              <span class="rec-label">{r.label}</span>
              <span class="rec-value">{r.value}</span>
              {#if r.achievedAt}<span class="rec-date">{fmtDayShort(r.achievedAt.slice(0, 10))} {r.achievedAt.slice(0, 4)}</span>{/if}
            </article>
          {/each}
        </div>
      </section>
    {/if}

    <section class="block" aria-label="Import">
      <GarminImportPanel onimported={load} />
      {#if lastImport}
        <p class="chart-note">Last export imported {new Date(lastImport.at).toLocaleDateString()}{lastImport.range ? ` · covers ${fmtDayShort(lastImport.range.from)} ${lastImport.range.from.slice(0, 4)} – ${fmtDayShort(lastImport.range.to)} ${lastImport.range.to.slice(0, 4)}` : ''}. New days arrive through the Garmin sync.</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .view--insights { gap: var(--space-6); }
  .ins-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .ins-head .view-subtitle { margin-top: var(--space-2); }
  .eyebrow { display: inline-flex; margin: 0 0 var(--space-2); align-items: center; gap: 6px; color: var(--color-accent); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .range { min-width: 15rem; }
  .card { border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .pad { padding: var(--space-5); }
  .skeleton { display: flex; min-height: 14rem; align-items: center; justify-content: center; gap: var(--space-3); color: var(--color-text-muted); }

  /* hero */
  .hero { display: grid; padding: var(--space-6); gap: var(--space-6); overflow: hidden; background:
    radial-gradient(120% 140% at 0% 0%, var(--color-accent-soft) 0%, transparent 55%), var(--color-surface); }
  .hero-main { display: flex; align-items: center; gap: var(--space-6); flex-wrap: wrap; }
  .hero-copy { min-width: 0; flex: 1 1 16rem; }
  .hero-copy h2 { margin: 0 0 var(--space-1); font-size: clamp(1.75rem, 5vw, 2.5rem); font-weight: var(--weight-bold); letter-spacing: -0.04em; line-height: 1.05; }
  .hero-sub { margin: 0 0 var(--space-3); color: var(--color-text-muted); font-size: var(--text-sm); }
  .parts { display: grid; margin: 0; padding: 0; gap: var(--space-2); list-style: none; }
  .parts li { display: grid; align-items: center; grid-template-columns: 4.5rem 7rem 1fr; gap: var(--space-3); font-size: var(--text-sm); }
  .part-bar { height: 6px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); overflow: hidden; }
  .part-bar span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); }
  .part-label { font-weight: var(--weight-semibold); }
  .part-detail { color: var(--color-text-muted); }
  .vitals { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9.25rem), 1fr)); gap: var(--space-3); }
  .vital { display: flex; min-width: 0; padding: var(--space-3) var(--space-4); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: color-mix(in oklab, var(--color-surface) 80%, transparent); backdrop-filter: blur(6px); }
  .vital-label { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .vital-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .vital-value { font-size: var(--text-2xl); font-weight: var(--weight-bold); letter-spacing: -0.03em; }
  .vital-value small { margin-left: 3px; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: 0; }
  .delta { font-size: var(--text-xs); color: var(--color-text-muted); }
  .delta.good { color: var(--color-up); }
  .delta.bad { color: var(--color-down); }

  /* blocks */
  .block { display: flex; flex-direction: column; gap: var(--space-4); }
  .block-head h2 { display: flex; margin: 0; align-items: center; gap: var(--space-2); font-size: var(--text-xl); letter-spacing: -0.02em; }
  .block-head p { margin: var(--space-1) 0 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .grid-2 { display: grid; gap: var(--space-4); align-items: start; }
  .grid-2 > *, .block > * { min-width: 0; }
  .chart-head { display: flex; margin-bottom: var(--space-3); align-items: baseline; justify-content: space-between; gap: var(--space-2) var(--space-4); flex-wrap: wrap; }
  .chart-head h3 { display: inline-flex; margin: 0; align-items: center; gap: var(--space-2); font-size: var(--text-md); }
  .head-num { font-size: var(--text-xl); font-weight: var(--weight-bold); letter-spacing: -0.02em; }
  .head-num small { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: 0; }
  .chart-note { margin: var(--space-2) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); }
  .chart-head .chart-note { margin: 0; }
  h4 { margin: 0 0 var(--space-3); color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .legend { display: flex; margin: 0; padding: 0; flex-wrap: wrap; gap: var(--space-1) var(--space-3); list-style: none; font-size: var(--text-xs); color: var(--color-text-muted); }
  .legend li { display: inline-flex; align-items: center; gap: 5px; }
  .legend i, .status-legend i, .sport-table i, .recent i { display: inline-block; width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto; }

  /* findings */
  .findings { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr)); gap: var(--space-4); }
  .finding { display: flex; padding: var(--space-5); flex-direction: column; gap: var(--space-2); }
  .finding h3 { margin: var(--space-1) 0 0; font-size: var(--text-lg); letter-spacing: -0.015em; line-height: 1.3; }
  .finding p { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.5; }
  .finding-top { display: flex; align-items: center; justify-content: space-between; }
  .cat { display: inline-flex; padding: 2px 9px 2px 7px; align-items: center; gap: 5px; border-radius: var(--radius-pill); background: var(--color-accent-soft); color: var(--color-accent); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .conf { color: var(--color-text-subtle); font-size: var(--text-xs); text-transform: capitalize; }
  .conf-strong { color: var(--color-text); font-weight: var(--weight-semibold); }
  .compare { display: grid; margin-top: auto; padding-top: var(--space-3); gap: 6px; }
  .cmp-row { display: grid; align-items: center; grid-template-columns: minmax(6rem, 8.5rem) 1fr auto; gap: var(--space-2); font-size: var(--text-xs); }
  .cmp-label { overflow: hidden; color: var(--color-text-muted); text-overflow: ellipsis; white-space: nowrap; }
  .cmp-track { height: 8px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .cmp-fill { display: block; height: 100%; border-radius: inherit; background: var(--color-border-strong); }
  .lead .cmp-fill { background: var(--color-accent); }
  .lead .cmp-label { color: var(--color-text); font-weight: var(--weight-medium); }
  .cmp-value { min-width: 3.25rem; font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; text-align: right; }
  .cmp-n { color: var(--color-text-subtle); font-size: 0.6875rem; }

  /* fitness */
  .kpi-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .kpi-label { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .kpi-big { margin: var(--space-2) 0 var(--space-3); font-size: 3.25rem; font-weight: var(--weight-bold); letter-spacing: -0.05em; line-height: 1; }
  .kpi-big small { margin-left: var(--space-2); color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-medium); letter-spacing: 0; }
  .kpi-foot { display: flex; margin-top: var(--space-3); flex-wrap: wrap; gap: var(--space-2) var(--space-5); color: var(--color-text-muted); font-size: var(--text-sm); }
  .kpi-foot b { color: var(--color-text); }
  .pill { padding: 2px 9px; border-radius: var(--radius-pill); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .pill.good { background: var(--color-up-soft); color: var(--color-up); }
  .pill.bad { background: var(--color-down-soft); color: var(--color-down); }
  .races { display: grid; margin-top: var(--space-3); gap: 0; }
  .race { display: grid; padding: var(--space-3) 0; align-items: center; grid-template-columns: 1fr auto auto auto; gap: var(--space-4); border-top: 1px solid var(--color-border); }
  .race:first-child { border-top: 0; }
  .race-label { color: var(--color-text-muted); font-size: var(--text-sm); }
  .race-time { font-size: var(--text-xl); font-weight: var(--weight-bold); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .race-delta { min-width: 4.5rem; font-size: var(--text-xs); font-weight: var(--weight-semibold); text-align: right; font-variant-numeric: tabular-nums; }
  .race-delta.good { color: var(--color-up); }
  .race-delta.bad { color: var(--color-down); }
  .race-delta.flat { color: var(--color-text-subtle); }
  .status { margin-top: var(--space-4); padding-top: var(--space-4); border-top: 1px solid var(--color-border); }
  .status-head { display: flex; margin-bottom: var(--space-2); justify-content: space-between; color: var(--color-text-muted); font-size: var(--text-sm); }
  .status-head b { color: var(--color-text); }
  .status-strip { display: flex; height: 14px; gap: 2px; }
  .status-strip span { min-width: 2px; flex-basis: 0; border-radius: 3px; }
  .status-legend { display: flex; margin: var(--space-2) 0 0; padding: 0; flex-wrap: wrap; gap: var(--space-1) var(--space-3); list-style: none; color: var(--color-text-muted); font-size: var(--text-xs); }
  .status-legend li { display: inline-flex; align-items: center; gap: 5px; }

  /* stats row */
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .stat { display: flex; padding: var(--space-4); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
  .stat span { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .stat b { font-size: var(--text-2xl); font-weight: var(--weight-bold); letter-spacing: -0.03em; }
  .stat em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }

  /* sleep */
  .sub-grid { display: grid; margin-top: var(--space-5); padding-top: var(--space-5); gap: var(--space-5); border-top: 1px solid var(--color-border); }
  .weekdays { display: grid; height: 7.5rem; grid-template-columns: repeat(7, 1fr); gap: var(--space-2); }
  .wd { display: flex; min-width: 0; align-items: center; flex-direction: column; gap: 3px; }
  .wd-bar { display: flex; width: 100%; max-width: 1.5rem; flex: 1; align-items: flex-end; }
  .wd-bar span { display: block; width: 100%; border-radius: 4px 4px 0 0; background: var(--viz-light); }
  .wd-bar span.weekend { background: var(--viz-deep); }
  .wd-val { font-size: 0.6875rem; font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .wd-day { color: var(--color-text-muted); font-size: 0.6875rem; }

  .breakdown { margin-top: var(--space-4); }

  /* training */
  .sport-table { width: 100%; margin-top: var(--space-4); border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .sport-table th, .sport-table td { padding: var(--space-2); border-top: 1px solid var(--color-border); text-align: left; }
  .sport-table thead th { border-top: 0; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .sport-table tbody th { display: flex; align-items: center; gap: var(--space-2); font-weight: var(--weight-medium); }
  .sport-table .num { text-align: right; }
  .recent-title { margin-top: var(--space-5); }
  .recent { display: grid; margin: 0; padding: 0; list-style: none; }
  .recent li { display: flex; padding: var(--space-2) 0; align-items: center; gap: var(--space-3); border-top: 1px solid var(--color-border); font-size: var(--text-sm); }
  .recent li:first-child { border-top: 0; }
  .r-name { display: flex; min-width: 0; flex: 1; flex-direction: column; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .r-name em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .r-num { font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }

  /* records */
  .records { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 10.5rem), 1fr)); gap: var(--space-3); }
  .record { display: flex; padding: var(--space-4); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: linear-gradient(160deg, var(--color-surface) 60%, var(--color-accent-soft)); }
  .rec-label { color: var(--color-text-muted); font-size: var(--text-xs); }
  .rec-value { font-size: var(--text-xl); font-weight: var(--weight-bold); letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .rec-date { color: var(--color-text-subtle); font-size: 0.6875rem; }

  .promise { display: grid; margin: 0; padding: 0; grid-template-columns: repeat(auto-fit, minmax(min(100%, 15rem), 1fr)); gap: var(--space-3); list-style: none; }
  .promise li { display: flex; padding: var(--space-4); align-items: flex-start; gap: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); color: var(--color-text-muted); font-size: var(--text-sm); }
  .promise :global(.icon) { margin-top: 2px; color: var(--color-accent); }
  .promise b { color: var(--color-text); }

  @media (min-width: 43.75rem) {
    .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .sub-grid { grid-template-columns: 1fr 1fr; }
  }
  @media (min-width: 62rem) {
    .grid-2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .span-2 { grid-column: span 2; }
    .hero { grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); align-items: center; }
  }
  @media (max-width: 43.7rem) {
    /* Findings become a swipeable row on phones. */
    .findings { display: flex; margin-inline: calc(-1 * var(--space-4)); padding: 0 var(--space-4) var(--space-2); overflow-x: auto; scroll-snap-type: x mandatory; scroll-padding-inline: var(--space-4); scrollbar-width: none; }
    .findings::-webkit-scrollbar { display: none; }
    .finding { flex: 0 0 min(86%, 21rem); scroll-snap-align: start; }
    .vital-row :global(svg) { width: 60px; }
  }
  @media (max-width: 30rem) {
    .hero { padding: var(--space-5); }
    .parts li { grid-template-columns: 3.5rem 1fr; }
    .part-detail { grid-column: 2; }
    .range { width: 100%; min-width: 0; }
    .sport-table .wide { display: none; }
    .race { grid-template-columns: 1fr auto auto; }
    .race :global(svg) { display: none; }
  }
</style>
