<script lang="ts">
  import Sheet from '../components/Sheet.svelte'
  import type { Meal, MealPatch } from '../types'

  interface Props {
    open: boolean
    meal: Meal
    onclose: () => void
    onsave: (patch: MealPatch) => Promise<void>
  }
  let { open, meal, onclose, onsave }: Props = $props()
  let name = $state('')
  let day = $state('')
  let description = $state('')
  let kcal = $state('')
  let protein = $state('')
  let carbs = $state('')
  let fat = $state('')
  let saving = $state(false)
  let error = $state('')

  $effect(() => {
    if (open) {
      name = meal.name
      day = meal.day
      description = meal.description ?? ''
      kcal = String(meal.kcal)
      protein = String(meal.proteinG)
      carbs = String(meal.carbsG)
      fat = String(meal.fatG)
      saving = false
      error = ''
    }
  })

  function validNumber(value: string): boolean {
    const parsed = Number(value)
    return value.trim() !== '' && Number.isFinite(parsed) && parsed >= 0
  }

  async function save(): Promise<void> {
    if (saving) return
    if (!name.trim()) { error = 'Give this meal a name.'; return }
    if (![kcal, protein, carbs, fat].every(validNumber)) { error = 'Calories and macros must be zero or positive numbers.'; return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { error = 'Choose a valid day.'; return }
    saving = true
    error = ''
    try {
      await onsave({
        name: name.trim(),
        day,
        eatenAt: `${day}T12:00:00.000Z`,
        description: description.trim() || null,
        kcal: Number(kcal),
        proteinG: Number(protein),
        carbsG: Number(carbs),
        fatG: Number(fat),
      })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this meal.'
      saving = false
    }
  }
</script>

<Sheet {open} title="Edit meal" subtitle="Adjust the estimate to match what you ate." onclose={() => { if (!saving) onclose() }}>
  <div class="meal-form">
    <div class="field"><label class="field-label" for="meal-name">Meal name</label><input class="field-input" id="meal-name" data-autofocus maxlength="200" bind:value={name} disabled={saving} /></div>
    <div class="field"><label class="field-label" for="meal-day">Day</label><input class="field-input" id="meal-day" type="date" bind:value={day} disabled={saving} /></div>
    <div class="field"><label class="field-label" for="meal-description">Description</label><textarea class="field-input meal-description" id="meal-description" rows="3" maxlength="2000" bind:value={description} disabled={saving}></textarea></div>
    <div class="field"><label class="field-label" for="meal-kcal">Calories</label><div class="field-with-unit"><input class="field-input" id="meal-kcal" type="number" inputmode="decimal" min="0" step="any" bind:value={kcal} disabled={saving} /><span class="field-unit">kcal</span></div></div>
    <div class="macro-grid">
      <div class="field"><label class="field-label" for="meal-protein">Protein</label><div class="field-with-unit"><input class="field-input" id="meal-protein" type="number" inputmode="decimal" min="0" step="any" bind:value={protein} disabled={saving} /><span class="field-unit">g</span></div></div>
      <div class="field"><label class="field-label" for="meal-carbs">Carbs</label><div class="field-with-unit"><input class="field-input" id="meal-carbs" type="number" inputmode="decimal" min="0" step="any" bind:value={carbs} disabled={saving} /><span class="field-unit">g</span></div></div>
      <div class="field"><label class="field-label" for="meal-fat">Fat</label><div class="field-with-unit"><input class="field-input" id="meal-fat" type="number" inputmode="decimal" min="0" step="any" bind:value={fat} disabled={saving} /><span class="field-unit">g</span></div></div>
    </div>
    {#if error}<p class="field-error" role="alert">{error}</p>{/if}
  </div>
  {#snippet actions()}
    <button class="button button--secondary" type="button" disabled={saving} onclick={onclose}>Cancel</button>
    <button class="button button--primary" type="button" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save meal'}</button>
  {/snippet}
</Sheet>

<style>
  .meal-form { display: flex; flex-direction: column; gap: var(--space-4); }
  .meal-description { resize: vertical; }
  .macro-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
  @media (max-width: 30rem) { .macro-grid { grid-template-columns: 1fr; } }
</style>
