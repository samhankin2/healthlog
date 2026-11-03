<script lang="ts">
  import type { Analysis, ChatMessage, ModelOutput } from '../types'
  import { fmtKcal, fmtNumber } from '../format'
  import Button from '../components/Button.svelte'
  import Icon from '../components/Icon.svelte'
  import MacroBar from '../components/MacroBar.svelte'
  import ModelCard from '../components/ModelCard.svelte'

  interface Props {
    message: ChatMessage
    analysis: Analysis
    saved: boolean
    busy?: boolean
    onsave: () => void
    onedit: () => void
    onaskagain: () => void
  }

  let { message, analysis, saved, busy = false, onsave, onedit, onaskagain }: Props = $props()

  function isModelOutput(output: Analysis['modelAOutput']): output is ModelOutput {
    return !('error' in output)
  }

  const modelA = $derived(isModelOutput(analysis.modelAOutput) ? analysis.modelAOutput : null)
  const modelB = $derived(isModelOutput(analysis.modelBOutput) ? analysis.modelBOutput : null)
  const splitMeals = $derived(analysis.reconciled?.meals ?? [])
  const assumption = $derived(modelA?.notes || modelB?.notes || '')
  const agreement = $derived(`${analysis.agreement[0]?.toUpperCase() ?? ''}${analysis.agreement.slice(1)} agreement`)
  const agreementTone = $derived(
    analysis.agreement === 'high' ? 'success' : analysis.agreement === 'medium' ? 'warning' : 'delta',
  )
</script>

<div class="message-bubble assistant-result">
  {#if analysis.reconciled}
    <MacroBar
      kcal={analysis.reconciled.total.kcal}
      protein={analysis.reconciled.total.protein_g}
      carbs={analysis.reconciled.total.carbs_g}
      fat={analysis.reconciled.total.fat_g}
    />

    <article class="model-card">
      <div class="model-card-header">
        <h3 class="model-card-title">Two estimates, compared</h3>
        <span class="badge" data-tone={agreementTone}>
          {agreement} · {fmtNumber(analysis.deltaPct, 1)}% apart
        </span>
      </div>
      <div class="model-grid">
        {#if modelA}
          <ModelCard
            label="Model A"
            model={analysis.modelA}
            total={modelA.total}
            confidence={modelA.confidence}
            notes={modelA.notes}
            chosen={!modelB}
          />
        {:else}
          <section class="model-panel model-panel--error" aria-label="Model A estimate unavailable">
            <div class="model-panel-heading">
              <span class="model-label">Model A</span>
              <span class="model-name" title={analysis.modelA}>{analysis.modelA}</span>
            </div>
            <p class="model-error">{'error' in analysis.modelAOutput ? analysis.modelAOutput.error : 'Estimate unavailable.'}</p>
          </section>
        {/if}

        {#if modelB}
          <ModelCard
            label="Model B"
            model={analysis.modelB}
            total={modelB.total}
            confidence={modelB.confidence}
            notes={modelB.notes}
            chosen={!modelA}
          />
        {:else}
          <section class="model-panel model-panel--error" aria-label="Model B estimate unavailable">
            <div class="model-panel-heading">
              <span class="model-label">Model B</span>
              <span class="model-name" title={analysis.modelB}>{analysis.modelB}</span>
            </div>
            <p class="model-error">{'error' in analysis.modelBOutput ? analysis.modelBOutput.error : 'Estimate unavailable.'}</p>
          </section>
        {/if}
      </div>
      {#if analysis.comparison}<p class="model-comparison">{analysis.comparison}</p>{/if}
    </article>

    {#if assumption}
      <div class="analysis-note">
        <strong>Assumption</strong>
        <p>{assumption}</p>
      </div>
    {/if}

    {#if splitMeals.length > 1}
      <section class="item-breakdown" aria-labelledby="breakdown-{analysis.id}">
        <h3 id="breakdown-{analysis.id}">Logged as {splitMeals.length} separate meals</h3>
        <ul>
          {#each splitMeals as group, index (index)}
            <li>
              <div class="item-copy">
                <strong>{group.name || group.items[0]?.name || `Meal ${index + 1}`}</strong>
                <span>
                  P {fmtNumber(group.total.protein_g, 0)} g · C {fmtNumber(group.total.carbs_g, 0)} g · F {fmtNumber(group.total.fat_g, 0)} g
                  {#if group.items.length > 1} · {group.items.map((item) => item.name).join(', ')}{/if}
                </span>
              </div>
              <span class="item-kcal">{fmtKcal(group.total.kcal)}</span>
            </li>
          {/each}
        </ul>
      </section>
    {:else if analysis.reconciled.items.length > 0}
      <section class="item-breakdown" aria-labelledby="breakdown-{analysis.id}">
        <h3 id="breakdown-{analysis.id}">Item breakdown</h3>
        <ul>
          {#each analysis.reconciled.items as item (item)}
            <li>
              <div class="item-copy">
                <strong>{item.name}</strong>
                {#if item.quantity}<span>{item.quantity}</span>{/if}
              </div>
              <span class="item-kcal">{fmtKcal(item.kcal)}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <div class="analysis-actions">
      {#if !saved}
        <Button onclick={onsave} disabled={busy}>
          <Icon name="plus" size={18} /> Save meal
        </Button>
      {:else}
        <span class="badge" data-tone="success"><Icon name="check" size={15} /> Meal saved</span>
      {/if}
      {#if splitMeals.length <= 1}
        <Button variant="secondary" onclick={onedit} disabled={busy}>
          <Icon name="edit" size={17} /> Edit
        </Button>
      {/if}
      <Button variant="ghost" onclick={onaskagain} disabled={busy}>
        <Icon name="sparkles" size={17} /> Ask again
      </Button>
    </div>
  {:else}
    <p class="fallback-copy">{message.content}</p>
    <article class="model-card">
      <div class="model-card-header">
        <h3 class="model-card-title">No estimate this time</h3>
        <span class="badge" data-tone="danger">Nothing saved</span>
      </div>
      {#if analysis.comparison}<p class="model-comparison">{analysis.comparison}</p>{/if}
    </article>
    <div class="analysis-actions">
      <Button variant="secondary" onclick={onaskagain} disabled={busy}>
        <Icon name="sparkles" size={17} /> Ask again
      </Button>
    </div>
  {/if}
</div>

<style>
  .assistant-result {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: var(--space-5);
    white-space: normal;
  }

  .analysis-note {
    padding-left: var(--space-3);
    border-left: 3px solid var(--color-accent);
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .analysis-note strong {
    color: var(--color-text);
  }

  .analysis-note p {
    margin: var(--space-1) 0 0;
  }

  .item-breakdown h3 {
    margin-bottom: var(--space-2);
    font-size: var(--text-sm);
  }

  .item-breakdown ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .item-breakdown li {
    display: flex;
    padding: var(--space-2) 0;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    border-top: 1px solid var(--color-border);
    font-size: var(--text-sm);
  }

  .item-copy {
    display: flex;
    min-width: 0;
    flex-direction: column;
  }

  .item-copy span {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
  }

  .item-kcal {
    flex: 0 0 auto;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .analysis-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .fallback-copy {
    margin: 0;
    white-space: pre-wrap;
  }

  .model-error {
    overflow-wrap: anywhere;
  }
</style>
