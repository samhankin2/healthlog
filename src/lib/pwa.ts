let started = false

/** Register the production worker without making offline support a boot dependency. */
export function registerServiceWorker(): void {
  if (started || !import.meta.env.PROD || !('serviceWorker' in navigator)) return
  started = true
  const register = (): void => {
    const url = new URL(`${import.meta.env.BASE_URL}sw.js`, window.location.href)
    navigator.serviceWorker.register(url.href).catch((error: unknown) => {
      console.warn('[healthlog] Offline support could not be started.', error)
    })
  }
  if (document.readyState === 'complete') register()
  else window.addEventListener('load', register, { once: true })
}
