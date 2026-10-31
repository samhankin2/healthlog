import { api } from './api'
import type { ApiRequestOptions } from './api'
import { setUser } from './auth'
import { today } from './format'
import type {
  Analysis,
  AppState,
  ChatInput,
  ChatMessage,
  DayString,
  Food,
  FoodInput,
  Meal,
  MealInput,
  MealPatch,
  Phase,
  PhaseInput,
  PhasePatch,
  ProfilePatch,
  User,
  WeightEntry,
  WeightInput,
  WeightPatch,
} from './types'

const EMPTY_STATE: AppState = {
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

let state: AppState = { ...EMPTY_STATE }
const listeners = new Set<(state: AppState) => void>()

function commit(patch: Partial<AppState>): void {
  state = { ...state, ...patch }
  for (const listener of listeners) listener(state)
}

function upsertById<T extends { id: string }>(items: T[], next: T): T[] {
  const exists = items.some((item) => item.id === next.id)
  return exists ? items.map((item) => item.id === next.id ? next : item) : [...items, next]
}

function removeById<T extends { id: string }>(items: T[], id: string): T[] {
  return items.filter((item) => item.id !== id)
}

export const store = {
  get(): AppState {
    return state
  },

  subscribe(listener: (state: AppState) => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },

  /** Clear all account data from memory. The auth token is managed by auth.ts. */
  reset(): void {
    setUser(null)
    state = { ...EMPTY_STATE }
    for (const listener of listeners) listener(state)
  },

  /** Put a freshly authenticated user into the shell before hydration finishes. */
  adoptUser(user: User): void {
    setUser(user)
    commit({ user, error: null })
  },

  /** Load the account and all shell data from the API. */
  async hydrate(day: DayString = today(), options?: ApiRequestOptions): Promise<void> {
    commit({ loading: true, error: null })
    try {
      const session = await api.me(options)
      setUser(session.user)
      const days = session.profile.chartWindowDays || 90
      const [weights, phases, meals, foods, messages, dashboard] = await Promise.all([
        api.getWeights({}, options),
        api.getPhases(options),
        api.getMeals({ day, limit: 50 }, options),
        api.getFoods(options),
        api.getChatMessages({ limit: 100 }, options),
        api.getDashboard(days, options),
      ])
      commit({
        user: session.user,
        profile: session.profile,
        weights: weights.entries,
        phases: phases.phases,
        meals: meals.meals,
        foods: foods.foods,
        messages: messages.messages,
        metrics: dashboard.metrics,
        loading: false,
        loaded: true,
        error: null,
      })
    } catch (error) {
      commit({ loading: false, error: error instanceof Error ? error.message : 'Could not load your data.' })
      throw error
    }
  },

  async refresh(day: DayString = today(), options?: ApiRequestOptions): Promise<void> {
    return this.hydrate(day, options)
  },

  async loadWeights(range: { from?: DayString; to?: DayString } = {}, options?: ApiRequestOptions): Promise<WeightEntry[]> {
    const response = await api.getWeights(range, options)
    commit({ weights: response.entries })
    return response.entries
  },

  async createWeight(input: WeightInput, options?: ApiRequestOptions): Promise<WeightEntry> {
    const response = await api.createWeight(input, options)
    const weights = [...state.weights.filter((entry) => entry.date !== response.entry.date), response.entry]
      .sort((a, b) => a.date.localeCompare(b.date))
    commit({ weights })
    return response.entry
  },

  async updateWeight(id: string, patch: WeightPatch, options?: ApiRequestOptions): Promise<WeightEntry> {
    const response = await api.updateWeight(id, patch, options)
    const weights = [...state.weights.filter((entry) => entry.id !== id && entry.date !== response.entry.date), response.entry]
      .sort((a, b) => a.date.localeCompare(b.date))
    commit({ weights })
    return response.entry
  },

  async deleteWeight(id: string, options?: ApiRequestOptions): Promise<void> {
    await api.deleteWeight(id, options)
    commit({ weights: removeById(state.weights, id) })
  },

  async loadPhases(options?: ApiRequestOptions): Promise<Phase[]> {
    const response = await api.getPhases(options)
    commit({ phases: response.phases })
    return response.phases
  },

  async createPhase(input: PhaseInput, options?: ApiRequestOptions): Promise<Phase> {
    const response = await api.createPhase(input, options)
    commit({ phases: upsertById(state.phases, response.phase) })
    return response.phase
  },

  async updatePhase(id: string, patch: PhasePatch, options?: ApiRequestOptions): Promise<Phase> {
    const response = await api.updatePhase(id, patch, options)
    commit({ phases: upsertById(state.phases, response.phase) })
    return response.phase
  },

  async deletePhase(id: string, options?: ApiRequestOptions): Promise<void> {
    await api.deletePhase(id, options)
    commit({ phases: removeById(state.phases, id) })
  },

  async updateProfile(patch: ProfilePatch, options?: ApiRequestOptions): Promise<void> {
    const response = await api.updateProfile(patch, options)
    commit({ profile: response.profile })
  },

  async loadDashboard(days = state.profile?.chartWindowDays ?? 90, options?: ApiRequestOptions): Promise<void> {
    const response = await api.getDashboard(days, options)
    commit({ metrics: response.metrics })
  },

  async loadMeals(day: DayString = today(), limit = 50, options?: ApiRequestOptions): Promise<Meal[]> {
    const response = await api.getMeals({ day, limit }, options)
    commit({ meals: response.meals })
    return response.meals
  },

  async createMeal(input: MealInput, options?: ApiRequestOptions): Promise<Meal> {
    const response = await api.createMeal(input, options)
    commit({ meals: upsertById(state.meals, response.meal) })
    return response.meal
  },

  async updateMeal(id: string, patch: MealPatch, options?: ApiRequestOptions): Promise<Meal> {
    const response = await api.updateMeal(id, patch, options)
    commit({ meals: upsertById(state.meals, response.meal) })
    return response.meal
  },

  async deleteMeal(id: string, options?: ApiRequestOptions): Promise<void> {
    await api.deleteMeal(id, options)
    commit({ meals: removeById(state.meals, id) })
  },

  async loadFoods(options?: ApiRequestOptions): Promise<Food[]> {
    const response = await api.getFoods(options)
    commit({ foods: response.foods })
    return response.foods
  },

  async createFood(input: FoodInput, options?: ApiRequestOptions): Promise<Food> {
    const response = await api.createFood(input, options)
    commit({ foods: upsertById(state.foods, response.food) })
    return response.food
  },

  async deleteFood(id: string, options?: ApiRequestOptions): Promise<void> {
    await api.deleteFood(id, options)
    commit({ foods: removeById(state.foods, id) })
  },

  async loadMessages(filter: { limit?: number; before?: string } = { limit: 100 }, options?: ApiRequestOptions): Promise<ChatMessage[]> {
    const response = await api.getChatMessages(filter, options)
    commit({ messages: response.messages })
    return response.messages
  },

  async sendChat(input: ChatInput, options?: ApiRequestOptions): Promise<{ message: ChatMessage; meal: Meal | null; analysis: Analysis | null }> {
    const response = await api.sendChat(input, options)
    const messages = await api.getChatMessages({ limit: 100 }, options)
    commit({
      messages: messages.messages,
      meals: response.meal ? upsertById(state.meals, response.meal) : state.meals,
      analysis: response.analysis,
    })
    return response
  },

  async loadAnalysis(id: string, options?: ApiRequestOptions): Promise<Analysis> {
    const response = await api.getAnalysis(id, options)
    commit({ analysis: response.analysis })
    return response.analysis
  },

  async importWeightJson(json: unknown, options?: ApiRequestOptions): Promise<{
    imported: { entries: number; phases: number }
    skipped: { entries: number; phases: number }
  }> {
    const response = await api.importWeightJson(json, options)
    await this.hydrate(today(), options)
    return { imported: response.imported, skipped: response.skipped }
  },
}
