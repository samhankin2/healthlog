import { getToken } from './auth'
import { acknowledgeEvents, pendingEvents, recordFetchFailure, recordFetchSuccess } from './clientLog'
import type {
  Activity,
  Analysis,
  DailyActivity,
  GarminStatus,
  CronometerStatus,
  CronometerSyncResult,
  CorosStatus,
  CorosSyncResult,
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
  Partner,
  Phase,
  PhaseInput,
  PhasePatch,
  LiftingPayload,
  ModelBenchPayload,
  Routine,
  Profile,
  ProfilePatch,
  SharedMeal,
  ShareStatus,
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

const API_BASE_KEY = 'healthlog.apiBase.v1'

/**
 * API origins from `window.APP_API_BASE`: one origin, or a comma-separated
 * list of origins serving the same API (SPEC §8). Empty means same origin.
 */
function apiBases(): string[] {
  const list = (window.APP_API_BASE ?? '')
    .split(',')
    .map((base) => base.trim().replace(/\/+$/, ''))
    .filter(Boolean)
  return list.length ? list : [window.location.origin.replace(/\/+$/, '')]
}

/** The origin that last worked, while it is still configured; else the first. */
function preferredBase(bases: string[]): string {
  try {
    const saved = window.localStorage.getItem(API_BASE_KEY)
    if (saved && bases.includes(saved)) return saved
  } catch {
    // Storage unavailable: start from the first origin every time.
  }
  return bases[0]
}

function rememberBase(base: string): void {
  try { window.localStorage.setItem(API_BASE_KEY, base) } catch { /* best-effort */ }
}

function hostOf(base: string): string {
  try { return new URL(base).host } catch { return base }
}

/**
 * Requests that are safe to send twice. A read always is; a write may have
 * reached the server before the connection dropped, so it is not re-sent
 * automatically (the next attempt still starts on the other origin).
 */
function resendable(method: string, path: string): boolean {
  return method === 'GET' || path === '/auth/login' || path === CLIENT_LOG_PATH
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

  const method = init.method ?? 'GET'
  const body = init.body === undefined ? undefined : JSON.stringify(init.body)
  // The diagnostics upload itself is never logged, or a dead API would feed the queue.
  const diagnose = path !== CLIENT_LOG_PATH
  const bases = apiBases()
  let base = preferredBase(bases)
  let startedAt = Date.now()
  try {
    let response: Response
    // Failover (SPEC §8): a request that gets no answer at all moves the app to
    // the next origin; a resendable one is retried there at once.
    for (let attempt = 0; ; attempt++) {
      startedAt = Date.now()
      try {
        response = await fetch(`${base}/api${path}`, { method, headers, body, signal: controller.signal })
        break
      } catch (error) {
        if (controller.signal.aborted) throw error
        if (diagnose) {
          const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
          recordFetchFailure({ path, method, kind: 'network', ms: Date.now() - startedAt, error: detail, base: hostOf(base) })
        }
        const next = bases[(bases.indexOf(base) + 1) % bases.length]
        if (next === base) throw error
        rememberBase(next)
        if (attempt > 0 || !resendable(method, path)) throw error
        base = next
      }
    }
    if (diagnose) {
      if (response.status >= 500) {
        recordFetchFailure({ path, method, kind: 'http', status: response.status, ms: Date.now() - startedAt, base: hostOf(base) })
      } else {
        recordFetchSuccess(hostOf(base))
        flushClientLog()
      }
    }
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
      if (diagnose) recordFetchFailure({ path, method, kind: 'timeout', ms: Date.now() - startedAt, base: hostOf(base) })
      throw new ApiError('The request took too long. Please try again.', 0)
    }
    throw new ApiError('Could not connect to HealthLog. Check your connection and try again.', 0)
  } finally {
    window.clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', abort)
  }
}

const CLIENT_LOG_PATH = '/client-log'
const CLIENT_LOG_BATCH = 50
let flushingClientLog = false

/** Upload queued diagnostics (SPEC §6 "Client diagnostics"). Best-effort, one batch at a time. */
function flushClientLog(): void {
  if (flushingClientLog) return
  const batch = pendingEvents().slice(0, CLIENT_LOG_BATCH)
  if (!batch.length) return
  flushingClientLog = true
  request<SuccessResponse>(CLIENT_LOG_PATH, { method: 'POST', body: { events: batch } }, { timeoutMs: 15_000 })
    .then(() => acknowledgeEvents(batch.length))
    .catch(() => {})
    .finally(() => { flushingClientLog = false })
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

  shareMeal(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { share: { id: string; status: ShareStatus; to: string } }> {
    return request(`/meals/${encodeURIComponent(id)}/share`, { method: 'POST' }, options)
  },

  getPartner(options?: ApiRequestOptions): Promise<SuccessResponse & { partner: Partner | null }> {
    return request('/partner', {}, options)
  },

  setPartner(email: string, options?: ApiRequestOptions): Promise<SuccessResponse & { partner: Partner | null }> {
    return request('/partner', { method: 'PUT', body: { email } }, options)
  },

  removePartner(options?: ApiRequestOptions): Promise<SuccessResponse & { partner: null }> {
    return request('/partner', { method: 'DELETE' }, options)
  },

  getSharedMeals(options?: ApiRequestOptions): Promise<SuccessResponse & { shares: SharedMeal[] }> {
    return request('/shared-meals', {}, options)
  },

  acceptSharedMeal(id: string, input: MealPatch, options?: ApiRequestOptions): Promise<SuccessResponse & { meal: Meal }> {
    return request(`/shared-meals/${encodeURIComponent(id)}/accept`, { method: 'POST', body: input }, options)
  },

  dismissSharedMeal(id: string, options?: ApiRequestOptions): Promise<SuccessResponse & { dismissed: string }> {
    return request(`/shared-meals/${encodeURIComponent(id)}/dismiss`, { method: 'POST' }, options)
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
  getModelBench(days: number, options?: ApiRequestOptions): Promise<SuccessResponse & ModelBenchPayload> {
    return request(`/model-bench${queryString({ days })}`, {}, options)
  },

  getInsights(range: { from?: DayString; to?: DayString } = {}, options?: ApiRequestOptions): Promise<SuccessResponse & InsightsPayload> {
    return request(`/insights${queryString(range)}`, {}, { timeoutMs: 30_000, ...options })
  },

  getCronometer(options?: ApiRequestOptions): Promise<SuccessResponse & { cronometer: CronometerStatus }> {
    return request('/cronometer', {}, options)
  },

  /** The password is used once on the server to log in; only the session is kept. */
  connectCronometer(email: string, password: string, options?: ApiRequestOptions): Promise<SuccessResponse & { result: CronometerSyncResult; cronometer: CronometerStatus }> {
    return request('/cronometer/connect', { method: 'POST', body: { email, password } }, { timeoutMs: 120_000, ...options })
  },

  syncCronometer(options?: ApiRequestOptions): Promise<SuccessResponse & { result: CronometerSyncResult; cronometer: CronometerStatus }> {
    return request('/cronometer/sync', { method: 'POST', body: {} }, { timeoutMs: 120_000, ...options })
  },

  disconnectCronometer(deleteMeals: boolean, options?: ApiRequestOptions): Promise<SuccessResponse & { deletedMeals: number; cronometer: CronometerStatus }> {
    return request('/cronometer/disconnect', { method: 'POST', body: { deleteMeals } }, options)
  },

  getCoros(options?: ApiRequestOptions): Promise<SuccessResponse & { coros: CorosStatus }> {
    return request('/coros', {}, options)
  },

  /** Starts COROS's OAuth sign-in: open `authorizeUrl`; COROS sends the browser back to `returnTo`. */
  connectCoros(returnTo: string, options?: ApiRequestOptions): Promise<SuccessResponse & { authorizeUrl: string }> {
    return request('/coros/connect', { method: 'POST', body: { returnTo } }, { timeoutMs: 60_000, ...options })
  },

  syncCoros(options?: ApiRequestOptions): Promise<SuccessResponse & { result: CorosSyncResult; coros: CorosStatus }> {
    return request('/coros/sync', { method: 'POST', body: {} }, { timeoutMs: 180_000, ...options })
  },

  disconnectCoros(deleteData: boolean, options?: ApiRequestOptions): Promise<SuccessResponse & { deleted: { days: number; activities: number; sleep: number }; coros: CorosStatus }> {
    return request('/coros/disconnect', { method: 'POST', body: { deleteData } }, options)
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

  updateExercise(id: string, patch: Partial<Pick<Exercise, 'name' | 'muscle' | 'equipment' | 'incrementKg' | 'repMin' | 'repMax' | 'perSide' | 'archived'>>, options?: ApiRequestOptions): Promise<SuccessResponse & { exercise: Exercise }> {
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
