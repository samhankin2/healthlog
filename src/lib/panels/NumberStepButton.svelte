<script lang="ts">
  import { onDestroy } from 'svelte'
  import Icon from '../components/Icon.svelte'

  interface Props {
    direction: -1 | 1
    step: number
    unit: string
    onstep: () => void
  }
  let { direction, step, unit, onstep }: Props = $props()
  let repeatDelay: number | undefined
  let repeatInterval: number | undefined
  let suppressClick = false

  function stopRepeat(): void {
    if (repeatDelay !== undefined) window.clearTimeout(repeatDelay)
    if (repeatInterval !== undefined) window.clearInterval(repeatInterval)
    repeatDelay = undefined
    repeatInterval = undefined
  }

  function startRepeat(event: PointerEvent): void {
    if (event.button !== 0) return
    suppressClick = true
    onstep()
    try { (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId) } catch { /* optional in embedded web views */ }
    repeatDelay = window.setTimeout(() => {
      repeatInterval = window.setInterval(onstep, 75)
    }, 425)
  }

  function click(): void {
    if (suppressClick) {
      suppressClick = false
      return
    }
    onstep()
  }

  onDestroy(stopRepeat)
</script>

<button
  class:step-button--increase={direction === 1}
  class:step-button--decrease={direction === -1}
  class="step-button"
  type="button"
  aria-label={`${direction === 1 ? 'Increase' : 'Decrease'} weight by ${step} ${unit}`}
  onpointerdown={startRepeat}
  onpointerup={stopRepeat}
  onpointercancel={() => { stopRepeat(); suppressClick = false }}
  onclick={click}
>
  <Icon name={direction === 1 ? 'plus' : 'minus'} size={28} />
</button>
