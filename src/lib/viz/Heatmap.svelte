<script lang="ts">
  /**
   * Rows × weeks grid of counts (hard sets per muscle per week). One hue, light
   * to dark, in five classes with a legend. It is a real table, so screen
   * readers get the numbers; each cell's value is also in its title.
   */
  import { fmtDayShort } from './scale'

  interface Props {
    label: string
    weeks: string[]
    rows: { key: string; label: string; values: number[] }[]
    /** Upper bounds of the classes (last class is everything above). */
    classes?: number[]
    unit?: string
  }
  let { label, weeks, rows, classes = [0, 4, 9, 14, 19], unit = 'sets' }: Props = $props()

  const MIX = [0, 22, 42, 64, 84, 100]
  const cls = (v: number): number => { const i = classes.findIndex((c) => v <= c); return i < 0 ? classes.length : i }
  const legend = $derived(classes.map((c, i) => (i === 0 ? '0' : `${classes[i - 1] + 1}–${c}`)).concat(`${classes[classes.length - 1] + 1}+`))
</script>

<div class="heat">
  <table aria-label={label}>
    <thead>
      <tr>
        <th scope="col"><span class="sr-only">Muscle</span></th>
        {#each weeks as w, i (w)}<th scope="col" class="wk"><span class:sr-only={i % 3 !== (weeks.length - 1) % 3}>{fmtDayShort(w)}</span></th>{/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as r (r.key)}
        <tr>
          <th scope="row">{r.label}</th>
          {#each r.values as v, i (weeks[i])}
            <td title="{r.label}, week of {fmtDayShort(weeks[i])}: {v} {unit}" style:--mix="{MIX[cls(v)]}%" class:empty={v === 0}><span class="sr-only">{v}</span></td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
  <div class="legend" aria-hidden="true">
    <span>{unit} / week</span>
    {#each legend as l, i (l)}<span class="key"><i style:--mix="{MIX[i]}%" class:empty={i === 0}></i>{l}</span>{/each}
  </div>
</div>

<style>
  .heat { display: flex; flex-direction: column; gap: var(--space-2); }
  table { width: 100%; border-collapse: separate; border-spacing: 2px; table-layout: fixed; }
  th { color: var(--color-text-muted); font-size: 0.6875rem; font-weight: var(--weight-regular); text-align: left; white-space: nowrap; }
  thead th:first-child, tbody th { width: 5.25rem; }
  .wk { overflow: visible; text-align: left; }
  td { height: 1.35rem; border-radius: 3px; background: color-mix(in oklab, var(--viz-strength) var(--mix), var(--color-surface)); }
  td.empty, i.empty { background: var(--color-surface-sunken); }
  .legend { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1) var(--space-3); color: var(--color-text-muted); font-size: 0.6875rem; }
  .key { display: inline-flex; align-items: center; gap: 4px; }
  .key i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; background: color-mix(in oklab, var(--viz-strength) var(--mix), var(--color-surface)); }
</style>
