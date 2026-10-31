import './design/tokens.css'
import './design/ui.css'

import { ApiError } from './lib/api'
import { isAuthenticated, logout } from './lib/auth'
import { registerServiceWorker } from './lib/pwa'
import { store } from './lib/store'
import type { AppState, Route, User, ViewContext, ViewHandle } from './lib/types'
import { Badge, Spinner } from './ui/components'
import { el, Icon } from './ui/dom'
import type { IconName } from './ui/icons'
import { renderLogin } from './views/login'

type TabRoute = Exclude<Route, 'history'>
type ViewRenderer = (context: ViewContext) => ViewHandle

const TABS: { id: TabRoute; label: string; icon: IconName }[] = [
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'dashboard', label: 'Dashboard', icon: 'activity' },
  { id: 'foods', label: 'Foods', icon: 'food' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
]
const ROUTES = new Set<Route>([...TABS.map((tab) => tab.id), 'history'])

function routeFromHash(): Route {
  const candidate = window.location.hash.replace(/^#\/?/, '').split('/')[0] as Route
  return ROUTES.has(candidate) ? candidate : 'chat'
}

function brand(): HTMLElement {
  return el('div', { class: 'brand' }, [
    el('span', { class: 'brand-mark' }, Icon('activity', { size: 23 })),
    el('span', { class: 'brand-copy' }, [
      el('span', { class: 'brand-name' }, 'HealthLog'),
      el('span', { class: 'brand-tagline' }, 'Weight, food, and the bigger picture'),
    ]),
  ])
}

function placeholder(route: Route, context: ViewContext): ViewHandle {
  const copy: Record<Route, { title: string; subtitle: string; heading: string; message: string; icon: IconName }> = {
    chat: {
      title: 'Your food journal',
      subtitle: 'Describe a meal in your own words. HealthLog will help with the numbers.',
      heading: 'A conversation, not a form',
      message: 'The AI food-logging conversation is coming next. You will be able to describe what you ate, compare two estimates, and save the meal.',
      icon: 'chat',
    },
    dashboard: {
      title: 'Your trends',
      subtitle: 'Weight, calories, and macros brought into one calm view.',
      heading: 'The bigger picture, at a glance',
      message: 'Your weight trend and daily nutrition dashboard is coming next. Metrics will be calculated securely by the HealthLog API.',
      icon: 'activity',
    },
    foods: {
      title: 'Saved foods',
      subtitle: 'Keep the meals and ingredients you come back to most.',
      heading: 'Your shortcuts will live here',
      message: 'Saved foods and guided CSV imports are coming next, so regular logging takes less typing.',
      icon: 'food',
    },
    settings: {
      title: 'Settings',
      subtitle: 'Your profile, nutrition targets, data, and account.',
      heading: 'Make HealthLog yours',
      message: 'Profile settings and data tools are coming next. You can already sign out securely below.',
      icon: 'settings',
    },
    history: {
      title: 'Weight history',
      subtitle: 'Every weigh-in, kept in local-calendar order.',
      heading: 'Your history will live here',
      message: 'The detailed weight history is coming next.',
      icon: 'calendar',
    },
  }
  const item = copy[route]
  const element = el('section', { class: 'view', 'data-view': route }, [
    el('header', { class: 'view-header' }, [
      el('h1', { class: 'view-title' }, item.title),
      el('p', { class: 'view-subtitle' }, item.subtitle),
    ]),
    el('div', { class: 'placeholder-panel' }, el('div', { class: 'placeholder-content' }, [
      el('div', { class: 'placeholder-icon' }, Icon(item.icon, { size: 34 })),
      Badge({ label: 'Coming next', tone: 'accent' }),
      el('h2', { class: 'placeholder-title' }, item.heading),
      el('p', { class: 'placeholder-message' }, item.message),
      el('p', { class: 'placeholder-note' }, [Icon('check', { size: 15 }), 'Sign-in, navigation, and offline support are ready']),
      route === 'settings' ? el('div', { class: 'button-row' }, el('button', {
        class: 'button button--secondary',
        type: 'button',
        onClick: () => void context.signOut(),
      }, [Icon('log-out', { size: 19 }), 'Sign out'])) : null,
    ])),
  ])
  return { element }
}

/**
 * Views implemented by the next lane replace these one-for-one:
 * renderChat/renderDashboard/renderFoods/renderSettings/renderHistory.
 */
const renderers: Record<Route, ViewRenderer> = {
  chat: placeholder.bind(null, 'chat'),
  dashboard: placeholder.bind(null, 'dashboard'),
  foods: placeholder.bind(null, 'foods'),
  settings: placeholder.bind(null, 'settings'),
  history: placeholder.bind(null, 'history'),
}

class App {
  private readonly root: HTMLElement
  private viewHost: HTMLElement | null = null
  private tabBars: HTMLElement[] = []
  private activeRoute: Route = routeFromHash()
  private activeView: ViewHandle | null = null
  private unsubscribe: (() => void) | null = null

  constructor(root: HTMLElement) {
    this.root = root
    window.addEventListener('hashchange', () => {
      this.activeRoute = routeFromHash()
      if (this.viewHost) {
        this.render()
        window.scrollTo({ top: 0 })
      }
    })
    void this.bootstrap()
  }

  private async bootstrap(): Promise<void> {
    if (!isAuthenticated()) {
      this.renderLogin()
      return
    }
    this.renderLoading('Opening your HealthLog…')
    try {
      await store.hydrate()
      this.buildShell()
    } catch (error) {
      await this.handleLoadError(error)
    }
  }

  private renderLogin(): void {
    this.teardownShell()
    this.root.replaceChildren(renderLogin({
      onAuthenticated: (user) => this.completeLogin(user),
    }))
    document.title = 'Sign in · HealthLog'
  }

  private async completeLogin(user: User): Promise<void> {
    store.adoptUser(user)
    this.renderLoading('Bringing your data together…')
    try {
      await store.hydrate()
      this.buildShell()
    } catch (error) {
      await this.handleLoadError(error)
    }
  }

  private async handleLoadError(error: unknown): Promise<void> {
    if (error instanceof ApiError && error.status === 401) {
      try { await logout() } catch { /* Local sign-out still completes. */ }
      store.reset()
      this.renderLogin()
      return
    }
    const message = error instanceof Error ? error.message : 'Could not connect to HealthLog.'
    this.root.replaceChildren(el('main', { class: 'loading-screen' }, el('section', { class: 'empty-state' }, [
      el('div', { class: 'empty-state-icon' }, Icon('alert', { size: 28 })),
      el('h1', { class: 'empty-state-title' }, 'We could not load your data'),
      el('p', { class: 'empty-state-message' }, message),
      el('div', { class: 'button-row' }, [
        el('button', { class: 'button button--primary', type: 'button', onClick: () => void this.bootstrap() }, 'Try again'),
        el('button', { class: 'button button--secondary', type: 'button', onClick: () => void this.signOut() }, 'Back to sign in'),
      ]),
    ])))
  }

  private renderLoading(label: string): void {
    this.teardownShell()
    this.root.replaceChildren(el('main', { class: 'loading-screen' }, el('div', { class: 'loading-card' }, [
      el('span', { class: 'brand-mark' }, Icon('activity', { size: 25 })),
      Spinner({ label }),
      el('p', {}, label),
    ])))
  }

  private buildShell(): void {
    this.teardownShell()
    this.viewHost = el('main', { class: 'view-host', id: 'main-content', tabindex: '-1' })
    const railNav = this.buildNavigation('rail-nav')
    const bottomNav = this.buildNavigation('bottom-nav')
    this.tabBars = [railNav, bottomNav]
    const user = store.get().user

    const rail = el('aside', { class: 'side-rail', 'aria-label': 'HealthLog sidebar' }, [
      brand(),
      railNav,
      el('div', { class: 'rail-footer' }, el('div', { class: 'account-chip' }, [
        el('span', { class: 'account-avatar' }, Icon('user', { size: 20 })),
        el('span', { class: 'account-copy' }, [
          el('span', { class: 'account-name' }, user?.displayName || 'Your account'),
          el('span', { class: 'account-email' }, user?.email || ''),
        ]),
      ])),
    ])
    const topbar = el('header', { class: 'app-topbar' }, [brand()])
    const shell = el('div', { class: 'health-app' }, [
      rail,
      el('div', { class: 'app-column' }, [topbar, this.viewHost]),
      bottomNav,
    ])
    this.root.replaceChildren(
      el('a', {
        class: 'skip-link',
        href: '#main-content',
        onClick: (event: Event) => {
          event.preventDefault()
          this.viewHost?.focus()
        },
      }, 'Skip to content'),
      shell,
    )
    this.unsubscribe = store.subscribe(() => this.render())
    this.render()
  }

  private buildNavigation(className: string): HTMLElement {
    return el('nav', { class: `tab-bar ${className}`, 'aria-label': 'Main navigation' }, TABS.map((tab) => el('button', {
      class: 'tab-button',
      type: 'button',
      'data-tab': tab.id,
      'aria-current': this.activeRoute === tab.id ? 'page' : 'false',
      onClick: () => this.navigate(tab.id),
    }, [Icon(tab.icon, { size: 22 }), el('span', { class: 'tab-label' }, tab.label)])))
  }

  private navigate(route: Route): void {
    if (route === this.activeRoute) {
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      window.scrollTo({ top: 0, behavior })
      return
    }
    window.location.hash = `/${route}`
  }

  private viewContext(state: AppState): ViewContext {
    return {
      state,
      navigate: (route) => this.navigate(route),
      refresh: () => store.refresh(),
      signOut: () => this.signOut(),
    }
  }

  private render(): void {
    if (!this.viewHost) return
    const focus = captureFocus(this.viewHost)
    this.activeView?.destroy?.()
    this.activeView = null
    const state = store.get()
    const handle = renderers[this.activeRoute](this.viewContext(state))
    this.activeView = handle
    this.viewHost.replaceChildren(handle.element)
    for (const bar of this.tabBars) {
      bar.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
        button.setAttribute('aria-current', button.dataset.tab === this.activeRoute ? 'page' : 'false')
      })
    }
    document.title = `${this.activeRoute[0].toUpperCase()}${this.activeRoute.slice(1)} · HealthLog`
    restoreFocus(this.viewHost, focus)
  }

  private async signOut(): Promise<void> {
    let failed = false
    try { await logout() } catch { failed = true }
    store.reset()
    this.renderLogin()
    if (failed) {
      // The local session is still removed; this is only a connection warning.
      const note = el('p', { class: 'login-privacy', role: 'status' }, 'Signed out on this device. The server session could not be confirmed.')
      this.root.querySelector('.login-card')?.append(note)
    }
  }

  private teardownShell(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.activeView?.destroy?.()
    this.activeView = null
    this.viewHost = null
    this.tabBars = []
  }
}

interface FocusSnapshot {
  key: string
  start: number | null
  end: number | null
}

function captureFocus(host: HTMLElement): FocusSnapshot | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || !host.contains(active) || !active.dataset.focusKey) return null
  const selectable = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
  return {
    key: active.dataset.focusKey,
    start: selectable ? active.selectionStart : null,
    end: selectable ? active.selectionEnd : null,
  }
}

function restoreFocus(host: HTMLElement, snapshot: FocusSnapshot | null): void {
  if (!snapshot) return
  const escaped = snapshot.key.replace(/["'\\\]]/g, '\\$&')
  const target = host.querySelector<HTMLElement>(`[data-focus-key="${escaped}"]`)
  target?.focus({ preventScroll: true })
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && snapshot.start !== null) {
    target.setSelectionRange(snapshot.start, snapshot.end ?? snapshot.start)
  }
}

const root = document.getElementById('app')
if (root) new App(root)
registerServiceWorker()
