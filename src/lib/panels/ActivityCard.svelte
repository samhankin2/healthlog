<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import ActivityRow from '../components/ActivityRow.svelte'
  import { fmtAgo, fmtSleep } from '../activity'
  import { fmtNumber, today } from '../format'
  import type { ActivityBlock } from '../types'

  interface Props {
    block: ActivityBlock
    onopen: () => void
  }

  let { block, onopen }: Props = $props()

  const latest = $derived(block.latest)
  const isToday = $derived(latest?.day === today())
  const needsAttention = $derived(block.garmin.status === 'needs_login' || block.garmin.status === 'error' || !!block.garmin.backoffUntil)
</script>

<section class="metric-card activity-card" aria-labelledby="activity-card-title">
  <div class="metric-card-header">
    <div class="metric-card-heading">
      <span class="metric-card-icon"><Icon name="trending-up" size={20} /></span>
      <h2 class="metric-card-title" id="activity-card-title">Activity</h2>
    </div>
    <button class="button button--secondary compact-button" type="button" aria-label="Open all activities" onclick={onopen}>All <Icon name="chevron-right" size={17} /></button>
  </div>
  <div class="metric-card-content">
    {#if latest}
      <p class="activity-day">{isToday ? 'Today so far' : `Latest: ${latest.day}`}</p>
      <dl class="daily-strip">
        <div><dt>Steps</dt><dd>{latest.steps === null ? '—' : fmtNumber(latest.steps, 0)}</dd></div>
        <div><dt>Active</dt><dd>{latest.activeKcal === null ? '—' : `${fmtNumber(latest.activeKcal, 0)} kcal`}</dd></div>
        <div><dt>Resting HR</dt><dd>{latest.restingHr === null ? '—' : `${latest.restingHr} bpm`}</dd></div>
        <div><dt>Sleep</dt><dd>{fmtSleep(latest.sleepSeconds)}</dd></div>
      </dl>
    {/if}

    {#if block.recent.length > 0}
      <ul class="recent-list" aria-label="Recent activities">
        {#each block.recent as activity (activity.id)}
          <li><ActivityRow {activity} compact /></li>
        {/each}
      </ul>
    {:else}
      <p class="card-note">No activities synced yet.</p>
    {/if}

    <p class="sync-note" class:attention={needsAttention}>
      {#if block.garmin.backoffUntil}Garmin is rate-limiting requests, so syncing is paused for now.
      {:else if block.garmin.status === 'needs_login'}Garmin needs a fresh login. See the Activity page.
      {:else if block.garmin.status === 'error'}Last Garmin sync failed {fmtAgo(block.garmin.lastAttemptAt)}.
      {:else}Garmin synced {fmtAgo(block.garmin.lastSuccessAt)}.{/if}
    </p>
  </div>
</section>

<style>
  .activity-card { min-width: 0; }
  .activity-day { margin: 0 0 var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); }
  .daily-strip { display: grid; margin: 0 0 var(--space-3); grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
  .daily-strip div { display: flex; min-width: 0; padding: var(--space-2) var(--space-3); flex-direction: column; border-radius: var(--radius-card); background: var(--color-surface-sunken); }
  .daily-strip dt { color: var(--color-text-muted); font-size: var(--text-xs); }
  .daily-strip dd { margin: 0; font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
  .recent-list { display: flex; margin: 0; padding: 0; flex-direction: column; list-style: none; }
  .recent-list li { border-top: 1px solid var(--color-border); }
  .recent-list li:first-child { border-top: 0; }
  .card-note, .sync-note { margin: var(--space-2) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); }
  .sync-note.attention { color: var(--color-danger); }
  .compact-button { min-height: var(--touch-target); padding: var(--space-2) var(--space-3); }
  @media (min-width: 30rem) {
    .daily-strip { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
</style>
