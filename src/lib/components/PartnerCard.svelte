<script lang="ts">
  import Icon from './Icon.svelte'
  import { loadSharing, removePartner, setPartner, sharing } from '../sharing.svelte'
  import { showToast } from '../toast.svelte'

  let email = $state('')
  let busy = $state(false)
  let error = $state('')
  let editing = $state(false)

  const partner = $derived(sharing.partner)
  const showForm = $derived(!partner || editing)

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (busy) return
    const value = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      error = 'Enter the email your partner signs in with.'
      return
    }
    busy = true
    error = ''
    try {
      await setPartner(value)
      editing = false
      email = ''
      showToast(sharing.partner?.status === 'linked' ? `Linked with ${sharing.partner.name}` : 'Partner saved', 'success')
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save your partner.'
    } finally {
      busy = false
    }
  }

  async function unlink(): Promise<void> {
    if (busy) return
    busy = true
    try {
      await removePartner()
      showToast('Partner removed', 'success')
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : 'Could not remove your partner.', 'error')
    } finally {
      busy = false
    }
  }
</script>

{#if partner && !editing}
  <div class="partner-status">
    {#if partner.status === 'linked'}
      <p class="partner-line"><span class="badge" data-tone="success"><Icon name="check" size={15} /> Linked</span> <span>Sharing with <strong>{partner.name}</strong> <span class="partner-email">({partner.email})</span></span></p>
      <p class="partner-help">Saved meals show a “Share with {partner.name}” button. Meals {partner.name} shares with you appear at the top of the food journal and dashboard when you open HealthLog.</p>
    {:else}
      <p class="partner-line"><span class="badge" data-tone="warning">Waiting</span> <span class="partner-email">{partner.email}</span></p>
      <p class="partner-help">Sharing starts once they add your email under Settings → Partner sharing. If they already have, check the address matches the one they sign in with.</p>
    {/if}
    <div class="partner-actions">
      {#if partner.status === 'pending'}
        <button class="button button--secondary" type="button" disabled={busy} onclick={() => loadSharing()}><Icon name="repeat" size={17} /> Check again</button>
      {/if}
      <button class="button button--secondary" type="button" disabled={busy} onclick={() => { editing = true; email = partner.email }}><Icon name="edit" size={17} /> Change</button>
      <button class="button button--ghost" type="button" disabled={busy} onclick={unlink}>Remove</button>
    </div>
  </div>
{/if}

{#if showForm}
  <form class="partner-form" onsubmit={save} novalidate>
    <div class="field">
      <label class="field-label" for="partner-email">Partner's email</label>
      <input class="field-input" id="partner-email" type="email" autocomplete="off" inputmode="email" maxlength="254" placeholder="partner@example.com" bind:value={email} disabled={busy} aria-describedby="partner-hint" />
      <p class="field-hint" id="partner-hint">The email of their HealthLog account. They add yours too; nothing is shared until both of you have.</p>
    </div>
    {#if error}<p class="field-error" role="alert">{error}</p>{/if}
    <div class="partner-actions">
      {#if editing}<button class="button button--secondary" type="button" disabled={busy} onclick={() => { editing = false; error = '' }}>Cancel</button>{/if}
      <button class="button button--primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save partner'}</button>
    </div>
  </form>
{/if}

<style>
  .partner-status,
  .partner-form {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: var(--space-3);
  }

  .partner-line {
    display: flex;
    margin: 0;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .partner-email {
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
  }

  .partner-help {
    margin: 0;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
  }

  .partner-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
</style>
