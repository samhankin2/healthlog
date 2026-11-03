/**
 * "Foods you've eaten" for the Foods view: logged meals grouped by name, so a
 * food that was logged through Chat or a CSV import can be saved to the
 * library in one tap. Pure — the view supplies the meals and saved foods.
 */
import type { DayString, Food, FoodInput, Meal } from './types'

export interface EatenFood {
  /** Normalised name, the grouping key. */
  key: string
  /** The most recent spelling. */
  name: string
  count: number
  lastDay: DayString
  /** Nutrition of the most recent log: a concrete portion, not an average. */
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  serving: string | null
  saved: boolean
}

export function foodKey(name: string): string {
  return name.trim().toLocaleLowerCase().replace(/\s+/g, ' ')
}

/** CSV imports keep the serving in the description: "Imported (serving: 1 bowl)". */
function servingFrom(meal: Meal): string | null {
  const match = /^Imported \(serving: (.+)\)$/.exec(meal.description ?? '')
  return match?.[1]?.trim() || null
}

/** Group meals by name, most-eaten first, then most recent. */
export function groupEatenFoods(meals: Meal[], saved: Food[]): EatenFood[] {
  const savedKeys = new Set(saved.map((food) => foodKey(food.name)))
  const groups = new Map<string, { latest: Meal; count: number }>()
  for (const meal of meals) {
    const key = foodKey(meal.name)
    if (!key) continue
    const group = groups.get(key)
    if (!group) groups.set(key, { latest: meal, count: 1 })
    else {
      group.count++
      if (`${meal.day}${meal.eatenAt}` > `${group.latest.day}${group.latest.eatenAt}`) group.latest = meal
    }
  }
  return Array.from(groups, ([key, { latest, count }]) => ({
    key,
    name: latest.name.trim(),
    count,
    lastDay: latest.day,
    kcal: latest.kcal,
    proteinG: latest.proteinG,
    carbsG: latest.carbsG,
    fatG: latest.fatG,
    serving: servingFrom(latest),
    saved: savedKeys.has(key),
  })).sort((a, b) => b.count - a.count || b.lastDay.localeCompare(a.lastDay) || a.name.localeCompare(b.name))
}

export function toFoodInput(food: EatenFood): FoodInput {
  return {
    name: food.name,
    serving: food.serving,
    kcal: Math.round(food.kcal),
    proteinG: Math.round(food.proteinG * 10) / 10,
    carbsG: Math.round(food.carbsG * 10) / 10,
    fatG: Math.round(food.fatG * 10) / 10,
  }
}
