import {
  CategoryScale,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js'
import type { ChartArea, ChartConfiguration, Plugin, Scale, ScriptableContext, TooltipItem } from 'chart.js'
import { fmtKg, fmtLong, fmtNumber, fmtShort } from '../format'
import type { Phase, WeightEntry } from '../types'
import type { WeightChartPoint } from './weightSeries'

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, Legend)

export interface WeightChartOptions {
  series: WeightChartPoint[]
  phases: Phase[]
  entries: WeightEntry[]
  windowDays: number
}

export interface WeightChartHandle {
  destroy(): void
  update(series: WeightChartPoint[], phases: Phase[]): void
}

interface ChartTheme {
  text: string
  grid: string
  accent: string
  muted: string
  surface: string
  font: string
}

interface PhaseBand {
  phase: Phase
  left: number
  right: number
  startVisible: boolean
}

function readTheme(canvas: HTMLCanvasElement): ChartTheme {
  const style = getComputedStyle(canvas.isConnected ? canvas : canvas.ownerDocument.documentElement)
  const read = (name: string, fallback: string): string => style.getPropertyValue(name).trim() || fallback
  return {
    text: read('--color-text', '#19231f'),
    grid: read('--color-border', '#d5ddd7'),
    accent: read('--color-accent', '#146c5a'),
    muted: read('--color-text-muted', '#55635c'),
    surface: read('--color-surface', '#ffffff'),
    font: read('--font-sans', 'system-ui, sans-serif'),
  }
}

function withAlpha(color: string, alpha: number, fallback = '#78867e'): string {
  const value = color.trim()
  const hex = /^#([\da-f]{3,8})$/i.exec(value)
  if (hex) {
    let digits = hex[1]
    if (digits.length === 3 || digits.length === 4) digits = digits.split('').map((char) => char + char).join('')
    if (digits.length >= 6) {
      return `rgba(${parseInt(digits.slice(0, 2), 16)}, ${parseInt(digits.slice(2, 4), 16)}, ${parseInt(digits.slice(4, 6), 16)}, ${alpha})`
    }
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(value)
  if (rgb) {
    const [r, g, b] = rgb[1].split(/[,\s/]+/).filter(Boolean)
    if (r && g && b) return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  return color === fallback ? `rgba(120, 134, 126, ${alpha})` : withAlpha(fallback, alpha)
}

function computeBands(labels: string[], phases: Phase[], x: Scale, area: ChartArea): PhaseBand[] {
  const first = labels[0]
  const last = labels[labels.length - 1]
  if (!first || !last) return []
  const measured = Math.abs(x.getPixelForValue(1) - x.getPixelForValue(0))
  const step = labels.length > 1 && Number.isFinite(measured) && measured > 0
    ? measured
    : area.width / Math.max(1, labels.length - 1)
  const half = step / 2
  const bands: PhaseBand[] = []

  for (const phase of phases) {
    if ((phase.endDate !== null && phase.endDate < first) || phase.startDate > last) continue
    let startIndex = labels.findIndex((date) => date >= phase.startDate)
    if (startIndex < 0) startIndex = labels.length - 1
    const endLimit = phase.endDate ?? last
    let endIndex = labels.length - 1
    while (endIndex > startIndex && labels[endIndex] > endLimit) endIndex -= 1
    if (labels[endIndex] > endLimit) continue
    const left = Math.max(area.left, x.getPixelForValue(startIndex) - half)
    const right = Math.min(area.right, x.getPixelForValue(endIndex) + half)
    if (right - left >= 1) bands.push({ phase, left, right, startVisible: phase.startDate >= first && phase.startDate <= last })
  }
  return bands
}

/** Raw weigh-ins, a trailing average, and phase bands without an annotation dependency. */
export function createWeightChart(canvas: HTMLCanvasElement, options: WeightChartOptions): WeightChartHandle {
  let theme = readTheme(canvas)
  let destroyed = false
  let resizeFrame = 0
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const current = {
    series: [] as WeightChartPoint[],
    phases: [] as Phase[],
    labels: [] as string[],
    empty: false,
    emptyMessage: '',
  }

  function sync(series: WeightChartPoint[], phases: Phase[]): void {
    current.series = series.map((point) => ({ ...point }))
    current.phases = phases.map((phase) => ({ ...phase }))
    current.labels = current.series.length > 0 ? current.series.map((point) => point.date) : ['']
    current.empty = current.series.length === 0 || current.series.every((point) => point.weightKg === null && point.avg7Kg === null)
    current.emptyMessage = options.entries.length > 0
      ? options.windowDays === 0 ? 'No weigh-ins to chart' : `No weigh-ins in the last ${options.windowDays} days`
      : 'No weigh-ins yet'
  }
  sync(options.series, options.phases)

  const values = (key: 'weightKg' | 'avg7Kg'): (number | null)[] =>
    current.series.length > 0 ? current.series.map((point) => point[key]) : [null]

  function areaFill(context: ScriptableContext<'line'>): string | CanvasGradient {
    const area = context.chart.chartArea
    if (!area) return withAlpha(theme.accent, 0.12)
    const gradient = context.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom)
    gradient.addColorStop(0, withAlpha(theme.accent, 0.18))
    gradient.addColorStop(0.65, withAlpha(theme.accent, 0.06))
    gradient.addColorStop(1, withAlpha(theme.accent, 0))
    return gradient
  }

  const phaseBands: Plugin<'line'> = {
    id: 'healthlogPhaseBands',
    beforeDatasetsDraw(chart) {
      if (current.empty) return
      const area = chart.chartArea
      const x = chart.scales.x
      if (!area || !x) return
      const { ctx } = chart
      ctx.save()
      for (const band of computeBands(current.labels, current.phases, x, area)) {
        ctx.fillStyle = withAlpha(band.phase.color, 0.12)
        ctx.fillRect(band.left, area.top, band.right - band.left, area.height)
        if (band.startVisible) {
          const borderX = Math.round(band.left) + 0.5
          ctx.strokeStyle = withAlpha(band.phase.color, 0.45)
          ctx.setLineDash([4, 4])
          ctx.beginPath()
          ctx.moveTo(borderX, area.top)
          ctx.lineTo(borderX, area.bottom)
          ctx.stroke()
          ctx.setLineDash([])
        }
      }
      ctx.restore()
    },
    afterDatasetsDraw(chart) {
      const area = chart.chartArea
      if (!area) return
      const { ctx } = chart
      ctx.save()
      if (current.empty) {
        ctx.fillStyle = theme.muted
        ctx.font = `500 13px ${theme.font}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(current.emptyMessage, area.left + area.width / 2, area.top + area.height / 2, Math.max(40, area.width - 16))
        ctx.restore()
        return
      }
      const x = chart.scales.x
      if (!x) {
        ctx.restore()
        return
      }
      ctx.font = `600 10px ${theme.font}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      for (const band of computeBands(current.labels, current.phases, x, area)) {
        if (band.right - band.left < 42) continue
        ctx.fillStyle = withAlpha(theme.text, 0.68)
        ctx.fillText(band.phase.name, band.left + 6, area.top + 5, band.right - band.left - 10)
      }
      ctx.restore()
    },
  }

  const config: ChartConfiguration<'line', (number | null)[], string> = {
    type: 'line',
    data: {
      labels: [...current.labels],
      datasets: [
        {
          label: 'Weigh-in',
          data: values('weightKg'),
          borderColor: () => withAlpha(theme.muted, 0.62),
          backgroundColor: () => withAlpha(theme.muted, 0.8),
          borderWidth: 1.25,
          pointRadius: 2.75,
          pointBorderWidth: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: () => theme.text,
          pointHoverBorderColor: () => theme.surface,
          pointHoverBorderWidth: 2,
          tension: 0.2,
          fill: false,
          spanGaps: false,
        },
        {
          label: '7-day average',
          data: values('avg7Kg'),
          borderColor: () => theme.accent,
          backgroundColor: areaFill,
          borderWidth: 3,
          pointRadius: 0,
          pointHoverRadius: 5,
          pointHoverBackgroundColor: () => theme.accent,
          pointHoverBorderColor: () => theme.surface,
          pointHoverBorderWidth: 2,
          cubicInterpolationMode: 'monotone',
          fill: 'origin',
          spanGaps: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 80,
      animation: reducedMotion ? false : { duration: 240 },
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      layout: { padding: { top: 4, right: 6 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17, 24, 39, 0.96)',
          titleColor: '#f9fafb',
          bodyColor: '#e5e7eb',
          cornerRadius: 10,
          padding: 10,
          displayColors: false,
          filter: (item: TooltipItem<'line'>) => item.datasetIndex === 1,
          callbacks: {
            title(items) {
              const point = current.series[items[0]?.dataIndex ?? -1]
              return point ? fmtLong(point.date) : ''
            },
            label(item) {
              const point = current.series[item.dataIndex]
              if (!point) return ''
              return point.weightKg === null ? 'Not logged' : fmtKg(point.weightKg)
            },
            afterLabel(item) {
              const point = current.series[item.dataIndex]
              if (!point) return ''
              const average = point.avg7Kg === null ? '—' : fmtKg(point.avg7Kg)
              const delta = point.deltaKg === null ? '—' : `${point.deltaKg > 0 ? '+' : ''}${fmtNumber(point.deltaKg)} kg`
              return [`7-day avg  ${average}`, `Change  ${delta}`]
            },
          },
        },
      },
      scales: {
        x: {
          type: 'category',
          offset: true,
          display: !current.empty,
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: () => theme.muted,
            font: { size: 11, family: theme.font },
            maxRotation: 0,
            autoSkip: true,
            autoSkipPadding: 14,
            maxTicksLimit: 5,
            callback(value) {
              const day = current.labels[typeof value === 'number' ? value : Number(value)]
              return day ? fmtShort(day) : ''
            },
          },
        },
        y: {
          type: 'linear',
          display: !current.empty,
          grace: '8%',
          grid: { color: () => withAlpha(theme.grid, 0.8), drawTicks: false },
          border: { display: false },
          ticks: {
            color: () => theme.muted,
            font: { size: 11, family: theme.font },
            maxTicksLimit: 5,
            padding: 6,
            callback(value, index) {
              const number = Number(value)
              if (!Number.isFinite(number)) return ''
              return index === 0 ? `${fmtNumber(number)} kg` : fmtNumber(number)
            },
          },
          afterDataLimits(scale) {
            const min = Number(scale.min)
            const max = Number(scale.max)
            if (Number.isFinite(min) && Number.isFinite(max) && max - min < 2) {
              const center = (min + max) / 2
              scale.min = center - 1
              scale.max = center + 1
            }
          },
        },
      },
    },
    plugins: [phaseBands],
  }

  canvas.style.display = 'block'
  canvas.style.minWidth = '0'
  canvas.style.maxWidth = '100%'
  const chart = new Chart<'line', (number | null)[], string>(canvas, config)

  function setAxisVisibility(visible: boolean): void {
    const scales = chart.options.scales
    if (!scales) return
    for (const key of ['x', 'y']) {
      const axis = scales[key] as unknown as { display?: boolean } | undefined
      if (axis) axis.display = visible
    }
  }

  function applyAccessibility(): void {
    canvas.setAttribute('role', 'img')
    const logged = current.series.filter((point) => point.weightKg !== null).length
    canvas.setAttribute('aria-label', current.empty
      ? current.emptyMessage
      : `Weight chart, ${logged} weigh-in${logged === 1 ? '' : 's'} over ${options.windowDays === 0 ? 'all time' : `the last ${options.windowDays} days`}`)
  }
  setAxisVisibility(!current.empty)
  applyAccessibility()

  function refreshTheme(): void {
    if (destroyed) return
    theme = readTheme(canvas)
    chart.resize()
    chart.update('none')
  }
  const onResize = (): void => {
    if (resizeFrame) return
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0
      if (!destroyed) chart.resize()
    })
  }
  const themeQuery = window.matchMedia('(prefers-color-scheme: dark)')
  window.addEventListener('resize', onResize)
  themeQuery.addEventListener('change', refreshTheme)

  return {
    destroy() {
      if (destroyed) return
      destroyed = true
      if (resizeFrame) cancelAnimationFrame(resizeFrame)
      window.removeEventListener('resize', onResize)
      themeQuery.removeEventListener('change', refreshTheme)
      chart.destroy()
    },
    update(series, phases) {
      if (destroyed) return
      sync(series, phases)
      chart.data.labels = [...current.labels]
      if (chart.data.datasets[0]) chart.data.datasets[0].data = values('weightKg')
      if (chart.data.datasets[1]) chart.data.datasets[1].data = values('avg7Kg')
      setAxisVisibility(!current.empty)
      applyAccessibility()
      chart.update()
    },
  }
}
