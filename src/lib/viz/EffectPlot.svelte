<script lang="ts">
  /**
   * Forest plot: one row per comparison, a dot at the difference and a bar for
   * its 90 % range, around a zero line. Every row's numbers are written out, so
   * it reads without hover and the text doubles as the table view.
   */
  interface Row { key: string; label: string; detail: string; diff: number; lo: number; hi: number; clear: boolean }
  interface Props { label: string; rows: Row[]; unit?: string; goodLabel?: string; badLabel?: string }
  let { label, rows, unit = '%', goodLabel = 'better', badLabel = 'worse' }: Props = $props()

  const span = $derived.by(() => {
    const m = Math.max(1, ...rows.flatMap((r) => [Math.abs(r.lo), Math.abs(r.hi)]))
    const step = m <= 2 ? 1 : m <= 5 ? 2.5 : m <= 10 ? 5 : 10
    return Math.ceil(m / step) * step
  })
  const pos = (v: number): number => ((Math.max(-span, Math.min(span, v)) + span) / (2 * span)) * 100
  const fmt = (v: number): string => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}${unit}`
</script>

<div class="effects" role="group" aria-label={label}>
  <div class="axis" aria-hidden="true">
    <span>← {badLabel}</span><span>0</span><span>{goodLabel} →</span>
  </div>
  <ul>
    {#each rows as r (r.key)}
      <li class:clear={r.clear}>
        <div class="text">
          <b>{r.label}</b>
          <span>{r.detail}</span>
        </div>
        <div class="track" aria-hidden="true">
          <span class="zero" style:left="{pos(0)}%"></span>
          <span class="ci" style:left="{pos(r.lo)}%" style:width="{Math.max(0.5, pos(r.hi) - pos(r.lo))}%"></span>
          <span class="dot" class:up={r.diff >= 0} style:left="{pos(r.diff)}%"></span>
        </div>
        <p class="nums">
          <b>{fmt(r.diff)}</b>
          <span>range {fmt(r.lo)} to {fmt(r.hi)}{r.clear ? '' : ' · could be chance'}</span>
        </p>
      </li>
    {/each}
  </ul>
</div>

<style>
  .effects { display: flex; flex-direction: column; gap: var(--space-2); }
  .axis { display: flex; justify-content: space-between; color: var(--viz-axis); font-size: 0.6875rem; }
  ul { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-3); list-style: none; }
  li { display: grid; grid-template-columns: 1fr; gap: 4px; }
  .text { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-2); font-size: var(--text-sm); }
  .text span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .track { position: relative; height: 18px; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .zero { position: absolute; top: 2px; bottom: 2px; width: 1px; background: var(--viz-axis); }
  .ci { position: absolute; top: 7px; height: 4px; border-radius: 2px; background: var(--viz-other); opacity: 0.55; }
  li.clear .ci { background: var(--viz-line); opacity: 0.6; }
  .dot { position: absolute; top: 3px; width: 12px; height: 12px; margin-left: -6px; border: 2px solid var(--color-surface); border-radius: 50%; background: var(--viz-other); }
  li.clear .dot { background: var(--viz-line); }
  .nums { display: flex; margin: 0; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-2); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .nums b { font-size: var(--text-sm); }
  .nums span { color: var(--color-text-muted); }
  @media (min-width: 40rem) {
    li { grid-template-columns: minmax(12rem, 1.2fr) 2fr minmax(9rem, 1fr); align-items: center; gap: var(--space-3); }
    .text { flex-direction: column; gap: 0; }
    .nums { flex-direction: column; gap: 0; }
  }
</style>
