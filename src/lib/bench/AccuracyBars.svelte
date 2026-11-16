<script lang="ts">
  import type { BenchModel } from '../types'
  import { niceTicks } from '../viz/scale'
  import { ROLE_COLOR, TIER_LABEL, fmtGap, fmtLatency, fmtLean, fmtPct, gapOf, leanOf, modelLabel, rankModels, statsFor, type Unit, type Yardstick } from './bench'

  interface Props { models: BenchModel[]; yardstick: Yardstick; unit: Unit }
  let { models, yardstick, unit }: Props = $props()

  // Ranked by typical drift. "Logged value" is left out: it is only A and B reconciled.
  const rows = $derived(rankModels(models, yardstick, unit))
  const nt = $derived(niceTicks(0, Math.max(unit === 'kcal' ? 50 : 10, ...rows.map((m) => gapOf(statsFor(m, yardstick), unit) ?? 0)), 4))
  const max = $derived(nt.domain[1])
  const ticks = $derived(nt.ticks.filter((t) => t <= max))
  const tickLabel = (t: number): string => (unit === 'kcal' ? `${t}` : `${t}%`)
</script>

<div class="bars" role="list" aria-label="Typical drift per model, smaller is closer">
  <div class="axis" aria-hidden="true">
    {#each ticks as t (t)}<span style:left="{(t / max) * 100}%">{tickLabel(t)}</span>{/each}
  </div>
  {#each rows as m, i (m.model)}
    {@const s = statsFor(m, yardstick)}
    <div class="row" role="listitem">
      <div class="name">
        <span class="rank">{i + 1}</span>
        <span class="swatch" style:background={ROLE_COLOR[m.role]} aria-hidden="true"></span>
        <b>{modelLabel(m.model)}</b>
        {#if m.role === 'a' || m.role === 'b'}<span class="chip">Model {m.role.toUpperCase()}</span>{/if}
        {#if m.tier}<span class="tier">{TIER_LABEL[m.tier]}</span>{/if}
      </div>
      <div class="line">
        <div class="track">
          {#each ticks as t (t)}<span class="grid" style:left="{(t / max) * 100}%" aria-hidden="true"></span>{/each}
          <span class="bar" style:width="{((gapOf(s, unit) ?? 0) / max) * 100}%" style:background={ROLE_COLOR[m.role]}></span>
        </div>
        <span class="value">{fmtGap(gapOf(s, unit), unit)}</span>
      </div>
      <p class="detail">
        {unit === 'kcal' ? fmtPct(s.medianAbsPct, 1) : fmtGap(s.medianAbsKcal, 'kcal')} typical · runs {fmtLean(leanOf(s, unit), unit)} ·
        {unit === 'kcal' ? `within 100 kcal on ${fmtPct(s.within100Kcal)}` : `within 10% on ${fmtPct(s.within10)}`} of {s.n} meals · {fmtLatency(m.medianLatencyMs)}{#if m.failures} · {m.failures} failed{/if}
      </p>
    </div>
  {/each}
</div>

<style>
  .bars { display: flex; flex-direction: column; gap: var(--space-3); }
  .axis { position: relative; height: 1rem; margin-right: 5rem; color: var(--viz-axis); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .axis span:first-child { transform: none; }
  .row { display: grid; gap: 4px; }
  .name { display: flex; min-width: 0; align-items: center; gap: var(--space-2); font-size: var(--text-sm); flex-wrap: wrap; }
  .rank { min-width: 1.1rem; color: var(--color-text-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .swatch { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 3px; }
  .chip { padding: 1px 6px; border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-text-muted); font-size: var(--text-xs); }
  .tier { color: var(--color-text-subtle); font-size: var(--text-xs); }
  .line { display: grid; grid-template-columns: 1fr 5rem; align-items: center; }
  .track { position: relative; height: 14px; }
  .grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--viz-grid); }
  .bar { position: absolute; top: 2px; left: 0; height: 10px; min-width: 2px; border-radius: 0 4px 4px 0; }
  .value { padding-left: var(--space-2); color: var(--color-text); font-size: var(--text-xs); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .detail { margin: 0; color: var(--color-text-muted); font-size: var(--text-xs); }
</style>
