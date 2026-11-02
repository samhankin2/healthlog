# Svelte component contract (HealthLog)

**Both Svelte lanes build against this file. Do not change it — if a component
cannot do what you need, work around it and report it.**

Svelte 5 (runes), plain Svelte + Vite (no SvelteKit). TypeScript.

## Where things live

```
src/
  main.ts                  entry: mount(App, { target: document.getElementById('app') })
  App.svelte               shell: auth gate, router, tab bar / side rail
  lib/
    api.ts auth.ts format.ts pwa.ts types.ts store.ts    framework-agnostic (unchanged)
    state.svelte.ts        the reactive state + actions (written, do not change)
    components/            shared primitives — Lane 1 writes these
    charts/                chart helpers
  views/
    Login.svelte Chat.svelte Dashboard.svelte Foods.svelte Settings.svelte History.svelte
  design/
    tokens.css ui.css      the design system — global, imported in main.ts
```

## Runes rules that matter here

- `$state` for mutable local state, `$derived` for computed values.
- **You cannot export a reassigned `$state` primitive.** `state.svelte.ts` uses
  a module-level `let` + a `route()` getter for that reason. Follow the same
  pattern if you need to export mutable state from a `.svelte.ts` module.
- Event handlers: `onclick={fn}` — `on:click` is deprecated in Svelte 5.
- Callbacks, not events: `let { onclose }: Props = $props()`.
- Snippets, not slots: `{@render children?.()}`.
- `bind:value` for two-way; props are **not** bindable unless the child opts
  in with `$bindable()`.
- `bind:this` for DOM refs; the variable is `undefined` until mount.
- Lifecycle: `onMount`, `onDestroy`, or `$effect` with a cleanup return. There
  is no `beforeUpdate`/`afterUpdate` in runes mode.
- `{#each items as item (item.id)}` — never use the index as a key.
- A11y: use a real `<button>`/`<a>`, or add `role` + `tabindex` + `onkeydown`.
  Do not silence warnings with `<!-- svelte-ignore -->`.
- Transitions are driven by the Web Animations API, so
  `@media (prefers-reduced-motion: reduce)` does **not** disable them — use
  `prefersReducedMotion` from `svelte/motion`.

## The shared components (Lane 1 writes these; Lane 2 imports them)

Exact props — both lanes must match this exactly.

```ts
// Icon.svelte
Props: { name: IconName; size?: number }
IconName = 'alert' | 'chat' | 'chart' | 'food' | 'settings' | 'plus' | 'close'
        | 'check' | 'chevron' | 'edit' | 'trash' | 'send' | 'scale' | 'history'
        | 'upload' | 'download' | 'logout' | 'user' | 'camera' | 'sparkle'

// Button.svelte
Props: { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
         type?: 'button' | 'submit'; disabled?: boolean; full?: boolean
         onclick?: (event: MouseEvent) => void }
Snippet: children (label). Renders <button class="button button--{variant}">.

// Field.svelte
Props: { id: string; label: string
         type?: 'text' | 'email' | 'password' | 'number' | 'date'
         value?: string | number; placeholder?: string
         hint?: string; error?: string; required?: boolean; disabled?: boolean
         autocomplete?: string; inputmode?: string
         oninput?: (value: string) => void }
Renders .field > .field-label + .field-input (+ .field-hint / .field-error).
Global classes in ui.css already style these — do not restyle them.

// SelectField.svelte
Props: { id: string; label: string; value: string
         options: { value: string; label: string }[]
         hint?: string; error?: string; disabled?: boolean
         onchange?: (value: string) => void }

// SegmentedControl.svelte
Props: { options: { value: string; label: string }[]; value: string
         ariaLabel?: string; onchange: (value: string) => void }

// StatTile.svelte
Props: { label: string; value: string | number; unit?: string
         sublabel?: string; tone?: 'neutral' | 'up' | 'down' | 'accent' }

// Sheet.svelte
Props: { open: boolean; title?: string; subtitle?: string; onclose: () => void }
Snippets: children (body), actions (optional footer row).
Bottom sheet on phones, centred dialog on desktop. role="dialog" aria-modal,
// Escape closes, focus trapped and restored, body scroll locked.

// ConfirmDialog.svelte
Props: { open: boolean; title: string; message: string
         confirmLabel?: string; danger?: boolean
         onconfirm: () => void; oncancel: () => void }

// EmptyState.svelte
Props: { icon?: IconName; title: string; message?: string }
Snippet: children (optional actions).

// Toast.svelte
Props: { message: string; tone?: 'default' | 'success' | 'error'; visible: boolean }
// Also: src/lib/toast.svelte.ts exports  showToast(message, tone?)  and
//        hideToast()  — a $state-backed toast host; App.svelte renders <Toast/> once.

// MacroBar.svelte
Props: { protein: number; carbs: number; fat: number; kcal?: number }
// A horizontal split bar in the macro colours + a legend with grams.
// Colour never carries meaning alone: always label the macros.

// ModelCard.svelte
Props: { label: string; model: string
         total: { kcal: number; protein_g: number; carbs_g: number; fat_g: number }
         confidence?: number | null; notes?: string; chosen?: boolean }
// One column of the "Model A / Model B" comparison card.
```

## State — `src/lib/state.svelte.ts` (already written, do not change)

```ts
import { app, actions, route, navigate, ROUTES } from '../lib/state.svelte'
import type { Route } from '../lib/state.svelte'

app        // $state<AppState>: user, profile, weights, phases, meals, foods,
           //   messages, analysis, metrics, loading, loaded, error
actions    // hydrate(), refresh(), reset(), adoptUser(), loadWeights(),
           //   createWeight(), updateWeight(), deleteWeight(), loadPhases(),
           //   createPhase(), updatePhase(), deletePhase(), updateProfile(),
           //   loadDashboard(), loadMeals(), createMeal(), updateMeal(),
           //   deleteMeal(), loadFoods(), createFood(), deleteFood(),
           //   loadMessages(), sendChat(), loadAnalysis(), importWeightJson()
route()    // current Route — reactive when read in a template
navigate(route)
ROUTES     // ['chat','dashboard','foods','settings','history']
```

`api.ts` is the only module that calls `fetch`. Use `actions.*` for data.

## Backend facts — exact field names

- `app.metrics.intake` → `{ day, kcal, kcalTarget, proteinG, **carbG** (singular),
  fatG, proteinPct, carbPct, fatPct }`. `intake` percentages are the share of
  **consumed** energy (4/4/9 kcal per gram), not of the target.
- `app.metrics.intakeHistory[]` → `{ day, kcal, proteinG, **carbsG** (plural),
  fatG }`. Both spellings are correct in their own place — do not normalise.
- `analysis` → `{ id, modelA, modelB, modelAOutput, modelBOutput, reconciled,
  comparison, agreement: 'high'|'medium'|'low', deltaPct }`.
  `modelXOutput` → `{ items, total: { kcal, protein_g, carbs_g, fat_g },
  confidence, notes }`. `reconciled` → `{ items, total }`.
- `POST /api/chat` body `{ message, day?, save?, clientId? }` — `clientId` is
  an idempotency key; **reuse the same one on retry** so a double tap cannot
  create two meals. `save: false` analyses without saving.
- `GET /api/chat/messages` returns messages **oldest → newest**.
- `app.metrics` also has `currentWeightKg`, `avg7d`, `totalChangeKg`,
  `weeklyRateKg`, `streakDays`, `bestStreakDays`, `bmi`, `dailySwingKg`,
  `goalProgressPct`, `startWeightKg`, `goalWeightKg`, `entryCount`,
  `latestDate`, `toGoalKg`, `goalReached`, `adherence`, `days`.
  **Do not recompute metrics in the browser** — the API owns them.
- CSV import preview → `{ headers, suggestedMapping, rows: [{ line, raw,
  parsed: { name, kcal, proteinG, carbsG, fatG, serving, date } }],
  skipped: [{ line, reason }], totalRows, truncated }`. Mapping keys are
  exactly `name, kcal, protein, carbs, fat, serving, date` and each value is a
  **CSV header name**.
- `PUT /api/profile` recomputes `kcalTarget` from Mifflin–St Jeor when the
  request carries `heightCm`, `startWeightKg`, `age`, `sex` or
  `activityLevel` — so **always send `kcalTarget` together with those fields**
  if the user has a custom target.
- `sex` ∈ `male|female|other`; `activityLevel` ∈
  `sedentary|light|moderate|active|very_active`.
- Timestamps are ISO-8601 UTC strings; day-keyed fields are `YYYY-MM-DD`.
  Weights are kilograms.

## Design language

Calm, quiet instrument — not gamified. Warm off-white/green.
`--color-bg #f3f5f1`, `--color-accent #146c5a`, dark `#101613`/`#7bd8bb`,
16px radius cards, 1px borders + soft shadow, tabular figures.
Macro colours: protein `--color-protein`, carbs `--color-carb`, fat
`--color-fat` (each has a `-soft` variant).

Non-negotiables:

- Mobile-first, and genuinely good on desktop (bottom tab bar under ~900px,
  left rail above).
- Every control has an accessible name; icon-only buttons are labelled.
- Touch targets ≥ 44px; visible focus rings; focus trapped in sheets and
  restored on close; Escape closes sheets.
- Light and dark themes both WCAG AA; `prefers-reduced-motion` respected.
- **Colour never carries meaning alone** — pair it with a word or a sign.
- Numbers use tabular figures.
- Hash routing (`#/chat`), so a refresh or a shared link never 404s on Pages.
