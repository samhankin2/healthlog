<script lang="ts">
  /** Every run as pace (y, faster up) against average heart rate (x), with a fitted line per group. */
  import { fmtRace, isNum } from '../insights'
  import { fmtDayLong, linear } from './scale'

  interface Dot { hr: number; paceS: number; day: string; detail: string }
  interface Group { label: string; color: string; dots: Dot[]; line: ((hr: number) => number | null) | null }
  interface Props { label: string; groups: Group[]; refHr: number; height?: number }
  let { label, groups, refHr, height = 280 }: Props = $props()

  let width = $state(0)
  let hover = $state<{ g: number; i: number } | null>(null)
  const PAD = { top: 16, right: 56, bottom: 34, left: 8 }

  const all = $derived(groups.flatMap((g) => g.dots))
  const xr = $derived.by(() => {
    const hrs = all.map((d) => d.hr)
    const lo = Math.floor((Math.min(...hrs, refHr) - 4) / 5) * 5
    const hi = Math.ceil((Math.max(...hrs, refHr) + 4) / 5) * 5
    const ticks: number[] = []
    for (let t = lo; t <= hi; t += hi - lo > 40 ? 10 : 5) ticks.push(t)
    return { lo, hi, ticks, scale: linear([lo, hi], [PAD.left, Math.max(PAD.left + 1, width - PAD.right)]) }
  })
  const yr = $derived.by(() => {
    const ps = all.map((d) => d.paceS)
    const lo = Math.min(...ps)
    const hi = Math.max(...ps)
    let step = 15
    while ((hi - lo) / step > 5) step *= 2
    const d0 = Math.floor((lo - 4) / step) * step
    const d1 = Math.ceil((hi + 4) / step) * step
    const ticks: number[] = []
    for (let t = d0; t <= d1; t += step) ticks.push(t)
    return { d0, d1, ticks, scale: linear([d0, d1], [PAD.top, height - PAD.bottom]) }
  })
  /** A group's line only spans the heart rates it actually ran at (plus a little), never a long extrapolation. */
  function linePts(f: (hr: number) => number | null, dots: Dot[]): string {
    const pts: string[] = []
    if (!dots.length) return ''
    const a = Math.max(xr.lo, Math.min(...dots.map((d) => d.hr)) - 3)
    const b = Math.min(xr.hi, Math.max(...dots.map((d) => d.hr)) + 3)
    for (let hr = a; hr <= b; hr += 1) {
      const p = f(hr)
      if (!isNum(p) || p < yr.d0 || p > yr.d1) continue
      pts.push(`${pts.length ? 'L' : 'M'}${xr.scale(hr).toFixed(1)},${yr.scale(p).toFixed(1)}`)
    }
    return pts.join('')
  }
  function move(e: PointerEvent): void {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = e.clientX - r.left
    const py = e.clientY - r.top
    let best: { g: number; i: number } | null = null
    let dist = 18 * 18
    groups.forEach((g, gi) => g.dots.forEach((d, i) => {
      const dd = (xr.scale(d.hr) - px) ** 2 + (yr.scale(d.paceS) - py) ** 2
      if (dd < dist) { dist = dd; best = { g: gi, i } }
    }))
    hover = best
  }
  const hd = $derived(hover ? groups[hover.g]?.dots[hover.i] ?? null : null)
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0 && all.length}
    <svg {width} {height} role="img" aria-label="{label}: {all.length} runs. {groups.map((g) => { const p = g.line?.(refHr); return isNum(p) ? `${g.label}: ${fmtRace(p)} per km at ${refHr} bpm` : '' }).filter(Boolean).join('. ')}" onpointermove={move} onpointerleave={() => (hover = null)}>
      {#each yr.ticks as t (t)}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={yr.scale(t)} y2={yr.scale(t)} />
        <text class="tick" x={width - PAD.right + 6} y={yr.scale(t)} dy="0.32em">{fmtRace(t)}</text>
      {/each}
      {#each xr.ticks as t (t)}
        <line class="grid v" x1={xr.scale(t)} x2={xr.scale(t)} y1={PAD.top} y2={height - PAD.bottom} />
        <text class="tick" x={xr.scale(t)} y={height - PAD.bottom + 14} text-anchor="middle">{t}</text>
      {/each}
      <text class="tick axis" x={(PAD.left + width - PAD.right) / 2} y={height - 4} text-anchor="middle">average heart rate (bpm)</text>
      <text class="tick axis" x={PAD.left} y={PAD.top - 5}>↑ faster</text>
      <line class="ref" x1={xr.scale(refHr)} x2={xr.scale(refHr)} y1={PAD.top} y2={height - PAD.bottom} />
      {#each groups as g, gi (g.label)}
        {#each g.dots as d, i (d.day + i)}
          <circle cx={xr.scale(d.hr)} cy={yr.scale(d.paceS)} r={hover?.g === gi && hover?.i === i ? 6 : 4} fill={g.color} opacity={hover && hover.g !== gi ? 0.35 : 0.85} stroke="var(--color-surface)" stroke-width="1.5" />
        {/each}
      {/each}
      {#each groups as g (g.label)}
        {#if g.line}<path d={linePts(g.line, g.dots)} fill="none" stroke={g.color} stroke-width="2.5" stroke-linecap="round" />{/if}
      {/each}
      {#each groups as g (g.label)}
        {@const p = g.line?.(refHr)}
        {#if isNum(p) && p >= yr.d0 && p <= yr.d1}
          <circle cx={xr.scale(refHr)} cy={yr.scale(p)} r="5.5" fill={g.color} stroke="var(--color-surface)" stroke-width="2" />
        {/if}
      {/each}
    </svg>
    {#if hd}
      <div class="tip" style:left="{Math.min(Math.max(xr.scale(hd.hr), 100), width - 100)}px" role="status">
        <span class="tip-day">{fmtDayLong(hd.day)}</span>
        <span><b>{fmtRace(hd.paceS)} /km</b> at {Math.round(hd.hr)} bpm</span>
        <span class="muted">{hd.detail}</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .viz { position: relative; width: 100%; }
  svg { display: block; overflow: visible; }
  .grid { stroke: var(--viz-grid); stroke-width: 1; }
  .grid.v { opacity: 0.6; }
  .ref { stroke: var(--color-text-muted); stroke-width: 1; }
  .tick { fill: var(--viz-axis); font-size: 0.6875rem; font-variant-numeric: tabular-nums; }
  .axis { font-size: 0.625rem; }
  .tip {
    position: absolute; top: 0; z-index: 2; display: flex; padding: var(--space-2) var(--space-3);
    flex-direction: column; gap: 2px; transform: translate(-50%, -6px); border: 1px solid var(--color-border);
    border-radius: var(--radius-sm); background: var(--color-surface-raised); box-shadow: var(--shadow-raised);
    font-size: var(--text-xs); white-space: nowrap; pointer-events: none;
  }
  .tip-day, .muted { color: var(--color-text-muted); }
  .tip b { font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
</style>
