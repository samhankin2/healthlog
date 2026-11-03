<script lang="ts">
  import Icon from './Icon.svelte'
  import { api } from '../api'
  import { garminStatusLine } from '../activity'
  import { showToast } from '../toast.svelte'
  import type { GarminStatus } from '../types'

  interface Props {
    status: GarminStatus | null
    /** Called after a sync attempt with the new status (success or not). */
    onsynced?: (status: GarminStatus) => void | Promise<void>
    showHelp?: boolean
    /** HealthLog account email, shown in the login command. */
    email?: string
  }

  let { status, onsynced, showHelp = false, email }: Props = $props()

  let syncing = $state(false)
  const line = $derived(status ? garminStatusLine(status) : null)
  const canSync = $derived(!!status && status.available && status.connected && !status.backoffUntil && !syncing && !status.syncing)

  async function syncNow(): Promise<void> {
    if (!canSync) return
    syncing = true
    try {
      const response = await api.syncGarmin()
      const r = response.result
      if (r.ok) showToast(`Garmin synced: ${r.activities ?? 0} activit${r.activities === 1 ? 'y' : 'ies'} over ${r.days ?? 0} days.`, 'success')
      else showToast(r.error === 'needs_login' ? 'Garmin needs a fresh login on the server.' : r.error === 'rate_limited' ? 'Garmin is rate-limiting requests. Syncing is paused for a few hours.' : 'Garmin sync failed. Your synced data is still here.', 'error')
      await onsynced?.(response.garmin)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Garmin sync failed.', 'error')
      try {
        const fresh = await api.getGarmin()
        await onsynced?.(fresh.garmin)
      } catch { /* keep the old status */ }
    } finally {
      syncing = false
    }
  }
</script>

<div class="garmin-sync">
  {#if line}
    <p class="garmin-status" data-tone={line.tone}><span class="dot" aria-hidden="true"></span>{line.text}</p>
  {:else}
    <p class="garmin-status">Checking Garmin…</p>
  {/if}
  {#if status?.available && status.connected}
    <button class="button button--secondary compact-button" type="button" disabled={!canSync} onclick={syncNow} aria-busy={syncing}>
      {#if syncing}<span class="spinner spinner--small" aria-hidden="true"></span> Syncing…{:else}<Icon name="download" size={17} /> Sync now{/if}
    </button>
  {/if}
  {#if showHelp && status && (!status.connected || status.status === 'needs_login')}
    <p class="garmin-help">
      To connect, run this once over SSH. You'll be asked for your Garmin password and MFA code. The password isn't stored; only the login tokens are kept.
      <code>scripts/hl garmin-login {email ?? 'you@example.com'}</code>
    </p>
  {/if}
</div>

<style>
  .garmin-sync { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .garmin-status { display: flex; margin: 0; flex: 1 1 16rem; align-items: baseline; gap: var(--space-2); color: var(--color-text-muted); font-size: var(--text-sm); }
  .dot { width: 0.55rem; height: 0.55rem; flex: 0 0 auto; border-radius: 50%; background: var(--color-border-strong); transform: translateY(-0.05rem); }
  .garmin-status[data-tone='success'] .dot { background: var(--color-success, #16a34a); }
  .garmin-status[data-tone='warning'] .dot { background: var(--color-warning, #d97706); }
  .garmin-status[data-tone='danger'] .dot { background: var(--color-danger); }
  .garmin-help { flex-basis: 100%; margin: 0; color: var(--color-text-muted); font-size: var(--text-xs); }
  .garmin-help code { display: block; margin-top: var(--space-2); padding: var(--space-2) var(--space-3); overflow-x: auto; border-radius: var(--radius-card); background: var(--color-surface-sunken); color: var(--color-text); white-space: nowrap; }
  .compact-button { min-height: var(--touch-target); padding: var(--space-2) var(--space-3); }
  .spinner--small { width: 1rem; height: 1rem; }
</style>
