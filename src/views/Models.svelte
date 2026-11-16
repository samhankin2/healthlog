<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import SegmentedControl from '../lib/components/SegmentedControl.svelte'
  import StatTile from '../lib/components/StatTile.svelte'
  import AccuracyBars from '../lib/bench/AccuracyBars.svelte'
  import BiasMap from '../lib/bench/BiasMap.svelte'
  import AgreementMatrix from '../lib/bench/AgreementMatrix.svelte'
  import DriftChart from '../lib/bench/DriftChart.svelte'
  import DisagreementStrips from '../lib/bench/DisagreementStrips.svelte'
  import { ROLE_COLOR, fmtPct, fmtSignedPct, modelLabel, statsFor, verdict, type Yardstick } from '../lib/bench/bench'
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

  function stored(): string {
    try { return localStorage.getItem(RANGE_KEY) ?? '90' } catch { return '90' }
  }

  let range = $state(stored())
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

  const logged = $derived(data?.models.find((m) => m.role === 'logged') ?? null)
  const ls = $derived(logged ? statsFor(logged, yardstick) : null)
  const v = $derived(data ? verdict(data.models, yardstick) : null)
  const ranked = $derived(data ? data.models.filter((m) => m.role !== 'logged' && statsFor(m, yardstick).n > 0).sort((a, b) => (statsFor(a, yardstick).medianAbsPct ?? 999) - (statsFor(b, yardstick).medianAbsPct ?? 999)) : [])
  const rankOf = (role: 'a' | 'b'): number => ranked.findIndex((m) => m.role === role) + 1
  const primary = (role: 'a' | 'b') => data?.models.find((m) => m.role === role) ?? null
  const shownLogs = $derived(data ? (onlyDiffered ? data.logs.filter((l) => l.differed || l.outcome === 'corrected') : data.logs) : [])

  /** Plain-English notes on the two models the app relies on. */
  const notes = $derived.by(() => {
    if (!data || !ranked.length) return []
    const out: string[] = []
    for (const role of ['a', 'b'] as const) {
      const m = primary(role)
      if (!m) continue
      const s = statsFor(m, yardstick)
      if (!s.n) continue
      const name = modelLabel(m.model)
      out.push(`${name} (Model ${role.toUpperCase()}) ranks ${rankOf(role)} of ${ranked.length} — typically ${fmtPct(s.medianAbsPct, 1)} off${Math.abs(s.biasPct ?? 0) >= 5 ? `, and tends to read ${fmtSignedPct(s.biasPct)} ${(s.biasPct ?? 0) < 0 ? 'low' : 'high'}` : ', with no real lean either way'}.`)
    }
    const best = ranked[0]
    if (best && best.role === 'bench') out.push(`Most consistent so far: ${modelLabel(best.model)} (${fmtPct(statsFor(best, yardstick).medianAbsPct, 1)}).`)
    return out
  })
</script>

<div class="view view--models">
  <header class="m-head">
    <div>
      <button class="back" type="button" onclick={() => navigate('insights')}><Icon name="chevron-left" size={16} /> Insights</button>
      <h1 class="view-title">Are the calorie estimates right?</h1>
      <p class="view-subtitle">Each meal you describe goes to the two models HealthLog uses and, quietly in the background, to {data?.config.bench.length ?? 5} more. Only the first two decide what gets logged.</p>
    </div>
    <div class="range"><SegmentedControl ariaLabel="Date range" options={RANGES} value={range} onchange={setRange} /></div>
  </header>

  {#if loading}
    <div class="skeleton" role="status"><span class="spinner" aria-hidden="true"></span><span>Comparing models…</span></div>
  {:else if loadError}
    <div class="card pad" role="alert"><p>{loadError}</p><button class="button button--secondary" type="button" onclick={load}>Try again</button></div>
  {:else if data}
    {#if !data.config.enabled}
      <div class="card pad notice" role="status"><Icon name="info" size={18} /><p>The background panel is switched off on the server (<code>AI_BENCH_MODELS=off</code>). Only models A and B are being recorded.</p></div>
    {:else if data.config.paused}
      <div class="card pad notice" role="status"><Icon name="alert" size={18} /><p>The background panel hit the AI usage limit and is paused for an hour, so it can't eat into the quota your logging needs.</p></div>
    {/if}

    {#if data.totals.logs === 0}
      <div class="card pad empty">
        <Icon name="chat" size={22} />
        <p><b>Nothing to compare yet.</b> Describe a meal in Chat — every one from now on is scored here.</p>
        <button class="button button--secondary" type="button" onclick={() => navigate('chat')}>Open Chat</button>
      </div>
    {:else}
      <section class="card pad verdict" data-tone={v?.tone} aria-labelledby="verdict-title">
        <h2 id="verdict-title" class="sr-only">Verdict</h2>
        <p class="verdict-text">{v?.text}</p>
        {#if notes.length}<ul>{#each notes as n (n)}<li>{n}</li>{/each}</ul>{/if}
      </section>

      <div class="tiles">
        <StatTile label="Logged within 10%" value={fmtPct(ls?.within10)} sublabel="of {ls?.n ?? 0} meals, vs {yardstick === 'consensus' ? 'the panel' : 'your corrections'}" />
        <StatTile label="Typical miss" value={fmtPct(ls?.medianAbsPct, 1)} sublabel="median gap · reads {fmtSignedPct(ls?.biasPct)}" />
        <StatTile label="Models split" value={data.totals.differed} sublabel="of {data.totals.logs} meals spread over {data.config.differPct}%" />
        <StatTile label="You corrected" value={data.totals.corrected} sublabel="{data.totals.accepted} saved as estimated" />
      </div>

      <div class="controls">
        <SegmentedControl
          ariaLabel="Measure against"
          options={[{ value: 'consensus', label: 'vs panel median' }, { value: 'corrected', label: `vs your corrections (${data.totals.corrected})` }]}
          value={yardstick}
          onchange={(next) => { if (next === 'consensus' || data?.totals.corrected) yardstick = next as Yardstick }}
        />
        <ul class="legend" aria-label="Legend">
          <li><span class="key diamond" aria-hidden="true"></span>Logged</li>
          <li><span class="key" style:background={ROLE_COLOR.a} aria-hidden="true"></span>A · {modelLabel(data.config.modelA)}</li>
          <li><span class="key" style:background={ROLE_COLOR.b} aria-hidden="true"></span>B · {modelLabel(data.config.modelB)}</li>
          <li><span class="key small" style:background={ROLE_COLOR.bench} aria-hidden="true"></span>Background panel</li>
          <li><span class="key ring" aria-hidden="true"></span>Your correction</li>
        </ul>
      </div>
      {#if yardstick === 'corrected' && data.totals.corrected < 5}
        <p class="caveat">Only {data.totals.corrected} corrected {data.totals.corrected === 1 ? 'meal' : 'meals'} so far — treat these numbers as early.</p>
      {/if}

      <section class="card pad" aria-labelledby="board-title">
        <div class="chart-head"><h2 id="board-title">Typical miss, by model</h2><span class="sub">median % from {yardstick === 'consensus' ? 'the other models’ median' : 'what you corrected to'} · lower is better</span></div>
        <AccuracyBars models={data.models} {yardstick} />
      </section>

      <div class="grid-2">
        <section class="card pad" aria-labelledby="bias-title">
          <div class="chart-head"><h2 id="bias-title">Lean vs accuracy</h2><span class="sub">left reads low, right reads high; the shaded box is within ±5% lean and 8% miss</span></div>
          <BiasMap models={data.models} {yardstick} />
        </section>
        <section class="card pad" aria-labelledby="pairs-title">
          <div class="chart-head"><h2 id="pairs-title">Who agrees with whom</h2><span class="sub">typical gap between each pair</span></div>
          <AgreementMatrix pairs={data.pairs} models={data.models} />
        </section>
      </div>

      <section class="card pad" aria-labelledby="drift-title">
        <div class="chart-head"><h2 id="drift-title">Logged value, meal by meal</h2><span class="sub">% from {yardstick === 'consensus' ? 'the panel median' : 'your correction'} · line is the last-7 median · band is ±10%</span></div>
        <DriftChart logs={data.logs} {yardstick} />
      </section>

      <section class="card pad" aria-labelledby="split-title">
        <div class="chart-head">
          <h2 id="split-title">Where they differed</h2>
          <SegmentedControl ariaLabel="Which meals" options={[{ value: 'diff', label: 'Splits & corrections' }, { value: 'all', label: `All ${data.logs.length}` }]} value={onlyDiffered ? 'diff' : 'all'} onchange={(next) => (onlyDiffered = next === 'diff')} />
        </div>
        <p class="sub">Each row is one meal; dots are each model’s estimate relative to the panel median. Open a row for the numbers.</p>
        <DisagreementStrips logs={shownLogs} />
      </section>

      <p class="method">
        <b>How this is scored.</b> There is no lab measurement of your meals, so two yardsticks: the <b>panel median</b> (each model is compared with the median of the <i>other</i> models, so it never grades itself) and <b>your corrections</b> — meals you fixed in chat or edited after saving, which are the closest thing to the truth. A panel can share a blind spot, so a correction outranks agreement. The background models never change what gets logged, and they pause automatically if the AI usage limit is hit.
      </p>
    {/if}
  {/if}
</div>

<style>
  .view--models { gap: var(--space-5); }
  .m-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
  .m-head .view-subtitle { max-width: 44rem; margin: var(--space-2) 0 0; color: var(--color-text-muted); }
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
  .legend { display: flex; margin: 0; padding: 0; gap: var(--space-2) var(--space-4); flex-wrap: wrap; list-style: none; color: var(--color-text-muted); font-size: var(--text-xs); }
  .legend li { display: flex; align-items: center; gap: 6px; }
  .key { width: 10px; height: 10px; border-radius: 50%; }
  .key.small { width: 8px; height: 8px; }
  .key.diamond { width: 9px; height: 9px; border-radius: 1px; background: var(--color-text); transform: rotate(45deg); }
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
