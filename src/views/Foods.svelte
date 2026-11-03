<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import FoodPanel from '../lib/panels/FoodPanel.svelte'
  import CsvImportPanel from '../lib/panels/CsvImportPanel.svelte'
  import WeightJsonPanel from '../lib/panels/WeightJsonPanel.svelte'
  import ConfirmPanel from '../lib/panels/ConfirmPanel.svelte'
  import { actions, app } from '../lib/state.svelte'
  import { fmtMacro, fmtNumber, fmtRelative, today } from '../lib/format'
  import { groupEatenFoods, toFoodInput, type EatenFood } from '../lib/eatenFoods'
  import { showToast } from '../lib/toast.svelte'
  import type { Food, FoodInput, Meal } from '../lib/types'

  let addOpen = $state(false)
  let csvOpen = $state(false)
  let jsonOpen = $state(false)
  let deletingFood = $state<Food | null>(null)

  const EATEN_PAGE = 12
  let history = $state<Meal[]>([])
  let historyLoading = $state(true)
  let historyError = $state('')
  let search = $state('')
  let showAll = $state(false)
  let savingKey = $state<string | null>(null)

  let eaten = $derived(groupEatenFoods(history, app.foods))
  let savedCount = $derived(eaten.filter((food) => food.saved).length)
  let filtered = $derived.by(() => {
    const term = search.trim().toLocaleLowerCase()
    return term ? eaten.filter((food) => food.key.includes(term)) : eaten
  })
  let visible = $derived(showAll || search.trim() ? filtered : filtered.slice(0, EATEN_PAGE))

  onMount(() => {
    actions.loadFoods().catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : 'Could not load saved foods.', 'error')
    })
    void loadHistory()
  })

  async function loadHistory(): Promise<void> {
    historyLoading = true
    historyError = ''
    try {
      history = await actions.loadMealHistory()
    } catch (error) {
      historyError = error instanceof Error ? error.message : 'Could not load the foods you have eaten.'
    } finally {
      historyLoading = false
    }
  }

  async function saveEaten(food: EatenFood): Promise<void> {
    if (savingKey) return
    savingKey = food.key
    try {
      await actions.createFood(toFoodInput(food))
      showToast(`${food.name} saved to your library.`, 'success')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save this food.', 'error')
    } finally {
      savingKey = null
    }
  }

  function eatenDetail(food: EatenFood): string {
    const times = food.count === 1 ? 'Eaten once' : `Eaten ${food.count}×`
    const when = fmtRelative(food.lastDay)
    const last = when === 'Today' || when === 'Yesterday' ? when.toLowerCase() : when
    return `${times} · last ${last}${food.serving ? ` · ${food.serving}` : ''}`
  }

  let loggingId = $state<string | null>(null)

  /** One tap: log a saved food as a meal for today, with the library's exact numbers. */
  async function logFood(food: Food): Promise<void> {
    if (loggingId) return
    loggingId = food.id
    try {
      await actions.createMeal({
        name: food.name,
        description: food.serving,
        day: today(),
        eatenAt: new Date().toISOString(),
        kcal: food.kcal,
        proteinG: food.proteinG,
        carbsG: food.carbsG,
        fatG: food.fatG,
        source: 'saved_food',
        items: [
          {
            name: food.name,
            quantity: food.serving,
            kcal: food.kcal,
            proteinG: food.proteinG,
            carbsG: food.carbsG,
            fatG: food.fatG,
            foodId: food.id,
          },
        ],
      })
      showToast(`${food.name} logged for today.`, 'success')
      void actions.loadDashboard().catch(() => {})
      void loadHistory()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not log this food.', 'error')
    } finally {
      loggingId = null
    }
  }

  async function saveFood(input: FoodInput): Promise<void> {
    await actions.createFood(input)
    addOpen = false
    showToast('Food saved.', 'success')
  }

  async function deleteFood(): Promise<void> {
    if (!deletingFood) return
    await actions.deleteFood(deletingFood.id)
    deletingFood = null
    showToast('Saved food deleted.', 'success')
  }

  async function afterCsvImport(): Promise<void> {
    await Promise.all([
      loadHistory(),
      actions.loadMeals(today()),
      actions.loadDashboard(Math.max(1, app.profile?.chartWindowDays ?? 90)),
    ])
  }
</script>

<div class="view view--foods">
  <header class="view-header foods-header">
    <div><h1 class="view-title">Foods</h1><p class="view-subtitle">Your reusable food library and meal imports.</p></div>
    <div class="header-actions">
      <button class="button button--secondary" type="button" onclick={() => { csvOpen = true }}><Icon name="upload" size={18} /> Import CSV</button>
      <button class="button button--primary" type="button" onclick={() => { addOpen = true }}><Icon name="plus" size={19} /> Add food</button>
    </div>
  </header>

  <div class="foods-layout">
    <section class="foods-library" aria-labelledby="saved-foods-title">
      <div class="section-heading"><h2 id="saved-foods-title">Saved foods</h2><span class="badge">{app.foods.length} saved</span></div>
      {#if app.foods.length === 0 && (historyLoading || eaten.length > 0)}
        <p class="library-hint">No saved foods yet. Save any of the foods you've eaten below to reuse it.</p>
      {:else if app.foods.length === 0}
        <div class="empty-state">
          <span class="empty-state-icon"><Icon name="food" size={28} /></span>
          <h2 class="empty-state-title">Build your food library</h2>
          <p class="empty-state-message">Save a food you eat often, or bring in a CSV to create meals in bulk.</p>
          <div class="empty-actions">
            <button class="button button--primary" type="button" onclick={() => { addOpen = true }}>Add your first food</button>
            <button class="button button--secondary" type="button" onclick={() => { csvOpen = true }}>Import CSV</button>
          </div>
        </div>
      {:else}
        <ul class="food-list">
          {#each [...app.foods].sort((a, b) => a.name.localeCompare(b.name)) as food (food.id)}
            <li class="food-row">
              <div class="food-main">
                <div class="food-title"><strong>{food.name}</strong><span>{food.serving || 'Serving not set'}</span></div>
                <strong class="food-kcal">{fmtNumber(food.kcal, 0)} <span>kcal</span></strong>
              </div>
              <dl class="food-macros">
                <div><dt>Protein</dt><dd>{fmtMacro(food.proteinG)}</dd></div>
                <div><dt>Carbs</dt><dd>{fmtMacro(food.carbsG)}</dd></div>
                <div><dt>Fat</dt><dd>{fmtMacro(food.fatG)}</dd></div>
              </dl>
              <button
                class="button button--primary compact-button log-food"
                type="button"
                aria-label={`Log ${food.name} for today`}
                disabled={loggingId !== null}
                onclick={() => logFood(food)}
              >{#if loggingId === food.id}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="plus" size={17} />{/if} Log for today</button>
              <button class="icon-button delete-food" type="button" aria-label={`Delete saved food ${food.name}`} onclick={() => { deletingFood = food }}><Icon name="trash" size={18} /></button>
            </li>
          {/each}
        </ul>
      {/if}

      <section class="eaten-foods" aria-labelledby="eaten-foods-title">
        <div class="section-heading">
          <div><h2 id="eaten-foods-title">Foods you've eaten</h2><p class="section-note">From the meals you've logged in Chat, by import, or in History.</p></div>
          {#if eaten.length > 0}<span class="badge">{eaten.length} foods{savedCount > 0 ? ` · ${savedCount} saved` : ''}</span>{/if}
        </div>
        {#if historyLoading}
          <div class="eaten-loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading your meals…</div>
        {:else if historyError}
          <div class="form-error" role="alert"><Icon name="alert" size={19} /><span>{historyError}</span></div>
          <button class="button button--secondary" type="button" onclick={loadHistory}>Try again</button>
        {:else if eaten.length === 0}
          <p class="library-hint">Nothing logged yet. Meals you save from Chat or import by CSV will appear here.</p>
        {:else}
          {#if eaten.length > EATEN_PAGE}
            <input class="field-input eaten-search" type="search" placeholder="Search foods you've eaten" aria-label="Search foods you've eaten" bind:value={search} />
          {/if}
          {#if visible.length === 0}
            <p class="library-hint">No eaten foods match “{search.trim()}”.</p>
          {:else}
            <ul class="eaten-list">
              {#each visible as food (food.key)}
                <li class="eaten-row">
                  <div class="eaten-copy">
                    <strong>{food.name}</strong>
                    <span>{eatenDetail(food)}</span>
                    <span class="eaten-macros">{fmtNumber(food.kcal, 0)} kcal · P {fmtNumber(food.proteinG, 0)} g · C {fmtNumber(food.carbsG, 0)} g · F {fmtNumber(food.fatG, 0)} g</span>
                  </div>
                  {#if food.saved}
                    <span class="badge saved-badge"><Icon name="check" size={15} /> Saved</span>
                  {:else}
                    <button
                      class="button button--secondary compact-button"
                      type="button"
                      aria-label={`Save ${food.name} to your food library`}
                      disabled={savingKey !== null}
                      onclick={() => saveEaten(food)}
                    >{#if savingKey === food.key}<span class="spinner" aria-hidden="true"></span>{:else}<Icon name="plus" size={17} />{/if} Save</button>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if !search.trim() && filtered.length > EATEN_PAGE}
              <button class="button button--secondary show-more" type="button" onclick={() => { showAll = !showAll }}>
                {showAll ? 'Show fewer' : `Show all ${filtered.length}`}
              </button>
            {/if}
          {/if}
        {/if}
      </section>
    </section>

    <aside class="import-sidebar" aria-label="Import options">
      <section class="metric-card">
        <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="upload" size={20} /></span><h2 class="metric-card-title">Import meals</h2></div></div>
        <div class="metric-card-content">
          <p class="import-copy">Bring in a spreadsheet with a header row. You can check and change every detected column before anything is saved.</p>
          <ul class="import-notes"><li>Quoted fields and commas supported</li><li>Optional dates and serving sizes</li><li>Preview before importing</li></ul>
          <button class="button button--secondary full-button" type="button" onclick={() => { csvOpen = true }}><Icon name="upload" size={18} /> Choose CSV import</button>
        </div>
      </section>
      <section class="metric-card">
        <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="calendar" size={20} /></span><h2 class="metric-card-title">Old weight tracker</h2></div></div>
        <div class="metric-card-content">
          <p class="import-copy">Restore weigh-ins and training phases from the previous app’s JSON export.</p>
          <button class="button button--secondary full-button" type="button" onclick={() => { jsonOpen = true }}><Icon name="upload" size={18} /> Import JSON backup</button>
        </div>
      </section>
    </aside>
  </div>
</div>

<FoodPanel open={addOpen} onclose={() => { addOpen = false }} onsave={saveFood} />
<CsvImportPanel open={csvOpen} onclose={() => { csvOpen = false }} oncommitted={afterCsvImport} />
<WeightJsonPanel open={jsonOpen} onclose={() => { jsonOpen = false }} onimport={actions.importWeightJson} />
<ConfirmPanel open={deletingFood !== null} title="Delete this saved food?" message={deletingFood ? `${deletingFood.name} will be removed from your library. Meals already logged will stay.` : ''} confirmLabel="Delete food" danger oncancel={() => { deletingFood = null }} onconfirm={deleteFood} />

<style>
  .foods-header { flex-direction: row; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .header-actions { display: flex; flex: 0 0 auto; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
  .foods-layout { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); align-items: start; gap: var(--space-5); }
  .foods-library, .import-sidebar { min-width: 0; }
  .section-heading { display: flex; margin-bottom: var(--space-4); align-items: center; justify-content: space-between; gap: var(--space-3); }
  .section-heading h2 { margin: 0; font-size: var(--text-xl); letter-spacing: -0.025em; }
  .library-hint { margin: 0; padding: var(--space-4); border: 1px dashed var(--color-border-strong); border-radius: var(--radius-card); color: var(--color-text-muted); font-size: var(--text-sm); }
  .eaten-foods { margin-top: var(--space-8); }
  .eaten-foods .section-heading { align-items: flex-end; flex-wrap: wrap; }
  .section-note { margin: var(--space-1) 0 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .eaten-loading { display: flex; min-height: 8rem; align-items: center; justify-content: center; gap: var(--space-3); color: var(--color-text-muted); }
  .eaten-search { margin-bottom: var(--space-3); }
  .eaten-list { margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); list-style: none; }
  .eaten-row { display: flex; min-width: 0; min-height: 4.5rem; padding: var(--space-3) var(--space-4); align-items: center; gap: var(--space-3); border-top: 1px solid var(--color-border); }
  .eaten-row:first-child { border-top: 0; }
  .eaten-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
  .eaten-copy strong { overflow-wrap: anywhere; }
  .eaten-copy span { color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .eaten-copy .eaten-macros { color: var(--color-text); }
  .compact-button { flex: 0 0 auto; min-height: var(--touch-target); padding: var(--space-2) var(--space-3); }
  .saved-badge { display: inline-flex; flex: 0 0 auto; align-items: center; gap: var(--space-1); }
  .show-more { margin-top: var(--space-3); }
  .empty-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-2); }
  .food-list { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-3); list-style: none; }
  .food-row { position: relative; display: grid; min-width: 0; padding: var(--space-4); grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .food-main { display: flex; min-width: 0; grid-column: 1 / -1; padding-right: 2.75rem; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
  .food-title { display: flex; min-width: 0; flex-direction: column; }
  .food-title > strong { overflow-wrap: anywhere; }
  .food-title span { color: var(--color-text-muted); font-size: var(--text-sm); }
  .food-kcal { flex: 0 0 auto; font-size: var(--text-lg); font-variant-numeric: tabular-nums; }
  .food-kcal span { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-regular); }
  .food-macros { display: grid; margin: 0; grid-column: 1 / -1; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
  .food-macros div { min-width: 0; padding: var(--space-2); border-radius: var(--radius-sm); background: var(--color-surface-sunken); }
  .food-macros dt { color: var(--color-text-muted); font-size: var(--text-xs); }
  .food-macros dd { margin: 0; font-size: var(--text-sm); font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); }
  .log-food { grid-column: 1 / -1; justify-self: start; }
  .delete-food { position: absolute; top: var(--space-2); right: var(--space-2); }
  .delete-food:hover { color: var(--color-danger); }
  .import-sidebar { display: flex; flex-direction: column; gap: var(--space-4); }
  .import-copy { margin: 0 0 var(--space-4); color: var(--color-text-muted); font-size: var(--text-sm); }
  .import-notes { margin: 0 0 var(--space-4); padding-left: var(--space-5); color: var(--color-text-muted); font-size: var(--text-sm); }
  .full-button { width: 100%; }
  @media (max-width: 43.75rem) {
    .foods-header { align-items: flex-start; flex-direction: column; }
    .header-actions { width: 100%; justify-content: flex-start; }
    .header-actions .button { flex: 1 1 9rem; }
  }
  @media (min-width: 70rem) {
    .foods-layout { grid-template-columns: minmax(0, 1fr) 20rem; gap: var(--space-6); }
    .import-sidebar { position: sticky; top: var(--space-6); }
  }
</style>
