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

/** The models, without the "Logged value" pseudo-entry (that is just A and B reconciled). */
export const realModels = (models: BenchModel[]): BenchModel[] => models.filter((m) => m.role !== 'logged')

/**
 * Headline: how far A and B drift from the other models (or from the user's
 * own corrections). Agreement is not truth, so the wording never says "accurate".
 */
export function verdict(models: BenchModel[], y: Yardstick): { tone: 'good' | 'ok' | 'poor' | 'none'; text: string } {
  const ranked = realModels(models)
    .filter((m) => statsFor(m, y).n > 0)
    .sort((p, q) => (statsFor(p, y).medianAbsPct ?? 999) - (statsFor(q, y).medianAbsPct ?? 999))
  const a = ranked.find((m) => m.role === 'a')
  const b = ranked.find((m) => m.role === 'b')
  const sa = a ? statsFor(a, y) : null
  const sb = b ? statsFor(b, y) : null
  if (!sa || !sb || sa.n < 3 || sb.n < 3 || sa.medianAbsPct == null || sb.medianAbsPct == null) {
    return { tone: 'none', text: y === 'corrected' ? 'Not enough corrected meals yet to compare against your own numbers.' : 'Log a few more meals and the comparison fills in here.' }
  }
  const worst = Math.max(sa.medianAbsPct, sb.medianAbsPct)
  const ref = y === 'consensus' ? 'the other models' : 'your corrections'
  const text =
    `On a typical meal, ${modelLabel(a!.model)} (A) is ${fmtPct(sa.medianAbsPct)} from ${ref} and ${modelLabel(b!.model)} (B) is ${fmtPct(sb.medianAbsPct)}` +
    ` — ranked ${ranked.indexOf(a!) + 1} and ${ranked.indexOf(b!) + 1} of ${ranked.length} for ${y === 'consensus' ? 'staying close to the group' : 'matching what you corrected to'}.`
  return { tone: worst <= 8 ? 'good' : worst <= 15 ? 'ok' : 'poor', text }
}
