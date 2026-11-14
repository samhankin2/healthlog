/** API and application domain types. Day keys are local-calendar YYYY-MM-DD strings. */
export type DayString = string
/** SPEC §8 uses epoch ms; ISO strings are accepted for §4 API interoperability. */
export type Timestamp = number | string

export interface User {
  id: string
  email: string
  displayName: string | null
}

export type Sex = 'male' | 'female' | 'other'
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active'

export interface Profile {
  heightCm: number | null
  startWeightKg: number | null
  goalWeightKg: number | null
  sex: Sex | null
  age: number | null
  activityLevel: ActivityLevel | null
  kcalTarget: number | null
  proteinG: number | null
  carbG: number | null
  fatG: number | null
  chartWindowDays: number
}

export type ProfilePatch = Partial<Omit<Profile, 'chartWindowDays'>> & Pick<Partial<Profile>, 'chartWindowDays'>

export interface WeightEntry {
  id: string
  date: DayString
  weightKg: number
  note: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface Phase {
  id: string
  name: string
  color: string
  startDate: DayString
  endDate: DayString | null
  createdAt: Timestamp
}

export interface Nutrition {
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
}

export interface MealItem extends Nutrition {
  id: string
  foodId?: string | null
  name: string
  quantity: string | null
}

export type MealSource = 'ai' | 'manual' | 'import' | 'saved_food' | 'cronometer'

export interface Meal extends Nutrition {
  id: string
  eatenAt: string
  day: DayString
  name: string
  description: string | null
  fiberG: number | null
  source: MealSource
  confidence: number | null
  analysisId?: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
  items: MealItem[]
}

export interface Food extends Nutrition {
  id: string
  name: string
  serving: string | null
  createdAt: Timestamp
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  mealId: string | null
  analysisId: string | null
  createdAt: Timestamp
}

export interface AnalysisItem {
  name: string
  quantity: string
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
}

export interface AnalysisTotal {
  kcal: number
  protein_g: number
  carbs_g: number
  fat_g: number
}

export interface ModelOutput {
  items: AnalysisItem[]
  total: AnalysisTotal
  confidence: number
  notes: string
}

export interface ModelFailure {
  error: string
}

export interface AnalysisMeal {
  name: string | null
  items: AnalysisItem[]
  total: AnalysisTotal
}

export interface ReconciledOutput {
  items: AnalysisItem[]
  total: AnalysisTotal
  /** Separate meals found in one message. Absent on analyses saved before multi-meal support. */
  meals?: AnalysisMeal[]
}

export interface Analysis {
  id: string
  modelA: string
  modelB: string
  modelAOutput: ModelOutput | ModelFailure
  modelBOutput: ModelOutput | ModelFailure
  reconciled: ReconciledOutput | null
  comparison: string
  agreement: 'high' | 'medium' | 'low'
  deltaPct: number
  mealId?: string | null
  createdAt?: Timestamp | null
  error?: string | null
}

export interface Intake {
  day: DayString
  kcal: number
  kcalTarget: number | null
  proteinG: number
  carbG: number
  fatG: number
  proteinPct: number | null
  carbPct: number | null
  fatPct: number | null
}

export interface IntakeHistoryDay extends Nutrition {
  day: DayString
  /** Logged, but far below the person's usual day: left out of averages (SPEC §6). */
  partial?: boolean
}

export interface Metrics {
  currentWeightKg: number | null
  avg7d: number | null
  totalChangeKg: number | null
  weeklyRateKg: number | null
  streakDays: number
  bestStreakDays: number
  bmi: number | null
  dailySwingKg: number | null
  goalProgressPct: number | null
  startWeightKg: number | null
  goalWeightKg: number | null
  intake: Intake
  intakeHistory: IntakeHistoryDay[]
  adaptiveTdee?: AdaptiveTdee
  activity?: ActivityBlock
}

/** Observed maintenance calories (SPEC §6). Shown beside kcalTarget; never replaces it. */
export interface AdaptiveTdee {
  kcal: number | null
  avgIntakeKcal: number | null
  weightSlopeKgPerWeek: number | null
  windowStart: DayString
  windowEnd: DayString
  windowDays: number
  /** Complete logged days used for the average (partial days excluded). */
  loggedDays: number
  /** Logged days in the window left out as likely partial. Older servers leave it out. */
  partialDays?: number
  weighIns: number
  confidence: 'high' | 'medium' | 'low' | null
  reason: string | null
  formulaKcal: number | null
  kcalTarget: number | null
  /** The watch's own average daily burn over the same window (null under 7 days of data). */
  watchKcal?: number | null
  watchDays?: number
}

export type GarminState = 'never' | 'connected' | 'needs_login' | 'rate_limited' | 'error'

export interface GarminStatus {
  available: boolean
  connected: boolean
  status: GarminState
  syncing: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  backoffUntil: string | null
  syncHour: number
  /** Hours between scheduled syncs (from syncHour until midnight). */
  syncIntervalHours: number
}

export type CronometerState = 'never' | 'connected' | 'needs_login' | 'rate_limited' | 'error'

export interface CronometerStatus {
  available: boolean
  connected: boolean
  /** The Cronometer account email, kept with the session (never the password). */
  email: string | null
  status: CronometerState
  syncing: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  backoffUntil: string | null
  syncHour: number
  syncIntervalHours: number
  exportsToday: number
  exportsPerDay: number
}

export interface CronometerSyncResult {
  ok: boolean
  from?: DayString
  to?: DayString
  meals?: number
  servings?: number
  /** 'daily' when the account's servings export has no nutrients and day totals were synced. */
  format?: 'servings' | 'daily'
  error?: string
  message?: string
}

export type CorosState = 'never' | 'connected' | 'needs_login' | 'rate_limited' | 'error'

export interface CorosStatus {
  available: boolean
  connected: boolean
  /** When the current COROS authorisation was granted (null when not connected). */
  connectedAt: string | null
  status: CorosState
  syncing: boolean
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  backoffUntil: string | null
  syncHour: number
  syncIntervalHours: number
}

export interface CorosSyncResult {
  ok: boolean
  from?: DayString
  to?: DayString
  days?: number
  sleep?: number
  activities?: number
  /** Tools COROS refused this time; the rest synced. */
  warnings?: string[]
  error?: string
  message?: string
}

export interface Activity {
  id: string
  source: string
  name: string | null
  type: string | null
  startLocal: string
  day: DayString
  durationS: number | null
  movingS: number | null
  distanceM: number | null
  kcal: number | null
  avgHr: number | null
  maxHr: number | null
  elevationGainM: number | null
  avgSpeedMps: number | null
  trainingEffect: number | null
}

export interface DailyActivity {
  day: DayString
  steps: number | null
  activeKcal: number | null
  totalKcal: number | null
  bmrKcal: number | null
  restingHr: number | null
  sleepSeconds: number | null
  intensityMinutes: number | null
  source: string
  syncedAt: string
}

export interface ActivityBlock {
  garmin: GarminStatus
  latest: DailyActivity | null
  avgSteps7d: number | null
  recent: Activity[]
}

export interface GarminSyncResult {
  ok: boolean
  from: DayString
  to: DayString
  days?: number
  activities?: number
  error?: string
  message?: string
}

export interface DashboardPayload {
  metrics: Metrics
}

export interface AppState {
  user: User | null
  profile: Profile | null
  weights: WeightEntry[]
  phases: Phase[]
  meals: Meal[]
  foods: Food[]
  messages: ChatMessage[]
  analysis: Analysis | null
  metrics: Metrics | null
  loading: boolean
  loaded: boolean
  error: string | null
}

export type Route = 'chat' | 'dashboard' | 'calories' | 'foods' | 'settings' | 'history' | 'activity' | 'insights' | 'advanced' | 'lifting'

export interface ViewContext {
  state: AppState
  navigate: (route: Route) => void
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

export interface ViewHandle {
  element: HTMLElement
  destroy?: () => void
}

export type WeightInput = Pick<WeightEntry, 'date' | 'weightKg'> & { note?: string | null }
export type WeightPatch = Partial<WeightInput>
export type PhaseInput = Pick<Phase, 'name' | 'startDate'> & Partial<Pick<Phase, 'color' | 'endDate'>>
export type PhasePatch = Partial<PhaseInput>
export type MealItemInput = Nutrition & { name: string; quantity?: string | null; foodId?: string | null }
export type MealInput = Nutrition & {
  name: string
  eatenAt?: string
  day?: DayString
  description?: string | null
  fiberG?: number | null
  source?: MealSource
  confidence?: number | null
  analysisId?: string | null
  /** Which meal of a multi-meal analysis this is (0-based); keeps the save idempotent per meal. */
  analysisPart?: number
  items?: MealItemInput[]
}
export type MealPatch = Partial<MealInput>
export type FoodInput = Nutrition & { name: string; serving?: string | null }
export type ChatInput = {
  message: string
  day?: DayString
  save?: boolean
  clientId?: string
  /** Re-estimate an earlier analysis using `message` as the user's correction. */
  reviseAnalysisId?: string
}

export interface FoodCsvMapping {
  name: string
  kcal: string
  protein: string
  carbs: string
  fat: string
  serving: string
  date?: string
}

export interface FoodCsvPreviewRow {
  line: number
  raw: Record<string, string>
  parsed: Partial<FoodInput> & { date?: DayString }
}

export interface FoodCsvPreview {
  headers: string[]
  suggestedMapping: Partial<FoodCsvMapping>
  rows: FoodCsvPreviewRow[]
  skipped: { line: number; reason: string }[]
}

/* -------------------------------------------------------------------------- */
/* Garmin insights (GET /api/insights)                                        */
/* -------------------------------------------------------------------------- */

export interface InsightDay {
  day: DayString
  steps: number | null
  activeKcal: number | null
  totalKcal: number | null
  bmrKcal: number | null
  restingHr: number | null
  sleepSeconds: number | null
  intensityMinutes: number | null
  distanceM: number | null
  floorsM: number | null
  moderateMin: number | null
  vigorousMin: number | null
  stepGoal: number | null
  minHr: number | null
  maxHr: number | null
  stressAvg: number | null
  stressMax: number | null
  stressRestS: number | null
  stressLowS: number | null
  stressMediumS: number | null
  stressHighS: number | null
  bbHigh: number | null
  bbLow: number | null
  bbCharged: number | null
  bbDrained: number | null
  bbWake: number | null
  spo2Avg: number | null
  spo2Low: number | null
  respAvg: number | null
  hrvNight: number | null
  hrvStatus: string | null
}

export interface SleepNight {
  day: DayString
  startLocal: string | null
  endLocal: string | null
  deepS: number | null
  lightS: number | null
  remS: number | null
  awakeS: number | null
  score: number | null
  qualityScore: number | null
  durationScore: number | null
  recoveryScore: number | null
  avgStress: number | null
  avgResp: number | null
  avgSpo2: number | null
  avgHr: number | null
  awakeCount: number | null
  restlessCount: number | null
  feedback: string | null
}

export interface FitnessMetric {
  day: DayString
  vo2max: number | null
  race5kS: number | null
  race10kS: number | null
  raceHalfS: number | null
  raceMarathonS: number | null
  trainingStatus: string | null
  weeklyLoad: number | null
  loadMin: number | null
  loadMax: number | null
  fitnessAge: number | null
  heatPct: number | null
}

export interface InsightActivity {
  id: string
  startLocal: string
  day: DayString
  name: string | null
  type: string | null
  durationS: number | null
  movingS: number | null
  distanceM: number | null
  kcal: number | null
  avgHr: number | null
  maxHr: number | null
  elevationGainM: number | null
  avgSpeedMps: number | null
  trainingEffect: number | null
  anaerobicTe: number | null
  trainingLoad: number | null
  teLabel: string | null
  vo2max: number | null
  steps: number | null
  cadence: number | null
  location: string | null
  hrZonesS: number[] | null
  sets: number | null
  reps: number | null
}

export interface PersonalRecord {
  type: string
  value: number
  achievedAt: string | null
  externalId: string | null
}

export interface InsightsPayload {
  from: DayString
  to: DayString
  coverage: { first: DayString | null; last: DayString | null }
  days: InsightDay[]
  sleep: SleepNight[]
  metrics: FitnessMetric[]
  activities: InsightActivity[]
  intake: { day: DayString; kcal: number; proteinG: number; partial?: boolean }[]
  weights: { day: DayString; weightKg: number }[]
  records: PersonalRecord[]
  meta: {
    hrZones?: Partial<Record<'z1' | 'z2' | 'z3' | 'z4' | 'z5' | 'max' | 'resting' | 'lthr', number>>
    thresholds?: Partial<Record<'lthr' | 'ftp' | 'ltPaceSPerKm', number>>
    lastImport?: { at: string; range: { from: DayString; to: DayString } | null; counts: Record<string, number> }
  }
  /** Which watch wrote the data (any date). Older servers leave it out. */
  sources?: { garmin: boolean; coros: boolean }
}

export interface GarminImportResult {
  days: number
  wellness: number
  sleep: number
  metrics: number
  activities: number
  records: number
}

/* -------------------------------------------------------------------------- */
/* Lifting (SPEC §6 "Lifting")                                                */
/* -------------------------------------------------------------------------- */

export type Muscle = 'chest' | 'back' | 'shoulders' | 'biceps' | 'triceps' | 'quads' | 'hamstrings' | 'glutes' | 'calves' | 'core' | 'other'
export type Equipment = 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight' | 'kettlebell' | 'other'
export type SetKind = 'working' | 'warmup' | 'drop' | 'failure'

export interface Exercise {
  id: string
  name: string
  muscle: Muscle
  equipment: Equipment
  /** Next-weight step; null = the equipment default. */
  incrementKg: number | null
  /** Rep range for progression; both null = picked automatically. */
  repMin?: number | null
  repMax?: number | null
  archived: boolean
  createdAt?: string | null
}

export interface LiftSet {
  id: string
  exerciseId: string
  /** Bodyweight lifts: the added load. */
  weightKg: number
  reps: number
  rpe: number | null
  kind: SetKind
  doneAt: string | null
}

export interface Workout {
  id: string
  day: DayString
  name: string | null
  notes: string | null
  startedAt: string | null
  /** null while the session is in progress. */
  endedAt: string | null
  createdAt?: string | null
  updatedAt?: string | null
  sets: LiftSet[]
}

export interface RoutineItem {
  exerciseId: string
  /** Swapped in when the kit for the main exercise is taken. */
  alternatives: string[]
}

export interface Routine {
  id: string
  name: string
  items: RoutineItem[]
  position: number
  updatedAt?: string | null
}

export interface LiftingPayload {
  exercises: Exercise[]
  workouts: Workout[]
  routines?: Routine[]
}
