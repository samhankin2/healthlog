<script lang="ts">
  /** Diverging bars around zero: surplus up (warm), deficit down (cool). */
  import { dayNum } from '../insights'
  import { dayTicks, linear, niceTicks } from './scale'

  interface Bar { key: string; heading: string; value: number; detail?: string }
  interface Props {
    label: string
    bars: Bar[]
    from: string
    to: string
    keyDays?: number
    format?: (v: number) => string
    upLabel?: string
    downLabel?: string
    height?: number
    upColor?: string
    downColor?: string
  }
  let { label, bars, from, to, keyDays = 1, format = (v: number) => `${Math.round(v)}`, upLabel = 'Surplus', downLabel = 'Deficit', height = 200, upColor = 'var(--viz-surplus)', downColor = 'var(--viz-deficit)' }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)
  const PAD = { top: 12, right: 52, bottom: 26, left: 8 }

  const y = $derived.by(() => {
    const vals = bars.map((b) => b.value)
    const m = Math.max(100, ...vals.map(Math.abs))
    const { ticks, domain } = niceTicks(Math.min(0, ...vals, -m * 0.25), Math.max(0, ...vals, m * 0.25), 4)
    return { ticks, scale: linear(domain, [height - PAD.bottom, PAD.top]) }
  })
  const d0 = $derived(dayNum(from))
  const x = $derived(linear([d0, dayNum(to) + 1], [PAD.left, Math.max(PAD.left + 1, width - PAD.right)]))
  const slot = $derived(Math.max(1, x(d0 + keyDays) - x(d0)))
  const barW = $derived(Math.max(2, Math.min(keyDays > 1 ? 28 : 18, slot * 0.72)))
  const zero = $derived(y.scale(0))
  const ticks = $derived(dayTicks(from, to, width < 420 ? 4 : 6))

  function path(bx: number, v: number): string {
    const top = y.scale(Math.max(0, v))
    const bot = y.scale(Math.min(0, v))
    const h = bot - top
    if (h <= 0) return ''
    const r = Math.min(4, barW / 2, h)
    // Rounded at the data end only; square at the zero line.
    return v >= 0
      ? `M${bx},${bot}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + barW - r}Q${bx + barW},${top} ${bx + barW},${top + r}V${bot}Z`
      : `M${bx},${top}V${bot - r}Q${bx},${bot} ${bx + r},${bot}H${bx + barW - r}Q${bx + barW},${bot} ${bx + barW},${bot - r}V${top}Z`
  }
  function onmove(e: PointerEvent): void {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    let best: number | null = null
    let dist = Infinity
    bars.forEach((b, i) => {
      const dd = Math.abs(x(dayNum(b.key)) + slot / 2 - px)
      if (dd < dist) { dist = dd; best = i }
    })
    hover = dist < Math.max(slot, 14) ? best : null
  }
  function onkey(e: KeyboardEvent): void {
    if (!bars.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = hover ?? bars.length - 1
      hover = Math.max(0, Math.min(bars.length - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)))
    } else if (e.key === 'Escape') hover = null
  }
  const hb = $derived(hover !== null ? bars[hover] : null)
  const valueText = $derived.by(() => {
    const b = hb ?? bars[bars.length - 1]
    return b ? `${b.heading}: ${b.value >= 0 ? upLabel : downLabel} ${format(Math.abs(b.value))}` : 'No data'
  })
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0}
    <svg {width} {height} role="slider" aria-label="{label}. Use the arrow keys to read each bar." aria-valuemin={0} aria-valuemax={Math.max(0, bars.length - 1)} aria-valuenow={hover ?? Math.max(0, bars.length - 1)} aria-valuetext={valueText} tabindex="0" onpointermove={onmove} onpointerleave={() => (hover = null)} onkeydown={onkey} onblur={() => (hover = null)}>
      {#each y.ticks as t (t)}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y.scale(t)} y2={y.scale(t)} />
        <text class="tick" x={width - PAD.right + 6} y={y.scale(t)} dy="0.32em">{t > 0 ? '+' : ''}{format(t)}</text>
      {/each}
      {#each ticks as t (t.day)}
        <text class="tick" x={x(dayNum(t.day))} y={height - 6} text-anchor="middle">{t.label}</text>
      {/each}
      {#each bars as b, i (b.key)}
        <path d={path(x(dayNum(b.key)) + (slot - barW) / 2, b.value)} fill={b.value >= 0 ? upColor : downColor} opacity={hover === null || hover === i ? 1 : 0.4} />
      {/each}
      <line class="zero" x1={PAD.left} x2={width - PAD.right} y1={zero} y2={zero} />
    </svg>
    {#if hb}
      <div class="tip" style:left="{Math.min(Math.max(x(dayNum(hb.key)) + slot / 2, 80), width - 80)}px" role="status">
        <span class="tip-day">{hb.heading}</span>
        <span><i style:background={hb.value >= 0 ? upColor : downColor}></i>{hb.value >= 0 ? upLabel : downLabel} <b>{format(Math.abs(hb.value))}</b></span>
        {#if hb.detail}<span class="muted">{hb.detail}</span>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .viz { position: relative; width: 100%; touch-action: pan-y; }
  svg { display: block; overflow: visible; outline: none; border-radius: var(--radius-sm); }
  svg:focus-visible { box-shadow: var(--focus-ring); }
  .grid { stroke: var(--viz-grid); stroke-width: 1; }
  .zero { stroke: var(--color-border-strong); stroke-width: 1; }
  .tick { fill: var(--viz-axis); font-size: 0.6875rem; font-variant-numeric: tabular-nums; }
  .tip {
    position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3);
    flex-direction: column; gap: 2px; transform: translate(-50%, -6px); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-surface-raised); box-shadow: var(--shadow-raised);
    font-size: var(--text-xs); white-space: nowrap; pointer-events: none;
  }
  .tip span { display: flex; align-items: center; gap: 6px; }
  .tip i { width: 8px; height: 8px; border-radius: 2px; }
  .tip b { font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .tip-day, .muted { color: var(--color-text-muted); }
</style>
