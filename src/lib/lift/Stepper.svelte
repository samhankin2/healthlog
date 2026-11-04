<script lang="ts">
  import { onDestroy } from 'svelte'
  import Icon from '../components/Icon.svelte'

  interface Props {
    /** Visible label, e.g. "Weight". */
    label: string
    value: number
    step: number
    min?: number
    max?: number
    unit?: string
    /** Accessible unit word for the buttons, e.g. "kilograms". */
    unitName?: string
    decimal?: boolean
    onchange: (value: number) => void
  }

  let { label, value, step, min = 0, max = 999, unit = '', unitName = unit, decimal = false, onchange }: Props = $props()

  const id = `stepper-${Math.random().toString(36).slice(2, 9)}`
  let text = $state('')
  let editing = $state(false)
  const shown = $derived(editing ? text : fmt(value))

  function fmt(v: number): string {
    return String(Math.round(v * 100) / 100)
  }
  function clamp(v: number): number {
    const snapped = decimal ? Math.round(v * 4) / 4 : Math.round(v)
    return Math.min(max, Math.max(min, snapped))
  }
  function bump(dir: -1 | 1): void {
    onchange(clamp(value + dir * step))
  }

  // Hold to repeat, like the weigh-in steppers.
  let delay: number | undefined
  let interval: number | undefined
  let suppress = false
  function stop(): void {
    if (delay !== undefined) window.clearTimeout(delay)
    if (interval !== undefined) window.clearInterval(interval)
    delay = interval = undefined
  }
  function press(event: PointerEvent, dir: -1 | 1): void {
    if (event.button !== 0) return
    suppress = true
    bump(dir)
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId) } catch { /* optional */ }
    delay = window.setTimeout(() => { interval = window.setInterval(() => bump(dir), 110) }, 450)
  }
  function click(dir: -1 | 1): void {
    if (suppress) { suppress = false; return }
    bump(dir)
  }
  onDestroy(stop)

  function focus(event: FocusEvent): void {
    editing = true
    text = fmt(value)
    const input = event.currentTarget as HTMLInputElement
    requestAnimationFrame(() => input.select())
  }
  function input(event: Event): void {
    text = (event.currentTarget as HTMLInputElement).value
    const n = Number(text.replace(',', '.'))
    if (text.trim() !== '' && Number.isFinite(n)) onchange(clamp(n))
  }
  function blur(): void {
    editing = false
  }
  function keydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowUp') { event.preventDefault(); bump(1) }
    if (event.key === 'ArrowDown') { event.preventDefault(); bump(-1) }
    if (event.key === 'Enter') (event.currentTarget as HTMLInputElement).blur()
  }
</script>

<div class="stepper">
  <label class="st-label" for={id}>{label}</label>
  <div class="st-row">
    <button
      class="st-btn"
      type="button"
      aria-label="{label}: minus {fmt(step)} {unitName}"
      disabled={value <= min}
      onpointerdown={(e) => press(e, -1)}
      onpointerup={stop}
      onpointercancel={() => { stop(); suppress = false }}
      onclick={() => click(-1)}
    ><Icon name="minus" size={24} /></button>
    <span class="st-value">
      <input
        {id}
        class="st-input"
        type="text"
        inputmode={decimal ? 'decimal' : 'numeric'}
        autocomplete="off"
        enterkeyhint="done"
        value={shown}
        onfocus={focus}
        oninput={input}
        onblur={blur}
        onkeydown={keydown}
      />
      {#if unit}<span class="st-unit" aria-hidden="true">{unit}</span>{/if}
    </span>
    <button
      class="st-btn"
      type="button"
      aria-label="{label}: plus {fmt(step)} {unitName}"
      disabled={value >= max}
      onpointerdown={(e) => press(e, 1)}
      onpointerup={stop}
      onpointercancel={() => { stop(); suppress = false }}
      onclick={() => click(1)}
    ><Icon name="plus" size={24} /></button>
  </div>
</div>

<style>
  .stepper { display: flex; min-width: 0; flex-direction: column; gap: var(--space-1); }
  .st-label { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  .st-row { display: flex; align-items: stretch; gap: 0; border: 1px solid var(--color-border-strong); border-radius: var(--radius-md); background: var(--color-surface); overflow: hidden; }
  .st-row:focus-within { border-color: var(--color-focus); box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-focus) 22%, transparent); }
  .st-btn { display: grid; width: 3.25rem; min-height: 3.5rem; flex: 0 0 auto; place-items: center; border: 0; background: var(--color-surface-sunken); color: var(--color-text); touch-action: manipulation; user-select: none; -webkit-user-select: none; }
  .st-btn:active { background: var(--color-accent-soft); color: var(--color-accent); }
  .st-btn:disabled { color: var(--color-text-subtle); opacity: 0.6; }
  .st-value { position: relative; display: flex; min-width: 0; flex: 1 1 auto; align-items: center; justify-content: center; }
  .st-input { width: 100%; min-width: 0; height: 100%; padding: 0 var(--space-1); border: 0; background: transparent; color: var(--color-text); font-family: var(--font-numeric); font-size: 1.75rem; font-weight: var(--weight-bold); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; text-align: center; }
  .st-input:focus { outline: none; }
  .st-unit { position: absolute; right: var(--space-2); bottom: var(--space-1); color: var(--color-text-subtle); font-size: var(--text-xs); font-weight: var(--weight-semibold); pointer-events: none; }
</style>
