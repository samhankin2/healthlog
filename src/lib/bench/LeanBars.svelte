<script lang="ts">
  import type { BenchModel } from '../types'
  import { niceTicks } from '../viz/scale'
  import { ROLE_COLOR, fmtLean, fmtSignedKcal, leanOf, modelLabel, realModels, statsFor, type Unit, type Yardstick } from './bench'

  /**
   * Which way each model leans: one row per model, a bar left (comes in lower
   * than the yardstick) or right (higher) of zero. Every row is labelled, so it
   * stays readable however close the models are. In kcal it also shows the
   * running total: how much more or less that model would have put in the diary.
   */
  interface Props { models: BenchModel[]; yardstick: Yardstick; unit: Unit }
  let { models, yardstick, unit }: Props = $props()

  const rows = $derived(
    realModels(models)
      .map((m) => ({ m, s: statsFor(m, yardstick) }))
      .filter((r) => r.s.n > 0 && leanOf(r.s, unit) != null)
      .sort((p, q) => (leanOf(p.s, unit) as number) - (leanOf(q.s, unit) as number)),
  )
  const lim = $derived.by(() => {
    const m = Math.max(unit === 'kcal' ? 20 : 4, ...rows.map((r) => Math.abs(leanOf(r.s, unit) as number)))
    return niceTicks(0, m * 1.4, 2).domain[1] // headroom for the value label at the bar end
  })
  const pos = (v: number): number => 50 + (Math.max(-lim, Math.min(lim, v)) / lim) * 50
  const tick = (v: number): string => (unit === 'kcal' ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}` : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}%`)
</script>

<div class="lean">
  <div class="head" aria-hidden="true">
    <span></span>
    <div class="axis">
      <span style:left="0%">{tick(-lim)}</span><span style:left="50%">0</span><span style:left="100%">{tick(lim)}</span>
    </div>
    {#if unit === 'kcal'}<span class="tot-h">over all meals</span>{/if}
  </div>
  <ul>
    {#each rows as r (r.m.model)}
      {@const v = leanOf(r.s, unit) as number}
      <li>
        <span class="name"><span class="swatch" style:background={ROLE_COLOR[r.m.role]} aria-hidden="true"></span>{modelLabel(r.m.model)}{#if r.m.role === 'a' || r.m.role === 'b'} <small>({r.m.role.toUpperCase()})</small>{/if}</span>
        <div class="track" aria-hidden="true">
          <span class="zero"></span>
          <span class="bar" class:neg={v < 0} style:left="{Math.min(50, pos(v))}%" style:width="{Math.abs(pos(v) - 50)}%" style:background={ROLE_COLOR[r.m.role]}></span>
          <span class="val" style:left="{pos(v)}%" class:neg={v < 0}>{fmtLean(v, unit)}</span>
        </div>
        {#if unit === 'kcal'}<span class="tot">{fmtSignedKcal(r.s.totalKcal)}<small> / {r.s.n}</small></span>{/if}
        <span class="sr-only">{modelLabel(r.m.model)} typically comes in {fmtLean(v, unit)} against {yardstick === 'consensus' ? 'the other models' : 'your corrections'}{unit === 'kcal' ? `, ${fmtSignedKcal(r.s.totalKcal)} over ${r.s.n} meals` : ''}.</span>
      </li>
    {/each}
  </ul>
  <div class="foot" aria-hidden="true"><span>← lower than {yardstick === 'consensus' ? 'the others' : 'your corrections'}</span><span>higher →</span></div>
</div>

<style>
  .lean { display: flex; flex-direction: column; gap: var(--space-2); font-size: var(--text-xs); }
  .head, li { display: grid; grid-template-columns: minmax(7rem, 11rem) 1fr auto; align-items: center; gap: var(--space-3); }
  .axis { position: relative; height: 1rem; color: var(--viz-axis); font-variant-numeric: tabular-nums; }
  .axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .axis span:first-child { transform: none; }
  .axis span:last-child { transform: translateX(-100%); }
  .tot-h { min-width: 6.5rem; color: var(--color-text-subtle); text-align: right; }
  ul { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-2); list-style: none; }
  .name { display: flex; min-width: 0; align-items: center; gap: 6px; overflow: hidden; color: var(--color-text); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
  .name small { color: var(--color-text-subtle); }
  .swatch { width: 10px; height: 10px; flex: 0 0 auto; border-radius: 3px; }
  .track { position: relative; height: 22px; border-radius: 4px; background: linear-gradient(90deg, transparent calc(50% - 0.5px), var(--viz-grid) calc(50% - 0.5px), var(--viz-grid) calc(50% + 0.5px), transparent calc(50% + 0.5px)); }
  .zero { position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; background: var(--viz-axis); }
  .bar { position: absolute; top: 6px; height: 10px; min-width: 2px; border-radius: 0 4px 4px 0; }
  .bar.neg { border-radius: 4px 0 0 4px; }
  .val { position: absolute; top: 50%; padding: 0 6px; transform: translateY(-50%); color: var(--color-text); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .val.neg { transform: translate(-100%, -50%); }
  .tot { min-width: 6.5rem; color: var(--color-text); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .tot small { color: var(--color-text-subtle); }
  .foot { display: flex; justify-content: space-between; color: var(--color-text-subtle); }
  /* Phones: name + running total on one line, the bar full width beneath. */
  @media (max-width: 34rem) {
    .head, li { grid-template-columns: 1fr auto; gap: 2px var(--space-3); }
    .head > span:first-child { display: none; }
    .head .axis { grid-column: 1 / -1; grid-row: 2; }
    .tot-h { grid-column: 2; grid-row: 1; }
    .name { grid-column: 1; grid-row: 1; }
    .tot { grid-column: 2; grid-row: 1; min-width: 0; }
    .track { grid-column: 1 / -1; grid-row: 2; }
  }
</style>
