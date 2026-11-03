<script lang="ts">
  import { activityTypeLabel, fmtActivityStart, fmtDistance, fmtDuration, fmtPaceOrSpeed } from '../activity'
  import type { Activity } from '../types'

  interface Props {
    activity: Activity
    compact?: boolean
  }

  let { activity, compact = false }: Props = $props()

  const distance = $derived(fmtDistance(activity.distanceM, activity.type))
  const pace = $derived(fmtPaceOrSpeed(activity))
  const stats = $derived(
    [
      { label: 'Time', value: fmtDuration(activity.durationS) },
      distance ? { label: 'Distance', value: distance } : null,
      pace ? { label: activity.type && /running|walking|hiking|swim/.test(activity.type) ? 'Pace' : 'Speed', value: pace } : null,
      activity.avgHr ? { label: 'Avg HR', value: `${Math.round(activity.avgHr)} bpm` } : null,
      activity.kcal ? { label: 'Calories', value: `${Math.round(activity.kcal).toLocaleString()} kcal` } : null,
      !compact && activity.elevationGainM ? { label: 'Climb', value: `${Math.round(activity.elevationGainM)} m` } : null,
      !compact && activity.trainingEffect ? { label: 'Training effect', value: activity.trainingEffect.toFixed(1) } : null,
    ].filter((s): s is { label: string; value: string } => s !== null).slice(0, compact ? 3 : 7),
  )
</script>

<article class="activity-row" class:compact>
  <div class="activity-head">
    <span class="activity-type">{activityTypeLabel(activity.type)}</span>
    <strong class="activity-name">{activity.name ?? activityTypeLabel(activity.type)}</strong>
    <span class="activity-when">{fmtActivityStart(activity.startLocal)}</span>
  </div>
  <dl class="activity-stats">
    {#each stats as stat (stat.label)}
      <div><dt>{stat.label}</dt><dd>{stat.value}</dd></div>
    {/each}
  </dl>
</article>

<style>
  .activity-row { display: flex; min-width: 0; padding: var(--space-3) 0; flex-direction: column; gap: var(--space-2); }
  .activity-head { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto; column-gap: var(--space-3); }
  .activity-type { grid-column: 1 / -1; color: var(--color-accent); font-size: var(--text-xs); font-weight: var(--weight-medium); text-transform: uppercase; letter-spacing: 0.04em; }
  .activity-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .activity-when { color: var(--color-text-muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums; white-space: nowrap; align-self: center; }
  .activity-stats { display: flex; margin: 0; flex-wrap: wrap; gap: var(--space-2) var(--space-5); }
  .activity-stats div { display: flex; flex-direction: column; }
  .activity-stats dt { color: var(--color-text-muted); font-size: var(--text-xs); }
  .activity-stats dd { margin: 0; font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
  .compact .activity-stats { gap: var(--space-1) var(--space-4); }
</style>
