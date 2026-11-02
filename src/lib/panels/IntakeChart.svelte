<script lang="ts">
  import { onMount } from 'svelte'
  import { BarController, BarElement, CategoryScale, Chart, LinearScale, Tooltip } from 'chart.js'
  import { fmtKcal, fmtNumber, fmtShort } from '../format'
  import type { IntakeHistoryDay } from '../types'

  Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip)

  interface Props { days: IntakeHistoryDay[]; target: number | null }
  let { days, target }: Props = $props()
  let canvas: HTMLCanvasElement | undefined = $state()
  let chart: Chart<'bar', number[], string> | null = $state(null)
  let lastSeven = $derived(days.slice(-7).map((day) => ({ ...day })))

  function colors(): { accent: string; grid: string; muted: string; font: string } {
    const style = getComputedStyle(document.documentElement)
    const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
    return {
      accent: read('--color-accent', '#146c5a'),
      grid: read('--color-border', '#d5ddd7'),
      muted: read('--color-text-muted', '#55635c'),
      font: read('--font-sans', 'system-ui, sans-serif'),
    }
  }

  onMount(() => {
    if (!canvas) return
    canvas.setAttribute('role', 'img')
    const theme = colors()
    chart = new Chart<'bar', number[], string>(canvas, {
      type: 'bar',
      data: {
        labels: lastSeven.map((day) => day.day),
        datasets: [{
          label: 'Calories',
          data: lastSeven.map((day) => day.kcal),
          backgroundColor: theme.accent,
          borderRadius: 6,
          borderSkipped: false,
          maxBarThickness: 42,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 240 },
        plugins: {
          tooltip: {
            displayColors: false,
            callbacks: {
              title(items) {
                const day = lastSeven[items[0]?.dataIndex ?? -1]
                return day ? fmtShort(day.day) : ''
              },
              label(item) {
                const day = lastSeven[item.dataIndex]
                if (!day) return ''
                return [
                  fmtKcal(day.kcal),
                  `Protein ${fmtNumber(day.proteinG)} g · Carbs ${fmtNumber(day.carbsG)} g · Fat ${fmtNumber(day.fatG)} g`,
                ]
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: theme.muted,
              font: { family: theme.font, size: 11 },
              maxRotation: 0,
              callback(value) {
                const day = lastSeven[typeof value === 'number' ? value : Number(value)]
                return day ? fmtShort(day.day).replace(' ', '\n') : ''
              },
            },
          },
          y: {
            beginAtZero: true,
            grace: '12%',
            grid: { color: theme.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: theme.muted,
              font: { family: theme.font, size: 11 },
              maxTicksLimit: 4,
              padding: 6,
              callback(value) { return fmtNumber(Number(value), 0) },
            },
          },
        },
      },
    })
    return () => {
      chart?.destroy()
      chart = null
    }
  })

  $effect(() => {
    if (!chart) return
    const snapshot = lastSeven.map((day) => ({ ...day }))
    chart.data.labels = snapshot.map((day) => day.day)
    if (chart.data.datasets[0]) chart.data.datasets[0].data = snapshot.map((day) => day.kcal)
    chart.update()
  })
</script>

<div class="intake-chart-frame">
  <canvas bind:this={canvas} aria-label={`Calorie intake for the last 7 days${target ? `, target ${fmtKcal(target)} per day` : ''}`}></canvas>
</div>
{#if lastSeven.every((day) => day.kcal === 0)}
  <p class="chart-note">No meals logged in the last 7 days.</p>
{/if}

<style>
  .intake-chart-frame {
    position: relative;
    width: 100%;
    min-width: 0;
    height: 12rem;
  }
  canvas { display: block; min-width: 0; max-width: 100%; }
  .chart-note {
    margin: var(--space-2) 0 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    text-align: center;
  }
</style>
