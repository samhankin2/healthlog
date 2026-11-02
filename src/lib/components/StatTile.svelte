<script lang="ts">
  interface Props {
    label: string
    value: string | number
    unit?: string
    sublabel?: string
    tone?: 'neutral' | 'up' | 'down' | 'accent'
  }

  let { label, value, unit, sublabel, tone }: Props = $props()

  const toneMark = $derived(tone === 'up' ? '↗' : tone === 'down' ? '↘' : tone === 'neutral' ? '→' : '')
  const toneLabel = $derived(
    tone === 'up' ? 'Increasing' : tone === 'down' ? 'Decreasing' : tone === 'neutral' ? 'Holding steady' : '',
  )
</script>

<article class="stat-tile" data-tone={tone ?? 'neutral'}>
  <span class="stat-label">{label}</span>
  <div class="stat-value-row">
    <span class="stat-value">{value}</span>
    {#if unit}<span class="stat-unit">{unit}</span>{/if}
    {#if toneMark}<span class="stat-tone-mark" aria-hidden="true">{toneMark}</span>{/if}
  </div>
  {#if toneLabel}<span class="sr-only">{toneLabel}</span>{/if}
  {#if sublabel}<span class="stat-sublabel">{sublabel}</span>{/if}
</article>

<style>
  .stat-tile[data-tone='accent'] .stat-value {
    color: var(--color-accent);
  }
</style>
