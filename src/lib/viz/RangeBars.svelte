<script lang="ts">
  import { dayNum, isNum } from '../insights'
  import { dayTicks, fmtDayLong, linear, niceTicks } from './scale'

  interface Range { day: string; lo: number; hi: number; mark?: number | null }
  interface Props {
    label: string
    ranges: Range[]
    from: string
    to: string
    format?: (v: number) => string
    /** Tooltip wording. */
    loLabel?: string
    hiLabel?: string
    markLabel?: string
    /** Fixed y-domain, e.g. [0, 100]. Otherwise derived. */
    domain?: [number, number]
    /** Draw small values at the top (clock axes: earlier = higher). */
    invert?: boolean
    color?: string
    height?: number
    /** Tick in multiples of this (60 = whole hours when values are minutes). */
    unit?: number
  }

  let {
    label, ranges, from, to, format = (v: number) => `${Math.round(v)}`, loLabel = 'Low', hiLabel = 'High', markLabel = 'Mark',
    domain, invert = false, color = 'var(--viz-line)', height = 200, unit = 1,
  }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)
  const PAD = { top: 12, right: 48, bottom: 26, left: 8 }

  const y = $derived.by(() => {
    const vals = ranges.flatMap((r) => [r.lo, r.hi])
    let ticks: number[]
    let dom: [number, number]
    if (domain) {
      dom = domain
      ticks = niceTicks(domain[0], domain[1], 4).ticks.filter((t) => t >= domain[0] && t <= domain[1])
    } else {
      const nt = niceTicks(Math.min(...vals) / unit, Math.max(...vals) / unit, 4, unit > 1 ? 1 : 0)
      ticks = nt.ticks.map((t) => t * unit)
      dom = [nt.domain[0] * unit, nt.domain[1] * unit]
    }
    const range: [number, number] = invert ? [PAD.top, height - PAD.bottom] : [height - PAD.bottom, PAD.top]
    return { ticks, scale: linear(dom, range) }
  })
  const d0 = $derived(dayNum(from))
  const x = $derived(linear([d0, dayNum(to) + 1], [PAD.left, Math.max(PAD.left + 1, width - PAD.right)]))
  const slot = $derived(Math.max(1, x(d0 + 1) - x(d0)))
  const barW = $derived(Math.max(1.5, Math.min(10, slot * 0.7)))
  const ticks = $derived(dayTicks(from, to, width < 420 ? 4 : 6))
  const shown = $derived(ranges.filter((r) => r.day >= from && r.day <= to))

  function onmove(e: PointerEvent): void {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    let best: number | null = null
    let dist = Infinity
    shown.forEach((r, i) => {
      const dd = Math.abs(x(dayNum(r.day)) + slot / 2 - px)
      if (dd < dist) { dist = dd; best = i }
    })
    hover = dist < Math.max(slot * 2, 12) ? best : null
  }
  function onkey(e: KeyboardEvent): void {
    if (!shown.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = hover ?? shown.length - 1
      hover = Math.max(0, Math.min(shown.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    } else if (e.key === 'Escape') hover = null
  }
  const hr = $derived(hover !== null ? shown[hover] ?? null : null)
  const valueText = $derived.by(() => {
    const r = hr ?? shown[shown.length - 1]
    if (!r) return 'No data'
    return `${fmtDayLong(r.day)}: ${hiLabel} ${format(r.hi)}, ${loLabel} ${format(r.lo)}${isNum(r.mark) ? `, ${markLabel} ${format(r.mark)}` : ''}`
  })
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0}
    <svg {width} {height} role="slider" aria-label="{label}. Use the arrow keys to read each day." aria-valuemin={0} aria-valuemax={Math.max(0, shown.length - 1)} aria-valuenow={hover ?? Math.max(0, shown.length - 1)} aria-valuetext={valueText} tabindex="0" onpointermove={onmove} onpointerleave={() => (hover = null)} onkeydown={onkey} onblur={() => (hover = null)}>
      {#each y.ticks as t (t)}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y.scale(t)} y2={y.scale(t)} />
        <text class="tick" x={width - PAD.right + 6} y={y.scale(t)} dy="0.32em">{format(t)}</text>
      {/each}
      {#each ticks as t (t.day)}
        <text class="tick" x={x(dayNum(t.day))} y={height - 6} text-anchor="middle">{t.label}</text>
      {/each}
      {#each shown as r, i (r.day)}
        {@const bx = x(dayNum(r.day)) + (slot - barW) / 2}
        {@const top = Math.min(y.scale(r.lo), y.scale(r.hi))}
        {@const h = Math.max(2, Math.abs(y.scale(r.hi) - y.scale(r.lo)))}
        <rect x={bx} y={top} width={barW} height={h} rx={Math.min(barW / 2, 4)} fill={color} opacity={hover === null || hover === i ? 0.72 : 0.3} />
        {#if isNum(r.mark) && barW >= 4}
          <circle cx={bx + barW / 2} cy={y.scale(r.mark)} r={Math.min(4, barW / 2 + 1)} fill="var(--color-text)" stroke="var(--color-surface)" stroke-width="1.5" />
        {/if}
      {/each}
    </svg>
    {#if hr}
      <div class="tip" style:left="{Math.min(Math.max(x(dayNum(hr.day)) + slot / 2, 80), width - 80)}px" role="status">
        <span class="tip-day">{fmtDayLong(hr.day)}</span>
        <span>{hiLabel} <b>{format(hr.hi)}</b></span>
        <span>{loLabel} <b>{format(hr.lo)}</b></span>
        {#if isNum(hr.mark)}<span>{markLabel} <b>{format(hr.mark)}</b></span>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .viz { position: relative; width: 100%; touch-action: pan-y; }
  svg { display: block; overflow: visible; outline: none; border-radius: var(--radius-sm); }
  svg:focus-visible { box-shadow: var(--focus-ring); }
  .grid { stroke: var(--viz-grid); stroke-width: 1; }
  .tick { fill: var(--viz-axis); font-size: 0.6875rem; font-variant-numeric: tabular-nums; }
  .tip {
    position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3);
    flex-direction: column; gap: 1px; transform: translate(-50%, -6px); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-surface-raised); box-shadow: var(--shadow-raised);
    font-size: var(--text-xs); white-space: nowrap; pointer-events: none;
  }
  .tip-day { color: var(--color-text-muted); }
  .tip b { font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
</style>
