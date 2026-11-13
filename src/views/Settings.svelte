<script lang="ts">
  import Icon from '../lib/components/Icon.svelte'
  import SegmentedControl from '../lib/components/SegmentedControl.svelte'
  import WeightJsonPanel from '../lib/panels/WeightJsonPanel.svelte'
  import ConfirmPanel from '../lib/panels/ConfirmPanel.svelte'
  import GarminSyncControl from '../lib/components/GarminSyncControl.svelte'
  import CronometerCard from '../lib/components/CronometerCard.svelte'
  import { actions, app, navigate } from '../lib/state.svelte'
  import { api } from '../lib/api'
  import { logout } from '../lib/auth'
  import { today } from '../lib/format'
  import { showToast } from '../lib/toast.svelte'
  import type { ActivityLevel, ProfilePatch, Sex } from '../lib/types'

  const RANGES = [
    { value: '30', label: '30d' },
    { value: '90', label: '90d' },
    { value: '180', label: '6mo' },
    { value: '365', label: '1y' },
    { value: '0', label: 'All' },
  ]

  const garmin = $derived(app.metrics?.activity?.garmin ?? null)
  let height = $state(app.profile?.heightCm?.toString() ?? '')
  let startWeight = $state(app.profile?.startWeightKg?.toString() ?? '')
  let goalWeight = $state(app.profile?.goalWeightKg?.toString() ?? '')
  let sex = $state(app.profile?.sex ?? '')
  let age = $state(app.profile?.age?.toString() ?? '')
  let activity = $state(app.profile?.activityLevel ?? '')
  let kcalTarget = $state(app.profile?.kcalTarget?.toString() ?? '')
  let protein = $state(app.profile?.proteinG?.toString() ?? '')
  let carbs = $state(app.profile?.carbG?.toString() ?? '')
  let fat = $state(app.profile?.fatG?.toString() ?? '')
  let initialRange = app.profile?.chartWindowDays ?? 90
  let chartRange = $state(initialRange >= 3650 ? 0 : initialRange)
  let saving = $state(false)
  let error = $state('')
  let jsonOpen = $state(false)
  let exporting = $state(false)
  let signOutOpen = $state(false)
  let macroKcal = $derived(Math.round(((Number(protein) || 0) + (Number(carbs) || 0)) * 4 + (Number(fat) || 0) * 9))

  // `bind:value` on a type="number" input hands back a number (or null when
  // empty) once the user edits it, not the string the state started as.
  function optionalNumber(value: string | number | null, min: number, max: number, integer = false): number | null | undefined {
    const text = String(value ?? '').trim()
    if (!text) return null
    const parsed = Number(text)
    if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) return undefined
    return parsed
  }

  async function saveProfile(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (saving) return
    const heightCm = optionalNumber(height, 80, 260)
    const startWeightKg = optionalNumber(startWeight, 20, 400)
    const goalWeightKg = optionalNumber(goalWeight, 20, 400)
    const parsedAge = optionalNumber(age, 1, 130, true)
    const parsedKcal = optionalNumber(kcalTarget, 0, 20000, true)
    const proteinG = optionalNumber(protein, 0, 2000, true)
    const carbG = optionalNumber(carbs, 0, 2000, true)
    const fatG = optionalNumber(fat, 0, 2000, true)
    const numeric = [heightCm, startWeightKg, goalWeightKg, parsedAge, parsedKcal, proteinG, carbG, fatG]
    if (numeric.some((value) => value === undefined)) {
      error = 'Check the highlighted ranges: height 80–260 cm, weight 20–400 kg, age 1–130, and whole-number nutrition values.'
      return
    }
    const apiDays = chartRange === 0 ? 3650 : chartRange
    const patch: ProfilePatch = {
      heightCm: heightCm ?? null,
      startWeightKg: startWeightKg ?? null,
      goalWeightKg: goalWeightKg ?? null,
      sex: (sex || null) as Sex | null,
      age: parsedAge ?? null,
      activityLevel: (activity || null) as ActivityLevel | null,
      // Deliberately sent alongside every Mifflin input so an explicit target
      // cannot be overwritten by the API's automatic recalculation.
      kcalTarget: parsedKcal ?? null,
      proteinG: proteinG ?? null,
      carbG: carbG ?? null,
      fatG: fatG ?? null,
      chartWindowDays: apiDays,
    }
    saving = true
    error = ''
    try {
      await actions.updateProfile(patch)
      await actions.loadDashboard(apiDays)
      showToast('Settings saved.', 'success')
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save your settings.'
    } finally {
      saving = false
    }
  }

  async function exportData(): Promise<void> {
    if (exporting) return
    exporting = true
    try {
      const [mealResponse, messageResponse] = await Promise.all([
        api.getMeals({ limit: 200 }),
        api.getChatMessages({ limit: 100 }),
      ])
      const data = {
        version: 1,
        exportedAt: new Date().toISOString(),
        user: app.user,
        profile: app.profile,
        weights: app.weights,
        phases: app.phases,
        meals: mealResponse.meals,
        foods: app.foods,
        messages: messageResponse.messages,
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `healthlog-export-${today()}.json`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      showToast('Account data exported.', 'success')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not export your data.', 'error')
    } finally {
      exporting = false
    }
  }

  async function signOut(): Promise<void> {
    await logout()
    actions.reset()
    signOutOpen = false
    window.location.hash = '#/chat'
  }
</script>

<div class="view view--settings">
  <header class="view-header"><h1 class="view-title">Settings</h1><p class="view-subtitle">Tune your targets and keep a copy of your data.</p></header>

  <form class="settings-form" onsubmit={saveProfile}>
    <section class="metric-card settings-card" aria-labelledby="profile-title">
      <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="user" size={20} /></span><h2 class="metric-card-title" id="profile-title">Profile</h2></div></div>
      <div class="metric-card-content">
        <p class="card-note">Used for goal progress, BMI, and calorie guidance. Everything except the chart range is optional.</p>
        <div class="settings-grid three-columns">
          <div class="field"><label class="field-label" for="settings-height">Height</label><div class="field-with-unit"><input class="field-input" id="settings-height" type="number" inputmode="decimal" min="80" max="260" step="0.1" placeholder="180" bind:value={height} disabled={saving} /><span class="field-unit">cm</span></div></div>
          <div class="field"><label class="field-label" for="settings-start">Start weight</label><div class="field-with-unit"><input class="field-input" id="settings-start" type="number" inputmode="decimal" min="20" max="400" step="0.1" placeholder="80.0" bind:value={startWeight} disabled={saving} /><span class="field-unit">kg</span></div></div>
          <div class="field"><label class="field-label" for="settings-goal">Goal weight</label><div class="field-with-unit"><input class="field-input" id="settings-goal" type="number" inputmode="decimal" min="20" max="400" step="0.1" placeholder="75.0" bind:value={goalWeight} disabled={saving} /><span class="field-unit">kg</span></div></div>
          <div class="field"><label class="field-label" for="settings-sex">Sex</label><select class="field-input field-select" id="settings-sex" bind:value={sex} disabled={saving}><option value="">Not set</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select></div>
          <div class="field"><label class="field-label" for="settings-age">Age</label><input class="field-input" id="settings-age" type="number" inputmode="numeric" min="1" max="130" step="1" placeholder="35" bind:value={age} disabled={saving} /></div>
          <div class="field"><label class="field-label" for="settings-activity">Activity level</label><select class="field-input field-select" id="settings-activity" bind:value={activity} disabled={saving}><option value="">Not set</option><option value="sedentary">Sedentary</option><option value="light">Light</option><option value="moderate">Moderate</option><option value="active">Active</option><option value="very_active">Very active</option></select></div>
        </div>
      </div>
    </section>

    <section class="metric-card settings-card" aria-labelledby="nutrition-title">
      <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="flame" size={20} /></span><h2 class="metric-card-title" id="nutrition-title">Daily nutrition</h2></div></div>
      <div class="metric-card-content">
        <div class="settings-grid nutrition-grid">
          <div class="field"><label class="field-label" for="settings-kcal">Calorie target</label><div class="field-with-unit"><input class="field-input" id="settings-kcal" type="number" inputmode="numeric" min="0" max="20000" step="1" placeholder="2000" bind:value={kcalTarget} disabled={saving} /><span class="field-unit">kcal</span></div><p class="field-hint">Your explicit target is kept when profile details change.</p></div>
          <fieldset class="macro-fieldset" disabled={saving}>
            <legend>Daily macro targets <span>(≈ {macroKcal} kcal)</span></legend>
            <div class="macro-settings-grid">
              <div class="field"><label class="field-label" for="settings-protein">Protein</label><div class="field-with-unit"><input class="field-input" id="settings-protein" type="number" inputmode="numeric" min="0" max="2000" step="1" bind:value={protein} /><span class="field-unit">g</span></div></div>
              <div class="field"><label class="field-label" for="settings-carbs">Carbs</label><div class="field-with-unit"><input class="field-input" id="settings-carbs" type="number" inputmode="numeric" min="0" max="2000" step="1" bind:value={carbs} /><span class="field-unit">g</span></div></div>
              <div class="field"><label class="field-label" for="settings-fat">Fat</label><div class="field-with-unit"><input class="field-input" id="settings-fat" type="number" inputmode="numeric" min="0" max="2000" step="1" bind:value={fat} /><span class="field-unit">g</span></div></div>
            </div>
          </fieldset>
        </div>
      </div>
    </section>

    <section class="metric-card settings-card" aria-labelledby="chart-settings-title">
      <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="activity" size={20} /></span><h2 class="metric-card-title" id="chart-settings-title">Default chart range</h2></div></div>
      <div class="metric-card-content"><SegmentedControl options={RANGES} value={String(chartRange)} ariaLabel="Default chart time range" onchange={(value) => { chartRange = Number(value) }} /></div>
    </section>

    {#if error}<p class="form-error" role="alert"><Icon name="alert" size={19} /> {error}</p>{/if}
    <button class="button button--primary save-settings" type="submit" disabled={saving}>{#if saving}<span class="spinner" aria-hidden="true"></span> Saving…{:else}<Icon name="check" size={19} /> Save settings{/if}</button>
  </form>

  <section class="metric-card settings-card" aria-labelledby="garmin-title">
    <div class="metric-card-header">
      <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="trending-up" size={20} /></span><h2 class="metric-card-title" id="garmin-title">Garmin</h2></div>
      <button class="button button--secondary compact-button" type="button" onclick={() => navigate('activity')}>Activities <Icon name="chevron-right" size={17} /></button>
    </div>
    <div class="metric-card-content">
      <p class="card-note">Steps, calories burned, resting heart rate, sleep and workouts from your watch. It syncs every {garmin?.syncIntervalHours ?? 3} hours from {garmin?.syncHour ?? 6}:00 to midnight, or whenever you press Sync now. Finished days are kept and only today (and yesterday, until noon) is fetched again.</p>
      <GarminSyncControl status={garmin} showHelp email={app.user?.email} onsynced={() => actions.loadDashboard()} />
    </div>
  </section>

  <section class="metric-card settings-card" aria-labelledby="cronometer-title">
    <div class="metric-card-header">
      <div class="metric-card-heading"><span class="metric-card-icon"><Icon name="food" size={20} /></span><h2 class="metric-card-title" id="cronometer-title">Cronometer</h2></div>
    </div>
    <div class="metric-card-content">
      <p class="card-note">Your Cronometer food diary as meals, one per meal group. Syncs every few hours during the day and re-reads the last 7 days, so changes in Cronometer carry over (the first sync brings in 90 days). Edit synced meals in Cronometer: changes made here are replaced on the next sync.</p>
      <CronometerCard onchanged={() => actions.loadDashboard()} />
    </div>
  </section>

  <section class="metric-card settings-card" aria-labelledby="data-title">
    <div class="metric-card-header"><div class="metric-card-heading"><span class="metric-card-icon"><Icon name="download" size={20} /></span><h2 class="metric-card-title" id="data-title">Your data</h2></div></div>
    <div class="metric-card-content">
      <p class="card-note">Restore the old weight-tracker format, or download your HealthLog profile, weigh-ins, phases, meals, foods, and recent chat messages as JSON.</p>
      <div class="data-actions">
        <button class="button button--secondary" type="button" onclick={() => { jsonOpen = true }}><Icon name="upload" size={18} /> Import old JSON</button>
        <button class="button button--secondary" type="button" disabled={exporting} onclick={exportData}><Icon name="download" size={18} /> {exporting ? 'Preparing export…' : 'Export account data'}</button>
      </div>
    </div>
  </section>

  <section class="account-section" aria-labelledby="account-title">
    <div><h2 id="account-title">Account</h2><p>{app.user?.email ?? 'Signed in'}</p></div>
    <button class="button button--secondary" type="button" onclick={() => { signOutOpen = true }}><Icon name="log-out" size={18} /> Sign out</button>
  </section>
</div>

<WeightJsonPanel open={jsonOpen} onclose={() => { jsonOpen = false }} onimport={actions.importWeightJson} />
<ConfirmPanel open={signOutOpen} title="Sign out of HealthLog?" message="Your data stays on the server. You will need your email and password to sign back in." confirmLabel="Sign out" oncancel={() => { signOutOpen = false }} onconfirm={signOut} />

<style>
  .compact-button { min-height: var(--touch-target); padding: var(--space-2) var(--space-3); }
  .settings-form { display: flex; flex-direction: column; gap: var(--space-4); }
  .settings-card { min-width: 0; }
  .card-note { margin: 0 0 var(--space-4); color: var(--color-text-muted); font-size: var(--text-sm); }
  .settings-grid { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
  .nutrition-grid { align-items: start; }
  .macro-fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
  .macro-fieldset legend { margin-bottom: var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .macro-fieldset legend span { color: var(--color-text-muted); font-variant-numeric: tabular-nums; }
  .macro-settings-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-3); }
  .save-settings { align-self: flex-end; min-width: 11rem; }
  .data-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }
  .account-section { display: flex; padding: var(--space-4) 0; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: var(--space-4); border-top: 1px solid var(--color-border); }
  .account-section h2 { margin: 0; font-size: var(--text-lg); }
  .account-section p { margin: var(--space-1) 0 0; color: var(--color-text-muted); font-size: var(--text-sm); overflow-wrap: anywhere; }
  @media (max-width: 30rem) {
    .macro-settings-grid { grid-template-columns: 1fr; }
    .save-settings { width: 100%; }
    .data-actions .button { width: 100%; }
  }
  @media (min-width: 43.75rem) {
    .three-columns { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .nutrition-grid { grid-template-columns: minmax(12rem, 0.75fr) minmax(0, 1.25fr); }
  }
  @media (min-width: 70rem) {
    .three-columns { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
</style>
