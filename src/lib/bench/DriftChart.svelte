<script lang="ts">
  import type { BenchLog } from '../types'
  import { linear, linePath, niceTicks } from '../viz/scale'
  import { fmtSignedPct, rollingMedian, type Yardstick } from './bench'

  interface Props { logs: BenchLog[]; yardstick: Yardstick }
  let { logs, yardstick }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)
  const height = 200
  const PAD = { top: 12, right: 44, bottom: 22, left: 8 }

  // Oldest → newest, only meals that have the chosen yardstick.
  const pts = $derived(
    [...logs]
      .reverse()
      .map((l) => ({ l, v: yardstick === 'consensus' ? l.loggedDevPct : l.loggedRefDevPct }))
      .filter((p): p is { l: BenchLog; v: number } => p.v != null),
  )
  const trend = $derived(rollingMedian(pts.map((p) => p.v), 7))
  const lim = $derived(Math.min(80, Math.max(20, ...pts.map((p) => Math.abs(p.v)))))
  const yt = $derived(niceTicks(-lim, lim, 4))
  const y = $derived(linear(yt.domain, [height - PAD.bottom, PAD.top]))
  const x = $derived(linear([0, Math.max(1, pts.length - 1)], [PAD.left + 6, Math.max(PAD.left + 7, width - PAD.right - 6)]))
  const cy = (v: number): number => y(Math.max(yt.domain[0], Math.min(yt.domain[1], v)))

  function onmove(e: PointerEvent): void {
    if (!pts.length) return
    const px = e.clientX - (e.currentTarget as SVGElement).getBoundingClientRect().left
    const i = Math.round(((px - x(0)) / Math.max(1, x(Math.max(1, pts.length - 1)) - x(0))) * Math.max(1, pts.length - 1))
    hover = Math.max(0, Math.min(pts.length - 1, i))
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
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0 && pts.length}
    <svg {width} {height} role="slider" tabindex="0" aria-label="Logged value against the {yardstick === 'consensus' ? 'panel median' : 'your corrections'}, meal by meal" aria-valuemin={0} aria-valuemax={pts.length - 1} aria-valuenow={hover ?? pts.length - 1} aria-valuetext={hp ? `${fmtDate(hp.l.createdAt)} ${hp.l.text}: ${fmtSignedPct(hp.v)}` : `Latest trend ${fmtSignedPct(trend[trend.length - 1])}`} onpointermove={onmove} onpointerleave={() => (hover = null)} onkeydown={onkey} onblur={() => (hover = null)}>
      <rect class="band" x={PAD.left} y={y(10)} width={width - PAD.left - PAD.right} height={y(-10) - y(10)} />
      {#each yt.ticks as t (t)}
        <line class="grid" class:zero={t === 0} x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
        <text class="tick" x={width - PAD.right + 6} y={y(t)} dy="0.32em">{t > 0 ? '+' : ''}{t}%</text>
      {/each}
      <text class="tick" x={PAD.left} y={height - 4}>{fmtDate(pts[0].l.createdAt)}</text>
      <text class="tick" x={width - PAD.right} y={height - 4} text-anchor="end">{fmtDate(pts[pts.length - 1].l.createdAt)}</text>
      {#each pts as p, i (p.l.id)}
        <circle cx={x(i)} cy={cy(p.v)} r={hover === i ? 5 : 3.5} fill="var(--color-text)" opacity={hover === null || hover === i ? 0.55 : 0.25} />
      {/each}
      {#if pts.length >= 3}
        <path class="trend" d={linePath(trend.map((v, i) => ({ x: x(i), y: cy(v) })))} />
      {/if}
      {#if hp}<line class="cross" x1={x(hover ?? 0)} x2={x(hover ?? 0)} y1={PAD.top} y2={height - PAD.bottom} />{/if}
    </svg>
    {#if hp}
      <div class="tip" role="status" style:left="{Math.min(Math.max(x(hover ?? 0), 90), width - 90)}px">
        <span class="tip-day">{fmtDate(hp.l.createdAt)} · {hp.l.text.slice(0, 40)}{hp.l.text.length > 40 ? '…' : ''}</span>
        <span>Logged <b>{Math.round(hp.l.logged?.kcal ?? 0)} kcal</b> · {fmtSignedPct(hp.v)}</span>
        <span>Trend (last 7) <b>{fmtSignedPct(trend[hover ?? 0])}</b></span>
      </div>
    {/if}
  {:else if width > 0}
    <p class="none">Nothing to plot yet.</p>
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
  .trend { fill: none; stroke: var(--viz-line); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .cross { stroke: var(--viz-axis); stroke-width: 1; }
  .tip { position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3); transform: translateX(-50%); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-raised, var(--color-surface)); box-shadow: var(--shadow-card); color: var(--color-text-muted); font-size: var(--text-xs); pointer-events: none; white-space: nowrap; }
  .tip b, .tip-day { color: var(--color-text); }
  .tip-day { font-weight: var(--weight-semibold); }
  .none { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
</style>
