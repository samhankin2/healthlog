<script lang="ts">
  import Icon from './Icon.svelte'
  import SegmentedControl from './SegmentedControl.svelte'
  import Sheet from './Sheet.svelte'
  import MealPanel from '../panels/MealPanel.svelte'
  import { acceptShared, dismissShared, sharing } from '../sharing.svelte'
  import { fmtNumber, fmtRelative } from '../format'
  import { showToast } from '../toast.svelte'
  import type { Meal, MealItemInput, MealPatch, SharedMeal } from '../types'

  // Your share of the dish, relative to what your partner logged.
  const PORTIONS = [
    { value: '0.5', label: '½' },
    { value: '0.75', label: '¾' },
    { value: '1', label: 'Same' },
    { value: '1.25', label: '1¼' },
    { value: '1.5', label: '1½' },
  ]
  const PORTION_TEXT: Record<string, string> = { '0.5': '½', '0.75': '¾', '1.25': '1¼', '1.5': '1½' }

  interface Props {
    /** One-line notification that opens the cards in a sheet (the chat, where space is short). */
    compact?: boolean
  }
  let { compact = false }: Props = $props()

  let reviewing = $state(false)
  let portions = $state<Record<string, string>>({})
  let busy = $state<string | null>(null)
  let adjusting = $state<SharedMeal | null>(null)

  // This component sits inside a `.view`, whose entry animation leaves a
  // transform on it — a stacking context that would put the sheets under the
  // tab bar. Render them at the end of <body> instead, like the other sheets.
  function portal(node: HTMLElement): { destroy: () => void } {
    document.body.appendChild(node)
    return { destroy: () => node.remove() }
  }

  const r1 = (n: number): number => Math.round(n * 10) / 10
  const portionOf = (share: SharedMeal): string => portions[share.id] ?? '1'

  function scaledItems(share: SharedMeal): MealItemInput[] {
    const key = portionOf(share)
    const k = Number(key)
    return share.meal.items.map((item) => ({
      name: item.name,
      quantity: k === 1 ? item.quantity : `${PORTION_TEXT[key]} of ${item.quantity ?? 'the portion'}`,
      kcal: r1(item.kcal * k),
      proteinG: r1(item.proteinG * k),
      carbsG: r1(item.carbsG * k),
      fatG: r1(item.fatG * k),
    }))
  }

  function scaled(share: SharedMeal): MealPatch {
    const k = Number(portionOf(share))
    return {
      kcal: r1(share.meal.kcal * k),
      proteinG: r1(share.meal.proteinG * k),
      carbsG: r1(share.meal.carbsG * k),
      fatG: r1(share.meal.fatG * k),
      items: scaledItems(share),
    }
  }

  /** The shared meal at the chosen portion, shaped for the edit sheet. */
  function draftMeal(share: SharedMeal): Meal {
    const s = scaled(share)
    return {
      ...share.meal,
      kcal: s.kcal ?? 0,
      proteinG: s.proteinG ?? 0,
      carbsG: s.carbsG ?? 0,
      fatG: s.fatG ?? 0,
      confidence: null,
    }
  }

  async function accept(share: SharedMeal, patch: MealPatch): Promise<void> {
    busy = share.id
    try {
      await acceptShared(share.id, patch)
      showToast(`${share.meal.name} added to your log`, 'success')
    } finally {
      busy = null
    }
  }

  async function quickAdd(share: SharedMeal): Promise<void> {
    if (busy) return
    try {
      await accept(share, scaled(share))
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not add that meal.', 'error')
    }
  }

  // The sheet shows its own error, so let a failure propagate to it.
  async function saveAdjusted(patch: MealPatch): Promise<void> {
    if (!adjusting) return
    const share = adjusting
    await accept(share, { ...patch, items: scaledItems(share) })
    adjusting = null
  }

  async function dismiss(share: SharedMeal): Promise<void> {
    if (busy) return
    busy = share.id
    try {
      await dismissShared(share.id)
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not dismiss that meal.', 'error')
    } finally {
      busy = null
    }
  }
</script>

{#snippet cards()}
  <div class="shared-list">
    {#each sharing.inbox as share (share.id)}
      {@const view = scaled(share)}
      <article class="shared-card" aria-labelledby="shared-{share.id}">
        <header class="shared-head">
          <span class="shared-icon" aria-hidden="true"><Icon name="heart" size={18} /></span>
          <p class="shared-from">
            <strong>{share.from.name}</strong> shared a meal · {fmtRelative(share.meal.day)}
          </p>
        </header>
        <div class="shared-body">
          <div class="shared-copy">
            <h2 class="shared-name" id="shared-{share.id}">{share.meal.name}</h2>
            <p class="shared-macros">
              P {fmtNumber(view.proteinG ?? 0, 0)} g · C {fmtNumber(view.carbsG ?? 0, 0)} g · F {fmtNumber(view.fatG ?? 0, 0)} g
            </p>
            {#if share.meal.items.length > 1}
              <p class="shared-items">{share.meal.items.map((item) => item.name).join(', ')}</p>
            {/if}
          </div>
          <span class="shared-kcal">{fmtNumber(view.kcal ?? 0, 0)} <span>kcal</span></span>
        </div>
        <div class="shared-portion">
          <span class="shared-portion-label">Your portion</span>
          <SegmentedControl
            options={PORTIONS}
            value={portionOf(share)}
            ariaLabel={`Your portion of ${share.meal.name} compared with ${share.from.name}'s`}
            onchange={(value) => { portions[share.id] = value }}
          />
        </div>
        <div class="shared-actions">
          <button class="button button--primary" type="button" disabled={busy === share.id} onclick={() => quickAdd(share)}>
            <Icon name="plus" size={18} /> Add to my log
          </button>
          <button class="button button--secondary" type="button" disabled={busy === share.id} onclick={() => { adjusting = share }}>
            <Icon name="edit" size={17} /> Correct
          </button>
          <button class="button button--ghost" type="button" disabled={busy === share.id} onclick={() => dismiss(share)}>
            Not for me
          </button>
        </div>
      </article>
    {/each}
  </div>
{/snippet}

{#if sharing.inbox.length > 0}
  {@const first = sharing.inbox[0]}
  {@const others = sharing.inbox.length - 1}
  <section class="shared-inbox" aria-label="Meals shared with you">
    {#if compact}
      <div class="shared-banner" role="status">
        <span class="shared-icon" aria-hidden="true"><Icon name="heart" size={18} /></span>
        <p class="shared-banner-copy">
          <strong>{first.from.name}</strong> shared <strong>{first.meal.name}</strong>{#if others > 0}{' '}and {others} more{/if}
        </p>
        <button class="button button--primary shared-banner-button" type="button" onclick={() => { reviewing = true }}>Review</button>
      </div>
    {:else}
      {@render cards()}
    {/if}
  </section>
{/if}

{#if compact}
  <div use:portal>
  <Sheet
    open={reviewing && sharing.inbox.length > 0}
    title={sharing.inbox.length > 1 ? 'Shared meals' : 'Shared meal'}
    subtitle="Add it with your own portion, correct it first, or skip it."
    onclose={() => { reviewing = false }}
  >
    {@render cards()}
  </Sheet>
  </div>
{/if}

{#if adjusting}
  <div use:portal>
  <MealPanel
    open
    meal={draftMeal(adjusting)}
    title="Correct before adding"
    subtitle={`Change anything that was different for you. ${adjusting.from.name}'s entry stays as it is.`}
    saveLabel="Add to my log"
    onclose={() => { adjusting = null }}
    onsave={saveAdjusted}
  />
  </div>
{/if}

<style>
  .shared-inbox,
  .shared-list {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--space-3);
  }

  .shared-banner {
    display: flex;
    padding: var(--space-3);
    align-items: center;
    gap: var(--space-3);
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-accent);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .shared-banner-copy {
    display: -webkit-box;
    min-width: 0;
    flex: 1 1 auto;
    margin: 0;
    overflow: hidden;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }

  .shared-banner-button {
    flex: 0 0 auto;
  }

  .shared-card {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-accent);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .shared-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .shared-icon {
    display: inline-flex;
    color: var(--color-accent);
  }

  .shared-from {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .shared-from strong {
    color: var(--color-text);
  }

  .shared-body {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .shared-copy {
    min-width: 0;
  }

  .shared-name {
    margin: 0;
    font-size: var(--text-lg);
    overflow-wrap: anywhere;
  }

  .shared-macros,
  .shared-items {
    margin: var(--space-1) 0 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .shared-items {
    font-size: var(--text-xs);
    overflow-wrap: anywhere;
  }

  .shared-kcal {
    flex: 0 0 auto;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .shared-kcal span {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    font-weight: normal;
  }

  .shared-portion {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--space-2);
  }

  .shared-portion-label {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
  }

  .shared-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
