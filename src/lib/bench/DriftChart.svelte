<script lang="ts">
  import type { BenchLog, BenchRun } from '../types'
  import { linear, linePath, niceTicks } from '../viz/scale'
  import { ROLE_COLOR, fmtSignedPct, modelLabel, rollingMedian, type Yardstick } from './bench'

  /**
   * Meal by meal: how far A and B each sit from the other models (or from the
   * user's correction), drawn over the range the five background models span
   * on the same yardstick. The lines are 7-meal rolling medians.
   */
  interface Props { logs: BenchLog[]; yardstick: Yardstick }
  let { logs, yardstick }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)
  const height = 240
  const PAD = { top: 12, right: 44, bottom: 22, left: 8 }

  const devOf = (r: BenchRun | undefined): number | null => (r ? (yardstick === 'consensus' ? r.looDevPct : r.refDevPct) : null)

  // Oldest → newest; a meal needs both A and B on the chosen yardstick.
  const pts = $derived(
    [...logs]
      .reverse()
      .map((l) => {
        const a = l.runs.find((r) => r.role === 'a')
        const b = l.runs.find((r) => r.role === 'b')
        const panel = l.runs.filter((r) => r.role === 'bench').map(devOf).filter((v): v is number => v != null)
        return { l, a, b, va: devOf(a), vb: devOf(b), lo: panel.length ? Math.min(...panel) : null, hi: panel.length ? Math.max(...panel) : null }
      })
      .filter((p): p is typeof p & { va: number; vb: number } => p.va != null && p.vb != null),
  )
  const trendA = $derived(rollingMedian(pts.map((p) => p.va), 7))
  const trendB = $derived(rollingMedian(pts.map((p) => p.vb), 7))
  const lim = $derived(Math.min(80, Math.max(20, ...pts.flatMap((p) => [Math.abs(p.va), Math.abs(p.vb), Math.abs(p.lo ?? 0), Math.abs(p.hi ?? 0)]))))
  const yt = $derived(niceTicks(-lim, lim, 4))
  const y = $derived(linear(yt.domain, [height - PAD.bottom, PAD.top]))
  const x = $derived(linear([0, Math.max(1, pts.length - 1)], [PAD.left + 6, Math.max(PAD.left + 7, width - PAD.right - 6)]))
  const cy = (v: number): number => y(Math.max(yt.domain[0], Math.min(yt.domain[1], v)))
  const step = $derived(pts.length > 1 ? x(1) - x(0) : 20)

  function onmove(e: PointerEvent): void {
    if (!pts.length) return
    const px = e.clientX - (e.currentTarget as SVGElement).getBoundingClientRect().left
    hover = Math.max(0, Math.min(pts.length - 1, Math.round((px - x(0)) / Math.max(1, step))))
  }
  function onkey(e: KeyboardEvent): void {
    if (!pts.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      hover = Math.max(0, Math.min(pts.length - 1, (hover ?? pts.length - 1) + (e.key === 'ArrowRight' ? 1 : -1)))
    } else if (e.key === 'Escape') hover = null
  }
  const hp = $derived(hover !== null ? pts[hover] ?? null : null)
  const fmtDate = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '')
  const ref = $derived(yardstick === 'consensus' ? 'the other models' : 'your correction')
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0 && pts.length}
    <svg {width} {height} role="slider" tabindex="0" aria-label="Model A and model B against {ref}, meal by meal" aria-valuemin={0} aria-valuemax={pts.length - 1} aria-valuenow={hover ?? pts.length - 1} aria-valuetext={hp ? `${fmtDate(hp.l.createdAt)} ${hp.l.text}: A ${fmtSignedPct(hp.va)}, B ${fmtSignedPct(hp.vb)}` : `Recent trend: A ${fmtSignedPct(trendA[trendA.length - 1])}, B ${fmtSignedPct(trendB[trendB.length - 1])}`} onpointermove={onmove} onpointerleave={() => (hover = null)} onkeydown={onkey} onblur={() => (hover = null)}>
      <rect class="band" x={PAD.left} y={y(10)} width={width - PAD.left - PAD.right} height={y(-10) - y(10)} />
      {#each yt.ticks as t (t)}
        <line class="grid" class:zero={t === 0} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
        <text class="tick" x={width - PAD.right + 6} y={y(t)} dy="0.32em">{t > 0 ? '+' : ''}{t}%</text>
      {/each}
      <text class="tick" x={PAD.left} y={height - 4}>{fmtDate(pts[0].l.createdAt)}</text>
      <text class="tick" x={width - PAD.right} y={height - 4} text-anchor="end">{fmtDate(pts[pts.length - 1].l.createdAt)}</text>
      <!-- the range the five background models span on each meal -->
      {#each pts as p, i (p.l.id)}
        {#if p.lo != null && p.hi != null}
          <line class="range" x1={x(i)} x2={x(i)} y1={cy(p.hi)} y2={cy(p.lo)} stroke-width={Math.max(2, Math.min(6, step * 0.45))} opacity={hover === null || hover === i ? 1 : 0.5} />
        {/if}
      {/each}
      {#if pts.length >= 3}
        <path class="trend" d={linePath(trendA.map((v, i) => ({ x: x(i), y: cy(v) })))} stroke={ROLE_COLOR.a} />
        <path class="trend" d={linePath(trendB.map((v, i) => ({ x: x(i), y: cy(v) })))} stroke={ROLE_COLOR.b} />
      {/if}
      {#each pts as p, i (p.l.id)}
        <circle cx={x(i)} cy={cy(p.va)} r={hover === i ? 5 : 3.5} fill={ROLE_COLOR.a} stroke="var(--color-surface)" stroke-width="1.5" opacity={hover === null || hover === i ? 0.9 : 0.35} />
        <circle cx={x(i)} cy={cy(p.vb)} r={hover === i ? 5 : 3.5} fill={ROLE_COLOR.b} stroke="var(--color-surface)" stroke-width="1.5" opacity={hover === null || hover === i ? 0.9 : 0.35} />
      {/each}
      {#if hp}<line class="cross" x1={x(hover ?? 0)} x2={x(hover ?? 0)} y1={PAD.top} y2={height - PAD.bottom} />{/if}
    </svg>
    {#if hp}
      <div class="tip" role="status" style:left="{Math.min(Math.max(x(hover ?? 0), 100), width - 100)}px">
        <span class="tip-day">{fmtDate(hp.l.createdAt)} · {hp.l.text.slice(0, 40)}{hp.l.text.length > 40 ? '…' : ''}</span>
        <span><i class="dot" style:background={ROLE_COLOR.a}></i>A {modelLabel(hp.a?.model ?? '')} <b>{Math.round(hp.a?.kcal ?? 0)} kcal · {fmtSignedPct(hp.va)}</b></span>
        <span><i class="dot" style:background={ROLE_COLOR.b}></i>B {modelLabel(hp.b?.model ?? '')} <b>{Math.round(hp.b?.kcal ?? 0)} kcal · {fmtSignedPct(hp.vb)}</b></span>
        {#if hp.lo != null && hp.hi != null}<span><i class="dot" style:background={ROLE_COLOR.bench}></i>Other five: {fmtSignedPct(hp.lo)} to {fmtSignedPct(hp.hi)}</span>{/if}
        {#if yardstick === 'corrected' && hp.l.reference}<span>Your {hp.l.reference.source}: <b>{Math.round(hp.l.reference.kcal)} kcal</b></span>{/if}
      </div>
    {/if}
  {:else if width > 0}
    <p class="none">{yardstick === 'corrected' ? 'No corrected meals in this range yet.' : 'Nothing to plot yet.'}</p>
  {/if}
</div>

<style>
  .viz { position: relative; width: 100%; touch-action: pan-y; }
  svg { display: block; overflow: visible; outline: none; border-radius: var(--radius-sm); }
  svg:focus-visible { box-shadow: var(--focus-ring); }
  .band { fill: var(--viz-wash); }
  .grid { stroke: var(--viz-grid); stroke-width: 1; }
  .grid.zero { stroke: var(--viz-axis); }
  .tick { fill: var(--viz-axis); font-size: 11px; font-variant-numeric: tabular-nums; }
  .range { stroke: color-mix(in oklab, var(--viz-other) 45%, var(--color-surface)); stroke-linecap: round; }
  .trend { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .cross { stroke: var(--viz-axis); stroke-width: 1; }
  .tip { position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3); transform: translateX(-50%); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-raised, var(--color-surface)); box-shadow: var(--shadow-card); color: var(--color-text-muted); font-size: var(--text-xs); pointer-events: none; white-space: nowrap; }
  .tip b, .tip-day { color: var(--color-text); }
  .tip-day { font-weight: var(--weight-semibold); }
  .dot { display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 50%; }
  .none { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
</style>
