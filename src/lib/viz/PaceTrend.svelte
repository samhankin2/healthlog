<script lang="ts">
  /**
   * Pace-at-reference-HR over time: one dot per run, a rolling median line,
   * shaded breaks, and drag-to-zoom. Faster is UP (the y-axis is inverted).
   */
  import { dayNum, fmtRace, isNum, numDay } from '../insights'
  import { dayTicks, fmtDayLong, linear, linePath } from './scale'

  interface P { day: string; adj: number; roll: number | null; detail: string; seg: number; inBreak: boolean }
  interface Props {
    label: string
    points: P[]
    breaks: { from: string; to: string; days: number }[]
    from: string
    to: string
    height?: number
    onzoom: (from: string, to: string) => void
  }
  let { label, points, breaks, from, to, height = 260, onzoom }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)
  let drag = $state<{ x0: number; x1: number } | null>(null)
  const PAD = { top: 16, right: 56, bottom: 26, left: 8 }

  const shown = $derived(points.filter((p) => p.day >= from && p.day <= to))
  const y = $derived.by(() => {
    const vals = shown.flatMap((p) => [p.adj, p.roll]).filter(isNum)
    const lo = vals.length ? Math.min(...vals) : 240
    const hi = vals.length ? Math.max(...vals) : 420
    let step = 15
    while ((hi - lo) / step > 5) step *= 2
    const d0 = Math.floor((lo - 4) / step) * step
    const d1 = Math.ceil((hi + 4) / step) * step
    const ticks: number[] = []
    for (let t = d0; t <= d1; t += step) ticks.push(t)
    // Inverted: faster (smaller) at the top.
    return { ticks, scale: linear([d0, d1], [PAD.top, height - PAD.bottom]) }
  })
  const x = $derived(linear([dayNum(from), Math.max(dayNum(to), dayNum(from) + 1)], [PAD.left, Math.max(PAD.left + 1, width - PAD.right)]))
  const xOf = (d: string): number => x(dayNum(d))
  const dayAt = (px: number): string => {
    const [d0, d1] = x.domain
    const [r0, r1] = x.range
    return numDay(Math.round(d0 + ((Math.max(r0, Math.min(r1, px)) - r0) / (r1 - r0 || 1)) * (d1 - d0)))
  }
  const ticks = $derived(dayTicks(from, to, width < 420 ? 4 : 6))
  /** The line lifts its pen at every break: one path per stretch of running. */
  const line = $derived.by(() => {
    const pts: { x: number; y: number | null }[] = []
    let seg: number | null = null
    for (const p of shown) {
      if (p.inBreak) continue
      if (seg !== null && p.seg !== seg) pts.push({ x: 0, y: null })
      seg = p.seg
      pts.push({ x: xOf(p.day), y: isNum(p.roll) ? y.scale(p.roll) : null })
    }
    return linePath(pts)
  })
  const breakBands = $derived(breaks.filter((b) => b.to >= from && b.from <= to).map((b) => ({ ...b, x0: xOf(b.from < from ? from : b.from), x1: xOf(b.to > to ? to : b.to) })))

  function localX(e: PointerEvent): number {
    return e.clientX - (e.currentTarget as SVGElement).getBoundingClientRect().left
  }
  function nearest(px: number): number | null {
    let best: number | null = null
    let dist = Infinity
    shown.forEach((p, i) => { const d = Math.abs(xOf(p.day) - px); if (d < dist) { dist = d; best = i } })
    return dist < 40 ? best : null
  }
  function down(e: PointerEvent): void {
    if (e.button !== 0) return
    ;(e.currentTarget as SVGElement).setPointerCapture(e.pointerId)
    drag = { x0: localX(e), x1: localX(e) }
  }
  function move(e: PointerEvent): void {
    const px = localX(e)
    if (drag) drag = { ...drag, x1: px }
    else hover = nearest(px)
  }
  function up(): void {
    if (drag && Math.abs(drag.x1 - drag.x0) > 10) {
      const a = dayAt(Math.min(drag.x0, drag.x1))
      const b = dayAt(Math.max(drag.x0, drag.x1))
      if (dayNum(b) - dayNum(a) >= 7) onzoom(a, b)
    }
    drag = null
  }
  function onkey(e: KeyboardEvent): void {
    if (!shown.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = hover ?? shown.length - 1
      hover = Math.max(0, Math.min(shown.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    } else if (e.key === 'Escape') hover = null
  }
  const hp = $derived(hover !== null ? shown[hover] ?? null : null)
  const valueText = $derived.by(() => {
    const p = hp ?? shown[shown.length - 1]
    return p ? `${fmtDayLong(p.day)}: ${fmtRace(p.adj)} per km at the reference heart rate. ${p.detail}` : 'No runs'
  })
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0}
    <svg {width} {height} role="slider" aria-label="{label}. Arrow keys read each run; drag across the chart to zoom." aria-valuemin={0} aria-valuemax={Math.max(0, shown.length - 1)} aria-valuenow={hover ?? Math.max(0, shown.length - 1)} aria-valuetext={valueText} tabindex="0"
      onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => (drag = null)} onpointerleave={() => { if (!drag) hover = null }} onkeydown={onkey} onblur={() => (hover = null)}>
      {#each breakBands as b (b.from)}
        <rect class="brk" x={b.x0} y={PAD.top} width={Math.max(2, b.x1 - b.x0)} height={height - PAD.top - PAD.bottom} />
        {#if b.x1 - b.x0 > 46}<text class="brk-label" x={(b.x0 + b.x1) / 2} y={PAD.top + 12} text-anchor="middle">{Math.round(b.days / 7)} wk off</text>{/if}
      {/each}
      {#each y.ticks as t (t)}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y.scale(t)} y2={y.scale(t)} />
        <text class="tick" x={width - PAD.right + 6} y={y.scale(t)} dy="0.32em">{fmtRace(t)}</text>
      {/each}
      <text class="tick axis-note" x={PAD.left} y={PAD.top - 5}>↑ faster</text>
      {#each ticks as t (t.day)}
        <text class="tick" x={xOf(t.day)} y={height - 6} text-anchor="middle">{t.label}</text>
      {/each}
      {#each shown as p, i (p.day + i)}
        <circle cx={xOf(p.day)} cy={y.scale(p.adj)} r={hover === i ? 5.5 : 3.5} class="dot" class:on={hover === i} class:lone={p.inBreak} />
      {/each}
      <path d={line} fill="none" stroke="var(--viz-run)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
      {#if drag}
        <rect class="brush" x={Math.min(drag.x0, drag.x1)} y={PAD.top} width={Math.abs(drag.x1 - drag.x0)} height={height - PAD.top - PAD.bottom} />
      {/if}
    </svg>
    {#if hp && !drag}
      <div class="tip" style:left="{Math.min(Math.max(xOf(hp.day), 100), width - 100)}px" role="status">
        <span class="tip-day">{fmtDayLong(hp.day)}</span>
        <span><b>{fmtRace(hp.adj)} /km</b> at the reference HR</span>
        {#if hp.inBreak}<span class="muted">One-off run during a break — not part of the trend</span>{:else if isNum(hp.roll)}<span class="muted">4-week median {fmtRace(hp.roll)} /km</span>{/if}
        <span class="muted">{hp.detail}</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .viz { position: relative; width: 100%; touch-action: pan-y; user-select: none; }
  svg { display: block; overflow: visible; outline: none; border-radius: var(--radius-sm); cursor: crosshair; }
  svg:focus-visible { box-shadow: var(--focus-ring); }
  .grid { stroke: var(--viz-grid); stroke-width: 1; }
  .tick { fill: var(--viz-axis); font-size: 0.6875rem; font-variant-numeric: tabular-nums; }
  .axis-note { font-size: 0.625rem; }
  .brk { fill: var(--color-surface-sunken); }
  .brk-label { fill: var(--color-text-muted); font-size: 0.6875rem; font-weight: var(--weight-semibold); }
  .dot { fill: color-mix(in oklab, var(--viz-run) 40%, var(--color-surface)); stroke: var(--color-surface); stroke-width: 1.5; }
  .dot.on { fill: var(--viz-run); }
  .dot.lone { fill: var(--color-surface); stroke: color-mix(in oklab, var(--viz-run) 55%, var(--color-surface)); stroke-width: 1.5; }
  .brush { fill: color-mix(in oklab, var(--color-accent) 18%, transparent); stroke: var(--color-accent); stroke-width: 1; }
  .tip {
    position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3);
    flex-direction: column; gap: 2px; transform: translate(-50%, -6px); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-surface-raised); box-shadow: var(--shadow-raised);
    font-size: var(--text-xs); white-space: nowrap; pointer-events: none;
  }
  .tip-day, .muted { color: var(--color-text-muted); }
  .tip b { font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
</style>
