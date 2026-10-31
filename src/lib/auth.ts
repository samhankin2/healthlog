import { api } from './api'
import type { ApiRequestOptions, AuthPayload } from './api'
import type { User } from './types'

export const TOKEN_KEY = 'healthlog:token'
let currentUser: User | null = null
let sessionToken: string | null = null

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? sessionToken
  } catch {
    return sessionToken
  }
}

function setToken(token: string | null): void {
  sessionToken = token
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Authentication still works for this page load if storage is unavailable.
  }
}

export function getUser(): User | null {
  return currentUser
}

export function setUser(user: User | null): void {
  currentUser = user
}

export function isAuthenticated(): boolean {
  return Boolean(getToken())
}

async function acceptAuth(payload: AuthPayload): Promise<User> {
  setToken(payload.token)
  currentUser = payload.user
  return payload.user
}

export async function login(
  credentials: { email: string; password: string },
  options?: ApiRequestOptions,
): Promise<User> {
  return acceptAuth(await api.login(credentials, options))
}

export async function register(
  details: { email: string; password: string; inviteCode: string },
  options?: ApiRequestOptions,
): Promise<User> {
  return acceptAuth(await api.register(details, options))
}

/** Clear local auth even if the server session cannot be reached. */
export async function logout(options?: ApiRequestOptions): Promise<void> {
  try {
    if (getToken()) await api.logout(options)
  } finally {
    setToken(null)
    currentUser = null
  }
}
