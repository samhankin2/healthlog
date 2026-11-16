<script lang="ts">
  import type { BenchLog, BenchRun } from '../types'
  import { niceTicks } from '../viz/scale'
  import { ROLE_COLOR, ROLE_LABEL, fmtLatency, fmtSignedKcal, fmtSignedPct, modelLabel, type Unit } from './bench'

  interface Props { logs: BenchLog[]; unit: Unit; pageSize?: number }
  let { logs, unit, pageSize = 15 }: Props = $props()

  let width = $state(0)
  let shown = $state(15)
  let hover = $state<{ log: string; i: number } | null>(null)

  const H = 34
  const PADX = 10

  /**
   * In kcal every meal shares ONE scale, so a 400 kcal disagreement on a
   * dinner looks big and a 25 kcal one on a coffee looks small — which is
   * what they mean for the day. The scale covers 95% of all gaps; the rest are
   * pinned to the edge with an arrow. In % it is a fixed ±50%.
   */
  const R = $derived.by(() => {
    if (unit === 'pct') return 50
    const gaps = logs.flatMap((l) => l.runs.map((r) => Math.abs(r.devKcal ?? 0))).sort((a, b) => a - b)
    const p95 = gaps[Math.floor(gaps.length * 0.95)] ?? 0
    return niceTicks(0, Math.min(800, Math.max(100, p95)), 2).domain[1]
  })
  const x = (v: number): number => PADX + ((Math.max(-R, Math.min(R, v)) + R) / (2 * R)) * Math.max(1, width - 2 * PADX)
  const TICKS = $derived(unit === 'pct' ? [-50, -25, -10, 0, 10, 25, 50] : [-R, -R / 2, 0, R / 2, R])
  const BAND = $derived(unit === 'pct' ? 10 : 100)
  const tickText = (t: number): string => {
    if (t === 0) return width >= 520 ? 'median of all 7' : 'median'
    const sign = t > 0 ? '+' : '−'
    return unit === 'pct' ? `${sign}${Math.abs(t)}%` : `${sign}${Math.abs(t)} kcal`
  }

  interface Mark { kind: 'run' | 'ref'; label: string; role: string; v: number; pct: number; dk: number; kcal: number; run?: BenchRun }
  function marks(l: BenchLog): Mark[] {
    const out: Mark[] = []
    const c = l.consensusKcal
    if (!c) return out
    const order = (r: BenchRun): number => (r.role === 'a' || r.role === 'b' ? 1 : 0)
    for (const r of [...l.runs].sort((p, q) => order(p) - order(q))) {
      if (r.kcal == null || r.devPct == null || r.devKcal == null) continue
      out.push({ kind: 'run', label: modelLabel(r.model), role: r.role, v: unit === 'pct' ? r.devPct : r.devKcal, pct: r.devPct, dk: r.devKcal, kcal: r.kcal, run: r })
    }
    if (l.reference) {
      const dk = l.reference.kcal - c
      const pct = (dk / c) * 100
      out.push({ kind: 'ref', label: `Your ${l.reference.source}`, role: 'logged', v: unit === 'pct' ? pct : dk, pct, dk, kcal: l.reference.kcal })
    }
    return out
  }

  function onmove(e: PointerEvent, l: BenchLog, ms: Mark[]): void {
    const px = e.clientX - (e.currentTarget as SVGElement).getBoundingClientRect().left
    let best = -1
    let dist = Infinity
    ms.forEach((m, i) => {
      const d = Math.abs(x(m.v) - px)
      if (d < dist) { dist = d; best = i }
    })
    hover = dist < 16 ? { log: l.id, i: best } : null
  }
  function onkey(e: KeyboardEvent, l: BenchLog, ms: Mark[]): void {
    if (!ms.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const sorted = ms.map((m, i) => ({ m, i })).sort((a, b) => a.m.v - b.m.v)
      const cur = hover?.log === l.id ? sorted.findIndex((s) => s.i === hover?.i) : -1
      const next = Math.max(0, Math.min(sorted.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
      hover = { log: l.id, i: sorted[next].i }
    } else if (e.key === 'Escape') hover = null
  }

  const when = (iso: string | null): string => {
    if (!iso) return ''
    const d = new Date(iso)
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  }
  const OUTCOME = { unsaved: 'Not saved', accepted: 'Saved as estimated', corrected: 'You corrected it' } as const
</script>

<div class="strips" bind:clientWidth={width}>
  <div class="axis" aria-hidden="true">
    {#each TICKS.filter((t) => width >= 520 || (unit === 'pct' ? Math.abs(t) !== 10 : Math.abs(t) !== R / 2)) as t (t)}<span style:left="{x(t)}px">{tickText(t)}</span>{/each}
  </div>
  {#each logs.slice(0, shown) as l (l.id)}
    {@const ms = marks(l)}
    {@const hm = hover?.log === l.id ? ms[hover.i] ?? null : null}
    <article class="log" class:differed={l.differed}>
      <header>
        <span class="when">{when(l.createdAt)}</span>
        <span class="text" title={l.text}>{l.text || 'Meal'}</span>
        <span class="meta">
          {#if l.spreadPct != null && l.spreadKcal != null}<span class="spread" class:wide={l.differed} title="Highest minus lowest estimate">{unit === 'kcal' ? `${Math.round(l.spreadKcal)} kcal apart` : `${Math.round(l.spreadPct)}% apart`}<small> · {unit === 'kcal' ? `${Math.round(l.spreadPct)}%` : `${Math.round(l.spreadKcal)} kcal`}</small></span>{/if}
          <span class="outcome" data-outcome={l.outcome}>{OUTCOME[l.outcome]}</span>
        </span>
      </header>
      {#if width > 0 && ms.length}
        <div class="strip">
          <svg width={width} height={H} role="slider" tabindex="0" aria-label="Estimates for {l.text || 'this meal'}, relative to the median of all the models. Arrow keys step through them." aria-valuemin={0} aria-valuemax={ms.length - 1} aria-valuenow={hm ? hover?.i ?? 0 : 0} aria-valuetext={hm ? `${hm.label}: ${Math.round(hm.kcal)} kcal, ${fmtSignedKcal(hm.dk)}, ${fmtSignedPct(hm.pct)}` : `Median of the models ${Math.round(l.consensusKcal ?? 0)} kcal`} onpointermove={(e) => onmove(e, l, ms)} onpointerleave={() => (hover = null)} onkeydown={(e) => onkey(e, l, ms)} onblur={() => (hover = null)}>
            <rect class="band" x={x(-BAND)} y="4" width={x(BAND) - x(-BAND)} height={H - 8} rx="4" />
            {#each TICKS as t (t)}<line class="grid" class:zero={t === 0} x1={x(t)} x2={x(t)} y1="2" y2={H - 2} />{/each}
            {#each ms as m, i (i)}
              {@const cx = x(m.v)}
              {@const dim = hm !== null && hover?.i !== i}
              {#if m.kind === 'ref'}
                <circle {cx} cy={H / 2} r="9" fill="none" stroke="var(--color-text)" stroke-width="2" opacity={dim ? 0.35 : 1} />
              {:else}
                <circle {cx} cy={H / 2} r={m.role === 'a' || m.role === 'b' ? 6 : 4.5} fill={ROLE_COLOR[m.role as keyof typeof ROLE_COLOR]} stroke="var(--color-surface)" stroke-width="2" opacity={dim ? 0.35 : m.role === 'bench' ? 0.85 : 1} />
              {/if}
              {#if Math.abs(m.v) > R}<text class="clip" x={cx} y={H - 1} text-anchor="middle">{m.v > 0 ? '▸' : '◂'}</text>{/if}
            {/each}
          </svg>
          {#if hm}
            <div class="tip" role="status" style:left="{Math.min(Math.max(x(hm.v), 90), width - 90)}px">
              <span class="tip-day">{hm.label}{hm.run ? ` · ${ROLE_LABEL[hm.run.role]}` : ''}</span>
              <span><b>{Math.round(hm.kcal)} kcal</b> · {fmtSignedKcal(hm.dk)} ({fmtSignedPct(hm.pct)}) vs median</span>
              {#if hm.run?.proteinG != null}<span>{Math.round(hm.run.proteinG)} g protein · {fmtLatency(hm.run.latencyMs)}</span>{/if}
            </div>
          {/if}
        </div>
      {/if}
      <details>
        <summary>All {l.runs.length} estimates{#if l.consensusKcal} · median of the models {Math.round(l.consensusKcal)} kcal{/if}</summary>
        <div class="table-wrap">
          <table>
            <thead><tr><th scope="col">Model</th><th scope="col">kcal</th><th scope="col">vs median</th><th scope="col">%</th><th scope="col">Protein</th><th scope="col">Meals</th><th scope="col">Time</th></tr></thead>
            <tbody>
              {#if l.logged}<tr class="logged-row"><th scope="row">Proposed to you (A + B combined)</th><td>{Math.round(l.logged.kcal)}</td><td>{l.consensusKcal ? fmtSignedKcal(l.logged.kcal - l.consensusKcal) : '—'}</td><td>{fmtSignedPct(l.loggedDevPct)}</td><td>{Math.round(l.logged.proteinG)} g</td><td></td><td></td></tr>{/if}
              {#if l.reference}<tr class="logged-row"><th scope="row">Your {l.reference.source}</th><td>{Math.round(l.reference.kcal)}</td><td>{l.consensusKcal ? fmtSignedKcal(l.reference.kcal - l.consensusKcal) : '—'}</td><td>{l.consensusKcal ? fmtSignedPct(((l.reference.kcal - l.consensusKcal) / l.consensusKcal) * 100) : '—'}</td><td>{Math.round(l.reference.proteinG)} g</td><td></td><td></td></tr>{/if}
              {#each l.runs as r (r.model)}
                <tr>
                  <th scope="row"><span class="dot" style:background={ROLE_COLOR[r.role]} aria-hidden="true"></span>{modelLabel(r.model)}{#if r.role === 'a' || r.role === 'b'}&nbsp;<small>({r.role.toUpperCase()})</small>{/if}</th>
                  {#if r.kcal == null}
                    <td colspan="6" class="err">failed — {r.error}</td>
                  {:else}
                    <td>{Math.round(r.kcal)}</td><td>{fmtSignedKcal(r.devKcal)}</td><td>{fmtSignedPct(r.devPct)}</td><td>{r.proteinG == null ? '—' : `${Math.round(r.proteinG)} g`}</td><td>{r.mealCount ?? '—'}</td><td>{fmtLatency(r.latencyMs)}</td>
                  {/if}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </details>
    </article>
  {:else}
    <p class="none">No meals in this range.</p>
  {/each}
  {#if logs.length > shown}
    <button class="button button--secondary more" type="button" onclick={() => (shown += pageSize)}>Show {Math.min(pageSize, logs.length - shown)} more</button>
  {/if}
</div>

<style>
  .strips { display: flex; flex-direction: column; gap: var(--space-2); }
  .axis { position: relative; height: 1rem; color: var(--viz-axis); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .axis span:first-child { transform: none; }
  .axis span:last-child { transform: translateX(-100%); }
  .log { display: flex; padding: var(--space-3) 0; flex-direction: column; gap: var(--space-2); border-top: 1px solid var(--viz-grid); }
  header { display: flex; min-width: 0; align-items: baseline; gap: var(--space-2) var(--space-3); flex-wrap: wrap; font-size: var(--text-sm); }
  .when { color: var(--color-text-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .text { min-width: 0; flex: 1 1 12rem; overflow: hidden; color: var(--color-text); text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; gap: var(--space-2); }
  .spread, .outcome { padding: 1px 8px; border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-text-muted); font-size: var(--text-xs); white-space: nowrap; }
  .spread small { color: var(--color-text-subtle); font-weight: var(--weight-regular, 400); }
  .spread.wide { border-color: var(--color-text-muted); color: var(--color-text); font-weight: var(--weight-semibold); }
  .outcome[data-outcome='corrected'] { color: var(--color-text); }
  .strip { position: relative; touch-action: pan-y; }
  svg { display: block; overflow: visible; outline: none; border-radius: var(--radius-sm); }
  svg:focus-visible { box-shadow: var(--focus-ring); }
  .band { fill: var(--viz-wash); }
  .grid { stroke: var(--viz-grid); stroke-width: 1; }
  .grid.zero { stroke: var(--viz-axis); }
  .clip { fill: var(--color-text-subtle); font-size: 9px; }
  .tip { position: absolute; bottom: calc(100% + 4px); z-index: 2; display: flex; padding: var(--space-2) var(--space-3); transform: translateX(-50%); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-raised, var(--color-surface)); box-shadow: var(--shadow-card); color: var(--color-text-muted); font-size: var(--text-xs); pointer-events: none; white-space: nowrap; }
  .tip b, .tip-day { color: var(--color-text); }
  .tip-day { font-weight: var(--weight-semibold); }
  details summary { color: var(--color-text-muted); font-size: var(--text-xs); cursor: pointer; }
  .table-wrap { margin-top: var(--space-2); overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  th, td { padding: 4px 8px 4px 0; border-bottom: 1px solid var(--viz-grid); text-align: right; white-space: nowrap; }
  th:first-child { text-align: left; font-weight: var(--weight-medium); }
  thead th { color: var(--color-text-subtle); font-weight: var(--weight-medium); }
  .logged-row th, .logged-row td { font-weight: var(--weight-semibold); }
  .dot { display: inline-block; width: 8px; height: 8px; margin-right: 6px; border-radius: 50%; }
  .err { color: var(--color-text-subtle); text-align: left; white-space: normal; }
  .none { color: var(--color-text-muted); font-size: var(--text-sm); }
  .more { align-self: center; }
</style>
