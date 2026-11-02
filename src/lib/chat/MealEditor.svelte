<script lang="ts">
  import { actions } from '../state.svelte'
  import { today } from '../format'
  import type { Analysis, Meal, MealInput } from '../types'
  import { showToast } from '../toast.svelte'
  import Button from '../components/Button.svelte'
  import Field from '../components/Field.svelte'
  import Sheet from '../components/Sheet.svelte'

  interface Props {
    open: boolean
    analysis: Analysis
    meal: Meal | null
    prompt: string
    onclose: () => void
    onsaved: (meal: Meal) => void
  }

  let { open, analysis, meal, prompt, onclose, onsaved }: Props = $props()

  let name = $state('')
  let kcal = $state('')
  let protein = $state('')
  let carbs = $state('')
  let fat = $state('')
  let saving = $state(false)
  let error = $state('')

  function mealName(): string {
    const names = analysis.reconciled?.items.map((item) => item.name).filter(Boolean) ?? []
    return names.slice(0, 3).join(', ') || prompt || 'Logged meal'
  }

  $effect(() => {
    if (!open) return
    const total = meal ?? analysis.reconciled?.total
    name = meal?.name ?? mealName()
    kcal = String(total?.kcal ?? 0)
    protein = String(meal?.proteinG ?? (total && 'protein_g' in total ? total.protein_g : 0))
    carbs = String(meal?.carbsG ?? (total && 'carbs_g' in total ? total.carbs_g : 0))
    fat = String(meal?.fatG ?? (total && 'fat_g' in total ? total.fat_g : 0))
    error = ''
  })

  function numericValue(raw: string): number | null {
    if (!raw.trim()) return null
    const value = Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : null
  }

  async function save(): Promise<void> {
    if (saving) return
    const values = [kcal, protein, carbs, fat].map(numericValue)
    if (!name.trim()) {
      error = 'Give this meal a name.'
      return
    }
    if (values.some((value) => value === null)) {
      error = 'Enter zero or a positive number for calories and each macro.'
      return
    }

    saving = true
    error = ''
    try {
      const input: MealInput = {
        name: name.trim(),
        description: meal?.description ?? prompt,
        kcal: values[0]!,
        proteinG: values[1]!,
        carbsG: values[2]!,
        fatG: values[3]!,
        items: analysis.reconciled?.items.map((item) => ({
          name: item.name,
          quantity: item.quantity,
          kcal: item.kcal,
          proteinG: item.protein_g,
          carbsG: item.carbs_g,
          fatG: item.fat_g,
        })) ?? [],
      }
      const saved = meal
        ? await actions.updateMeal(meal.id, input)
        : await actions.createMeal({
            ...input,
            day: today(),
            eatenAt: new Date().toISOString(),
            source: 'ai',
            analysisId: analysis.id,
          })
      showToast(meal ? 'Meal updated' : 'Meal saved', 'success')
      onsaved(saved)
      onclose()
    } catch (cause: unknown) {
      error = cause instanceof Error ? cause.message : 'Could not save the meal. Please try again.'
    } finally {
      saving = false
    }
  }
</script>

<Sheet
  {open}
  title={meal ? 'Edit meal' : 'Edit and save meal'}
  subtitle="Adjust the estimate before it goes into your day."
  onclose={onclose}
>
  <form class="meal-editor" aria-busy={saving} onsubmit={(event) => { event.preventDefault(); void save() }}>
    {#if error}<p class="form-error" role="alert">{error}</p>{/if}
    <Field id="edit-meal-name" label="Meal name" value={name} required disabled={saving} oninput={(value) => (name = value)} />
    <Field id="edit-meal-kcal" label="Calories (kcal)" type="number" inputmode="decimal" value={kcal} required disabled={saving} oninput={(value) => (kcal = value)} />
    <div class="macro-fields">
      <Field id="edit-meal-protein" label="Protein (g)" type="number" inputmode="decimal" value={protein} required disabled={saving} oninput={(value) => (protein = value)} />
      <Field id="edit-meal-carbs" label="Carbs (g)" type="number" inputmode="decimal" value={carbs} required disabled={saving} oninput={(value) => (carbs = value)} />
      <Field id="edit-meal-fat" label="Fat (g)" type="number" inputmode="decimal" value={fat} required disabled={saving} oninput={(value) => (fat = value)} />
    </div>
  </form>
  {#snippet actions()}
    <Button variant="secondary" onclick={onclose} disabled={saving}>Cancel</Button>
    <Button onclick={save} disabled={saving}>
      {#if saving}<span class="spinner-wrap" aria-hidden="true"><span class="spinner"></span></span>Saving…{:else}Save meal{/if}
    </Button>
  {/snippet}
</Sheet>

<style>
  .meal-editor {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .macro-fields {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
  }

  @media (max-width: 25rem) {
    .macro-fields {
      grid-template-columns: 1fr;
    }
  }
</style>
