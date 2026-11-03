<script lang="ts" module>
  import type { IntakeMetric } from '../intakeStats'

  /** One slide of the intake carousel: which series, how to label it, what colour. */
  export interface IntakeChartSpec {
    metric: IntakeMetric
    label: string
    unit: 'kcal' | 'g'
    target: number | null
    /** CSS custom properties for the bar fill and today's lighter fill. */
    colorVar: string
    softVar: string
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import {
    BarController,
    BarElement,
    CategoryScale,
    Chart,
    type ChartConfiguration,
    LinearScale,
    LineController,
    LineElement,
    PointElement,
    Tooltip,
  } from 'chart.js'
  import { fmtNumber, fmtShort, fmtWithDay } from '../format'
  import { rollingAverage } from '../intakeStats'
  import type { DayString, IntakeHistoryDay } from '../types'

  Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip)

  interface Props { days: IntakeHistoryDay[]; spec: IntakeChartSpec; todayDay: DayString }
  let { days, spec, todayDay }: Props = $props()

  type Mixed = Chart<'bar' | 'line', (number | null)[], string>
  let canvas: HTMLCanvasElement | undefined = $state()
  let chart: Mixed | null = $state(null)

  interface Theme { fill: string; soft: string; grid: string; muted: string; text: string; font: string }

  function readTheme(): Theme {
    const style = getComputedStyle(document.documentElement)
    const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
    return {
      fill: read(spec.colorVar, '#146c5a'),
      soft: read(spec.softVar, '#e0efe9'),
      grid: read('--color-border', '#d5ddd7'),
      muted: read('--color-text-muted', '#55635c'),
      text: read('--color-text', '#17211c'),
      font: read('--font-sans', 'system-ui, sans-serif'),
    }
  }

  const amount = (value: number): string => `${fmtNumber(value, 0)} ${spec.unit}`
  const hasTarget = (): boolean => spec.target !== null && spec.target > 0

  // A snapshot so Chart.js never holds Svelte proxies.
  function snapshot(): { rows: IntakeHistoryDay[]; avg: (number | null)[] } {
    const rows = days.map((day) => ({ ...day }))
    return { rows, avg: rollingAverage(rows, 7, spec.metric) }
  }

  function datasets(rows: IntakeHistoryDay[], avg: (number | null)[], theme: Theme): Mixed['data']['datasets'] {
    const dense = rows.length > 45
    const sets: Mixed['data']['datasets'] = [
      {
        type: 'bar',
        label: spec.label,
        // Unlogged days are gaps, not zero bars.
        data: rows.map((day) => (day.kcal > 0 ? day[spec.metric] : null)),
        backgroundColor: rows.map((day) => (day.day === todayDay ? theme.soft : theme.fill)),
        borderColor: theme.fill,
        borderWidth: rows.map((day) => (day.day === todayDay ? 1.5 : 0)),
        borderRadius: dense ? 2 : 6,
        borderSkipped: false,
        maxBarThickness: 42,
        order: 3,
      },
      {
        type: 'line',
        label: '7-day average',
        data: avg,
        borderColor: theme.text,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 3,
        tension: 0.3,
        spanGaps: true,
        order: 1,
      },
    ]
    if (hasTarget()) {
      sets.push({
        type: 'line',
        label: 'Target',
        data: rows.map(() => spec.target),
        borderColor: theme.muted,
        borderWidth: 1.5,
        borderDash: [6, 5],
        pointRadius: 0,
        pointHoverRadius: 0,
        order: 2,
      })
    }
    return sets
  }

  onMount(() => {
    if (!canvas) return
    canvas.setAttribute('role', 'img')
    const theme = readTheme()
    const initial = snapshot()
    chart = new Chart(canvas, {
      type: 'bar',
      data: { labels: initial.rows.map((day) => day.day), datasets: datasets(initial.rows, initial.avg, theme) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 240 },
        plugins: {
          // Legend is registered globally by the weight chart; the carousel draws its own in HTML.
          legend: { display: false },
          tooltip: {
            filter: (item) => item.dataset.label !== 'Target',
            callbacks: {
              title(items) {
                const day = String(chart?.data.labels?.[items[0]?.dataIndex ?? -1] ?? '')
                if (!day) return ''
                return day === todayDay ? 'Today (in progress)' : fmtWithDay(day)
              },
              label(item) {
                if (item.raw === null || item.raw === undefined) return ''
                if (item.dataset.label === '7-day average') return `7-day average ${amount(Number(item.raw))}`
                return `${spec.label} ${amount(Number(item.raw))}`
              },
              afterBody(items) {
                const row = days[items[0]?.dataIndex ?? -1]
                if (!row) return ''
                if (row.kcal === 0) return 'Nothing logged'
                const lines = spec.metric === 'kcal'
                  ? [`Protein ${fmtNumber(row.proteinG, 0)} g · Carbs ${fmtNumber(row.carbsG, 0)} g · Fat ${fmtNumber(row.fatG, 0)} g`]
                  : [`${fmtNumber(row.kcal, 0)} kcal that day`]
                if (hasTarget()) {
                  const delta = Math.round(row[spec.metric] - (spec.target ?? 0))
                  lines.push(delta === 0 ? 'Exactly on target' : `${delta > 0 ? '+' : '−'}${amount(Math.abs(delta))} vs target`)
                }
                return lines
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
              autoSkip: true,
              maxTicksLimit: 8,
              callback(value) {
                const day = String(chart?.data.labels?.[Number(value)] ?? '')
                return day ? fmtShort(day) : ''
              },
            },
          },
          y: {
            beginAtZero: true,
            grace: '10%',
            grid: { color: theme.grid, drawTicks: false },
            border: { display: false },
            ticks: {
              color: theme.muted,
              font: { family: theme.font, size: 11 },
              maxTicksLimit: 5,
              padding: 6,
              callback(value) { return fmtNumber(Number(value), 0) },
            },
          },
        },
      },
    } as ChartConfiguration<'bar' | 'line', (number | null)[], string>) as Mixed
    return () => {
      chart?.destroy()
      chart = null
    }
  })

  $effect(() => {
    if (!chart) return
    const { rows, avg } = snapshot()
    chart.data.labels = rows.map((day) => day.day)
    chart.data.datasets = datasets(rows, avg, readTheme())
    chart.update()
  })

  let label = $derived(
    `Daily ${spec.label.toLowerCase()} for ${days.length} days with a 7-day average line${hasTarget() ? ` and a target of ${amount(spec.target ?? 0)}` : ''}`,
  )
</script>

<div class="intake-chart-frame">
  <canvas bind:this={canvas} aria-label={label}></canvas>
</div>

<style>
  .intake-chart-frame {
    position: relative;
    width: 100%;
    min-width: 0;
    height: 16rem;
  }
  canvas { display: block; min-width: 0; max-width: 100%; }
  @media (min-width: 70rem) {
    .intake-chart-frame { height: 19rem; }
  }
</style>
