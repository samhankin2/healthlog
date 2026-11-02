/**
 * A single toast host for the whole app.
 *
 * `showToast('Saved')` from anywhere; `App.svelte` renders `<Toast />` once
 * and it animates in and out on its own.
 */
export type ToastTone = 'default' | 'success' | 'error'

export const toast = $state({
  message: '',
  tone: 'default' as ToastTone,
  visible: false,
})

let hideTimer: number | undefined

export function showToast(message: string, tone: ToastTone = 'default'): void {
  toast.message = message
  toast.tone = tone
  toast.visible = true
  if (hideTimer !== undefined) window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    toast.visible = false
  }, 3200)
}

export function hideToast(): void {
  if (hideTimer !== undefined) window.clearTimeout(hideTimer)
  toast.visible = false
}
