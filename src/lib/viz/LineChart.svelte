<script lang="ts">
  import { dayNum, isNum, type Point } from '../insights'
  import { dayTicks, fmtDayLong, linear, linePath, niceTicks } from './scale'

  interface Props {
    /** Accessible name: what is plotted. */
    label: string
    from: string
    to: string
    /** The main line (usually a rolling mean). */
    line: Point[]
    /** Optional raw daily values, drawn as faint dots. */
    raw?: Point[]
    /** Optional shaded band (e.g. 30-day norm ± 1 SD). */
    band?: { day: string; lo: number; hi: number }[]
    bandLabel?: string
    lineLabel?: string
    rawLabel?: string
    format?: (v: number) => string
    height?: number
    /** Force the y-domain to include these values (e.g. 0). */
    include?: number[]
    /** Step the line (for values that change in jumps, like VO₂ max). */
    step?: boolean
    color?: string
    /** Draw the newest value as a labelled end-dot. */
    endLabel?: boolean
    /** Smallest tick step (1 for whole-number metrics). */
    minStep?: number
  }

  let {
    label, from, to, line, raw = [], band = [], bandLabel = 'Your normal range', lineLabel = '7-day average', rawLabel = 'Day',
    format = (v: number) => `${Math.round(v)}`, height = 200, include = [], step = false, color = 'var(--viz-line)', endLabel = true, minStep = 0,
  }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)

  const PAD = { top: 14, right: 44, bottom: 26, left: 8 }
  const d0 = $derived(dayNum(from))
  const d1 = $derived(Math.max(dayNum(to), dayNum(from) + 1))
  const values = $derived([
    ...line.map((p) => p.value),
    ...raw.map((p) => p.value),
    ...band.flatMap((b) => [b.lo, b.hi]),
    ...include,
  ].filter(isNum))
  const y = $derived.by(() => {
    const lo = Math.min(...values)
    const hi = Math.max(...values)
    const pad = (hi - lo) * 0.08 || 1
    // Never invent negative space for a metric that cannot go below zero.
    const floor = lo >= 0 ? 0 : -Infinity
    const { ticks, domain } = niceTicks(Math.max(floor, lo - pad), hi + pad, height < 160 ? 3 : 4, minStep)
    return { ticks, scale: linear(domain, [height - PAD.bottom, PAD.top]) }
  })
  const x = $derived(linear([d0, d1], [PAD.left, Math.max(PAD.left + 1, width - PAD.right)]))
  const xOf = (day: string): number => x(dayNum(day))

  const linePts = $derived.by(() => {
    const pts = line.filter((p) => p.day >= from && p.day <= to)
    if (!step) return pts.map((p) => ({ x: xOf(p.day), y: isNum(p.value) ? y.scale(p.value) : null }))
    const out: { x: number; y: number | null }[] = []
    const known = pts.filter((p) => isNum(p.value))
    known.forEach((p, i) => {
      const yy = y.scale(p.value as number)
      if (i > 0) out.push({ x: xOf(p.day), y: out[out.length - 1].y })
      out.push({ x: xOf(p.day), y: yy })
    })
    if (known.length) out.push({ x: xOf(to), y: out[out.length - 1].y })
    return out
  })
  const path = $derived(linePath(linePts))
  const areaPath = $derived.by(() => {
    const pts = linePts.filter((p) => p.y !== null)
    if (pts.length < 2) return ''
    const base = y.scale.range[0]
    return `${linePath(linePts)}L${pts[pts.length - 1].x.toFixed(1)},${base}L${pts[0].x.toFixed(1)},${base}Z`
  })
  const bandPath = $derived.by(() => {
    const b = band.filter((p) => p.day >= from && p.day <= to)
    if (b.length < 2) return ''
    const top = b.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.day).toFixed(1)},${y.scale(p.hi).toFixed(1)}`).join('')
    const bottom = [...b].reverse().map((p) => `L${xOf(p.day).toFixed(1)},${y.scale(p.lo).toFixed(1)}`).join('')
    return `${top}${bottom}Z`
  })
  const dots = $derived(raw.filter((p) => isNum(p.value) && p.day >= from && p.day <= to))
  const ticks = $derived(dayTicks(from, to, width < 420 ? 4 : 6))

  /** Every day with any value, for hover + keyboard. */
  const hoverDays = $derived.by(() => {
    const set = new Set<string>()
    for (const p of line) if (isNum(p.value) && p.day >= from && p.day <= to) set.add(p.day)
    for (const p of raw) if (isNum(p.value) && p.day >= from && p.day <= to) set.add(p.day)
    return [...set].sort()
  })
  const lineMap = $derived(new Map(line.map((p) => [p.day, p.value])))
  const rawMap = $derived(new Map(raw.map((p) => [p.day, p.value])))
  const bandMap = $derived(new Map(band.map((b) => [b.day, b])))
  const last = $derived([...line].reverse().find((p) => isNum(p.value) && p.day <= to) ?? null)
  const hoverDay = $derived(hover !== null ? hoverDays[hover] ?? null : null)

  function nearest(px: number): number | null {
    if (!hoverDays.length) return null
    let best = 0
    let dist = Infinity
    hoverDays.forEach((d, i) => {
      const dd = Math.abs(xOf(d) - px)
      if (dd < dist) { dist = dd; best = i }
    })
    return best
  }
  function onmove(e: PointerEvent): void {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
    hover = nearest(e.clientX - rect.left)
  }
  function onkey(e: KeyboardEvent): void {
    if (!hoverDays.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = hover ?? hoverDays.length - 1
      hover = Math.max(0, Math.min(hoverDays.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    } else if (e.key === 'Home') { e.preventDefault(); hover = 0 }
    else if (e.key === 'End') { e.preventDefault(); hover = hoverDays.length - 1 }
    else if (e.key === 'Escape') hover = null
  }
  const valueText = $derived.by(() => {
    const d = hoverDay ?? hoverDays[hoverDays.length - 1]
    if (!d) return 'No data'
    const lv = lineMap.get(d)
    const rv = rawMap.get(d)
    return `${fmtDayLong(d)}: ${[isNum(rv) && raw.length ? `${format(rv)} ${rawLabel.toLowerCase()}` : '', isNum(lv) ? `${format(lv)} ${lineLabel.toLowerCase()}` : ''].filter(Boolean).join(', ')}`
  })
  const summary = $derived(last && isNum(last.value) ? `${label}. Latest ${lineLabel.toLowerCase()} ${format(last.value)}. Use the arrow keys to read values.` : `${label}. No data in this range.`)
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0}
    <svg
      {width}
      {height}
      role="slider"
      aria-label={summary}
      aria-valuemin={0}
      aria-valuemax={Math.max(0, hoverDays.length - 1)}
      aria-valuenow={hover ?? Math.max(0, hoverDays.length - 1)}
      aria-valuetext={valueText}
      tabindex="0"
      onpointermove={onmove}
      onpointerleave={() => (hover = null)}
      onkeydown={onkey}
      onblur={() => (hover = null)}
    >
      {#each y.ticks as t (t)}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y.scale(t)} y2={y.scale(t)} />
        <text class="tick" x={width - PAD.right + 6} y={y.scale(t)} dy="0.32em">{format(t)}</text>
      {/each}
      {#each ticks as t (t.day)}
        <text class="tick" x={xOf(t.day)} y={height - 6} text-anchor="middle">{t.label}</text>
      {/each}
      {#if bandPath}<path class="band" d={bandPath} />{/if}
      {#if areaPath && !band.length}<path d={areaPath} fill={color} opacity="0.08" />{/if}
      {#each dots as p (p.day)}
        <circle class="dot" cx={xOf(p.day)} cy={y.scale(p.value as number)} r="2" fill={color} />
      {/each}
      <path d={path} fill="none" stroke={color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      {#if endLabel && last && isNum(last.value) && hoverDay === null}
        <circle cx={xOf(last.day)} cy={y.scale(last.value)} r="4.5" fill={color} stroke="var(--color-surface)" stroke-width="2" />
      {/if}
      {#if hoverDay}
        {@const hv = lineMap.get(hoverDay) ?? rawMap.get(hoverDay) ?? null}
        <line class="cross" x1={xOf(hoverDay)} x2={xOf(hoverDay)} y1={PAD.top} y2={height - PAD.bottom} />
        {#if isNum(hv)}
          <circle cx={xOf(hoverDay)} cy={y.scale(hv)} r="5" fill={color} stroke="var(--color-surface)" stroke-width="2" />
        {/if}
      {/if}
    </svg>
    {#if hoverDay}
      {@const lv = lineMap.get(hoverDay)}
      {@const rv = rawMap.get(hoverDay)}
      {@const bv = bandMap.get(hoverDay)}
      <div class="tip" style:left="{Math.min(Math.max(xOf(hoverDay), 70), width - 70)}px" role="status">
        <span class="tip-day">{fmtDayLong(hoverDay)}</span>
        {#if isNum(rv) && raw.length}<span class="tip-row"><b>{format(rv)}</b> {rawLabel.toLowerCase()}</span>{/if}
        {#if isNum(lv)}<span class="tip-row"><b>{format(lv)}</b> {lineLabel.toLowerCase()}</span>{/if}
        {#if bv}<span class="tip-row muted">{bandLabel} {format(bv.lo)}–{format(bv.hi)}</span>{/if}
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
  .band { fill: var(--viz-band); }
  .dot { opacity: 0.28; }
  .cross { stroke: var(--color-border-strong); stroke-width: 1; }
  .tip {
    position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3);
    flex-direction: column; gap: 1px; transform: translate(-50%, -6px); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-surface-raised); box-shadow: var(--shadow-raised);
    font-size: var(--text-xs); white-space: nowrap; pointer-events: none;
  }
  .tip-day { color: var(--color-text-muted); }
  .tip-row b { font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .muted { color: var(--color-text-muted); }
</style>
