<script lang="ts">
  import type { AnalysisTotal } from '../types'
  import { fmtKcal, fmtMacro } from '../format'

  interface Props {
    label: string
    model: string
    total: AnalysisTotal
    confidence?: number | null
    notes?: string
    chosen?: boolean
  }

  let { label, model, total, confidence, notes, chosen = false }: Props = $props()

  const confidenceLabel = $derived(
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}% confidence`
      : 'Confidence not provided',
  )
</script>

<section class="model-panel" aria-label="{label} estimate">
  <div class="model-panel-heading">
    <div class="model-heading-row">
      <span class="model-label">{label}</span>
      {#if chosen}<span class="badge" data-tone="accent">Selected</span>{/if}
    </div>
    <span class="model-name" title={model}>{model}</span>
  </div>
  <strong class="model-kcal">{fmtKcal(total.kcal)}</strong>
  <p class="model-confidence">{confidenceLabel}</p>
  <p class="model-macros">
    Protein {fmtMacro(total.protein_g)} · Carbs {fmtMacro(total.carbs_g)} · Fat {fmtMacro(total.fat_g)}
  </p>
  {#if notes}<p class="model-notes">{notes}</p>{/if}
</section>

<style>
  .model-heading-row {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .model-macros {
    margin: calc(var(--space-2) * -1) 0 var(--space-3);
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    line-height: 1.5;
  }
</style>
