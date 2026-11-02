<script lang="ts">
  import { fmtKcal, fmtMacro } from '../format'

  interface Props {
    protein: number
    carbs: number
    fat: number
    kcal?: number
  }

  let { protein, carbs, fat, kcal }: Props = $props()

  const macros = $derived.by(() => {
    const values = [
      { key: 'protein', label: 'Protein', grams: protein, calories: Math.max(0, protein * 4) },
      { key: 'carb', label: 'Carbs', grams: carbs, calories: Math.max(0, carbs * 4) },
      { key: 'fat', label: 'Fat', grams: fat, calories: Math.max(0, fat * 9) },
    ]
    const total = values.reduce((sum, macro) => sum + macro.calories, 0)
    return values.map((macro) => ({
      ...macro,
      width: total > 0 ? `${(macro.calories / total) * 100}%` : '0%',
    }))
  })
</script>

<section class="macro-bar" aria-label="Calorie and macro breakdown">
  {#if kcal !== undefined}
    <div class="macro-kcal-row">
      <strong class="macro-kcal">{fmtKcal(kcal)}</strong>
    </div>
  {/if}
  <div class="macro-track" aria-hidden="true">
    {#each macros as macro (macro.key)}
      <span class="macro-segment macro-segment--{macro.key}" style:width={macro.width}></span>
    {/each}
  </div>
  <dl class="macro-legend">
    {#each macros as macro (macro.key)}
      <div class="macro-stat macro-stat--{macro.key}">
        <dt>{macro.label}</dt>
        <dd>{fmtMacro(macro.grams)}</dd>
      </div>
    {/each}
  </dl>
</section>
