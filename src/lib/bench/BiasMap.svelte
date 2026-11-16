<script lang="ts">
  import type { BenchModel } from '../types'
  import { linear, niceTicks } from '../viz/scale'
  import { ROLE_COLOR, ROLE_LABEL, fmtPct, fmtSignedPct, modelLabel, statsFor, type Yardstick } from './bench'

  interface Props { models: BenchModel[]; yardstick: Yardstick }
  let { models, yardstick }: Props = $props()

  let width = $state(0)
  let hover = $state<number | null>(null)
  const height = 260
  const PAD = { top: 16, right: 16, bottom: 34, left: 40 }

  const pts = $derived(
    models
      .map((m) => ({ m, s: statsFor(m, yardstick) }))
      .filter((p) => p.s.n > 0 && p.s.biasPct != null && p.s.medianAbsPct != null)
      // Grey panel first so the coloured marks sit on top.
      .sort((p, q) => (p.m.role === 'bench' || p.m.role === 'other' ? 0 : 1) - (q.m.role === 'bench' || q.m.role === 'other' ? 0 : 1)),
  )
  const xr = $derived(Math.max(10, ...pts.map((p) => Math.abs(p.s.biasPct as number))) * 1.15)
  const xt = $derived(niceTicks(-xr, xr, 4))
  const yt = $derived(niceTicks(0, Math.max(10, ...pts.map((p) => p.s.medianAbsPct as number)) * 1.1, 4))
  const x = $derived(linear([-Math.max(...xt.domain.map(Math.abs)), Math.max(...xt.domain.map(Math.abs))], [PAD.left, Math.max(PAD.left + 1, width - PAD.right)]))
  const y = $derived(linear([0, yt.domain[1]], [height - PAD.bottom, PAD.top]))
  const xTicks = $derived(xt.ticks.filter((t) => t >= x.domain[0] && t <= x.domain[1]))

  const labelled = (role: string): boolean => role === 'logged' || role === 'a' || role === 'b'

  function onmove(e: PointerEvent): void {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    let best: number | null = null
    let dist = Infinity
    pts.forEach((p, i) => {
      const d = Math.hypot(x(p.s.biasPct as number) - px, y(p.s.medianAbsPct as number) - py)
      if (d < dist) { dist = d; best = i }
    })
    hover = dist < 28 ? best : null
  }
  function onkey(e: KeyboardEvent): void {
    if (!pts.length) return
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const cur = hover ?? -1
      hover = (cur + (e.key === 'ArrowRight' ? 1 : -1) + pts.length) % pts.length
    } else if (e.key === 'Escape') hover = null
  }
  const hp = $derived(hover !== null ? pts[hover] ?? null : null)
  const valueText = $derived(hp ? `${modelLabel(hp.m.model)}: reads ${fmtSignedPct(hp.s.biasPct)}, typical miss ${fmtPct(hp.s.medianAbsPct, 1)}` : 'Use the arrow keys to read each model')
</script>

<div class="viz" bind:clientWidth={width} style:height="{height}px">
  {#if width > 0}
    <svg {width} {height} role="slider" tabindex="0" aria-label="Bias against typical miss, one dot per model" aria-valuemin={0} aria-valuemax={Math.max(0, pts.length - 1)} aria-valuenow={hover ?? 0} aria-valuetext={valueText} onpointermove={onmove} onpointerleave={() => (hover = null)} onkeydown={onkey} onblur={() => (hover = null)}>
      <!-- the sweet spot: centred and low -->
      <rect class="sweet" x={x(-5)} y={y(Math.min(8, y.domain[1]))} width={Math.max(0, x(5) - x(-5))} height={Math.max(0, y(0) - y(Math.min(8, y.domain[1])))} rx="6" />
      {#each yt.ticks.filter((t) => t <= y.domain[1]) as t (t)}
        <line class="grid" x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
        {#if t > 0}<text class="tick" x={PAD.left - 6} y={y(t)} dy="0.32em" text-anchor="end">{t}%</text>{/if}
      {/each}
      {#each xTicks as t (t)}
        <text class="tick" x={x(t)} y={height - PAD.bottom + 14} text-anchor="middle">{t > 0 ? '+' : ''}{t}%</text>
      {/each}
      <line class="zero" x1={x(0)} x2={x(0)} y1={PAD.top} y2={height - PAD.bottom} />
      <text class="hint" x={PAD.left} y={height - 4}>← reads low</text>
      <text class="hint" x={width - PAD.right} y={height - 4} text-anchor="end">reads high →</text>
      {#each pts as p, i (p.m.model)}
        {@const cx = x(p.s.biasPct as number)}
        {@const cy = y(p.s.medianAbsPct as number)}
        {#if p.m.role === 'logged'}
          <rect x={cx - 6} y={cy - 6} width="12" height="12" transform="rotate(45 {cx} {cy})" fill={ROLE_COLOR.logged} stroke="var(--color-surface)" stroke-width="2" opacity={hover === null || hover === i ? 1 : 0.4} />
        {:else}
          <circle {cx} {cy} r={labelled(p.m.role) ? 7 : 5} fill={ROLE_COLOR[p.m.role]} stroke="var(--color-surface)" stroke-width="2" opacity={hover === null || hover === i ? 1 : 0.4} />
        {/if}
        {#if labelled(p.m.role) || hover === i}
          <text class="label" x={cx + 10} y={cy} dy="0.32em" text-anchor={cx > width - 110 ? 'end' : 'start'} dx={cx > width - 110 ? -20 : 0}>{p.m.role === 'logged' ? 'Logged' : modelLabel(p.m.model)}</text>
        {/if}
      {/each}
    </svg>
    {#if hp}
      <div class="tip" role="status" style:left="{Math.min(Math.max(x(hp.s.biasPct as number), 90), width - 90)}px" style:top="{Math.max(0, y(hp.s.medianAbsPct as number) - 86)}px">
        <span class="tip-day">{modelLabel(hp.m.model)} · {ROLE_LABEL[hp.m.role]}</span>
        <span>Typical miss <b>{fmtPct(hp.s.medianAbsPct, 1)}</b></span>
        <span>Reads <b>{fmtSignedPct(hp.s.biasPct, 1)}</b> on average</span>
        <span>{hp.s.n} meals · {fmtPct(hp.s.within10)} within 10%</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .viz { position: relative; width: 100%; touch-action: pan-y; }
  svg { display: block; overflow: visible; outline: none; border-radius: var(--radius-sm); }
  svg:focus-visible { box-shadow: var(--focus-ring); }
  .grid { stroke: var(--viz-grid); stroke-width: 1; }
  .zero { stroke: var(--viz-axis); stroke-width: 1; opacity: 0.6; }
  .sweet { fill: var(--viz-wash); }
  .tick { fill: var(--viz-axis); font-size: 11px; font-variant-numeric: tabular-nums; }
  .hint { fill: var(--color-text-subtle); font-size: 11px; }
  .label { fill: var(--color-text); font-size: 12px; font-weight: 600; paint-order: stroke; stroke: var(--color-surface); stroke-width: 3px; }
  .tip { position: absolute; z-index: 2; display: flex; padding: var(--space-2) var(--space-3); transform: translateX(-50%); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface-raised, var(--color-surface)); box-shadow: var(--shadow-card); color: var(--color-text-muted); font-size: var(--text-xs); pointer-events: none; white-space: nowrap; }
  .tip b { color: var(--color-text); }
  .tip-day { color: var(--color-text); font-weight: var(--weight-semibold); }
</style>
