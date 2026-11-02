<script lang="ts">
  import { tick } from 'svelte'
  import { ApiError } from '../lib/api'
  import { login, register } from '../lib/auth'
  import type { User } from '../lib/types'
  import Button from '../lib/components/Button.svelte'
  import Field from '../lib/components/Field.svelte'
  import Icon from '../lib/components/Icon.svelte'

  interface Props {
    onauthenticated: (user: User) => void | Promise<void>
  }

  let { onauthenticated }: Props = $props()

  let registering = $state(false)
  let submitting = $state(false)
  let email = $state('')
  let password = $state('')
  let inviteCode = $state('')
  let error = $state('')

  async function toggleMode(): Promise<void> {
    registering = !registering
    error = ''
    if (registering) {
      await tick()
      document.getElementById('login-invite')?.focus()
    }
  }

  function showValidationError(message: string, id: string): void {
    error = message
    document.getElementById(id)?.focus()
  }

  async function onsubmit(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (submitting) return

    const cleanEmail = email.trim()
    const cleanInvite = inviteCode.trim()
    if (!cleanEmail || !cleanEmail.includes('@')) {
      showValidationError('Enter a valid email address.', 'login-email')
      return
    }
    if (!password || (registering && password.length < 8)) {
      showValidationError(
        registering ? 'Choose a password with at least 8 characters.' : 'Enter your password.',
        'login-password',
      )
      return
    }
    if (registering && !cleanInvite) {
      showValidationError('Enter your invite code to create an account.', 'login-invite')
      return
    }

    error = ''
    submitting = true
    try {
      const user = registering
        ? await register({ email: cleanEmail, password, inviteCode: cleanInvite })
        : await login({ email: cleanEmail, password })
      await onauthenticated(user)
    } catch (cause: unknown) {
      error = cause instanceof ApiError || cause instanceof Error
        ? cause.message
        : 'Could not sign in. Check your connection and try again.'
    } finally {
      submitting = false
    }
  }
</script>

<main class="login-screen" aria-labelledby="login-title">
  <div class="login-layout">
    <section class="login-intro">
      <div class="brand">
        <span class="brand-mark"><Icon name="activity" size={24} /></span>
        <span class="brand-copy">
          <span class="brand-name">HealthLog</span>
          <span class="brand-tagline">Weight, food, and the bigger picture</span>
        </span>
      </div>
      <p class="login-kicker">A quieter way to keep track</p>
      <h2 class="login-headline">Small daily notes. A clearer picture over time.</h2>
      <p class="login-description">
        Log a weigh-in, describe a meal, and let HealthLog bring the details together without the noise.
      </p>
    </section>

    <section class="login-card">
      <div class="login-card-header">
        <h1 class="login-title" id="login-title">{registering ? 'Create your account' : 'Welcome back'}</h1>
        <p class="login-subtitle">
          {registering
            ? 'Use your invite to start a private HealthLog account.'
            : 'Sign in to pick up where you left off.'}
        </p>
      </div>

      <form class="login-form" aria-busy={submitting} novalidate {onsubmit}>
        {#if error}
          <p class="form-error" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
          </p>
        {/if}

        <Field
          id="login-email"
          label="Email address"
          type="email"
          autocomplete="email"
          inputmode="email"
          placeholder="you@example.com"
          required
          disabled={submitting}
          value={email}
          oninput={(value) => (email = value)}
        />
        <Field
          id="login-password"
          label="Password"
          type="password"
          autocomplete={registering ? 'new-password' : 'current-password'}
          required
          disabled={submitting}
          value={password}
          oninput={(value) => (password = value)}
        />

        <button
          class="invite-toggle"
          type="button"
          aria-expanded={registering}
          aria-controls="invite-field"
          disabled={submitting}
          onclick={toggleMode}
        >
          {registering ? 'Use an existing account instead' : 'I have an invite code'}
        </button>

        {#if registering}
          <div class="invite-field" id="invite-field">
            <Field
              id="login-invite"
              label="Invite code"
              autocomplete="off"
              placeholder="Enter your code"
              hint="An invite code is only needed the first time you create an account."
              required
              disabled={submitting}
              value={inviteCode}
              oninput={(value) => (inviteCode = value)}
            />
          </div>
        {/if}

        <Button type="submit" disabled={submitting} full>
          {#if submitting}
            <span class="spinner-wrap" aria-hidden="true"><span class="spinner"></span></span>
            {registering ? 'Creating account…' : 'Signing in…'}
          {:else}
            {registering ? 'Create account' : 'Sign in'}
          {/if}
        </Button>
      </form>

      <p class="login-privacy">
        Your account is protected with a secure session. Your food and weight data stays connected to you.
      </p>
    </section>
  </div>
</main>

<style>
  /* Keep the two mobile grid rows together instead of stretching them across
     the viewport. Explicit block padding also keeps the card rhythm symmetric. */
  .login-layout {
    align-content: center;
  }

  .login-card {
    padding-block: clamp(var(--space-5), 5vw, var(--space-8));
  }

  .login-headline {
    font-weight: 700;
    letter-spacing: -0.04em;
  }
</style>
