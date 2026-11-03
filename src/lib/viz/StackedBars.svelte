<script lang="ts">
  import { dayNum } from '../insights'
  import { barPath, dayTicks, linear, niceTicks } from './scale'

  interface Bar { key: string; heading: string; values: number[] }
  interface Props {
    label: string
    /** One bar per key (a day or a Monday), oldest first. */
    bars: Bar[]
    series: { label: string; color: string }[]
    from: string
    to: string
    /** Width of one key in days (1 for daily bars, 7 for weekly). */
    keyDays?: number
    format?: (v: number) => string
    height?: number
    reference?: { value: number; label: string }
    /** Tick in multiples of this (e.g. 3600 for hours when values are seconds). */
    unit?: number
  }

  let { label, bars, series, from, to, keyDays = 1, format = (v: number) => `${Math.round(v)}`, height = 200, reference, unit = 1 }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)
  const PAD = { top: 12, right: 44, bottom: 26, left: 8 }

  const totals = $derived(bars.map((b) => b.values.reduce((a, v) => a + Math.max(0, v), 0)))
  const y = $derived.by(() => {
    const hi = Math.max(1, ...totals, reference?.value ?? 0)
    const nt = niceTicks(0, hi / unit, height < 160 ? 3 : 4, unit > 1 ? 1 : 0)
    return { ticks: nt.ticks.map((t) => t * unit), scale: linear([nt.domain[0] * unit, nt.domain[1] * unit], [height - PAD.bottom, PAD.top]) }
  })
  const d0 = $derived(dayNum(from))
  const d1 = $derived(dayNum(to) + 1)
  const x = $derived(linear([d0, d1], [PAD.left, Math.max(PAD.left + 1, width - PAD.right)]))
  const slot = $derived(Math.max(1, x(d0 + keyDays) - x(d0)))
  const barW = $derived(Math.max(1.5, Math.min(24, slot - Math.min(4, slot * 0.25))))
  const ticks = $derived(dayTicks(from, to, width < 420 ? 4 : 6))
  const base = $derived(y.scale.range[0])

  function segments(b: Bar): { y: number; h: number; color: string; top: boolean }[] {
    const out: { y: number; h: number; color: string; top: boolean }[] = []
    let acc = 0
    const lastIdx = b.values.reduce((li, v, i) => (v > 0 ? i : li), -1)
    b.values.forEach((v, i) => {
      if (v <= 0) return
      const yTop = y.scale(acc + v)
      const yBot = y.scale(acc)
      // 2px surface gap: every segment above the first gives up its bottom 2px.
      const gap = out.length ? 2 : 0
      acc += v
      out.push({ y: yTop, h: Math.max(0, yBot - yTop - gap), color: series[i]?.color ?? 'var(--viz-other)', top: i === lastIdx })
    })
    return out
  }

  function onmove(e: PointerEvent): void {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    let best: number | null = null
    let dist = Infinity
    bars.forEach((b, i) => {
      const cx = x(dayNum(b.key)) + slot / 2
      const dd = Math.abs(cx - px)
      if (dd < dist) { dist = dd; best = i }
    })
    hover = dist < Math.max(slot, 12) ? best : null
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
    const i = hover ?? bars.length - 1
    const b = bars[i]
    if (!b) return 'No data'
    return `${b.heading}: ${series.map((s, si) => (b.values[si] > 0 ? `${s.label} ${format(b.values[si])}` : '')).filter(Boolean).join(', ')}; total ${format(totals[i])}`
  })
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0}
    <svg {width} {height} role="slider" aria-label="{label}. Use the arrow keys to read each bar." aria-valuemin={0} aria-valuemax={Math.max(0, bars.length - 1)} aria-valuenow={hover ?? Math.max(0, bars.length - 1)} aria-valuetext={valueText} tabindex="0" onpointermove={onmove} onpointerleave={() => (hover = null)} onkeydown={onkey} onblur={() => (hover = null)}>
      {#each y.ticks as t (t)}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y.scale(t)} y2={y.scale(t)} />
        <text class="tick" x={width - PAD.right + 6} y={y.scale(t)} dy="0.32em">{format(t)}</text>
      {/each}
      {#each ticks as t (t.day)}
        <text class="tick" x={x(dayNum(t.day))} y={height - 6} text-anchor="middle">{t.label}</text>
      {/each}
      {#each bars as b, i (b.key)}
        {@const bx = x(dayNum(b.key)) + (slot - barW) / 2}
        <g opacity={hover === null || hover === i ? 1 : 0.45}>
          {#each segments(b) as s, si (si)}
            {#if s.top}
              <path d={barPath(bx, s.y, barW, s.h, Math.min(4, barW / 2))} fill={s.color} />
            {:else}
              <rect x={bx} y={s.y} width={barW} height={s.h} fill={s.color} />
            {/if}
          {/each}
        </g>
      {/each}
      {#if reference}
        <line class="ref" x1={PAD.left} x2={width - PAD.right} y1={y.scale(reference.value)} y2={y.scale(reference.value)} />
        <text class="ref-label" x={PAD.left + 4} y={y.scale(reference.value) - 5}>{reference.label}</text>
      {/if}
      <line class="axis" x1={PAD.left} x2={width - PAD.right} y1={base} y2={base} />
    </svg>
    {#if hb && hover !== null}
      <div class="tip" style:left="{Math.min(Math.max(x(dayNum(hb.key)) + slot / 2, 80), width - 80)}px" role="status">
        <span class="tip-day">{hb.heading}</span>
        {#each series as s, si (s.label)}
          {#if hb.values[si] > 0}
            <span class="tip-row"><i style:background={s.color}></i>{s.label} <b>{format(hb.values[si])}</b></span>
          {/if}
        {/each}
        <span class="tip-row total">Total <b>{format(totals[hover])}</b></span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .viz { position: relative; width: 100%; touch-action: pan-y; }
  svg { display: block; overflow: visible; outline: none; border-radius: var(--radius-sm); }
  svg:focus-visible { box-shadow: var(--focus-ring); }
  .grid { stroke: var(--viz-grid); stroke-width: 1; }
  .axis { stroke: var(--color-border); stroke-width: 1; }
  .ref { stroke: var(--color-text-muted); stroke-width: 1; }
  .ref-label { fill: var(--color-text-muted); font-size: 0.6875rem; }
  .tick { fill: var(--viz-axis); font-size: 0.6875rem; font-variant-numeric: tabular-nums; }
  .tip {
    position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3);
    flex-direction: column; gap: 2px; transform: translate(-50%, -6px); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-surface-raised); box-shadow: var(--shadow-raised);
    font-size: var(--text-xs); white-space: nowrap; pointer-events: none;
  }
  .tip-day { color: var(--color-text-muted); }
  .tip-row { display: flex; align-items: center; gap: 6px; }
  .tip-row b { margin-left: auto; padding-left: var(--space-3); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .tip-row i { width: 8px; height: 8px; border-radius: 2px; }
  .total { margin-top: 2px; padding-top: 3px; border-top: 1px solid var(--color-border); }
</style>
