<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import StatTile from '../lib/components/StatTile.svelte'
  import GarminSyncControl from '../lib/components/GarminSyncControl.svelte'
  import ActivityRow from '../lib/components/ActivityRow.svelte'
  import { api } from '../lib/api'
  import { actions, app } from '../lib/state.svelte'
  import { fmtSleep } from '../lib/activity'
  import { fmtNumber, today } from '../lib/format'
  import { showToast } from '../lib/toast.svelte'
  import type { Activity, GarminStatus } from '../lib/types'

  const PAGE = 30

  let activities = $state<Activity[]>([])
  let garmin = $state<GarminStatus | null>(null)
  let loading = $state(true)
  let loadingMore = $state(false)
  let hasMore = $state(false)
  const latest = $derived(app.metrics?.activity?.latest ?? null)
  const avgSteps = $derived(app.metrics?.activity?.avgSteps7d ?? null)

  async function load(): Promise<void> {
    loading = true
    try {
      const [list, status] = await Promise.all([api.getActivities({ limit: PAGE }), api.getGarmin()])
      activities = list.activities
      hasMore = list.activities.length === PAGE
      garmin = status.garmin
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load activities.', 'error')
    } finally {
      loading = false
    }
  }

  async function loadMore(): Promise<void> {
    const last = activities[activities.length - 1]
    if (!last || loadingMore) return
    loadingMore = true
    try {
      const list = await api.getActivities({ limit: PAGE, before: last.startLocal })
      activities = [...activities, ...list.activities]
      hasMore = list.activities.length === PAGE
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load more activities.', 'error')
    } finally {
      loadingMore = false
    }
  }

  async function synced(status: GarminStatus): Promise<void> {
    garmin = status
    await Promise.all([load(), actions.loadDashboard().catch(() => undefined)])
  }

  onMount(load)
</script>

<div class="view view--activity">
  <header class="view-header">
    <h1 class="view-title">Activity</h1>
    <p class="view-subtitle">Workouts and daily numbers from your Garmin watch.</p>
  </header>

  <section class="metric-card" aria-labelledby="garmin-sync-title">
    <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="activity" size={20} /></span><h2 class="metric-card-title" id="garmin-sync-title">Garmin</h2></div></div>
    <div class="metric-card-content"><GarminSyncControl status={garmin} onsynced={synced} showHelp email={app.user?.email} /></div>
  </section>

  {#if latest}
    <section class="daily-section" aria-labelledby="daily-title">
      <div class="section-heading"><h2 id="daily-title">{latest.day === today() ? 'Today so far' : `Latest day · ${latest.day}`}</h2></div>
      <div class="stat-grid">
        <StatTile label="Steps" value={latest.steps === null ? '—' : fmtNumber(latest.steps, 0)} sublabel={avgSteps === null ? undefined : `7-day avg ${fmtNumber(avgSteps, 0)}`} />
        <StatTile label="Active calories" value={latest.activeKcal === null ? '—' : fmtNumber(latest.activeKcal, 0)} unit={latest.activeKcal === null ? undefined : 'kcal'} sublabel={latest.totalKcal === null ? undefined : `${fmtNumber(latest.totalKcal, 0)} kcal total`} />
        <StatTile label="Resting HR" value={latest.restingHr === null ? '—' : latest.restingHr} unit={latest.restingHr === null ? undefined : 'bpm'} />
        <StatTile label="Sleep" value={fmtSleep(latest.sleepSeconds)} />
      </div>
    </section>
  {/if}

  <section class="metric-card" aria-labelledby="activities-title">
    <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="trending-up" size={20} /></span><h2 class="metric-card-title" id="activities-title">Activities</h2></div>{#if activities.length > 0}<span class="badge">{activities.length}{hasMore ? '+' : ''}</span>{/if}</div>
    <div class="metric-card-content">
      {#if loading}
        <div class="placeholder-panel loading-panel"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading activities</span></div>
      {:else if activities.length === 0}
        <p class="quiet-empty">No activities yet. They'll show up here after the first Garmin sync.</p>
      {:else}
        <ul class="activity-list">
          {#each activities as activity (activity.id)}
            <li><ActivityRow {activity} /></li>
          {/each}
        </ul>
        {#if hasMore}
          <div class="more"><button class="button button--secondary" type="button" onclick={loadMore} disabled={loadingMore}>{loadingMore ? 'Loading…' : 'Show older activities'}</button></div>
        {/if}
      {/if}
    </div>
  </section>
</div>

<style>
  .daily-section { display: flex; flex-direction: column; gap: var(--space-3); }
  .section-heading h2 { margin: 0; font-size: var(--text-lg); }
  .stat-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .activity-list { display: flex; margin: 0; padding: 0; flex-direction: column; list-style: none; }
  .activity-list li { border-top: 1px solid var(--color-border); }
  .activity-list li:first-child { border-top: 0; }
  .quiet-empty { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .more { display: flex; margin-top: var(--space-4); justify-content: center; }
  .loading-panel { min-height: 8rem; }
  @media (min-width: 43.75rem) {
    .stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  }
</style>
