/**
 * Lifting state: the exercise library, workouts, the session in progress, the
 * rest timer, and an outbox that keeps the phone working with no signal.
 *
 * Every change is applied here first and saved to localStorage, then pushed to
 * the API (`PUT /api/lifting/workouts/:id` replaces the whole workout, so a
 * retry is always safe). A failed push stays in the outbox and is retried when
 * the browser comes back online, the tab becomes visible, every 20 s while
 * offline, and on the next change. Nothing logged in a basement gym is lost.
 */
import { api, ApiError } from './api'
import { app } from './state.svelte'
import { today } from './format'
import { exerciseOrder } from './lifting'
import type { Equipment, Exercise, LiftSet, Muscle, Workout } from './types'

type SyncState = 'idle' | 'saving' | 'offline' | 'error'

interface Outbox {
  exercises: Exercise[]
  workouts: Record<string, { w: Workout; rev: number; failed?: boolean }>
  deletes: string[]
}

export const lift = $state({
  exercises: [] as Exercise[],
  workouts: [] as Workout[],
  loaded: false,
  loading: false,
  error: '',
  activeId: null as string | null,
  /** Planned exercise order per workout (exercises added before their first set). */
  plans: {} as Record<string, string[]>,
  sync: 'idle' as SyncState,
  syncError: '',
  pending: 0,
  rest: { endsAt: 0, total: 0, preset: 120 },
})

let outbox: Outbox = { exercises: [], workouts: {}, deletes: [] }
let loadedFor: string | null = null
let rev = 0

/* ---------------- persistence ---------------- */

const key = (part: string): string => `healthlog.lifting.${app.user?.id ?? 'anon'}.${part}`

function readJson<T>(k: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(k)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function persist(): void {
  try {
    localStorage.setItem(key('outbox'), JSON.stringify(outbox))
    localStorage.setItem(key('plans'), JSON.stringify(lift.plans))
    if (lift.activeId) localStorage.setItem(key('active'), lift.activeId)
    else localStorage.removeItem(key('active'))
    localStorage.setItem('healthlog.lifting.rest', JSON.stringify(lift.rest))
  } catch {
    /* storage full or blocked: the API push still runs */
  }
  lift.pending = outbox.exercises.length + Object.keys(outbox.workouts).length + outbox.deletes.length
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/* ---------------- loading ---------------- */

/** Load (or reload) everything. Local unsynced changes win over the server copy. */
export async function loadLifting(force = false): Promise<void> {
  const userId = app.user?.id ?? null
  if (!userId) return
  if (loadedFor !== userId) {
    loadedFor = userId
    outbox = readJson<Outbox>(key('outbox'), { exercises: [], workouts: {}, deletes: [] })
    lift.plans = readJson<Record<string, string[]>>(key('plans'), {})
    lift.activeId = localStorage.getItem(key('active'))
    lift.rest = { ...lift.rest, ...readJson('healthlog.lifting.rest', lift.rest) }
    lift.loaded = false
    applyServer({ exercises: [], workouts: [] })
  } else if (lift.loaded && !force) {
    void flush()
    return
  }
  lift.loading = !lift.loaded
  lift.error = ''
  try {
    const data = await api.getLifting()
    applyServer(data)
    lift.loaded = true
  } catch (cause) {
    // Offline with a local copy is still usable: show what the outbox holds.
    lift.error = cause instanceof Error ? cause.message : 'Could not load your lifting log.'
    if (Object.keys(outbox.workouts).length || outbox.exercises.length) lift.loaded = true
  } finally {
    lift.loading = false
  }
  persist()
  void flush()
}

function applyServer(data: { exercises: Exercise[]; workouts: Workout[] }): void {
  const exercises = new Map(data.exercises.map((e) => [e.id, e]))
  for (const e of outbox.exercises) if (![...exercises.values()].some((x) => x.name.toLowerCase() === e.name.toLowerCase())) exercises.set(e.id, e)
  lift.exercises = [...exercises.values()].sort((a, b) => a.name.localeCompare(b.name))
  const workouts = new Map(data.workouts.map((w) => [w.id, w]))
  for (const { w } of Object.values(outbox.workouts)) workouts.set(w.id, w)
  for (const id of outbox.deletes) workouts.delete(id)
  lift.workouts = [...workouts.values()]
  // Resume a session started on another device (or before a cleared cache).
  if (lift.activeId && !workouts.has(lift.activeId) && lift.loaded) lift.activeId = null
  if (!lift.activeId) {
    const open = lift.workouts.filter((w) => !w.endedAt && w.startedAt && Date.now() - Date.parse(w.startedAt) < 12 * 3600e3)
    lift.activeId = open.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]?.id ?? null
  }
}

/* ---------------- sync ---------------- */

let flushing: Promise<void> | null = null
let again = false
let retryTimer: number | undefined

function scheduleRetry(): void {
  if (retryTimer !== undefined) return
  retryTimer = window.setTimeout(() => {
    retryTimer = undefined
    void flush()
  }, 20_000)
}

function remapExercise(from: string, to: string): void {
  if (from === to) return
  const fix = (w: Workout): Workout => ({ ...w, sets: w.sets.map((s) => (s.exerciseId === from ? { ...s, exerciseId: to } : s)) })
  lift.workouts = lift.workouts.map(fix)
  for (const entry of Object.values(outbox.workouts)) entry.w = fix(entry.w)
  for (const [id, plan] of Object.entries(lift.plans)) lift.plans[id] = plan.map((e) => (e === from ? to : e))
}

export function flush(): Promise<void> {
  if (flushing) {
    again = true
    return flushing
  }
  if (!app.user) return Promise.resolve()
  flushing = (async () => {
    do {
      again = false
      await flushOnce()
    } while (again)
  })().finally(() => {
    flushing = null
  })
  return flushing
}

async function flushOnce(): Promise<void> {
  if (!lift.pending && !outbox.exercises.length && !Object.keys(outbox.workouts).length && !outbox.deletes.length) {
    if (lift.sync !== 'error') lift.sync = 'idle'
    return
  }
  lift.sync = 'saving'
  try {
    for (const ex of [...outbox.exercises]) {
      const { exercise } = await api.createExercise({ id: ex.id, name: ex.name, muscle: ex.muscle, equipment: ex.equipment, incrementKg: ex.incrementKg })
      outbox.exercises = outbox.exercises.filter((e) => e.id !== ex.id)
      lift.exercises = lift.exercises.map((e) => (e.id === ex.id ? exercise : e))
      remapExercise(ex.id, exercise.id)
      persist()
    }
    let failed = ''
    for (const [id, entry] of Object.entries(outbox.workouts)) {
      if (entry.failed) { failed = failed || 'A workout could not be saved.'; continue }
      const sentRev = entry.rev
      try {
        await api.saveWorkout(entry.w)
        if (outbox.workouts[id]?.rev === sentRev) delete outbox.workouts[id]
      } catch (cause) {
        if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 401 && cause.status !== 429) {
          entry.failed = true
          failed = cause.message
        } else throw cause
      }
      persist()
    }
    for (const id of [...outbox.deletes]) {
      try {
        await api.deleteWorkout(id)
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 404)) throw cause
      }
      outbox.deletes = outbox.deletes.filter((d) => d !== id)
      persist()
    }
    lift.sync = failed ? 'error' : 'idle'
    lift.syncError = failed
  } catch (cause) {
    const offline = cause instanceof ApiError && (cause.status === 0 || cause.status >= 500 || cause.status === 429)
    lift.sync = offline ? 'offline' : 'error'
    lift.syncError = cause instanceof Error ? cause.message : 'Could not save.'
    if (offline) scheduleRetry()
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flush())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && lift.pending) void flush()
  })
}

/* ---------------- workouts ---------------- */

export const workoutById = (id: string | null): Workout | null => (id ? lift.workouts.find((w) => w.id === id) ?? null : null)
export const activeWorkout = (): Workout | null => workoutById(lift.activeId)

/** Exercises of a workout in display order: logged ones, then planned-only ones in plan order. */
export function workoutExercises(w: Workout): string[] {
  const plan = lift.plans[w.id] ?? []
  const logged = exerciseOrder(w)
  const out = [...logged]
  // Keep planned exercises at their planned position relative to logged ones.
  plan.forEach((id, i) => {
    if (out.includes(id)) return
    const after = plan.slice(0, i).reverse().find((p) => out.includes(p))
    out.splice(after ? out.indexOf(after) + 1 : out.length, 0, id)
  })
  return out
}

function save(w: Workout): Workout {
  const next = { ...w, updatedAt: new Date().toISOString() }
  const i = lift.workouts.findIndex((x) => x.id === w.id)
  if (i >= 0) lift.workouts[i] = next
  else lift.workouts = [...lift.workouts, next]
  outbox.workouts[w.id] = { w: $state.snapshot(next) as Workout, rev: ++rev }
  outbox.deletes = outbox.deletes.filter((d) => d !== w.id)
  persist()
  void flush()
  return next
}

export function startWorkout(opts: { name?: string | null; day?: string; plan?: string[]; live?: boolean } = {}): Workout {
  const live = opts.live ?? true
  const w: Workout = {
    id: uid(), day: opts.day ?? today(), name: opts.name ?? null, notes: null,
    startedAt: live ? new Date().toISOString() : null, endedAt: live ? null : new Date().toISOString(), sets: [],
  }
  lift.plans[w.id] = opts.plan ?? []
  if (live) lift.activeId = w.id
  // Saved straight away so a refresh or a second device can resume it; an
  // empty session is deleted again when it is finished.
  return save(w)
}

export function updateWorkout(id: string, patch: Partial<Pick<Workout, 'name' | 'notes' | 'day' | 'startedAt' | 'endedAt'>>): void {
  const w = workoutById(id)
  if (w) save({ ...w, ...patch })
}

export function addPlanned(workoutId: string, exerciseId: string): void {
  const w = workoutById(workoutId)
  if (!w) return
  const order = workoutExercises(w)
  if (!order.includes(exerciseId)) lift.plans[workoutId] = [...order, exerciseId]
  persist()
}

export function addSet(workoutId: string, set: Omit<LiftSet, 'id' | 'doneAt'>): LiftSet {
  const w = workoutById(workoutId)!
  const full: LiftSet = { ...set, id: uid(), doneAt: new Date().toISOString() }
  // Insert after the exercise's last set so supersets keep their own blocks.
  const order = workoutExercises(w)
  const sets = [...w.sets, full]
  sets.sort((a, b) => order.indexOf(a.exerciseId) - order.indexOf(b.exerciseId))
  lift.plans[workoutId] = order
  save({ ...w, sets })
  return full
}

export function updateSet(workoutId: string, setId: string, patch: Partial<Omit<LiftSet, 'id'>>): void {
  const w = workoutById(workoutId)
  if (w) save({ ...w, sets: w.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) })
}

export function deleteSet(workoutId: string, setId: string): void {
  const w = workoutById(workoutId)
  if (w) save({ ...w, sets: w.sets.filter((s) => s.id !== setId) })
}

export function removeExercise(workoutId: string, exerciseId: string): void {
  const w = workoutById(workoutId)
  if (!w) return
  lift.plans[workoutId] = (lift.plans[workoutId] ?? []).filter((e) => e !== exerciseId)
  if (w.sets.some((s) => s.exerciseId === exerciseId)) save({ ...w, sets: w.sets.filter((s) => s.exerciseId !== exerciseId) })
  else persist()
}

export function moveExercise(workoutId: string, exerciseId: string, by: -1 | 1): void {
  const w = workoutById(workoutId)
  if (!w) return
  const order = workoutExercises(w)
  const i = order.indexOf(exerciseId)
  const j = i + by
  if (i < 0 || j < 0 || j >= order.length) return
  ;[order[i], order[j]] = [order[j], order[i]]
  lift.plans[workoutId] = order
  const sets = [...w.sets].sort((a, b) => order.indexOf(a.exerciseId) - order.indexOf(b.exerciseId))
  if (sets.some((s, k) => s.id !== w.sets[k].id)) save({ ...w, sets })
  else persist()
}

/** End the live session. An empty one is discarded instead. */
export function finishWorkout(id: string, notes?: string | null): 'saved' | 'discarded' {
  const w = workoutById(id)
  if (lift.activeId === id) lift.activeId = null
  stopRest()
  if (!w) return 'discarded'
  if (!w.sets.length) {
    deleteWorkout(id)
    return 'discarded'
  }
  save({ ...w, endedAt: w.endedAt ?? new Date().toISOString(), notes: notes === undefined ? w.notes : notes })
  return 'saved'
}

export function deleteWorkout(id: string): void {
  const known = Boolean(outbox.workouts[id]) || lift.workouts.some((w) => w.id === id && w.sets.length)
  lift.workouts = lift.workouts.filter((w) => w.id !== id)
  delete outbox.workouts[id]
  delete lift.plans[id]
  if (lift.activeId === id) lift.activeId = null
  if (known && !outbox.deletes.includes(id)) outbox.deletes.push(id)
  persist()
  void flush()
}

/** Retry a save the server rejected (after the user fixed or accepted it). */
export function retryFailed(): void {
  for (const entry of Object.values(outbox.workouts)) entry.failed = false
  lift.syncError = ''
  void flush()
}

/* ---------------- exercises ---------------- */

export function createExercise(input: { name: string; muscle: Muscle; equipment: Equipment; incrementKg?: number | null }): Exercise {
  const name = input.name.trim().replace(/\s+/g, ' ')
  const existing = lift.exercises.find((e) => e.name.toLowerCase() === name.toLowerCase())
  if (existing) {
    if (existing.archived) void setArchived(existing.id, false)
    return existing
  }
  const ex: Exercise = { id: uid(), name, muscle: input.muscle, equipment: input.equipment, incrementKg: input.incrementKg ?? null, archived: false }
  lift.exercises = [...lift.exercises, ex].sort((a, b) => a.name.localeCompare(b.name))
  outbox.exercises.push(ex)
  persist()
  void flush()
  return ex
}

export async function editExercise(id: string, patch: Partial<Pick<Exercise, 'name' | 'muscle' | 'equipment' | 'incrementKg'>>): Promise<void> {
  const pendingLocal = outbox.exercises.find((e) => e.id === id)
  if (pendingLocal) {
    Object.assign(pendingLocal, patch)
    lift.exercises = lift.exercises.map((e) => (e.id === id ? { ...e, ...patch } : e))
    persist()
    return
  }
  const { exercise } = await api.updateExercise(id, patch)
  lift.exercises = lift.exercises.map((e) => (e.id === id ? exercise : e)).sort((a, b) => a.name.localeCompare(b.name))
}

export async function setArchived(id: string, archived: boolean): Promise<void> {
  const { exercise } = await api.updateExercise(id, { archived })
  lift.exercises = lift.exercises.map((e) => (e.id === id ? exercise : e))
}

/* ---------------- rest timer ---------------- */

export const REST_PRESETS = [60, 90, 120, 180, 240]

export function startRest(seconds = lift.rest.preset): void {
  lift.rest.endsAt = Date.now() + seconds * 1000
  lift.rest.total = seconds
  persist()
}

export function adjustRest(delta: number): void {
  if (!lift.rest.endsAt) return
  lift.rest.endsAt = Math.max(Date.now() + 1000, lift.rest.endsAt + delta * 1000)
  lift.rest.total = Math.max(1, lift.rest.total + delta)
  persist()
}

export function stopRest(): void {
  lift.rest.endsAt = 0
  persist()
}

export function setRestPreset(seconds: number): void {
  lift.rest.preset = seconds
  persist()
}
