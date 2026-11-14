<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
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
  let busy = $state<'' | 'connect' | 'sync' | 'disconnect'>('')
  let connectError = $state('')
  let confirmingDisconnect = $state(false)
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let pollUntil = 0

  const canSync = $derived(!!status && status.connected && !status.backoffUntil && !status.syncing && !busy)
  /** Just back from COROS: the first sync runs on the server in the background. */
  const firstSyncPending = $derived(!!status && status.connected && (status.syncing || !status.lastSuccessAt) && status.status !== 'error')

  const line = $derived.by((): { text: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } | null => {
    const s = status
    if (!s) return null
    if (!s.available) return { text: 'COROS sync is switched off on the server.', tone: 'neutral' }
    if (s.status === 'needs_login') return { text: 'COROS ended the connection. Connect again to keep syncing.', tone: 'danger' }
    if (!s.connected) return s.lastError ? { text: s.lastError, tone: 'danger' } : { text: 'Not connected.', tone: 'neutral' }
    if (s.backoffUntil) return { text: `COROS is rate-limiting requests, so syncing is paused until ${fmtClock(s.backoffUntil)}.`, tone: 'warning' }
    if (s.syncing || !s.lastSuccessAt) return { text: 'Connected. Bringing in your COROS history…', tone: 'neutral' }
    if (s.status === 'error') return { text: `Last sync failed ${fmtAgo(s.lastAttemptAt)}: ${s.lastError ?? 'unknown error'}`, tone: 'danger' }
    if (s.lastError) return { text: `Synced ${fmtAgo(s.lastSuccessAt)}, with gaps: ${s.lastError}`, tone: 'warning' }
    return { text: `Synced ${fmtAgo(s.lastSuccessAt)}.`, tone: 'success' }
  })

  onMount(() => {
    void refresh().then(() => {
      if (firstSyncPending) startPolling()
    })
  })

  onDestroy(() => {
    if (pollTimer) clearTimeout(pollTimer)
  })

  async function refresh(): Promise<void> {
    try {
      status = (await api.getCoros()).coros
      loadError = ''
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Could not load the COROS status.'
    }
  }

  /** Watch the background first sync (up to 3 minutes), then refresh the app's data once. */
  function startPolling(): void {
    pollUntil = Date.now() + 180_000
    const tick = async (): Promise<void> => {
      await refresh()
      if (firstSyncPending && Date.now() < pollUntil) {
        pollTimer = setTimeout(() => void tick(), 3000)
        return
      }
      pollTimer = null
      if (status?.lastSuccessAt) await onchanged?.()
    }
    pollTimer = setTimeout(() => void tick(), 2000)
  }

  const plural = (n: number | undefined, one: string, many: string): string => `${n ?? 0} ${n === 1 ? one : many}`

  function syncedToast(result: CorosSyncResult): void {
    if (result.ok) {
      const gaps = result.warnings?.length ? ' (some data was unavailable)' : ''
      showToast(`COROS synced: ${plural(result.days, 'day', 'days')}, ${plural(result.sleep, 'night', 'nights')}, ${plural(result.activities, 'activity', 'activities')}${gaps}.`, 'success')
    } else if (result.error === 'needs_login') showToast('COROS ended the connection. Connect again.', 'error')
    else showToast(result.message ?? 'COROS sync failed. Your synced data is still here.', 'error')
  }

  async function connect(): Promise<void> {
    if (busy) return
    connectError = ''
    busy = 'connect'
    try {
      const returnTo = `${window.location.origin}${window.location.pathname}#/settings`
      const { authorizeUrl } = await api.connectCoros(returnTo)
      window.location.assign(authorizeUrl)
    } catch (error) {
      connectError = error instanceof Error ? error.message : 'Could not start the COROS sign-in.'
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
      showToast(deleteData ? `COROS disconnected and ${plural(response.deleted.activities, 'activity', 'activities')} removed.` : 'COROS disconnected. Synced data was kept.', 'success')
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
    <p class="status" data-tone={line.tone} aria-live="polite"><span class="dot" aria-hidden="true"></span>{line.text}</p>
  {:else}
    <p class="status">Checking COROS…</p>
  {/if}

  {#if status?.connected}
    <div class="actions">
      <button class="button button--secondary compact-button" type="button" disabled={!canSync || firstSyncPending} onclick={syncNow} aria-busy={busy === 'sync' || firstSyncPending}>
        {#if busy === 'sync' || firstSyncPending}<span class="spinner spinner--small" aria-hidden="true"></span> Syncing…{:else}<Icon name="download" size={17} /> Sync now{/if}
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
  {:else if status?.available}
    {#if connectError}<p class="form-error" role="alert"><Icon name="alert" size={18} /> {connectError}</p>{/if}
    <p class="hint"><Icon name="lock" size={14} /> You sign in on COROS's own page; HealthLog never sees your COROS password. You can disconnect here at any time.</p>
    <div class="actions">
      <button class="button button--primary compact-button" type="button" disabled={busy === 'connect'} onclick={connect} aria-busy={busy === 'connect'}>
        {#if busy === 'connect'}<span class="spinner spinner--small" aria-hidden="true"></span> Opening COROS…{:else}Connect COROS{/if}
      </button>
    </div>
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
  .compact-button { min-height: var(--touch-target); padding: var(--space-2) var(--space-3); }
  .spinner--small { width: 1rem; height: 1rem; }
</style>
