<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import { fmtKcal, fmtNumber } from '../format'
  import type { AdaptiveTdee } from '../types'

  interface Props {
    tdee: AdaptiveTdee
  }

  let { tdee }: Props = $props()

  const MIN_LOGGED = 14
  const MIN_WEIGH_INS = 8
  const KCAL_PER_KG = 7700

  const confidenceTone = $derived(tdee.confidence === 'high' ? 'success' : tdee.confidence === 'medium' ? 'neutral' : 'warning')

  // What the current target implies against the observed maintenance.
  const targetGap = $derived(tdee.kcal !== null && tdee.kcalTarget !== null ? tdee.kcalTarget - tdee.kcal : null)
  const impliedRate = $derived(targetGap === null ? null : (targetGap * 7) / KCAL_PER_KG)

  function signedKcal(value: number): string {
    return `${value > 0 ? '+' : value < 0 ? '−' : '±'}${Math.abs(Math.round(value)).toLocaleString()}`
  }
</script>

<section class="metric-card tdee-card" aria-labelledby="tdee-title">
  <div class="metric-card-header">
    <div class="metric-card-heading">
      <span class="metric-card-icon"><Icon name="scale" size={20} /></span>
      <h2 class="metric-card-title" id="tdee-title">Maintenance estimate</h2>
    </div>
    {#if tdee.confidence}<span class="badge" data-tone={confidenceTone}>{tdee.confidence} confidence</span>{/if}
  </div>

  <div class="metric-card-content">
    {#if tdee.kcal !== null}
      <div class="tdee-headline">
        <strong>{fmtKcal(tdee.kcal)}</strong><span>/ day</span>
      </div>
      <p class="tdee-basis">
        Based on {tdee.loggedDays} of {tdee.windowDays} days logged at {fmtKcal(tdee.avgIntakeKcal ?? 0)} on average,
        while your weight trend was {tdee.weightSlopeKgPerWeek !== null && tdee.weightSlopeKgPerWeek > 0 ? '+' : ''}{fmtNumber(tdee.weightSlopeKgPerWeek ?? 0, 2)} kg/wk.
      </p>

      <dl class="tdee-compare">
        <div><dt>From your logs</dt><dd>{fmtKcal(tdee.kcal)}</dd></div>
        <div>
          <dt>From the formula</dt>
          <dd>{tdee.formulaKcal === null ? '—' : fmtKcal(tdee.formulaKcal)}</dd>
        </div>
        {#if tdee.watchKcal != null}
          <div><dt>Garmin watch</dt><dd>{fmtKcal(tdee.watchKcal)}</dd></div>
        {/if}
        <div><dt>Your daily target</dt><dd>{tdee.kcalTarget === null ? '—' : fmtKcal(tdee.kcalTarget)}</dd></div>
      </dl>

      {#if targetGap !== null && impliedRate !== null}
        <p class="tdee-implication">
          {#if Math.abs(targetGap) < 50}
            Your target is about at maintenance, so expect your weight to hold steady.
          {:else}
            Your target is {signedKcal(targetGap)} kcal/day against this estimate, which works out to about
            {impliedRate > 0 ? '+' : '−'}{fmtNumber(Math.abs(impliedRate), 2)} kg/wk.
          {/if}
        </p>
      {/if}
      <p class="card-note">
        This assumes the meals you log are complete. Days where you skipped logging some meals pull it down. The formula comes from the
        activity level in Settings.{#if tdee.watchKcal != null}{' '}The watch figure is Garmin's own average daily burn over {tdee.watchDays} days. Watches often overestimate it.{/if}
      </p>
    {:else}
      <p class="tdee-reason">{tdee.reason}</p>
      <div class="tdee-progress">
        <div>
          <span>Days with food logged</span>
          <strong>{Math.min(tdee.loggedDays, MIN_LOGGED)} / {MIN_LOGGED}</strong>
          <div class="progress-track" role="progressbar" aria-label="Days with food logged" aria-valuemin="0" aria-valuemax={MIN_LOGGED} aria-valuenow={Math.min(tdee.loggedDays, MIN_LOGGED)}>
            <span style:width={`${Math.min(100, (tdee.loggedDays / MIN_LOGGED) * 100)}%`}></span>
          </div>
        </div>
        <div>
          <span>Weigh-ins</span>
          <strong>{Math.min(tdee.weighIns, MIN_WEIGH_INS)} / {MIN_WEIGH_INS}</strong>
          <div class="progress-track" role="progressbar" aria-label="Weigh-ins" aria-valuemin="0" aria-valuemax={MIN_WEIGH_INS} aria-valuenow={Math.min(tdee.weighIns, MIN_WEIGH_INS)}>
            <span style:width={`${Math.min(100, (tdee.weighIns / MIN_WEIGH_INS) * 100)}%`}></span>
          </div>
        </div>
      </div>
      {#if tdee.formulaKcal !== null}
        <p class="card-note">Until then, the formula estimate is {fmtKcal(tdee.formulaKcal)} a day, based on your profile.</p>
      {/if}
    {/if}
  </div>
</section>

<style>
  .tdee-card { min-width: 0; }
  .tdee-headline { display: flex; align-items: baseline; gap: var(--space-2); font-variant-numeric: tabular-nums; }
  .tdee-headline strong { font-size: var(--text-number); letter-spacing: -0.045em; line-height: 1.15; }
  .tdee-headline span { color: var(--color-text-muted); font-size: var(--text-lg); }
  .tdee-basis, .tdee-implication, .tdee-reason { margin: var(--space-2) 0 var(--space-3); color: var(--color-text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .tdee-implication { color: var(--color-text); }
  .tdee-compare { display: grid; margin: 0; grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr)); gap: var(--space-2); }
  .tdee-compare div { display: flex; min-width: 0; padding: var(--space-3); flex-direction: column; gap: var(--space-1); border-radius: var(--radius-card); background: var(--color-surface-sunken); }
  .tdee-compare dt { color: var(--color-text-muted); font-size: var(--text-xs); }
  .tdee-compare dd { margin: 0; font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
  .card-note { margin: var(--space-3) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); }
  .tdee-progress { display: grid; gap: var(--space-3); }
  .tdee-progress > div { display: grid; grid-template-columns: 1fr auto; gap: var(--space-1) var(--space-3); font-size: var(--text-sm); }
  .tdee-progress strong { font-variant-numeric: tabular-nums; }
  .progress-track { grid-column: 1 / -1; height: 0.5rem; overflow: hidden; border-radius: var(--radius-pill); background: var(--color-surface-sunken); }
  .progress-track span { display: block; height: 100%; border-radius: inherit; background: var(--color-accent); }
  @media (max-width: 30rem) {
    .tdee-compare { grid-template-columns: minmax(0, 1fr); }
    .tdee-compare div { flex-direction: row; justify-content: space-between; }
  }
</style>
