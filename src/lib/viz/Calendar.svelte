<script lang="ts">
  import { dayNum, numDay, weekday, weekStart } from '../insights'
  import { fmtDayLong } from './scale'

  interface Props {
    label: string
    /** Value per day (e.g. training minutes). */
    values: { day: string; value: number; detail?: string }[]
    from: string
    to: string
    format?: (v: number) => string
  }

  let { label, values, from, to, format = (v: number) => `${Math.round(v)}` }: Props = $props()

  let width = $state(0)
  let hover = $state<string | null>(null)
  const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

  const map = $derived(new Map(values.map((v) => [v.day, v])))
  const start = $derived(weekStart(from))
  const weeks = $derived(Math.floor((dayNum(to) - dayNum(start)) / 7) + 1)
  const GAP = 3
  const cell = $derived(Math.max(6, Math.min(22, Math.floor((width - 28) / weeks) - GAP)))
  const step = $derived(cell + GAP)
  const max = $derived(Math.max(1, ...values.map((v) => v.value)))
  /** 5 sequential steps of the accent, light -> dark; 0 is the empty track. */
  function level(v: number): number {
    if (v <= 0) return 0
    return Math.min(4, 1 + Math.floor((v / max) * 3.999))
  }
  const months = $derived.by(() => {
    const out: { x: number; label: string }[] = []
    let prev = -1
    for (let w = 0; w < weeks; w++) {
      const d = numDay(dayNum(start) + w * 7)
      const m = +d.slice(5, 7) - 1
      if (m !== prev) {
        if (!out.length || w * step - out[out.length - 1].x > 30) out.push({ x: w * step, label: MONTH[m] })
        prev = m
      }
    }
    return out
  })
  const cells = $derived.by(() => {
    const out: { day: string; x: number; y: number; lv: number }[] = []
    for (let n = dayNum(start); n <= dayNum(to); n++) {
      const d = numDay(n)
      if (d < from) continue
      const w = Math.floor((n - dayNum(start)) / 7)
      out.push({ day: d, x: w * step, y: weekday(d) * step, lv: level(map.get(d)?.value ?? 0) })
    }
    return out
  })
  const svgW = $derived(weeks * step + 26)
  const svgH = $derived(7 * step + 18)
  const active = $derived(values.filter((v) => v.value > 0 && v.day >= from && v.day <= to).length)
  const hv = $derived(hover ? map.get(hover) ?? null : null)
</script>

<div class="cal" bind:clientWidth={width}>
  {#if width > 0}
    <svg width={Math.min(width, svgW)} height={svgH} viewBox="0 0 {svgW} {svgH}" role="img" aria-label="{label}: {active} active days between {fmtDayLong(from)} and {fmtDayLong(to)}.">
      <g transform="translate(26 16)">
        {#each months as m (m.x)}
          <text class="lbl" x={m.x} y="-5">{m.label}</text>
        {/each}
        {#each ['Mon', 'Wed', 'Fri'] as d, i (d)}
          <text class="lbl" x="-5" y={(i * 2) * step + cell / 2} dy="0.32em" text-anchor="end">{d[0]}</text>
        {/each}
        {#each cells as c (c.day)}
          <rect
            x={c.x}
            y={c.y}
            width={cell}
            height={cell}
            rx="2.5"
            class="c l{c.lv}"
            class:on={hover === c.day}
            role="presentation"
            onpointerenter={() => (hover = c.day)}
            onpointerleave={() => (hover = null)}
          />
        {/each}
      </g>
    </svg>
    <div class="foot">
      <span class="status" role="status">
        {#if hover}
          <b>{fmtDayLong(hover)}</b> · {hv ? `${format(hv.value)}${hv.detail ? ` · ${hv.detail}` : ''}` : 'Rest day'}
        {:else}
          {active} active days
        {/if}
      </span>
      <span class="legend" aria-hidden="true">Less {#each [0, 1, 2, 3, 4] as l (l)}<i class="l{l}"></i>{/each} More</span>
    </div>
  {/if}
</div>

<style>
  .cal { width: 100%; overflow-x: auto; }
  svg { display: block; }
  .lbl { fill: var(--viz-axis); font-size: 10px; }
  .c { stroke: transparent; stroke-width: 1.5; }
  .c.on { stroke: var(--color-text); }
  .l0 { fill: var(--color-surface-sunken); background: var(--color-surface-sunken); }
  .l1 { fill: color-mix(in oklab, var(--color-accent) 28%, var(--color-surface)); background: color-mix(in oklab, var(--color-accent) 28%, var(--color-surface)); }
  .l2 { fill: color-mix(in oklab, var(--color-accent) 52%, var(--color-surface)); background: color-mix(in oklab, var(--color-accent) 52%, var(--color-surface)); }
  .l3 { fill: color-mix(in oklab, var(--color-accent) 76%, var(--color-surface)); background: color-mix(in oklab, var(--color-accent) 76%, var(--color-surface)); }
  .l4 { fill: var(--color-accent); background: var(--color-accent); }
  .foot { display: flex; margin-top: var(--space-2); align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; color: var(--color-text-muted); font-size: var(--text-xs); }
  .status b { color: var(--color-text); font-weight: var(--weight-semibold); }
  .legend { display: inline-flex; align-items: center; gap: 3px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
</style>
