<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import SegmentedControl from '../lib/components/SegmentedControl.svelte'
  import StatTile from '../lib/components/StatTile.svelte'
  import AccuracyBars from '../lib/bench/AccuracyBars.svelte'
  import LeanBars from '../lib/bench/LeanBars.svelte'
  import AgreementMatrix from '../lib/bench/AgreementMatrix.svelte'
  import DriftChart from '../lib/bench/DriftChart.svelte'
  import DisagreementStrips from '../lib/bench/DisagreementStrips.svelte'
  import { ROLE_COLOR, fmtGap, fmtKcal, fmtPct, fmtSignedKcal, gapOf, modelLabel, rankModels, statsFor, verdict, type Unit, type Yardstick } from '../lib/bench/bench'
  import { api } from '../lib/api'
  import { navigate } from '../lib/state.svelte'
  import type { ModelBenchPayload } from '../lib/types'

  const RANGE_KEY = 'healthlog.models.range'
  const RANGES = [
    { value: '30', label: '30 days' },
    { value: '90', label: '90 days' },
    { value: '365', label: '1 year' },
    { value: '3650', label: 'All' },
  ]

  const UNIT_KEY = 'healthlog.models.unit'
  function stored(key: string, fallback: string): string {
    try { return localStorage.getItem(key) ?? fallback } catch { return fallback }
  }

  let range = $state(stored(RANGE_KEY, '90'))
  let unit = $state<Unit>(stored(UNIT_KEY, 'kcal') === 'pct' ? 'pct' : 'kcal')
  function setUnit(next: string): void {
    unit = next === 'pct' ? 'pct' : 'kcal'
    try { localStorage.setItem(UNIT_KEY, unit) } catch { /* private mode */ }
  }
  let data = $state<ModelBenchPayload | null>(null)
  let loading = $state(true)
  let loadError = $state('')
  let yardstick = $state<Yardstick>('consensus')
  let onlyDiffered = $state(true)

  async function load(): Promise<void> {
    loading = !data
    loadError = ''
    try {
      data = await api.getModelBench(Number(range))
      if (yardstick === 'corrected' && !data.totals.corrected) yardstick = 'consensus'
    } catch (cause) {
      loadError = cause instanceof Error ? cause.message : 'Could not load the model comparison.'
    } finally {
      loading = false
    }
  }
  onMount(load)

  function setRange(next: string): void {
    range = next
    try { localStorage.setItem(RANGE_KEY, next) } catch { /* private mode */ }
    void load()
  }

  const v = $derived(data ? verdict(data.models, yardstick, unit) : null)
  const ranked = $derived(data ? rankModels(data.models, yardstick, unit) : [])
  const primary = (role: 'a' | 'b') => data?.models.find((m) => m.role === role) ?? null
  // Big splits are listed biggest calorie gap first: those are the ones that move a day's total.
  const shownLogs = $derived(
    data
      ? onlyDiffered
        ? data.logs.filter((l) => l.differed || l.outcome === 'corrected').sort((p, q) => (q.spreadKcal ?? 0) - (p.spreadKcal ?? 0))
        : data.logs
      : [],
  )
  const refWord = $derived(yardstick === 'consensus' ? 'the other models' : 'your corrections')

  /**
   * Plain-English notes on A and B: which way they lean, and what that adds up
   * to in calories over every meal — the number that matters for a diary.
   */
  const notes = $derived.by(() => {
    if (!data || !ranked.length) return []
    const out: string[] = []
    for (const role of ['a', 'b'] as const) {
      const m = primary(role)
      if (!m) continue
      const s = statsFor(m, yardstick)
      if (!s.n || s.biasKcal == null || s.totalKcal == null) continue
      const name = `${modelLabel(m.model)} (${role.toUpperCase()})`
      if (Math.abs(s.meanKcal ?? 0) < 15) {
        out.push(`${name} has no real lean against ${refWord}: over ${s.n} meals it nets out at ${fmtSignedKcal(s.totalKcal)}.`)
      } else {
        out.push(`${name} would have logged ${fmtKcal(Math.abs(s.totalKcal))} ${s.totalKcal < 0 ? 'less' : 'more'} than ${refWord} over ${s.n} meals — about ${fmtKcal(Math.abs(s.meanKcal ?? 0))} a meal.`)
      }
    }
    const best = ranked[0]
    if (best && best.role === 'bench') out.push(`Closest to ${refWord} so far: ${modelLabel(best.model)} (${fmtGap(gapOf(statsFor(best, yardstick), unit), unit)} typical drift).`)
    return out
  })
</script>

<div class="view view--models">
  <header class="m-head">
    <div>
      <button class="back" type="button" onclick={() => navigate('insights')}><Icon name="chevron-left" size={16} /> Insights</button>
      <h1 class="view-title">How far apart are the models?</h1>
      <p class="view-subtitle">Every meal you describe goes to the two models HealthLog uses (A and B) and, in the background, to {data?.config.bench.length ?? 5} more. This page shows how far each model drifts from the others on the same meal. Agreement isn’t proof a number is right, but a model that keeps drifting away from the rest is the one to doubt.</p>
    </div>
    <div class="range"><SegmentedControl ariaLabel="Date range" options={RANGES} value={range} onchange={setRange} /></div>
  </header>

  {#if loading}
    <div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Comparing models…</span></div>
  {:else if loadError}
    <div class="card pad" role="alert"><p>{loadError}</p><button class="button button--secondary" type="button" onclick={load}>Try again</button></div>
  {:else if data}
    {#if !data.config.enabled}
      <div class="card pad notice" role="status"><Icon name="info" size={18} /><p>The background models are switched off on the server (<code>AI_BENCH_MODELS=off</code>). Only A and B are being recorded.</p></div>
    {:else if data.config.paused}
      <div class="card pad notice" role="status"><Icon name="alert" size={18} /><p>The background models hit the AI usage limit and are paused for an hour, so they can't eat into the quota your logging needs.</p></div>
    {/if}

    {#if data.totals.logs === 0}
      <div class="card pad empty">
        <Icon name="chat" size={22} />
        <p><b>Nothing to compare yet.</b> Describe a meal in Chat — every one from now on is compared here.</p>
        <button class="button button--secondary" type="button" onclick={() => navigate('chat')}>Open Chat</button>
      </div>
    {:else}
      <section class="card pad verdict" data-tone={v?.tone} aria-labelledby="verdict-title">
        <h2 id="verdict-title" class="sr-only">Summary</h2>
        <p class="verdict-text">{v?.text}</p>
        {#if notes.length}<ul>{#each notes as n (n)}<li>{n}</li>{/each}</ul>{/if}
      </section>

      <div class="tiles">
        <StatTile label="A vs B" value={unit === 'kcal' ? fmtKcal(data.totals.medianAbKcal) : fmtPct(data.totals.medianAbPct, 1)} sublabel="typical gap between your two models ({unit === 'kcal' ? fmtPct(data.totals.medianAbPct) : fmtKcal(data.totals.medianAbKcal)})" />
        <StatTile label="Spread of all 7" value={unit === 'kcal' ? fmtKcal(data.totals.medianSpreadKcal) : fmtPct(data.totals.medianSpreadPct)} sublabel="highest minus lowest on a typical meal" />
        <StatTile label="Big splits" value={data.totals.differed} sublabel="of {data.totals.logs} meals: over {data.config.differKcal} kcal and {data.config.differPct}% apart" />
        <StatTile label="You corrected" value={data.totals.corrected} sublabel="meals where you changed the numbers" />
      </div>

      <div class="controls">
        <div class="switches">
          <SegmentedControl
            ariaLabel="Compare each model against"
            options={[{ value: 'consensus', label: 'vs the other models' }, { value: 'corrected', label: `vs your corrections (${data.totals.corrected})` }]}
            value={yardstick}
            onchange={(next) => { if (next === 'consensus' || data?.totals.corrected) yardstick = next as Yardstick }}
          />
          <SegmentedControl ariaLabel="Show gaps in" options={[{ value: 'kcal', label: 'kcal' }, { value: 'pct', label: '%' }]} value={unit} onchange={setUnit} />
        </div>
        <ul class="legend" aria-label="Legend">
          <li><span class="key" style:background={ROLE_COLOR.a} aria-hidden="true"></span>A · {modelLabel(data.config.modelA)}</li>
          <li><span class="key" style:background={ROLE_COLOR.b} aria-hidden="true"></span>B · {modelLabel(data.config.modelB)}</li>
          <li><span class="key small" style:background={ROLE_COLOR.bench} aria-hidden="true"></span>The other five</li>
          <li><span class="key ring" aria-hidden="true"></span>Your correction</li>
        </ul>
      </div>
      <p class="caveat">
        {#if yardstick === 'consensus'}
          Each model is compared with the median of the <i>other six</i> on the same meal, so it never counts towards its own score.
          {unit === 'kcal' ? 'Gaps in kcal show what a miss does to your day: 50% off a coffee is small, 40% off a big dinner is not.' : 'Gaps in % are relative to the meal, so small items can look dramatic — switch to kcal for what it costs your day.'}
        {:else}
          Only meals where you changed the numbers{data.totals.corrected < 5 ? ` — just ${data.totals.corrected} so far, so treat this as early` : ''}. Your corrected total is the reference.
        {/if}
      </p>

      <section class="card pad" aria-labelledby="drift-title">
        <div class="chart-head"><h2 id="drift-title">A and B, meal by meal</h2><span class="sub">{unit === 'kcal' ? 'kcal' : '%'} from {yardstick === 'consensus' ? 'the median of the other six models' : 'what you corrected to'} · grey bar = where the other five landed · lines = last-7 median · band = ±{unit === 'kcal' ? '100 kcal' : '10%'}</span></div>
        <DriftChart logs={data.logs} {yardstick} {unit} />
      </section>

      <section class="card pad" aria-labelledby="board-title">
        <div class="chart-head"><h2 id="board-title">Typical drift, by model</h2><span class="sub">median {unit === 'kcal' ? 'kcal' : '%'} from {refWord} · lower means closer</span></div>
        <AccuracyBars models={data.models} {yardstick} {unit} />
      </section>

      <div class="grid-2">
        <section class="card pad" aria-labelledby="bias-title">
          <div class="chart-head"><h2 id="bias-title">Which way they lean</h2><span class="sub">typical meal vs {refWord}{unit === 'kcal' ? '; right column = what it adds up to over all meals' : ''}</span></div>
          <LeanBars models={data.models} {yardstick} {unit} />
        </section>
        <section class="card pad" aria-labelledby="pairs-title">
          <div class="chart-head"><h2 id="pairs-title">Who agrees with whom</h2><span class="sub">typical gap between each pair{unit === 'kcal' ? ', kcal' : ''}</span></div>
          <AgreementMatrix pairs={data.pairs} models={data.models} {unit} />
        </section>
      </div>

      <section class="card pad" aria-labelledby="split-title">
        <div class="chart-head">
          <h2 id="split-title">Every meal, every model</h2>
          <SegmentedControl ariaLabel="Which meals" options={[{ value: 'diff', label: 'Big splits & corrections' }, { value: 'all', label: `All ${data.logs.length}` }]} value={onlyDiffered ? 'diff' : 'all'} onchange={(next) => (onlyDiffered = next === 'diff')} />
        </div>
        <p class="sub">One row per meal{onlyDiffered ? ', biggest calorie gap first' : ''}. Each dot is one model’s estimate, placed by how far it is from the median of all seven{unit === 'kcal' ? ' — every row on the same kcal scale, so big meals with big gaps stand out' : ''}. Open a row for the numbers.</p>
        <DisagreementStrips logs={shownLogs} {unit} />
      </section>

      <p class="method">
        <b>What this does and doesn’t tell you.</b> None of these models weighed your food, so there’s no “true” number here. What it shows is <b>disagreement</b>: if A or B regularly lands away from where the other models cluster, that model is the likelier one to be wrong on that kind of meal. The <b>vs your corrections</b> view uses the only real ground truth there is: the meals where you fixed the numbers yourself. The background models never change what gets logged, and they pause automatically if the AI usage limit is hit.
      </p>
    {/if}
  {/if}
</div>

<style>
  .view--models { gap: var(--space-5); }
  .m-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .m-head .view-subtitle { max-width: 46rem; margin: var(--space-2) 0 0; color: var(--color-text-muted); }
  .back { display: inline-flex; margin-bottom: var(--space-2); padding: 0; align-items: center; gap: 2px; border: 0; background: none; color: var(--color-text-muted); font-size: var(--text-sm); }
  .back:hover { color: var(--color-accent); }
  .card { min-width: 0; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .pad { padding: var(--space-5); }
  .skeleton { display: flex; padding: var(--space-8); align-items: center; justify-content: center; gap: var(--space-3); color: var(--color-text-muted); }
  .notice { display: flex; align-items: flex-start; gap: var(--space-3); color: var(--color-text-muted); }
  .notice p, .empty p { margin: 0; }
  .empty { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
  .verdict { display: flex; flex-direction: column; gap: var(--space-2); border-left: 4px solid var(--color-border); }
  .verdict[data-tone='good'] { border-left-color: var(--color-success, var(--color-accent)); }
  .verdict[data-tone='ok'] { border-left-color: var(--color-warning, var(--color-accent)); }
  .verdict[data-tone='poor'] { border-left-color: var(--color-danger, var(--color-accent)); }
  .verdict-text { margin: 0; font-size: var(--text-lg); font-weight: var(--weight-semibold); letter-spacing: -0.01em; }
  .verdict ul { margin: 0; padding-left: 1.1rem; color: var(--color-text-muted); font-size: var(--text-sm); }
  .tiles { display: grid; gap: var(--space-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .controls { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .switches { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .switches > :global(.segmented-control) { width: auto; flex: 0 0 auto; }
  .legend { display: flex; margin: 0; padding: 0; gap: var(--space-2) var(--space-4); flex-wrap: wrap; list-style: none; color: var(--color-text-muted); font-size: var(--text-xs); }
  .legend li { display: flex; align-items: center; gap: 6px; }
  .key { width: 10px; height: 10px; border-radius: 50%; }
  .key.small { width: 8px; height: 8px; }
  .key.ring { width: 12px; height: 12px; border: 2px solid var(--color-text); }
  .caveat { margin: calc(-1 * var(--space-2)) 0 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .chart-head { display: flex; margin-bottom: var(--space-3); align-items: baseline; justify-content: space-between; gap: var(--space-2) var(--space-4); flex-wrap: wrap; }
  .chart-head h2 { margin: 0; font-size: var(--text-lg); letter-spacing: -0.01em; }
  .sub { margin: 0 0 var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); }
  .grid-2 { display: grid; gap: var(--space-4); align-items: start; }
  .grid-2 > * { min-width: 0; }
  .method { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); line-height: 1.55; }
  .method b { color: var(--color-text); }
  @media (min-width: 48rem) {
    .tiles { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
  @media (min-width: 96rem) {
    .grid-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
</style>
