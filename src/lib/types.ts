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
  proteinPct: number | null
  carbPct: number | null
  fatPct: number | null
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

export type MealSource = 'ai' | 'manual' | 'import' | 'saved_food'

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

export interface ReconciledOutput {
  items: AnalysisItem[]
  total: AnalysisTotal
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

export type Route = 'chat' | 'dashboard' | 'foods' | 'settings' | 'history'

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
  items?: MealItemInput[]
}
export type MealPatch = Partial<MealInput>
export type FoodInput = Nutrition & { name: string; serving?: string | null }
export type ChatInput = { message: string; day?: DayString; save?: boolean; clientId?: string }

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
