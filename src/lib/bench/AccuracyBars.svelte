<script lang="ts">
  import type { BenchModel } from '../types'
  import { ROLE_COLOR, TIER_LABEL, fmtLatency, fmtPct, fmtSignedPct, modelLabel, statsFor, type Yardstick } from './bench'

  interface Props { models: BenchModel[]; yardstick: Yardstick }
  let { models, yardstick }: Props = $props()

  // What was logged is pinned on top; the models are ranked by typical miss.
  const rows = $derived.by(() => {
    const scored = models.filter((m) => statsFor(m, yardstick).n > 0)
    const logged = scored.filter((m) => m.role === 'logged')
    const rest = scored.filter((m) => m.role !== 'logged').sort((x, y) => (statsFor(x, yardstick).medianAbsPct ?? 999) - (statsFor(y, yardstick).medianAbsPct ?? 999))
    return [...logged, ...rest]
  })
  const max = $derived(Math.max(10, ...rows.map((m) => statsFor(m, yardstick).medianAbsPct ?? 0)) * 1.08)
  const ticks = $derived([0, 5, 10, 15, 20, 25, 30, 40, 50, 75, 100].filter((t) => t <= max).filter((_, i, a) => a.length <= 5 || i % 2 === 0))
  const rank = (m: BenchModel): number => rows.filter((r) => r.role !== 'logged').indexOf(m) + 1
</script>

<div class="bars" role="list" aria-label="Typical miss per model, smaller is better">
  <div class="axis" aria-hidden="true">
    {#each ticks as t (t)}<span style:left="{(t / max) * 100}%">{t}%</span>{/each}
  </div>
  {#each rows as m (m.model)}
    {@const s = statsFor(m, yardstick)}
    <div class="row" class:logged={m.role === 'logged'} role="listitem">
      <div class="name">
        {#if m.role !== 'logged'}<span class="rank">{rank(m)}</span>{/if}
        <span class="swatch" style:background={ROLE_COLOR[m.role]} aria-hidden="true"></span>
        <b>{modelLabel(m.model)}</b>
        {#if m.role === 'a' || m.role === 'b'}<span class="chip">Model {m.role.toUpperCase()}</span>{/if}
        {#if m.tier}<span class="tier">{TIER_LABEL[m.tier]}</span>{/if}
      </div>
      <div class="line">
        <div class="track">
          {#each ticks as t (t)}<span class="grid" style:left="{(t / max) * 100}%" aria-hidden="true"></span>{/each}
          <span class="bar" style:width="{((s.medianAbsPct ?? 0) / max) * 100}%" style:background={ROLE_COLOR[m.role]}></span>
        </div>
        <span class="value">{fmtPct(s.medianAbsPct, 1)}</span>
      </div>
      <p class="detail">
        reads {fmtSignedPct(s.biasPct)} · {fmtPct(s.within10)} within 10% · {s.n} meals{#if m.role !== 'logged'} · {fmtLatency(m.medianLatencyMs)}{#if m.failures} · {m.failures} failed{/if}{/if}
      </p>
    </div>
  {/each}
</div>

<style>
  .bars { display: flex; flex-direction: column; gap: var(--space-3); }
  .axis { position: relative; height: 1rem; margin-right: 3.5rem; color: var(--viz-axis); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .axis span:first-child { transform: none; }
  .row { display: grid; gap: 4px; }
  .row.logged { padding-bottom: var(--space-3); border-bottom: 1px solid var(--viz-grid); }
  .name { display: flex; min-width: 0; align-items: center; gap: var(--space-2); font-size: var(--text-sm); flex-wrap: wrap; }
  .rank { min-width: 1.1rem; color: var(--color-text-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .swatch { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 3px; }
  .chip { padding: 1px 6px; border: 1px solid var(--color-border); border-radius: 999px; color: var(--color-text-muted); font-size: var(--text-xs); }
  .tier { color: var(--color-text-subtle); font-size: var(--text-xs); }
  .line { display: grid; grid-template-columns: 1fr 3.5rem; align-items: center; }
  .track { position: relative; height: 14px; }
  .grid { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--viz-grid); }
  .bar { position: absolute; top: 2px; left: 0; height: 10px; min-width: 2px; border-radius: 0 4px 4px 0; }
  .value { padding-left: var(--space-2); color: var(--color-text); font-size: var(--text-xs); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .detail { margin: 0; color: var(--color-text-muted); font-size: var(--text-xs); }
</style>
