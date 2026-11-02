<script lang="ts">
  import Sheet from '../components/Sheet.svelte'
  import type { FoodInput } from '../types'

  interface Props {
    open: boolean
    onclose: () => void
    onsave: (input: FoodInput) => Promise<void>
  }
  let { open, onclose, onsave }: Props = $props()
  let name = $state('')
  let serving = $state('')
  let kcal = $state('')
  let protein = $state('')
  let carbs = $state('')
  let fat = $state('')
  let saving = $state(false)
  let error = $state('')

  $effect(() => {
    if (open) {
      name = ''
      serving = ''
      kcal = ''
      protein = ''
      carbs = ''
      fat = ''
      saving = false
      error = ''
    }
  })

  function number(value: string, fallback = 0): number | null {
    if (!value.trim()) return fallback
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }

  async function save(): Promise<void> {
    if (saving) return
    const calories = number(kcal)
    const proteinG = number(protein)
    const carbsG = number(carbs)
    const fatG = number(fat)
    if (!name.trim()) { error = 'Give this food a name.'; return }
    if (calories === null || proteinG === null || carbsG === null || fatG === null) {
      error = 'Calories and macros must be zero or positive numbers.'
      return
    }
    saving = true
    error = ''
    try {
      await onsave({ name: name.trim(), serving: serving.trim() || null, kcal: calories, proteinG, carbsG, fatG })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this food.'
      saving = false
    }
  }
</script>

<Sheet {open} title="Add a saved food" subtitle="Keep the foods you reach for often close at hand." onclose={() => { if (!saving) onclose() }}>
  <form class="food-form" onsubmit={(event) => { event.preventDefault(); void save() }}>
    <div class="field">
      <label class="field-label" for="food-name">Food name</label>
      <input class="field-input" id="food-name" data-autofocus required maxlength="200" placeholder="e.g. Overnight oats" bind:value={name} disabled={saving} />
    </div>
    <div class="form-grid">
      <div class="field">
        <label class="field-label" for="food-serving">Serving</label>
        <input class="field-input" id="food-serving" placeholder="e.g. 1 bowl" bind:value={serving} disabled={saving} />
      </div>
      <div class="field">
        <label class="field-label" for="food-kcal">Calories</label>
        <div class="field-with-unit"><input class="field-input" id="food-kcal" type="number" inputmode="decimal" min="0" step="any" required bind:value={kcal} disabled={saving} /><span class="field-unit">kcal</span></div>
      </div>
    </div>
    <div class="macro-grid">
      <div class="field"><label class="field-label" for="food-protein">Protein</label><div class="field-with-unit"><input class="field-input" id="food-protein" type="number" inputmode="decimal" min="0" step="any" bind:value={protein} disabled={saving} /><span class="field-unit">g</span></div></div>
      <div class="field"><label class="field-label" for="food-carbs">Carbs</label><div class="field-with-unit"><input class="field-input" id="food-carbs" type="number" inputmode="decimal" min="0" step="any" bind:value={carbs} disabled={saving} /><span class="field-unit">g</span></div></div>
      <div class="field"><label class="field-label" for="food-fat">Fat</label><div class="field-with-unit"><input class="field-input" id="food-fat" type="number" inputmode="decimal" min="0" step="any" bind:value={fat} disabled={saving} /><span class="field-unit">g</span></div></div>
    </div>
    {#if error}<p class="field-error" role="alert">{error}</p>{/if}
    <button class="sr-only" type="submit" tabindex="-1">Save food</button>
  </form>
  {#snippet actions()}
    <button class="button button--secondary" type="button" disabled={saving} onclick={onclose}>Cancel</button>
    <button class="button button--primary" type="button" disabled={saving} onclick={save}>{saving ? 'Saving…' : 'Save food'}</button>
  {/snippet}
</Sheet>

<style>
  .food-form { display: flex; flex-direction: column; gap: var(--space-4); }
  .form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .macro-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
  @media (max-width: 30rem) { .macro-grid { grid-template-columns: 1fr; } }
  @media (max-width: 22.5rem) { .form-grid { grid-template-columns: 1fr; } }
</style>
