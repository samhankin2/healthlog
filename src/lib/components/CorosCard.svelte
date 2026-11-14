<script lang="ts">
  import { onMount } from 'svelte'
  import Icon from './Icon.svelte'
  import { api } from '../api'
  import { fmtAgo, fmtClock } from '../activity'
  import { showToast } from '../toast.svelte'
  import type { CorosStatus, CorosSyncResult } from '../types'

  interface Props {
    /** Called after anything that changed the user's watch data. */
    onchanged?: () => void | Promise<void>
  }

  let { onchanged }: Props = $props()

  let status = $state<CorosStatus | null>(null)
  let loadError = $state('')
  let email = $state('')
  let password = $state('')
  let busy = $state<'' | 'connect' | 'sync' | 'disconnect'>('')
  let formError = $state('')
  let confirmingDisconnect = $state(false)

  const needsForm = $derived(!!status && status.available && !status.connected)
  const canSync = $derived(!!status && status.connected && !status.backoffUntil && !status.syncing && !busy)

  const line = $derived.by((): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } | null => {
    const s = status
    if (!s) return null
    if (!s.available) return { text: 'COROS sync is switched off on the server.', tone: 'neutral' }
    if (s.status === 'needs_login') return { text: 'COROS ended the session (usually after signing in to Training Hub elsewhere). Sign in again to keep syncing.', tone: 'danger' }
    if (!s.connected) return { text: 'Not connected.', tone: 'neutral' }
    if (s.backoffUntil) return { text: `COROS is rate-limiting requests, so syncing is paused until ${fmtClock(s.backoffUntil)}.`, tone: 'warning' }
    if (s.status === 'error') return { text: `Last sync failed ${fmtAgo(s.lastAttemptAt)}: ${s.lastError ?? 'unknown error'}`, tone: 'danger' }
    if (s.lastSuccessAt) return { text: `Synced ${fmtAgo(s.lastSuccessAt)} as ${s.email ?? 'your account'}.`, tone: 'success' }
    return { text: `Connected as ${s.email ?? 'your account'}.`, tone: 'neutral' }
  })

  onMount(() => {
    void refresh()
  })

  async function refresh(): Promise<void> {
    try {
      status = (await api.getCoros()).coros
      loadError = ''
      if (status.email && !email) email = status.email
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Could not load the COROS status.'
    }
  }

  const plural = (n: number | undefined, word: string): string => `${n ?? 0} ${word}${n === 1 ? '' : 's'}`

  function syncedToast(result: CorosSyncResult): void {
    if (result.ok) showToast(`COROS synced: ${plural(result.days, 'day')}, ${plural(result.activities, 'activity').replace('activitys', 'activities')}.`, 'success')
    else if (result.error === 'needs_login') showToast('COROS ended the session. Sign in again.', 'error')
    else showToast(result.message ?? 'COROS sync failed. Your synced data is still here.', 'error')
  }

  async function connect(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    formError = ''
    if (!email.trim() || !password) {
      formError = 'Enter your COROS email and password.'
      return
    }
    busy = 'connect'
    try {
      const response = await api.connectCoros(email.trim(), password)
      status = response.coros
      syncedToast(response.result)
      await onchanged?.()
    } catch (error) {
      formError = error instanceof Error ? error.message : 'Could not sign in to COROS.'
    } finally {
      password = ''
      busy = ''
    }
  }

  async function syncNow(): Promise<void> {
    if (!canSync) return
    busy = 'sync'
    try {
      const response = await api.syncCoros()
      status = response.coros
      syncedToast(response.result)
      await onchanged?.()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'COROS sync failed.', 'error')
      await refresh()
    } finally {
      busy = ''
    }
  }

  async function disconnect(deleteData: boolean): Promise<void> {
    busy = 'disconnect'
    try {
      const response = await api.disconnectCoros(deleteData)
      status = response.coros
      confirmingDisconnect = false
      showToast(deleteData ? `COROS disconnected and ${plural(response.deleted.activities, 'activity').replace('activitys', 'activities')} removed.` : 'COROS disconnected. Synced data was kept.', 'success')
      if (deleteData) await onchanged?.()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not disconnect COROS.', 'error')
    } finally {
      busy = ''
    }
  }
</script>

<div class="coros">
  {#if loadError}
    <p class="status" data-tone="danger"><span class="dot" aria-hidden="true"></span>{loadError}</p>
  {:else if line}
    <p class="status" data-tone={line.tone}><span class="dot" aria-hidden="true"></span>{line.text}</p>
  {:else}
    <p class="status">Checking COROS…</p>
  {/if}

  {#if status?.connected}
    <div class="actions">
      <button class="button button--secondary compact-button" type="button" disabled={!canSync} onclick={syncNow} aria-busy={busy === 'sync'}>
        {#if busy === 'sync'}<span class="spinner spinner--small" aria-hidden="true"></span> Syncing…{:else}<Icon name="download" size={17} /> Sync now{/if}
      </button>
      <button class="button button--secondary compact-button" type="button" disabled={!!busy} onclick={() => { confirmingDisconnect = !confirmingDisconnect }} aria-expanded={confirmingDisconnect}>Disconnect</button>
    </div>
    {#if confirmingDisconnect}
      <div class="confirm" role="group" aria-label="Disconnect COROS">
        <p>Stop syncing? You can keep the COROS data already synced, or remove it.</p>
        <div class="actions">
          <button class="button button--secondary compact-button" type="button" disabled={!!busy} onclick={() => disconnect(false)}>Keep synced data</button>
          <button class="button button--danger compact-button" type="button" disabled={!!busy} onclick={() => disconnect(true)}><Icon name="trash" size={17} /> Remove synced data</button>
          <button class="button button--secondary compact-button" type="button" disabled={!!busy} onclick={() => { confirmingDisconnect = false }}>Cancel</button>
        </div>
      </div>
    {/if}
  {/if}

  {#if needsForm}
    <form class="connect-form" onsubmit={connect} novalidate>
      <div class="field">
        <label class="field-label" for="coros-email">COROS email</label>
        <input class="field-input" id="coros-email" name="coros-email" type="email" autocomplete="off" inputmode="email" bind:value={email} disabled={busy === 'connect'} />
      </div>
      <div class="field">
        <label class="field-label" for="coros-password">COROS password</label>
        <input class="field-input" id="coros-password" name="coros-password" type="password" autocomplete="off" bind:value={password} disabled={busy === 'connect'} />
      </div>
      {#if formError}<p class="form-error" role="alert"><Icon name="alert" size={18} /> {formError}</p>{/if}
      <p class="hint full"><Icon name="lock" size={14} /> Your password is used once to sign in and is never stored. Only the COROS session is kept. Signing in to COROS Training Hub in a browser can end it; if that happens, sign in here again.</p>
      <button class="button button--primary compact-button" type="submit" disabled={busy === 'connect'} aria-busy={busy === 'connect'}>
        {#if busy === 'connect'}<span class="spinner spinner--small" aria-hidden="true"></span> Connecting…{:else}Connect COROS{/if}
      </button>
    </form>
  {/if}
</div>

<style>
  .coros { display: flex; flex-direction: column; gap: var(--space-3); }
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
