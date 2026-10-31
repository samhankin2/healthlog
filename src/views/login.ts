import { ApiError } from '../lib/api'
import { login, register } from '../lib/auth'
import type { User } from '../lib/types'
import { FieldInput, Spinner } from '../ui/components'
import { el, Icon } from '../ui/dom'

export interface LoginViewOptions {
  onAuthenticated: (user: User) => void | Promise<void>
}

/** Email sign-in with invite-only registration revealed on request. */
export function renderLogin({ onAuthenticated }: LoginViewOptions): HTMLElement {
  let registering = false
  let submitting = false

  const title = el('h1', { class: 'login-title', id: 'login-title' }, 'Welcome back')
  const subtitle = el('p', { class: 'login-subtitle' }, 'Sign in to pick up where you left off.')
  const error = el('p', { class: 'form-error', role: 'alert', hidden: true })
  const inviteHost = el('div', { class: 'invite-field', id: 'invite-field', hidden: true })
  const toggle = el('button', {
    class: 'invite-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': 'invite-field',
  }, 'I have an invite code')
  const submit = el('button', { class: 'button button--primary', type: 'submit' }, 'Sign in')
  const emailField = FieldInput({
    id: 'login-email',
    label: 'Email address',
    type: 'email',
    autocomplete: 'email',
    inputmode: 'email',
    placeholder: 'you@example.com',
    required: true,
    focusKey: 'login-email',
    autoFocus: true,
  })
  const passwordField = FieldInput({
    id: 'login-password',
    label: 'Password',
    type: 'password',
    autocomplete: 'current-password',
    required: true,
    focusKey: 'login-password',
  })
  const inviteField = FieldInput({
    id: 'login-invite',
    label: 'Invite code',
    autocomplete: 'off',
    placeholder: 'Enter your code',
    required: true,
    hint: 'An invite code is only needed the first time you create an account.',
    focusKey: 'login-invite',
  })
  inviteHost.append(inviteField)

  const form = el('form', { class: 'login-form', novalidate: true }, [
    error,
    emailField,
    passwordField,
    toggle,
    inviteHost,
    submit,
  ])

  function showError(message = ''): void {
    error.hidden = !message
    error.replaceChildren(...(message ? [Icon('alert', { size: 18 }), el('span', {}, message)] : []))
  }

  function setSubmitting(next: boolean): void {
    submitting = next
    form.setAttribute('aria-busy', String(next))
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach((control) => {
      control.disabled = next
    })
    submit.replaceChildren(...(next ? [Spinner({ label: registering ? 'Creating account' : 'Signing in' }), registering ? 'Creating account…' : 'Signing in…'] : [registering ? 'Create account' : 'Sign in']))
  }

  function setMode(next: boolean): void {
    registering = next
    showError()
    title.textContent = next ? 'Create your account' : 'Welcome back'
    subtitle.textContent = next
      ? 'Use your invite to start a private HealthLog account.'
      : 'Sign in to pick up where you left off.'
    toggle.textContent = next ? 'Use an existing account instead' : 'I have an invite code'
    toggle.setAttribute('aria-expanded', String(next))
    inviteHost.hidden = !next
    const password = form.querySelector<HTMLInputElement>('#login-password')
    password?.setAttribute('autocomplete', next ? 'new-password' : 'current-password')
    submit.textContent = next ? 'Create account' : 'Sign in'
    if (next) form.querySelector<HTMLInputElement>('#login-invite')?.focus()
  }

  toggle.addEventListener('click', () => setMode(!registering))

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (submitting) return
    const email = form.querySelector<HTMLInputElement>('#login-email')?.value.trim() ?? ''
    const password = form.querySelector<HTMLInputElement>('#login-password')?.value ?? ''
    const inviteCode = form.querySelector<HTMLInputElement>('#login-invite')?.value.trim() ?? ''

    if (!email || !email.includes('@')) {
      showError('Enter a valid email address.')
      form.querySelector<HTMLInputElement>('#login-email')?.focus()
      return
    }
    if (!password || (registering && password.length < 8)) {
      showError(registering ? 'Choose a password with at least 8 characters.' : 'Enter your password.')
      form.querySelector<HTMLInputElement>('#login-password')?.focus()
      return
    }
    if (registering && !inviteCode) {
      showError('Enter your invite code to create an account.')
      form.querySelector<HTMLInputElement>('#login-invite')?.focus()
      return
    }

    showError()
    setSubmitting(true)
    const attempt = registering
      ? register({ email, password, inviteCode })
      : login({ email, password })
    attempt.then(onAuthenticated).catch((cause: unknown) => {
      const message = cause instanceof ApiError || cause instanceof Error
        ? cause.message
        : 'Could not sign in. Check your connection and try again.'
      showError(message)
    }).finally(() => {
      if (form.isConnected) setSubmitting(false)
    })
  })

  return el('main', { class: 'login-screen', 'aria-labelledby': 'login-title' }, [
    el('div', { class: 'login-layout' }, [
      el('section', { class: 'login-intro' }, [
        el('div', { class: 'brand' }, [
          el('span', { class: 'brand-mark' }, Icon('activity', { size: 24 })),
          el('span', { class: 'brand-copy' }, [
            el('span', { class: 'brand-name' }, 'HealthLog'),
            el('span', { class: 'brand-tagline' }, 'Weight, food, and the bigger picture'),
          ]),
        ]),
        el('p', { class: 'login-kicker' }, 'A quieter way to keep track'),
        el('h2', { class: 'login-headline' }, 'Small daily notes. A clearer picture over time.'),
        el('p', { class: 'login-description' }, 'Log a weigh-in, describe a meal, and let HealthLog bring the details together without the noise.'),
      ]),
      el('section', { class: 'login-card' }, [
        el('div', { class: 'login-card-header' }, [title, subtitle]),
        form,
        el('p', { class: 'login-privacy' }, 'Your account is protected with a secure session. Your food and weight data stays connected to you.'),
      ]),
    ]),
  ])
}
