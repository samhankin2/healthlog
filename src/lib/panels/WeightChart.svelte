<script lang="ts">
  import { onMount } from 'svelte'
  import { createWeightChart, type WeightChartHandle } from '../charts/weightChart'
  import { buildWeightSeries, defaultChartEndDate } from '../charts/weightSeries'
  import type { Phase, WeightEntry } from '../types'

  interface Props {
    entries: WeightEntry[]
    phases: Phase[]
    windowDays: number
  }

  let { entries, phases, windowDays }: Props = $props()
  let canvas: HTMLCanvasElement | undefined = $state()
  let handle: WeightChartHandle | null = $state(null)
  let series = $derived(buildWeightSeries(entries, defaultChartEndDate(), windowDays))

  onMount(() => {
    if (!canvas) return
    handle = createWeightChart(canvas, {
      series: series.map((point) => ({ ...point })),
      phases: phases.map((phase) => ({ ...phase })),
      entries: entries.map((entry) => ({ ...entry })),
      windowDays,
    })
    return () => {
      handle?.destroy()
      handle = null
    }
  })

  $effect(() => {
    const nextSeries = series.map((point) => ({ ...point }))
    const nextPhases = phases.map((phase) => ({ ...phase }))
    handle?.update(nextSeries, nextPhases)
  })
</script>

<div class="weight-chart-frame">
  <canvas bind:this={canvas} aria-label="Weight trend chart"></canvas>
</div>

<style>
  .weight-chart-frame {
    position: relative;
    width: 100%;
    min-width: 0;
    height: 17.5rem;
  }
  canvas {
    display: block;
    min-width: 0;
    max-width: 100%;
  }
  @media (min-width: 56.25rem) {
    .weight-chart-frame { height: 20rem; }
  }
</style>
