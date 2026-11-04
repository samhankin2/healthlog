<script lang="ts">
  /** Up to three series on ONE shared axis (same unit), crosshair + tooltip. Legend lives with the caller. */
  import { dayNum, isNum, type Point } from '../insights'
  import { dayTicks, fmtDayLong, linear, linePath, niceTicks } from './scale'

  interface Series { label: string; points: Point[]; color: string; dashed?: boolean; dots?: boolean }
  interface Props {
    label: string
    series: Series[]
    from: string
    to: string
    format?: (v: number) => string
    height?: number
    include?: number[]
    /** Optional shaded band of constant values (e.g. the 0.8–1.3 sweet spot). */
    zone?: { lo: number; hi: number; label: string }
    /** Exact tick spacing (e.g. 15 for pace in seconds). */
    tickStep?: number
  }
  let { label, series, from, to, format = (v: number) => `${Math.round(v)}`, height = 200, include = [], zone, tickStep }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)
  const PAD = { top: 12, right: 48, bottom: 26, left: 8 }

  const vals = $derived([...series.flatMap((s) => s.points.filter((p) => p.day >= from && p.day <= to).map((p) => p.value)), ...include, ...(zone ? [zone.lo, zone.hi] : [])].filter(isNum))
  const y = $derived.by(() => {
    const lo = Math.min(...vals)
    const hi = Math.max(...vals)
    const pad = (hi - lo) * 0.08 || 1
    if (tickStep) {
      let step = tickStep
      while ((hi - lo) / step > 5) step *= 2
      const d0 = Math.floor((lo - pad / 2) / step) * step
      const d1 = Math.ceil((hi + pad / 2) / step) * step
      const ticks: number[] = []
      for (let t = d0; t <= d1 + 1e-9; t += step) ticks.push(t)
      return { ticks, scale: linear([d0, d1], [height - PAD.bottom, PAD.top]) }
    }
    const { ticks, domain } = niceTicks(lo >= 0 ? Math.max(0, lo - pad) : lo - pad, hi + pad, height < 160 ? 3 : 4)
    return { ticks, scale: linear(domain, [height - PAD.bottom, PAD.top]) }
  })
  const x = $derived(linear([dayNum(from), Math.max(dayNum(to), dayNum(from) + 1)], [PAD.left, Math.max(PAD.left + 1, width - PAD.right)]))
  const xOf = (d: string): number => x(dayNum(d))
  const ticks = $derived(dayTicks(from, to, width < 420 ? 4 : 6))
  const days = $derived([...new Set(series.flatMap((s) => s.points.filter((p) => isNum(p.value) && p.day >= from && p.day <= to).map((p) => p.day)))].sort())
  const maps = $derived(series.map((s) => new Map(s.points.map((p) => [p.day, p.value]))))
  const hd = $derived(hover !== null ? days[hover] ?? null : null)

  function onmove(e: PointerEvent): void {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    let best = 0
    let dist = Infinity
    days.forEach((d, i) => { const dd = Math.abs(xOf(d) - px); if (dd < dist) { dist = dd; best = i } })
    hover = days.length ? best : null
  }
  function onkey(e: KeyboardEvent): void {
    if (!days.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = hover ?? days.length - 1
      hover = Math.max(0, Math.min(days.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    } else if (e.key === 'Escape') hover = null
  }
  const valueText = $derived.by(() => {
    const d = hd ?? days[days.length - 1]
    if (!d) return 'No data'
    return `${fmtDayLong(d)}: ${series.map((s, i) => { const v = maps[i].get(d); return isNum(v) ? `${s.label} ${format(v)}` : '' }).filter(Boolean).join(', ')}`
  })
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0}
    <svg {width} {height} role="slider" aria-label="{label}. Use the arrow keys to read values." aria-valuemin={0} aria-valuemax={Math.max(0, days.length - 1)} aria-valuenow={hover ?? Math.max(0, days.length - 1)} aria-valuetext={valueText} tabindex="0" onpointermove={onmove} onpointerleave={() => (hover = null)} onkeydown={onkey} onblur={() => (hover = null)}>
      {#if zone}
        <rect x={PAD.left} width={Math.max(0, width - PAD.right - PAD.left)} y={y.scale(zone.hi)} height={Math.max(0, y.scale(zone.lo) - y.scale(zone.hi))} fill="var(--viz-band)" />
        <text class="zone" x={PAD.left + 4} y={y.scale(zone.hi) + 12}>{zone.label}</text>
      {/if}
      {#each y.ticks as t (t)}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y.scale(t)} y2={y.scale(t)} />
        <text class="tick" x={width - PAD.right + 6} y={y.scale(t)} dy="0.32em">{format(t)}</text>
      {/each}
      {#each ticks as t (t.day)}
        <text class="tick" x={xOf(t.day)} y={height - 6} text-anchor="middle">{t.label}</text>
      {/each}
      {#each series as s (s.label)}
        {#if s.dots}
          {#each s.points.filter((p) => isNum(p.value) && p.day >= from && p.day <= to) as p (p.day)}
            <circle cx={xOf(p.day)} cy={y.scale(p.value as number)} r="3.5" fill={s.color} stroke="var(--color-surface)" stroke-width="1.5" />
          {/each}
        {:else}
          <path d={linePath(s.points.filter((p) => p.day >= from && p.day <= to).map((p) => ({ x: xOf(p.day), y: isNum(p.value) ? y.scale(p.value) : null })))} fill="none" stroke={s.color} stroke-width="2" stroke-dasharray={s.dashed ? '5 4' : undefined} stroke-linejoin="round" stroke-linecap="round" />
        {/if}
      {/each}
      {#if hd}
        <line class="cross" x1={xOf(hd)} x2={xOf(hd)} y1={PAD.top} y2={height - PAD.bottom} />
        {#each series as s, i (s.label)}
          {@const v = maps[i].get(hd)}
          {#if isNum(v)}<circle cx={xOf(hd)} cy={y.scale(v)} r="4.5" fill={s.color} stroke="var(--color-surface)" stroke-width="2" />{/if}
        {/each}
      {/if}
    </svg>
    {#if hd}
      <div class="tip" style:left="{Math.min(Math.max(xOf(hd), 80), width - 80)}px" role="status">
        <span class="tip-day">{fmtDayLong(hd)}</span>
        {#each series as s, i (s.label)}
          {@const v = maps[i].get(hd)}
          {#if isNum(v)}<span><i style:background={s.color}></i>{s.label} <b>{format(v)}</b></span>{/if}
        {/each}
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
  .zone { fill: var(--color-text-muted); font-size: 0.6875rem; }
  .cross { stroke: var(--color-border-strong); stroke-width: 1; }
  .tip {
    position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3);
    flex-direction: column; gap: 2px; transform: translate(-50%, -6px); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-surface-raised); box-shadow: var(--shadow-raised);
    font-size: var(--text-xs); white-space: nowrap; pointer-events: none;
  }
  .tip span { display: flex; align-items: center; gap: 6px; }
  .tip i { width: 8px; height: 8px; border-radius: 2px; }
  .tip b { margin-left: auto; padding-left: var(--space-3); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .tip-day { color: var(--color-text-muted); }
</style>
