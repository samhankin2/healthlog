<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import LogWeightPanel from '../lib/panels/LogWeightPanel.svelte'
  import MealPanel from '../lib/panels/MealPanel.svelte'
  import ConfirmPanel from '../lib/panels/ConfirmPanel.svelte'
  import { actions, app } from '../lib/state.svelte'
  import { fmtKg, fmtLong, fmtMacro, fmtNumber, fmtTime, today } from '../lib/format'
  import { showToast } from '../lib/toast.svelte'
  import type { Meal, MealPatch, WeightEntry } from '../lib/types'

  interface MonthGroup { key: string; label: string; entries: WeightEntry[] }

  let logOpen = $state(false)
  let editingWeight = $state<WeightEntry | null>(null)
  let deletingWeight = $state<WeightEntry | null>(null)
  let selectedDay = $state(today())
  let mealsLoading = $state(true)
  let mealsError = $state('')
  let editingMeal = $state<Meal | null>(null)
  let deletingMeal = $state<Meal | null>(null)
  let latestWeight = $derived([...app.weights].sort((a, b) => b.date.localeCompare(a.date))[0])
  let groups = $derived.by<MonthGroup[]>(() => {
    const byMonth = new Map<string, WeightEntry[]>()
    for (const entry of [...app.weights].sort((a, b) => b.date.localeCompare(a.date))) {
      const key = entry.date.slice(0, 7)
      byMonth.set(key, [...(byMonth.get(key) ?? []), entry])
    }
    return Array.from(byMonth, ([key, entries]) => {
      const [year, month] = key.split('-').map(Number)
      return {
        key,
        entries,
        label: new Date(year, (month ?? 1) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
      }
    })
  })

  onMount(() => { void loadMeals() })

  async function loadMeals(): Promise<void> {
    mealsLoading = true
    mealsError = ''
    try { await actions.loadMeals(selectedDay) } catch (error) {
      mealsError = error instanceof Error ? error.message : 'Could not load meals for this day.'
    } finally {
      mealsLoading = false
    }
  }

  async function changeDay(): Promise<void> {
    editingMeal = null
    await loadMeals()
  }

  function openLog(entry: WeightEntry | null = null): void {
    editingWeight = entry
    logOpen = true
  }

  async function refreshDashboard(): Promise<void> {
    await actions.loadDashboard(Math.max(1, app.profile?.chartWindowDays ?? 90))
  }

  async function saveWeight(date: string, weightKg: number, note: string): Promise<void> {
    const target = editingWeight ?? app.weights.find((entry) => entry.date === date) ?? null
    if (target) await actions.updateWeight(target.id, { date, weightKg, note: note || null })
    else await actions.createWeight({ date, weightKg, note: note || null })
    await refreshDashboard()
    logOpen = false
    editingWeight = null
    showToast('Weigh-in saved.', 'success')
  }

  async function deleteWeight(): Promise<void> {
    const target = deletingWeight ?? editingWeight
    if (!target) return
    await actions.deleteWeight(target.id)
    await refreshDashboard()
    deletingWeight = null
    logOpen = false
    editingWeight = null
    showToast('Weigh-in deleted.', 'success')
  }

  async function saveMeal(patch: MealPatch): Promise<void> {
    if (!editingMeal) return
    await actions.updateMeal(editingMeal.id, patch)
    await loadMeals()
    await refreshDashboard()
    editingMeal = null
    showToast('Meal updated.', 'success')
  }

  async function deleteMeal(): Promise<void> {
    if (!deletingMeal) return
    await actions.deleteMeal(deletingMeal.id)
    await loadMeals()
    await refreshDashboard()
    deletingMeal = null
    showToast('Meal deleted.', 'success')
  }

  function sourceLabel(meal: Meal): string {
    if (meal.source === 'ai') return 'AI estimate'
    if (meal.source === 'import') return 'Imported'
    if (meal.source === 'saved_food') return 'Saved food'
    if (meal.source === 'cronometer') return 'Cronometer'
    return 'Manual'
  }
</script>

<div class="view view--history">
  <header class="view-header history-header">
    <div><h1 class="view-title">History</h1><p class="view-subtitle">Your weigh-ins and meals, with room to correct the record.</p></div>
    <button class="button button--primary" type="button" onclick={() => openLog()}><Icon name="plus" size={19} /> Log weight</button>
  </header>

  <div class="history-layout">
    <section class="weights-history" aria-labelledby="weigh-ins-title">
      <div class="section-heading"><h2 id="weigh-ins-title">Weigh-ins</h2><span class="badge">{app.weights.length} total</span></div>
      {#if groups.length === 0}
        <div class="empty-state compact-empty">
          <span class="empty-state-icon"><Icon name="scale" size={27} /></span>
          <h3 class="empty-state-title">No history yet</h3>
          <p class="empty-state-message">Once you log a weight it will show up here.</p>
          <button class="button button--primary" type="button" onclick={() => openLog()}>Record first weight</button>
        </div>
      {:else}
        <div class="month-groups">
          {#each groups as group (group.key)}
            <section class="history-group" aria-labelledby={`month-${group.key}`}>
              <h3 class="history-month" id={`month-${group.key}`}>{group.label}</h3>
              <ul class="entry-list">
                {#each group.entries as entry (entry.id)}
                  <li class="entry-row">
                    <div class="entry-date-block"><strong>{Number(entry.date.slice(8, 10))}</strong><span>{fmtLong(entry.date).split(' ')[1]} {entry.date.slice(0, 4)}</span></div>
                    <div class="entry-copy">
                      <strong>{fmtKg(entry.weightKg)}</strong>
                      <span>{entry.note || 'No note'}</span>
                    </div>
                    <button class="icon-button" type="button" aria-label={`Edit weigh-in for ${fmtLong(entry.date)}, ${fmtKg(entry.weightKg)}`} onclick={() => openLog(entry)}><Icon name="edit" size={18} /></button>
                    <button class="icon-button danger-icon" type="button" aria-label={`Delete weigh-in for ${fmtLong(entry.date)}`} onclick={() => { deletingWeight = entry }}><Icon name="trash" size={18} /></button>
                  </li>
                {/each}
              </ul>
            </section>
          {/each}
        </div>
      {/if}
    </section>

    <section class="meals-history" aria-labelledby="meals-title">
      <div class="section-heading meals-heading">
        <div><h2 id="meals-title">Meals by day</h2><p>Choose a day to review its food log.</p></div>
        <input class="field-input day-picker" type="date" aria-label="Day to show meals" bind:value={selectedDay} onchange={changeDay} />
      </div>
      {#if mealsLoading}
        <div class="meals-loading" role="status"><span class="spinner" aria-hidden="true"></span> Loading meals…</div>
      {:else if mealsError}
        <div class="form-error" role="alert"><Icon name="alert" size={19} /><span>{mealsError}</span></div>
        <button class="button button--secondary" type="button" onclick={loadMeals}>Try again</button>
      {:else if app.meals.length === 0}
        <div class="empty-state compact-empty">
          <span class="empty-state-icon"><Icon name="food" size={27} /></span>
          <h3 class="empty-state-title">Nothing logged this day</h3>
          <p class="empty-state-message">Meals you save from Chat or import will appear here.</p>
        </div>
      {:else}
        <ul class="meal-list">
          {#each app.meals as meal (meal.id)}
            <li class="meal-card">
              <div class="meal-topline">
                <div class="meal-title"><strong>{meal.name}</strong><span>{fmtTime(meal.eatenAt) || meal.day} · {sourceLabel(meal)}</span></div>
                <strong class="meal-kcal">{fmtNumber(meal.kcal, 0)} <span>kcal</span></strong>
              </div>
              {#if meal.description}<p class="meal-description">{meal.description}</p>{/if}
              <dl class="meal-macros">
                <div><dt>Protein</dt><dd>{fmtMacro(meal.proteinG)}</dd></div>
                <div><dt>Carbs</dt><dd>{fmtMacro(meal.carbsG)}</dd></div>
                <div><dt>Fat</dt><dd>{fmtMacro(meal.fatG)}</dd></div>
              </dl>
              <div class="meal-actions">
                <button class="button button--secondary" type="button" aria-label={`Edit ${meal.name}`} onclick={() => { editingMeal = meal }}><Icon name="edit" size={17} /> Edit</button>
                <button class="icon-button danger-icon" type="button" aria-label={`Delete ${meal.name}`} onclick={() => { deletingMeal = meal }}><Icon name="trash" size={18} /></button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</div>

<LogWeightPanel open={logOpen} initialDate={editingWeight?.date ?? today()} existing={editingWeight} prefillKg={latestWeight?.weightKg ?? 0} onclose={() => { logOpen = false; editingWeight = null }} onsave={saveWeight} ondelete={editingWeight ? deleteWeight : undefined} />
{#if editingMeal}<MealPanel open meal={editingMeal} onclose={() => { editingMeal = null }} onsave={saveMeal} />{/if}
<ConfirmPanel open={deletingWeight !== null} title="Delete this weigh-in?" message={deletingWeight ? `The ${fmtLong(deletingWeight.date)} entry at ${fmtKg(deletingWeight.weightKg)} will be permanently removed.` : ''} confirmLabel="Delete weigh-in" danger oncancel={() => { deletingWeight = null }} onconfirm={deleteWeight} />
<ConfirmPanel open={deletingMeal !== null} title="Delete this meal?" message={deletingMeal ? `${deletingMeal.name} and its nutrition totals will be permanently removed.` : ''} confirmLabel="Delete meal" danger oncancel={() => { deletingMeal = null }} onconfirm={deleteMeal} />

<style>
  .history-header { flex-direction: row; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .history-header .button { flex: 0 0 auto; }
  .history-layout { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); gap: var(--space-8); }
  .weights-history, .meals-history { min-width: 0; }
  .section-heading { display: flex; margin-bottom: var(--space-4); align-items: center; justify-content: space-between; gap: var(--space-3); }
  .section-heading h2 { margin: 0; font-size: var(--text-xl); letter-spacing: -0.025em; }
  .month-groups { display: flex; flex-direction: column; gap: var(--space-6); }
  .history-month { margin: 0 0 var(--space-2); color: var(--color-text-muted); font-size: var(--text-sm); font-weight: var(--weight-semibold); }
  .entry-list { margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); list-style: none; }
  .entry-row { display: flex; min-width: 0; min-height: 4.5rem; padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4); align-items: center; gap: var(--space-2); border-top: 1px solid var(--color-border); }
  .entry-row:first-child { border-top: 0; }
  .entry-date-block { display: flex; width: 3rem; flex: 0 0 auto; align-items: center; flex-direction: column; line-height: 1.25; }
  .entry-date-block strong { font-size: var(--text-xl); font-variant-numeric: tabular-nums; }
  .entry-date-block span { color: var(--color-text-muted); font-size: 0.65rem; }
  .entry-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; }
  .entry-copy strong { font-variant-numeric: tabular-nums; }
  .entry-copy span { overflow: hidden; color: var(--color-text-muted); font-size: var(--text-sm); text-overflow: ellipsis; white-space: nowrap; }
  .danger-icon:hover { color: var(--color-danger); }
  .compact-empty { min-height: 15rem; }
  .meals-heading { align-items: flex-end; flex-wrap: wrap; }
  .meals-heading p { margin: var(--space-1) 0 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .day-picker { width: auto; min-width: 10rem; }
  .meals-loading { display: flex; min-height: 10rem; align-items: center; justify-content: center; gap: var(--space-3); color: var(--color-text-muted); }
  .meal-list { display: flex; margin: 0; padding: 0; flex-direction: column; gap: var(--space-3); list-style: none; }
  .meal-card { padding: var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .meal-topline { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
  .meal-title { display: flex; min-width: 0; flex-direction: column; }
  .meal-title > strong { overflow-wrap: anywhere; }
  .meal-title span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .meal-kcal { flex: 0 0 auto; font-size: var(--text-lg); font-variant-numeric: tabular-nums; }
  .meal-kcal span { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-regular); }
  .meal-description { margin: var(--space-3) 0 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .meal-macros { display: grid; margin: var(--space-4) 0 0; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
  .meal-macros div { padding: var(--space-2); border-radius: var(--radius-sm); background: var(--color-surface-sunken); }
  .meal-macros dt { color: var(--color-text-muted); font-size: var(--text-xs); }
  .meal-macros dd { margin: 0; font-size: var(--text-sm); font-variant-numeric: tabular-nums; font-weight: var(--weight-semibold); }
  .meal-actions { display: flex; margin-top: var(--space-3); align-items: center; justify-content: flex-end; gap: var(--space-2); }
  @media (max-width: 30rem) {
    .history-header { align-items: flex-start; flex-direction: column; }
    .history-header .button { width: 100%; }
    .entry-row { padding-left: var(--space-2); gap: var(--space-1); }
    .entry-date-block { width: 2.5rem; }
  }
  @media (min-width: 70rem) {
    .history-layout { grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr); align-items: start; }
    .meals-history { position: sticky; top: var(--space-6); }
  }
</style>
