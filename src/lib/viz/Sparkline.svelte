<script lang="ts">
  import { isNum, type Point } from '../insights'
  import { linePath } from './scale'

  interface Props { points: Point[]; width?: number; height?: number; color?: string }
  let { points, width = 120, height = 32, color = 'var(--viz-line)' }: Props = $props()

  const vals = $derived(points.map((p) => p.value).filter(isNum))
  const lo = $derived(Math.min(...vals))
  const hi = $derived(Math.max(...vals))
  const yOf = (v: number): number => (hi === lo ? height / 2 : height - 3 - ((v - lo) / (hi - lo)) * (height - 6))
  const xOf = (i: number): number => (points.length < 2 ? width / 2 : 2 + (i / (points.length - 1)) * (width - 6))
  const d = $derived(linePath(points.map((p, i) => ({ x: xOf(i), y: isNum(p.value) ? yOf(p.value) : null }))))
  const lastIdx = $derived(points.map((p) => isNum(p.value)).lastIndexOf(true))
</script>

{#if vals.length >= 2}
  <svg {width} {height} aria-hidden="true">
    <path {d} fill="none" stroke="var(--color-border-strong)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.7" />
    {#if lastIdx >= 0}
      <circle cx={xOf(lastIdx)} cy={yOf(points[lastIdx].value as number)} r="3.5" fill={color} stroke="var(--color-surface)" stroke-width="1.5" />
    {/if}
  </svg>
{/if}

<style>
  svg { display: block; overflow: visible; }
</style>
