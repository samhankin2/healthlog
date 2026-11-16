/**
 * Model benchmark helpers (SPEC §7 "Model benchmark"). Pure.
 *
 * Colour follows the job, not the model: the two models the app uses get the
 * two categorical hues (blue / orange — a colour-blind-safe pair), what was
 * actually logged is ink, and the background panel is one neutral grey with
 * direct labels. That keeps the charts at three hues however many models run.
 */
import type { BenchModel, BenchRole, BenchStats } from '../types'

export type Yardstick = 'consensus' | 'corrected'

export const ROLE_COLOR: Record<BenchRole, string> = {
  logged: 'var(--color-text)',
  a: 'var(--viz-run)',
  b: 'var(--viz-ride)',
  bench: 'var(--viz-other)',
  other: 'var(--viz-other)',
}

export const ROLE_LABEL: Record<BenchRole, string> = {
  logged: 'What was logged',
  a: 'Model A',
  b: 'Model B',
  bench: 'Background panel',
  other: 'Earlier model',
}

/** `claude-haiku-5-5` → `Claude Haiku 5.5`, `deepseek-v4.1-flash` → `DeepSeek V4.1 Flash`. */
export function modelLabel(model: string): string {
  if (model === 'Logged value') return 'Logged value'
  const special: Record<string, string> = { gpt: 'GPT', glm: 'GLM', deepseek: 'DeepSeek', minimax: 'MiniMax', qwen: 'Qwen', kimi: 'Kimi' }
  const parts = model.replace(/^.*\//, '').split('-')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    // "5-5" style versions read as 5.5
    if (/^\d+$/.test(p) && /^\d+$/.test(parts[i + 1] ?? '') && i > 0) {
      out.push(`${p}.${parts[i + 1]}`)
      i++
      continue
    }
    out.push(special[p] ?? (/^v?\d/.test(p) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
  }
  return out.join(' ')
}

export const statsFor = (m: BenchModel, y: Yardstick): BenchStats => (y === 'consensus' ? m.consensus : m.corrected)

export const fmtPct = (v: number | null | undefined, digits = 0): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits)}%`

export const fmtSignedPct = (v: number | null | undefined, digits = 0): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(digits)}%`

export const fmtLatency = (ms: number | null | undefined): string =>
  ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`

export const TIER_LABEL = { small: 'Small', medium: 'Mid', large: 'Large' } as const

/** Rolling median, for the drift line. */
export function rollingMedian(values: number[], window: number): number[] {
  return values.map((_, i) => {
    const w = values.slice(Math.max(0, i - window + 1), i + 1).slice().sort((a, b) => a - b)
    const mid = w.length >> 1
    return w.length % 2 ? w[mid] : (w[mid - 1] + w[mid]) / 2
  })
}

/** One-sentence answer to "are the two I use accurate enough?". */
export function verdict(models: BenchModel[], y: Yardstick): { tone: 'good' | 'ok' | 'poor' | 'none'; text: string } {
  const logged = models.find((m) => m.role === 'logged')
  const s = logged ? statsFor(logged, y) : null
  if (!s || s.n < 3 || s.medianAbsPct == null) {
    return { tone: 'none', text: y === 'corrected' ? 'Not enough corrected meals yet — the panel comparison fills in faster.' : 'Log a few more meals and the comparison fills in here.' }
  }
  const ref = y === 'consensus' ? 'the seven-model consensus' : 'your corrected numbers'
  if (s.medianAbsPct <= 8 && (s.within10 ?? 0) >= 65) {
    return { tone: 'good', text: `Accurate enough. What HealthLog logs is typically ${fmtPct(s.medianAbsPct)} from ${ref}, and within 10% on ${fmtPct(s.within10)} of meals.` }
  }
  if (s.medianAbsPct <= 15) {
    return { tone: 'ok', text: `Mostly fine. Logged values are typically ${fmtPct(s.medianAbsPct)} from ${ref}; within 10% on ${fmtPct(s.within10)} of meals. Check the meals below where they split.` }
  }
  return { tone: 'poor', text: `Worth a look. Logged values are typically ${fmtPct(s.medianAbsPct)} from ${ref} — only ${fmtPct(s.within10)} land within 10%.` }
}
