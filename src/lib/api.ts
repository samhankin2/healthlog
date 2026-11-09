import { getToken } from './auth'
import type {
  Activity,
  Analysis,
  DailyActivity,
  GarminStatus,
  GarminSyncResult,
  GarminImportResult,
  InsightsPayload,
  ChatInput,
  ChatMessage,
  DashboardPayload,
  DayString,
  Exercise,
  Food,
  FoodCsvMapping,
  FoodCsvPreview,
  FoodInput,
  Meal,
  MealInput,
  MealPatch,
  Phase,
  PhaseInput,
  PhasePatch,
  LiftingPayload,
  Routine,
  Profile,
  ProfilePatch,
  User,
  WeightEntry,
  WeightInput,
  WeightPatch,
  Workout,
} from './types'
import type { GarminImportPayload } from './garminExport'

declare global {
  interface Window {
    APP_API_BASE?: string
  }
}

interface SuccessResponse {
  ok: true
}

interface FailureResponse {
  ok?: false
  error?: string
}

export interface AuthPayload extends SuccessResponse {
  token: string
  user: User
}

export interface MePayload extends SuccessResponse {
  user: User
  profile: Profile
}

export interface ApiRequestOptions {
  /** Cancel the request from the caller. */
  signal?: AbortSignal
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
}

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

function baseUrl(): string {
  const configured = window.APP_API_BASE?.trim()
  return (configured || window.location.origin).replace(/\/+$/, '')
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value))
  }
  const result = query.toString()
  return result ? `?${result}` : ''
}

/** The sole fetch wrapper in the frontend. */
async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  options: ApiRequestOptions = {},
): Promise<T> {
  const controller = new AbortController()
  const externalSignal = options.signal
  const abort = (): void => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) abort()
  else externalSignal?.addEventListener('abort', abort, { once: true })

  const timeoutMs = options.timeoutMs ?? 20_000
  const timeout = window.setTimeout(() => controller.abort('timeout'), timeoutMs)
  const headers = new Headers(init.body === undefined ? undefined : { 'Content-Type': 'application/json' })
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)

  try {
    const response = await fetch(`${baseUrl()}/api${path}`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    })
    const payload = response.status === 204
      ? null
      : await response.json().catch(() => null) as (T & SuccessResponse) | FailureResponse | null

    if (!response.ok) {
      const message = payload && 'error' in payload && typeof payload.error === 'string'
        ? payload.error
        : `Request failed (${response.status})`
      throw new ApiError(message, response.status)
    }
    return payload as T
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (controller.signal.aborted) {
      if (externalSignal?.aborted) throw error
      throw new ApiError('The request took too long. Please try again.', 0)
    }
    throw new ApiError('Could not connect to HealthLog. Check your connection and try again.', 0)
  } finally {
    window.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abort)
  }
}

export interface HealthPayload extends SuccessResponse {
  service: string
  commit: string | null
}

export const api = {
  health(options?: ApiRequestOptions): Promise<HealthPayload> {
    return request<HealthPayload>('/health', {}, options)
  },

  login(credentials: { email: string; password: string }, options?: ApiRequestOptions): Promise<AuthPayload> {
    return request<AuthPayload>('/auth/login', { method: 'POST', body: credentials }, options)
  },

  register(details: { email: string; password: string; inviteCode: string }, options?: ApiRequestOptions): Promise<AuthPayload> {
    return request<AuthPayload>('/auth/register', { method: 'POST', body: details }, options)
  },

  logout(options?: ApiRequestOptions): Promise<SuccessResponse> {
    return request<SuccessResponse>('/auth/logout', { method: 'POST' }, options)
  },

  me(options?: ApiRequestOptions): Promise<MePayload> {
    return request<MePayload>('/auth/me', {}, options)
  },

  getProfile(options?: ApiRequestOptions): Promise<SuccessResponse & { profile: Profile }> {
    return request('/profile', {}, options)
  },

  updateProfile(patch: ProfilePatch, options?: ApiRequestOptions): Promise<SuccessResponse & { profile: Profile }> {
    return request('/profile', { method: 'PUT', body: patch }, options)
  },

  getWeights(range: { from?: DayString; to?: DayString } = {}, options?: ApiRequestOptions): Promise<SuccessResponse & { entries: WeightEntry[] }> {
    return request(`/weights${queryString(range)}`, {}, options)
  },

  createWeight(input: WeightInput, options?: ApiRequestOptions): Promise<SuccessResponse & { entry: WeightEntry }> {
    return request('/weights', { method: 'POST', body: input }, options)
  },

  updateWeight(id: string, patch: WeightPatch, options?: ApiRequestOptions): Promise<SuccessResponse & { entry: WeightEntry }> {
    return request(`/weights/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }, options)
  },

  deleteWeight(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { deleted: string }> {
    return request(`/weights/${encodeURIComponent(id)}`, { method: 'DELETE' }, options)
  },

  getPhases(options?: ApiRequestOptions): Promise<SuccessResponse & { phases: Phase[] }> {
    return request('/phases', {}, options)
  },

  createPhase(input: PhaseInput, options?: ApiRequestOptions): Promise<SuccessResponse & { phase: Phase }> {
    return request('/phases', { method: 'POST', body: input }, options)
  },

  updatePhase(id: string, patch: PhasePatch, options?: ApiRequestOptions): Promise<SuccessResponse & { phase: Phase }> {
    return request(`/phases/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }, options)
  },

  deletePhase(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { deleted: string }> {
    return request(`/phases/${encodeURIComponent(id)}`, { method: 'DELETE' }, options)
  },

  /** `day` pins "today" to the client's calendar day; the server's clock is UTC. */
  getDashboard(days: number, day: DayString, options?: ApiRequestOptions): Promise<SuccessResponse & DashboardPayload> {
    return request(`/dashboard${queryString({ days, day })}`, {}, options)
  },

  getMeals(filter: { day?: DayString; limit?: number; offset?: number } = {}, options?: ApiRequestOptions): Promise<SuccessResponse & { meals: Meal[] }> {
    return request(`/meals${queryString(filter)}`, {}, options)
  },

  createMeal(input: MealInput, options?: ApiRequestOptions): Promise<SuccessResponse & { meal: Meal }> {
    return request('/meals', { method: 'POST', body: input }, options)
  },

  updateMeal(id: string, patch: MealPatch, options?: ApiRequestOptions): Promise<SuccessResponse & { meal: Meal }> {
    return request(`/meals/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }, options)
  },

  deleteMeal(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { deleted: string }> {
    return request(`/meals/${encodeURIComponent(id)}`, { method: 'DELETE' }, options)
  },

  getFoods(options?: ApiRequestOptions): Promise<SuccessResponse & { foods: Food[] }> {
    return request('/foods', {}, options)
  },

  createFood(input: FoodInput, options?: ApiRequestOptions): Promise<SuccessResponse & { food: Food }> {
    return request('/foods', { method: 'POST', body: input }, options)
  },

  deleteFood(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { deleted: string }> {
    return request(`/foods/${encodeURIComponent(id)}`, { method: 'DELETE' }, options)
  },

  getChatMessages(filter: { limit?: number; before?: string } = {}, options?: ApiRequestOptions): Promise<SuccessResponse & { messages: ChatMessage[] }> {
    return request(`/chat/messages${queryString(filter)}`, {}, options)
  },

  sendChat(input: ChatInput, options?: ApiRequestOptions): Promise<SuccessResponse & { message: ChatMessage; meal: Meal | null; meals?: Meal[]; analysis: Analysis | null }> {
    // Worst case on the server: both models time out at 45 s (they run in
    // parallel) and then the judge model adds up to 30 s. 100 s leaves headroom
    // without letting a hung request hang the composer forever.
    return request('/chat', { method: 'POST', body: input }, { timeoutMs: 100_000, ...options })
  },

  getAnalysis(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { analysis: Analysis }> {
    return request(`/analyses/${encodeURIComponent(id)}`, {}, options)
  },

  importWeightJson(json: unknown, options?: ApiRequestOptions): Promise<SuccessResponse & {
    imported: { entries: number; phases: number }
    skipped: { entries: number; phases: number }
  }> {
    return request('/import/weight-json', { method: 'POST', body: { json } }, options)
  },

  previewFoodCsv(csv: string, options?: ApiRequestOptions): Promise<SuccessResponse & FoodCsvPreview> {
    return request('/import/food-csv/preview', { method: 'POST', body: { csv } }, options)
  },

  commitFoodCsv(csv: string, mapping: FoodCsvMapping, options?: ApiRequestOptions): Promise<SuccessResponse & {
    imported: number
    skipped: number
    meals: Meal[]
  }> {
    return request('/import/food-csv/commit', { method: 'POST', body: { csv, mapping } }, options)
  },

  getGarmin(options?: ApiRequestOptions): Promise<SuccessResponse & { garmin: GarminStatus }> {
    return request('/garmin', {}, options)
  },

  /** Resumes saved tokens on the server; a backfill can take a minute or two. */
  syncGarmin(days?: number, options?: ApiRequestOptions): Promise<SuccessResponse & { result: GarminSyncResult; garmin: GarminStatus }> {
    return request('/garmin/sync', { method: 'POST', body: days === undefined ? {} : { days } }, { timeoutMs: 200_000, ...options })
  },

  getActivities(filter: { limit?: number; before?: string } = {}, options?: ApiRequestOptions): Promise<SuccessResponse & { activities: Activity[] }> {
    return request(`/activities${queryString(filter)}`, {}, options)
  },

  getDailyActivity(range: { from?: DayString; to?: DayString } = {}, options?: ApiRequestOptions): Promise<SuccessResponse & { days: DailyActivity[] }> {
    return request(`/activity/daily${queryString(range)}`, {}, options)
  },

  /** Everything the Insights tab charts, for one date range. */
  getInsights(range: { from?: DayString; to?: DayString } = {}, options?: ApiRequestOptions): Promise<SuccessResponse & InsightsPayload> {
    return request(`/insights${queryString(range)}`, {}, { timeoutMs: 30_000, ...options })
  },

  /** A Garmin Connect data export, already unpacked + normalised in the browser. */
  importGarminExport(payload: GarminImportPayload, options?: ApiRequestOptions): Promise<SuccessResponse & { imported: GarminImportResult }> {
    return request('/garmin/import', { method: 'POST', body: payload }, { timeoutMs: 120_000, ...options })
  },

  /** The exercise library and every workout with its sets. */
  getLifting(options?: ApiRequestOptions): Promise<SuccessResponse & LiftingPayload> {
    return request('/lifting', {}, { timeoutMs: 30_000, ...options })
  },

  /** Idempotent: a known id or an existing name returns the stored exercise. */
  createExercise(input: Pick<Exercise, 'name' | 'muscle' | 'equipment'> & { id?: string; incrementKg?: number | null; repMin?: number | null; repMax?: number | null }, options?: ApiRequestOptions): Promise<SuccessResponse & { exercise: Exercise }> {
    return request('/lifting/exercises', { method: 'POST', body: input }, options)
  },

  updateExercise(id: string, patch: Partial<Pick<Exercise, 'name' | 'muscle' | 'equipment' | 'incrementKg' | 'repMin' | 'repMax' | 'archived'>>, options?: ApiRequestOptions): Promise<SuccessResponse & { exercise: Exercise }> {
    return request(`/lifting/exercises/${encodeURIComponent(id)}`, { method: 'PUT', body: patch }, options)
  },

  /** Archives an exercise that has history; deletes an unused one. */
  deleteExercise(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { deleted?: string; archived?: string }> {
    return request(`/lifting/exercises/${encodeURIComponent(id)}`, { method: 'DELETE' }, options)
  },

  /** Upsert a whole workout, sets included (replace-all; safe to retry). */
  saveWorkout(workout: Workout, options?: ApiRequestOptions): Promise<SuccessResponse & { workout: Workout }> {
    const { id, day, name, notes, startedAt, endedAt, sets } = workout
    return request(`/lifting/workouts/${encodeURIComponent(id)}`, { method: 'PUT', body: { day, name, notes, startedAt, endedAt, sets } }, options)
  },

  deleteWorkout(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { deleted: string }> {
    return request(`/lifting/workouts/${encodeURIComponent(id)}`, { method: 'DELETE' }, options)
  },

  /** Replace-all upsert of a routine by client id. */
  saveRoutine(routine: Pick<Routine, 'id' | 'name' | 'items' | 'position'>, options?: ApiRequestOptions): Promise<SuccessResponse & { routine: Routine }> {
    return request(`/lifting/routines/${encodeURIComponent(routine.id)}`, { method: 'PUT', body: { name: routine.name, items: routine.items, position: routine.position } }, options)
  },

  deleteRoutine(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { deleted: string }> {
    return request(`/lifting/routines/${encodeURIComponent(id)}`, { method: 'DELETE' }, options)
  },
}
