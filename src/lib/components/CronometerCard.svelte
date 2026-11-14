<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'
  import { api } from '../api'
  import { fmtAgo, fmtClock } from '../activity'
  import { showToast } from '../toast.svelte'
  import type { CronometerStatus } from '../types'

  interface Props {
    /** Called after anything that changed the user's meals. */
    onchanged?: () => void | Promise<void>
  }

  let { onchanged }: Props = $props()

  let status = $state<CronometerStatus | null>(null)
  let loadError = $state('')
  let email = $state('')
  let password = $state('')
  let busy = $state<'' | 'connect' | 'sync' | 'disconnect'>('')
  let formError = $state('')
  let confirmingDisconnect = $state(false)

  const needsForm = $derived(!!status && status.available && !status.connected)
  const outOfExports = $derived(!!status && status.exportsToday >= status.exportsPerDay)
  const canSync = $derived(!!status && status.connected && !status.backoffUntil && !status.syncing && !outOfExports && !busy)

  const line = $derived.by((): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } | null => {
    const s = status
    if (!s) return null
    if (!s.available) return { text: 'Cronometer sync is switched off on the server.', tone: 'neutral' }
    if (s.status === 'needs_login') return { text: 'Cronometer ended the session. Sign in again to keep syncing.', tone: 'danger' }
    if (!s.connected) return { text: 'Not connected.', tone: 'neutral' }
    if (s.backoffUntil) return { text: `Cronometer is rate-limiting requests, so syncing is paused until ${fmtClock(s.backoffUntil)}.`, tone: 'warning' }
    if (s.status === 'error') return { text: `Last sync failed ${fmtAgo(s.lastAttemptAt)}: ${s.lastError ?? 'unknown error'}`, tone: 'danger' }
    if (s.lastSuccessAt) return { text: `Synced ${fmtAgo(s.lastSuccessAt)} as ${s.email ?? 'your account'}.`, tone: 'success' }
    return { text: `Connected as ${s.email ?? 'your account'}.`, tone: 'neutral' }
  })

  onMount(() => {
    void refresh()
  })

  async function refresh(): Promise<void> {
    try {
      status = (await api.getCronometer()).cronometer
      loadError = ''
      if (status.email && !email) email = status.email
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Could not load the Cronometer status.'
    }
  }

  function syncedToast(result: { ok: boolean; meals?: number; servings?: number; format?: 'servings' | 'daily'; error?: string; message?: string }): void {
    if (result.ok && result.format === 'daily') showToast(`Cronometer synced: daily totals for ${result.meals ?? 0} day${result.meals === 1 ? '' : 's'}.`, 'success')
    else if (result.ok) showToast(`Cronometer synced: ${result.servings ?? 0} food${result.servings === 1 ? '' : 's'} in ${result.meals ?? 0} meal${result.meals === 1 ? '' : 's'}.`, 'success')
    else if (result.error === 'needs_login') showToast('Cronometer ended the session. Sign in again.', 'error')
    else showToast(result.message ?? 'Cronometer sync failed. Your synced meals are still here.', 'error')
  }

  async function connect(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    formError = ''
    if (!email.trim() || !password) {
      formError = 'Enter your Cronometer email and password.'
      return
    }
    busy = 'connect'
    try {
      const response = await api.connectCronometer(email.trim(), password)
      status = response.cronometer
      syncedToast(response.result)
      await onchanged?.()
    } catch (error) {
      formError = error instanceof Error ? error.message : 'Could not sign in to Cronometer.'
    } finally {
      password = ''
      busy = ''
    }
  }

  async function syncNow(): Promise<void> {
    if (!canSync) return
    busy = 'sync'
    try {
      const response = await api.syncCronometer()
      status = response.cronometer
      syncedToast(response.result)
      await onchanged?.()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Cronometer sync failed.', 'error')
      await refresh()
    } finally {
      busy = ''
    }
  }

  async function disconnect(deleteMeals: boolean): Promise<void> {
    busy = 'disconnect'
    try {
      const response = await api.disconnectCronometer(deleteMeals)
      status = response.cronometer
      confirmingDisconnect = false
      showToast(deleteMeals ? `Cronometer disconnected and ${response.deletedMeals} synced meal${response.deletedMeals === 1 ? '' : 's'} removed.` : 'Cronometer disconnected. Synced meals were kept.', 'success')
      if (deleteMeals) await onchanged?.()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not disconnect Cronometer.', 'error')
    } finally {
      busy = ''
    }
  }
</script>

<div class="cronometer">
  {#if loadError}
    <p class="status" data-tone="danger"><span class="dot" aria-hidden="true"></span>{loadError}</p>
  {:else if line}
    <p class="status" data-tone={line.tone}><span class="dot" aria-hidden="true"></span>{line.text}</p>
  {:else}
    <p class="status">Checking Cronometer…</p>
  {/if}

  {#if status?.connected}
    <div class="actions">
      <button class="button button--secondary compact-button" type="button" disabled={!canSync} onclick={syncNow} aria-busy={busy === 'sync'}>
        {#if busy === 'sync'}<span class="spinner spinner--small" aria-hidden="true"></span> Syncing…{:else}<Icon name="download" size={17} /> Sync now{/if}
      </button>
      <button class="button button--secondary compact-button" type="button" disabled={!!busy} onclick={() => { confirmingDisconnect = !confirmingDisconnect }} aria-expanded={confirmingDisconnect}>Disconnect</button>
    </div>
    <p class="hint">{status.exportsToday} of {status.exportsPerDay} syncs used today. Cronometer allows about 10 exports a day per account.</p>
    {#if confirmingDisconnect}
      <div class="confirm" role="group" aria-label="Disconnect Cronometer">
        <p>Stop syncing? You can keep the meals already synced, or remove them.</p>
        <div class="actions">
          <button class="button button--secondary compact-button" type="button" disabled={!!busy} onclick={() => disconnect(false)}>Keep synced meals</button>
          <button class="button button--danger compact-button" type="button" disabled={!!busy} onclick={() => disconnect(true)}><Icon name="trash" size={17} /> Remove synced meals</button>
          <button class="button button--secondary compact-button" type="button" disabled={!!busy} onclick={() => { confirmingDisconnect = false }}>Cancel</button>
        </div>
      </div>
    {/if}
  {/if}

  {#if needsForm}
    <form class="connect-form" onsubmit={connect} novalidate>
      <div class="field">
        <label class="field-label" for="cronometer-email">Cronometer email</label>
        <input class="field-input" id="cronometer-email" name="cronometer-email" type="email" autocomplete="off" inputmode="email" bind:value={email} disabled={busy === 'connect'} />
      </div>
      <div class="field">
        <label class="field-label" for="cronometer-password">Cronometer password</label>
        <input class="field-input" id="cronometer-password" name="cronometer-password" type="password" autocomplete="off" bind:value={password} disabled={busy === 'connect'} />
      </div>
      {#if formError}<p class="form-error" role="alert"><Icon name="alert" size={18} /> {formError}</p>{/if}
      <p class="hint full"><Icon name="lock" size={14} /> Your password is used once to sign in and is never stored. Only the Cronometer session is kept; when it ends, sign in here again.</p>
      <button class="button button--primary compact-button" type="submit" disabled={busy === 'connect'} aria-busy={busy === 'connect'}>
        {#if busy === 'connect'}<span class="spinner spinner--small" aria-hidden="true"></span> Connecting…{:else}Connect Cronometer{/if}
      </button>
    </form>
  {/if}
</div>

<style>
  .cronometer { display: flex; flex-direction: column; gap: var(--space-3); }
  .status { display: flex; margin: 0; align-items: baseline; gap: var(--space-2); color: var(--color-text-muted); font-size: var(--text-sm); overflow-wrap: anywhere; }
  .dot { width: 0.55rem; height: 0.55rem; flex: 0 0 auto; border-radius: 50%; background: var(--color-border-strong); transform: translateY(-0.05rem); }
  .status[data-tone='success'] .dot { background: var(--color-success, #16a34a); }
  .status[data-tone='warning'] .dot { background: var(--color-warning, #d97706); }
  .status[data-tone='danger'] .dot { background: var(--color-danger); }
  .actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
  .hint { display: flex; margin: 0; align-items: baseline; gap: var(--space-1); color: var(--color-text-muted); font-size: var(--text-xs); }
  .confirm { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3); border-radius: var(--radius-card); background: var(--color-surface-sunken); }
  .confirm p { margin: 0; font-size: var(--text-sm); }
  .connect-form { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr); gap: var(--space-3); }
  .connect-form .button { justify-self: start; }
  .full { grid-column: 1 / -1; }
  .compact-button { min-height: var(--touch-target); padding: var(--space-2) var(--space-3); }
  .spinner--small { width: 1rem; height: 1rem; }
  @media (min-width: 43.75rem) {
    .connect-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .connect-form .form-error, .connect-form .button { grid-column: 1 / -1; }
  }
</style>
