/**
 * Svelte-facing application state.
 *
 * The data logic lives in `store.ts` (framework-agnostic, already covered by
 * the API test suite). This module is the thin reactive layer that Svelte
 * components read from: it mirrors the store into a `$state` object so any
 * component re-renders when the data changes, and exposes the mutations as
 * plain functions.
 *
 * `.svelte.ts` is required here — a plain `.ts` module cannot use runes.
 */
import { store } from './store'
import { today } from './format'
import type {
  Analysis,
  AppState,
  ChatInput,
  ChatMessage,
  DayString,
  Food,
  FoodInput,
  Intake,
  IntakeHistoryDay,
  Meal,
  MealInput,
  MealPatch,
  Phase,
  PhaseInput,
  PhasePatch,
  ProfilePatch,
  WeightEntry,
  WeightInput,
  WeightPatch,
} from './types'

const EMPTY: AppState = {
  user: null,
  profile: null,
  weights: [],
  phases: [],
  meals: [],
  foods: [],
  messages: [],
  analysis: null,
  metrics: null,
  loading: false,
  loaded: false,
  error: null,
}

/** The reactive mirror of the store. Read it directly in components. */
export const app = $state<AppState>({ ...EMPTY })

// Keep the mirror in sync. `store.subscribe` fires on every commit.
store.subscribe((state) => {
  app.user = state.user
  app.profile = state.profile
  app.weights = state.weights
  app.phases = state.phases
  app.meals = state.meals
  app.foods = state.foods
  app.messages = state.messages
  app.analysis = state.analysis
  app.metrics = state.metrics
  app.loading = state.loading
  app.loaded = state.loaded
  app.error = state.error
})

/* -------------------------------------------------------------------------- */
/* Routing                                                                    */
/* -------------------------------------------------------------------------- */

export const ROUTES = ['chat', 'dashboard', 'calories', 'foods', 'settings', 'history', 'activity'] as const
export type Route = (typeof ROUTES)[number]

// A `$state` primitive cannot be exported and reassigned — only its
// properties can. So the current route lives in module state and is read
// through a function: calling `route()` inside a template or an effect
// registers the dependency, so it stays reactive.
let currentRoute = $state<Route>('chat')

function routeFromHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return (ROUTES as readonly string[]).includes(raw) ? (raw as Route) : 'chat'
}

currentRoute = routeFromHash()

window.addEventListener('hashchange', () => {
  currentRoute = routeFromHash()
})

/** The current tab. Reactive: read it inside a template or an effect. */
export function route(): Route {
  return currentRoute
}

/** Switch tab. The hash keeps a refresh on the same tab. */
export function navigate(next: Route): void {
  currentRoute = next
  if (window.location.hash !== `#/${next}`) {
    window.location.hash = `#/${next}`
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every mutation goes through the store so the mirror, the API and the
 * components stay in step. These are arrow functions on purpose: the store
 * uses `this` internally, so destructuring its methods would break them.
 */
export const actions = {
  hydrate: (day: DayString = today()): Promise<void> => store.hydrate(day),
  refresh: (day: DayString = today()): Promise<void> => store.refresh(day),
  reset: (): void => store.reset(),
  adoptUser: (user: AppState['user']): void => {
    if (user) store.adoptUser(user)
  },

  loadWeights: (range: { from?: DayString; to?: DayString } = {}): Promise<WeightEntry[]> =>
    store.loadWeights(range),
  createWeight: (input: WeightInput): Promise<WeightEntry> => store.createWeight(input),
  updateWeight: (id: string, patch: WeightPatch): Promise<WeightEntry> => store.updateWeight(id, patch),
  deleteWeight: (id: string): Promise<void> => store.deleteWeight(id),

  loadPhases: (): Promise<Phase[]> => store.loadPhases(),
  createPhase: (input: PhaseInput): Promise<Phase> => store.createPhase(input),
  updatePhase: (id: string, patch: PhasePatch): Promise<Phase> => store.updatePhase(id, patch),
  deletePhase: (id: string): Promise<void> => store.deletePhase(id),

  updateProfile: (patch: ProfilePatch): Promise<void> => store.updateProfile(patch),
  loadDashboard: (days?: number): Promise<void> => store.loadDashboard(days),
  loadIntakeHistory: (days: number): Promise<{ intake: Intake; history: IntakeHistoryDay[] }> =>
    store.loadIntakeHistory(days),

  loadMeals: (day: DayString = today(), limit = 50): Promise<Meal[]> => store.loadMeals(day, limit),
  loadMealHistory: (max?: number): Promise<Meal[]> => store.loadMealHistory(max),
  createMeal: (input: MealInput): Promise<Meal> => store.createMeal(input),
  updateMeal: (id: string, patch: MealPatch): Promise<Meal> => store.updateMeal(id, patch),
  deleteMeal: (id: string): Promise<void> => store.deleteMeal(id),

  loadFoods: (): Promise<Food[]> => store.loadFoods(),
  createFood: (input: FoodInput): Promise<Food> => store.createFood(input),
  deleteFood: (id: string): Promise<void> => store.deleteFood(id),

  loadMessages: (filter: { limit?: number; before?: string } = { limit: 100 }): Promise<ChatMessage[]> =>
    store.loadMessages(filter),
  sendChat: (input: ChatInput): Promise<{ message: ChatMessage; meal: Meal | null; analysis: Analysis | null }> =>
    store.sendChat(input),
  loadAnalysis: (id: string): Promise<Analysis> => store.loadAnalysis(id),

  importWeightJson: (json: unknown): Promise<{
    imported: { entries: number; phases: number }
    skipped: { entries: number; phases: number }
  }> => store.importWeightJson(json),
}
