/**
 * Partner sharing state: the partner link and the inbox of meals a partner
 * has offered. Loaded when the app opens and again whenever it comes back to
 * the foreground, so a meal shared while the app was closed shows up as soon
 * as it is opened.
 */
import { api } from './api'
import { actions } from './state.svelte'
import type { MealPatch, Partner, SharedMeal } from './types'

export const sharing = $state<{ partner: Partner | null; inbox: SharedMeal[]; loaded: boolean }>({
  partner: null,
  inbox: [],
  loaded: false,
})

let inflight: Promise<void> | null = null

/** The linked partner's first name, or null when there is no live link. */
export function partnerName(): string | null {
  return sharing.partner?.status === 'linked' ? sharing.partner.name : null
}

/** Fetch the partner link and the inbox. Failures keep the last known state. */
export function loadSharing(): Promise<void> {
  inflight ??= (async () => {
    try {
      const [partner, inbox] = await Promise.all([api.getPartner(), api.getSharedMeals()])
      sharing.partner = partner.partner
      sharing.inbox = inbox.shares
      sharing.loaded = true
    } catch {
      /* Sharing is secondary: never block the app on it. */
    } finally {
      inflight = null
    }
  })()
  return inflight
}

export function resetSharing(): void {
  sharing.partner = null
  sharing.inbox = []
  sharing.loaded = false
}

export async function setPartner(email: string): Promise<void> {
  sharing.partner = (await api.setPartner(email)).partner
  sharing.inbox = (await api.getSharedMeals()).shares
}

export async function removePartner(): Promise<void> {
  await api.removePartner()
  sharing.partner = null
  sharing.inbox = []
}

/** Add a shared meal to my log (with any corrections) and drop it from the inbox. */
export async function acceptShared(id: string, input: MealPatch): Promise<void> {
  await actions.acceptSharedMeal(id, input)
  sharing.inbox = sharing.inbox.filter((share) => share.id !== id)
  void actions.loadDashboard().catch(() => {})
}

export async function dismissShared(id: string): Promise<void> {
  await api.dismissSharedMeal(id)
  sharing.inbox = sharing.inbox.filter((share) => share.id !== id)
}
