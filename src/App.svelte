<script lang="ts">
  import { onMount } from 'svelte'
  import { ApiError } from './lib/api'
  import { isAuthenticated, logout } from './lib/auth'
  import { registerServiceWorker } from './lib/pwa'
  import { actions, app, navigate, route } from './lib/state.svelte'
  import type { Route, User } from './lib/types'
  import type { IconName } from './lib/icons'
  import { showToast } from './lib/toast.svelte'
  import Button from './lib/components/Button.svelte'
  import EmptyState from './lib/components/EmptyState.svelte'
  import Icon from './lib/components/Icon.svelte'
  import Toast from './lib/components/Toast.svelte'
  import Login from './views/Login.svelte'
  import Chat from './views/Chat.svelte'
  import Dashboard from './views/Dashboard.svelte'
  import Foods from './views/Foods.svelte'
  import Settings from './views/Settings.svelte'
  import History from './views/History.svelte'
  import Calories from './views/Calories.svelte'
  import ActivityView from './views/Activity.svelte'
  import Insights from './views/Insights.svelte'
  import AdvancedInsights from './views/AdvancedInsights.svelte'

  // `railOnly` tabs appear in the desktop side rail but not the mobile bottom
  // bar, which holds six buttons at most.
  const TABS: { id: Route; label: string; icon: IconName; railOnly?: boolean }[] = [
    { id: 'chat', label: 'Chat', icon: 'chat' },
    { id: 'dashboard', label: 'Dashboard', icon: 'activity' },
    { id: 'calories', label: 'Calories', icon: 'flame' },
    { id: 'insights', label: 'Insights', icon: 'insights' },
    { id: 'foods', label: 'Foods', icon: 'food' },
    { id: 'history', label: 'History', icon: 'calendar', railOnly: true },
    { id: 'activity', label: 'Activity', icon: 'trending-up', railOnly: true },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ]

  const TITLES: Record<Route, string> = {
    chat: 'Food journal',
    dashboard: 'Your trends',
    calories: 'Calories',
    foods: 'Saved foods',
    settings: 'Settings',
    history: 'History',
    activity: 'Activity',
    insights: 'Insights',
    advanced: 'Advanced insights',
  }

  let booting = $state(isAuthenticated())
  let loadError = $state('')
  let signingOut = $state(false)
  const current = $derived(route())

  async function hydrateSession(): Promise<void> {
    booting = true
    loadError = ''
    try {
      await actions.hydrate()
    } catch (cause: unknown) {
      if (cause instanceof ApiError && cause.status === 401) {
        try { await logout() } catch { /* Local sign-out still completes. */ }
        actions.reset()
      } else {
        loadError = cause instanceof Error ? cause.message : 'Could not connect to HealthLog.'
      }
    } finally {
      booting = false
    }
  }

  async function completeLogin(user: User): Promise<void> {
    actions.adoptUser(user)
    await hydrateSession()
  }

  async function signOut(): Promise<void> {
    if (signingOut) return
    signingOut = true
    let serverConfirmed = true
    try {
      await logout()
    } catch {
      serverConfirmed = false
    } finally {
      actions.reset()
      navigate('chat')
      signingOut = false
      if (!serverConfirmed) {
        showToast('Signed out on this device. The server session could not be confirmed.', 'error')
      }
    }
  }

  function skipToContent(event: MouseEvent): void {
    event.preventDefault()
    document.getElementById('main-content')?.focus()
  }

  onMount(() => {
    registerServiceWorker()
    if (isAuthenticated()) void hydrateSession()
    else booting = false
  })

  $effect(() => {
    document.title = app.user ? `${TITLES[current]} · HealthLog` : 'Sign in · HealthLog'
  })
</script>

{#snippet brand()}
  <div class="brand">
    <span class="brand-mark"><Icon name="activity" size={23} /></span>
    <span class="brand-copy">
      <span class="brand-name">HealthLog</span>
      <span class="brand-tagline">Weight, food, and the bigger picture</span>
    </span>
  </div>
{/snippet}

{#snippet navigation(className: string, rail: boolean)}
  <nav class="tab-bar {className}" aria-label="Main navigation">
    {#each TABS.filter((tab) => rail || !tab.railOnly) as tab (tab.id)}
      <button
        class="tab-button"
        type="button"
        data-tab={tab.id}
        aria-current={current === tab.id || (tab.id === 'insights' && current === 'advanced') ? 'page' : 'false'}
        onclick={() => navigate(tab.id)}
      >
        <Icon name={tab.icon} size={22} />
        <span class="tab-label">{tab.label}</span>
      </button>
    {/each}
  </nav>
{/snippet}

{#if booting || (app.loading && !app.loaded)}
  <main class="loading-screen">
    <div class="loading-card">
      <span class="brand-mark"><Icon name="activity" size={25} /></span>
      <span class="spinner-wrap" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span class="sr-only">Opening your HealthLog</span>
      </span>
      <p>Bringing your data together…</p>
    </div>
  </main>
{:else if loadError}
  <main class="loading-screen">
    <EmptyState icon="alert" title="We could not load your data" message={loadError}>
      <div class="error-actions">
        <Button onclick={hydrateSession}>Try again</Button>
        <Button variant="secondary" onclick={signOut}>Back to sign in</Button>
      </div>
    </EmptyState>
  </main>
{:else if !app.user}
  <Login onauthenticated={completeLogin} />
{:else}
  <a class="skip-link" href="#main-content" onclick={skipToContent}>Skip to content</a>
  <div class="health-app">
    <aside class="side-rail" aria-label="HealthLog sidebar">
      {@render brand()}
      {@render navigation('rail-nav', true)}
      <div class="rail-footer">
        <button
          class="account-chip"
          type="button"
          aria-label={`Sign out ${app.user.displayName || app.user.email}`}
          disabled={signingOut}
          onclick={signOut}
        >
          <span class="account-avatar"><Icon name="user" size={20} /></span>
          <span class="account-copy">
            <span class="account-name">{app.user.displayName || 'Your account'}</span>
            <span class="account-email">{app.user.email}</span>
          </span>
          <Icon name="log-out" size={18} />
        </button>
      </div>
    </aside>

    <div class="app-column">
      <header class="app-topbar">
        {@render brand()}
        <span class="screen-title">{TITLES[current]}</span>
      </header>
      <main class="view-host" id="main-content" tabindex="-1">
        {#if current === 'chat'}
          <Chat />
        {:else if current === 'dashboard'}
          <Dashboard />
        {:else if current === 'calories'}
          <Calories />
        {:else if current === 'foods'}
          <Foods />
        {:else if current === 'settings'}
          <Settings />
        {:else if current === 'history'}
          <History />
        {:else if current === 'activity'}
          <ActivityView />
        {:else if current === 'insights'}
          <Insights />
        {:else if current === 'advanced'}
          <AdvancedInsights />
        {/if}
      </main>
    </div>
    {@render navigation('bottom-nav', false)}
  </div>
{/if}

<Toast />

<style>
  .screen-title {
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
  }

  .tab-button {
    display: flex;
    padding: var(--space-2);
    align-items: center;
    justify-content: center;
    flex-direction: column;
    gap: 0.2rem;
    border: 0;
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--text-xs);
    font-weight: var(--weight-medium);
  }

  .tab-button[aria-current='page'] {
    color: var(--color-accent);
  }

  .account-chip {
    width: 100%;
    min-height: var(--touch-target);
    color: var(--color-text);
    text-align: left;
  }

  .account-chip:hover {
    background: var(--color-surface-sunken);
  }

  .account-chip .account-copy {
    flex: 1 1 auto;
  }

  .error-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--space-3);
  }

  @media (min-width: 56.25rem) {
    .rail-nav .tab-button {
      padding: var(--space-3) var(--space-4);
      justify-content: flex-start;
      flex-direction: row;
      gap: var(--space-3);
      font-size: var(--text-sm);
    }
  }
</style>
