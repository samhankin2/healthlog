<script module lang="ts">
  let bodyLockCount = 0
  let previousBodyOverflow = ''
  let nextSheetId = 0
  const sheetStack: object[] = []

  function lockBody(): void {
    if (bodyLockCount === 0) {
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    }
    bodyLockCount += 1
  }

  function unlockBody(): void {
    bodyLockCount = Math.max(0, bodyLockCount - 1)
    if (bodyLockCount === 0) document.body.style.overflow = previousBodyOverflow
  }

  function focusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((node) => !node.hasAttribute('hidden') && node.getClientRects().length > 0)
  }
</script>

<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  interface Props {
    open: boolean
    title?: string
    subtitle?: string
    onclose: () => void
    children: Snippet
    actions?: Snippet
  }

  let { open, title, subtitle, onclose, children, actions }: Props = $props()

  const id = `sheet-${++nextSheetId}`
  const titleId = `${id}-title`
  const subtitleId = `${id}-subtitle`
  const token = {}
  let panel: HTMLElement | undefined = $state()
  let previousFocus: HTMLElement | null = null
  let focusRetry = 0

  function isTopSheet(): boolean {
    return sheetStack[sheetStack.length - 1] === token
  }

  function moveFocusIntoSheet(): void {
    if (!panel || !open) return
    const autofocus = panel.querySelector<HTMLElement>('[data-autofocus]')
    const target = autofocus ?? focusableElements(panel)[0] ?? panel
    target.focus()
    if (document.activeElement === target) {
      focusRetry = 0
      return
    }
    if (focusRetry < 5) {
      focusRetry += 1
      window.requestAnimationFrame(moveFocusIntoSheet)
    }
  }

  function onDocumentKeydown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Escape' || !isTopSheet()) return
    event.preventDefault()
    event.stopPropagation()
    onclose()
  }

  function onkeydown(event: KeyboardEvent): void {
    if (!open || event.key !== 'Tab' || !panel || !isTopSheet()) return
    const focusable = focusableElements(panel)
    if (focusable.length === 0) {
      event.preventDefault()
      panel.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (!panel.contains(active)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  $effect(() => {
    if (!open || !panel) return

    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    focusRetry = 0
    sheetStack.push(token)
    lockBody()
    document.addEventListener('keydown', onDocumentKeydown, true)
    const frame = window.requestAnimationFrame(moveFocusIntoSheet)

    return () => {
      window.cancelAnimationFrame(frame)
      document.removeEventListener('keydown', onDocumentKeydown, true)
      const position = sheetStack.lastIndexOf(token)
      if (position !== -1) sheetStack.splice(position, 1)
      unlockBody()
      if (previousFocus?.isConnected) previousFocus.focus()
      previousFocus = null
    }
  })
</script>

<div
  class="sheet-layer"
  class:is-open={open}
  aria-hidden={!open}
  inert={!open}
  {onkeydown}
>
  <button class="sheet-backdrop" type="button" tabindex="-1" aria-label="Close dialog" onclick={onclose}></button>
  <div
    bind:this={panel}
    class="sheet-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby={title ? titleId : undefined}
    aria-label={title ? undefined : 'Dialog'}
    aria-describedby={subtitle ? subtitleId : undefined}
    tabindex="-1"
  >
    <div class="sheet-grabber" aria-hidden="true"></div>
    <header class="sheet-header">
      <div class="sheet-heading">
        {#if title}<h2 class="sheet-title" id={titleId}>{title}</h2>{/if}
        {#if subtitle}<p class="sheet-subtitle" id={subtitleId}>{subtitle}</p>{/if}
      </div>
      <button class="icon-button sheet-close" type="button" aria-label="Close dialog" onclick={onclose}>
        <Icon name="x" size={20} />
      </button>
    </header>
    <div class="sheet-content">{@render children()}</div>
    {#if actions}<div class="sheet-actions">{@render actions()}</div>{/if}
  </div>
</div>

<style>
  .sheet-backdrop {
    padding: 0;
    border: 0;
  }
</style>
