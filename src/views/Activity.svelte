<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from '../lib/components/Icon.svelte'
  import StatTile from '../lib/components/StatTile.svelte'
  import GarminSyncControl from '../lib/components/GarminSyncControl.svelte'
  import ActivityRow from '../lib/components/ActivityRow.svelte'
  import { api } from '../lib/api'
  import { actions, app } from '../lib/state.svelte'
  import { fmtClock, fmtSleep } from '../lib/activity'
  import { addDays, fmtNumber, fmtShort, fmtWithDay, fromDateInputValue, toDateInputValue, today } from '../lib/format'
  import { showToast } from '../lib/toast.svelte'
  import type { Activity, DailyActivity, GarminStatus } from '../lib/types'

  const PAGE = 30
  /** Days of watch data loaded for the day view and the recent-days table. */
  const DAILY_WINDOW = 30
  const RECENT_ROWS = 14

  const todayDay = today()
  const yesterday = addDays(todayDay, -1)
  const oldestDay = addDays(todayDay, -(DAILY_WINDOW - 1))

  let activities = $state<Activity[]>([])
  let garmin = $state<GarminStatus | null>(null)
  let loading = $state(true)
  let loadingMore = $state(false)
  let hasMore = $state(false)
  let daily = $state<DailyActivity[]>([])
  /** Null until the user picks a day; until then the last complete day is shown. */
  let pickedDay = $state<string | null>(null)

  const byDay = $derived(new Map(daily.map((d) => [d.day, d])))
  /** Yesterday by default: today is partial and depends on when the last sync ran. */
  const defaultDay = $derived(byDay.has(yesterday) || daily.length === 0 ? yesterday : daily[daily.length - 1].day)
  const selectedDay = $derived(pickedDay ?? defaultDay)
  const selected = $derived(byDay.get(selectedDay) ?? null)
  const isToday = $derived(selectedDay === todayDay)
  /** Average over the 7 complete days before the one shown (today never counts). */
  const avgSteps = $derived.by(() => {
    const end = isToday ? yesterday : addDays(selectedDay, -1)
    const start = addDays(end, -6)
    const steps = daily.filter((d) => d.day >= start && d.day <= end && d.steps !== null).map((d) => d.steps as number)
    return steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : null
  })
  const dayHeading = $derived(
    isToday ? 'Today so far' : selectedDay === yesterday ? `Yesterday · ${fmtWithDay(selectedDay)}` : fmtWithDay(selectedDay),
  )
  const recentDays = $derived(daily.slice(-RECENT_ROWS).reverse())

  function showDay(day: string): void {
    pickedDay = day < oldestDay ? oldestDay : day > todayDay ? todayDay : day
  }

  function pickDay(event: Event): void {
    const day = fromDateInputValue((event.currentTarget as HTMLInputElement).value)
    if (day) showDay(day)
  }

  async function load(): Promise<void> {
    loading = true
    try {
      const [list, status, days] = await Promise.all([
        api.getActivities({ limit: PAGE }),
        api.getGarmin(),
        api.getDailyActivity({ from: oldestDay, to: todayDay }),
      ])
      activities = list.activities
      daily = days.days
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
    <p class="view-subtitle">Workouts and daily numbers from your watch.</p>
  </header>

  <section class="metric-card" aria-labelledby="garmin-sync-title">
    <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="activity" size={20} /></span><h2 class="metric-card-title" id="garmin-sync-title">Garmin</h2></div></div>
    <div class="metric-card-content"><GarminSyncControl status={garmin} onsynced={synced} showHelp email={app.user?.email} /></div>
  </section>

  {#if daily.length > 0}
    <section class="daily-section" aria-labelledby="daily-title">
      <div class="day-nav">
        <button class="icon-button" type="button" aria-label="Previous day" disabled={selectedDay <= oldestDay} onclick={() => showDay(addDays(selectedDay, -1))}><Icon name="chevron-left" size={20} /></button>
        <input class="field-input day-input" type="date" aria-label="Day to show" min={toDateInputValue(oldestDay)} max={toDateInputValue(todayDay)} value={toDateInputValue(selectedDay)} onchange={pickDay} />
        <button class="icon-button" type="button" aria-label="Next day" disabled={isToday} onclick={() => showDay(addDays(selectedDay, 1))}><Icon name="chevron-right" size={20} /></button>
      </div>
      <div class="section-heading">
        <h2 id="daily-title">{dayHeading}</h2>
        {#if isToday && selected}<span>As of the {fmtClock(selected.syncedAt)} sync</span>{/if}
      </div>
      {#if selected}
        <div class="stat-grid">
          <StatTile label="Steps" value={selected.steps === null ? '—' : fmtNumber(selected.steps, 0)} sublabel={avgSteps === null ? undefined : `7-day avg ${fmtNumber(avgSteps, 0)}`} />
          <StatTile label="Active calories" value={selected.activeKcal === null ? '—' : fmtNumber(selected.activeKcal, 0)} unit={selected.activeKcal === null ? undefined : 'kcal'} sublabel={selected.totalKcal === null ? undefined : `${fmtNumber(selected.totalKcal, 0)} kcal total`} />
          <StatTile label="Resting HR" value={selected.restingHr === null ? '—' : selected.restingHr} unit={selected.restingHr === null ? undefined : 'bpm'} />
          <StatTile label="Sleep" value={fmtSleep(selected.sleepSeconds)} />
        </div>
      {:else}
        <p class="quiet-empty">No watch data for this day.</p>
      {/if}
    </section>

    <section class="metric-card" aria-labelledby="recent-days-title">
      <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="calendar" size={20} /></span><h2 class="metric-card-title" id="recent-days-title">Recent days</h2></div></div>
      <div class="metric-card-content">
        <div class="table-scroll">
          <table class="days-table">
            <caption class="sr-only">Daily watch data, newest first. Choose a day to show it above.</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col" class="num">Steps</th>
                <th scope="col" class="num">Active</th>
                <th scope="col" class="num wide-only">Total</th>
                <th scope="col" class="num">RHR</th>
                <th scope="col" class="num">Sleep</th>
              </tr>
            </thead>
            <tbody>
              {#each recentDays as d (d.day)}
                <tr class:selected={d.day === selectedDay}>
                  <th scope="row"><button class="day-link" type="button" aria-pressed={d.day === selectedDay} onclick={() => showDay(d.day)}>{d.day === todayDay ? 'Today*' : fmtShort(d.day)}</button></th>
                  <td class="num">{d.steps === null ? '—' : fmtNumber(d.steps, 0)}</td>
                  <td class="num">{d.activeKcal === null ? '—' : fmtNumber(d.activeKcal, 0)}</td>
                  <td class="num wide-only">{d.totalKcal === null ? '—' : fmtNumber(d.totalKcal, 0)}</td>
                  <td class="num">{d.restingHr ?? '—'}</td>
                  <td class="num">{fmtSleep(d.sleepSeconds)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if recentDays[0]?.day === todayDay}<p class="table-note">* Today is partial: it only counts up to the last sync.</p>{/if}
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
  .section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap; }
  .section-heading h2 { margin: 0; font-size: var(--text-lg); }
  .section-heading span { color: var(--color-text-muted); font-size: var(--text-xs); }
  .day-nav { display: flex; align-items: center; gap: var(--space-2); }
  .day-input { width: auto; min-width: 9.5rem; }
  .table-scroll { overflow-x: auto; }
  .days-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .days-table th, .days-table td { padding: var(--space-2); border-top: 1px solid var(--color-border); text-align: left; white-space: nowrap; }
  .days-table thead th { border-top: 0; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .days-table .num { text-align: right; }
  .days-table tr.selected { background: var(--color-accent-soft); }
  .day-link { padding: 0; border: 0; background: none; color: var(--color-text); font: inherit; font-weight: var(--weight-medium); text-decoration: underline; text-decoration-color: var(--color-border); text-underline-offset: 3px; cursor: pointer; }
  .table-note { margin: var(--space-2) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); }
  @media (max-width: 30rem) {
    .days-table .wide-only { display: none; }
    .days-table th, .days-table td { padding: var(--space-2) var(--space-1); }
  }
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
