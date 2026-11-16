<script lang="ts">
  import type { BenchModel, ModelBenchPayload } from '../types'
  import { ROLE_COLOR, fmtPct, modelLabel } from './bench'

  interface Props { pairs: ModelBenchPayload['pairs']; models: BenchModel[] }
  let { pairs, models }: Props = $props()

  // Order: A, B, then the panel by accuracy — same order as the leaderboard.
  const order = $derived(models.filter((m) => m.role !== 'logged').map((m) => m.model).filter((m) => pairs.models.includes(m)))
  const idx = (m: string): number => pairs.models.indexOf(m)
  const CAP = 30 // a 30% gap is already "different meal"; deeper shades add nothing
  const shade = (pct: number | null): string =>
    pct == null ? 'transparent' : `color-mix(in oklab, var(--viz-run) ${Math.round(8 + (Math.min(pct, CAP) / CAP) * 62)}%, var(--color-surface))`
  const roleOf = (m: string): BenchModel['role'] => models.find((x) => x.model === m)?.role ?? 'bench'
  const short = (m: string): string => modelLabel(m).split(' ')[0]
</script>

<div class="matrix-wrap">
  <table class="matrix">
    <caption class="sr-only">Typical gap between each pair of models, as a percentage of the larger estimate</caption>
    <thead>
      <tr>
        <td></td>
        {#each order as m (m)}<th scope="col" title={modelLabel(m)}><span class="swatch" style:background={ROLE_COLOR[roleOf(m)]} aria-hidden="true"></span>{short(m)}</th>{/each}
      </tr>
    </thead>
    <tbody>
      {#each order as row (row)}
        <tr>
          <th scope="row" title={modelLabel(row)}><span class="swatch" style:background={ROLE_COLOR[roleOf(row)]} aria-hidden="true"></span>{short(row)}</th>
          {#each order as col (col)}
            {@const c = pairs.cells[idx(row)]?.[idx(col)]}
            {#if row === col}
              <td class="self" aria-label="same model">·</td>
            {:else}
              <td style:background={shade(c?.pct ?? null)} title="{modelLabel(row)} vs {modelLabel(col)}: typically {fmtPct(c?.pct, 1)} apart over {c?.n ?? 0} meals" class:strong={(c?.pct ?? 0) > CAP * 0.6}>{c?.n ? fmtPct(c.pct) : '—'}</td>
            {/if}
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
<div class="scale" aria-hidden="true">
  <span>agree</span><span class="ramp"></span><span>{CAP}%+ apart</span>
</div>

<style>
  .matrix-wrap { overflow-x: auto; }
  .matrix { width: 100%; border-collapse: separate; border-spacing: 2px; font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  th { color: var(--color-text-muted); font-weight: var(--weight-medium); white-space: nowrap; }
  thead th { padding: 0 2px 4px; text-align: center; }
  tbody th { padding-right: var(--space-2); text-align: left; }
  td { min-width: 2.3rem; height: 2rem; border-radius: 4px; color: var(--color-text); text-align: center; }
  td.strong { color: var(--color-on-accent, #fff); font-weight: var(--weight-semibold); }
  td.self { color: var(--color-text-subtle); }
  .swatch { display: inline-block; width: 8px; height: 8px; margin-right: 5px; border-radius: 2px; }
  .scale { display: flex; margin-top: var(--space-2); align-items: center; gap: var(--space-2); color: var(--color-text-subtle); font-size: var(--text-xs); }
  .ramp { width: 8rem; height: 8px; border-radius: 4px; background: linear-gradient(90deg, color-mix(in oklab, var(--viz-run) 8%, var(--color-surface)), color-mix(in oklab, var(--viz-run) 70%, var(--color-surface))); }
</style>
