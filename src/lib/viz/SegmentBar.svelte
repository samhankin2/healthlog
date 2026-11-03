<script lang="ts">
  /** Tall segmented bar: one whole split into parts, share printed inside when it fits. */
  interface Part { label: string; value: number; color: string; ink?: 'light' | 'dark'; detail?: string }
  interface Props { label: string; parts: Part[]; format?: (v: number) => string }
  let { label, parts, format }: Props = $props()

  const total = $derived(parts.reduce((a, p) => a + Math.max(0, p.value), 0) || 1)
  const shown = $derived(parts.filter((p) => p.value > 0))
  const pct = (v: number): number => Math.round((v / total) * 100)
  const describe = $derived(parts.map((p) => `${p.label} ${pct(p.value)}%${format ? ` (${format(p.value)})` : ''}`).join(', '))
</script>

<div class="seg-wrap">
  <div class="seg" role="img" aria-label="{label}: {describe}">
    {#each shown as p (p.label)}
      <span class="part" style:flex-grow={p.value} style:background={p.color} title="{p.label}: {pct(p.value)}%{format ? ` · ${format(p.value)}` : ''}{p.detail ? ` · ${p.detail}` : ''}">
        {#if pct(p.value) >= 9}<span class="in" class:dark={p.ink === 'dark'}>{pct(p.value)}%</span>{/if}
      </span>
    {/each}
  </div>
  <ul class="legend">
    {#each parts as p (p.label)}
      <li><i style:background={p.color}></i>{p.label}<span>{pct(p.value)}%{format ? ` · ${format(p.value)}` : ''}</span></li>
    {/each}
  </ul>
</div>

<style>
  .seg { display: flex; height: 28px; gap: 2px; }
  .part { display: flex; min-width: 3px; align-items: center; flex-basis: 0; border-radius: 4px; overflow: visible; }
  .in { padding-left: 7px; color: #fff; font-size: var(--text-xs); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .in.dark { color: #0b0b0b; }
  .legend { display: flex; margin: var(--space-3) 0 0; padding: 0; flex-wrap: wrap; gap: var(--space-2) var(--space-4); list-style: none; font-size: var(--text-xs); }
  .legend li { display: flex; align-items: center; gap: 6px; color: var(--color-text); }
  .legend i { width: 10px; height: 10px; border-radius: 3px; }
  .legend span { color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
</style>
