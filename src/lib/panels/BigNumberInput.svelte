<script lang="ts">
  import NumberStepButton from './NumberStepButton.svelte'

  interface Props {
    value: number
    onchange: (value: number) => void
    onsubmit: () => void
  }
  let { value, onchange, onsubmit }: Props = $props()

  const step = 0.1
  const unit = 'kg'
  const floor = 20
  const ceiling = 400
  let current = 0
  let blank = true
  let text = $state('')

  // Synchronise only external resets (opening a different entry). While the
  // user types, the parent sends back the same number and the draft is kept.
  $effect(() => {
    const next = value
    if (Number.isFinite(next) && next !== current) {
      current = Math.max(0, next)
      blank = current <= 0
      renderValue()
    }
  })

  function parseInput(): number | null {
    const raw = text.trim().replace(',', '.')
    if (!raw || !/^\d*\.?\d*$/.test(raw)) return null
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }

  function renderValue(): void {
    text = blank || !Number.isFinite(current) || current <= 0 ? '' : current.toFixed(1)
  }

  function setValue(next: number): void {
    current = Math.max(0, Math.round(next * 1000) / 1000)
    blank = false
    renderValue()
    onchange(current)
  }

  function adjust(direction: -1 | 1): void {
    const base = blank || !Number.isFinite(current) || current <= 0 ? floor : current
    setValue(Math.min(ceiling, base + direction * step))
  }

  function input(): void {
    const parsed = parseInput()
    blank = text.trim() === ''
    current = parsed ?? Number.NaN
    onchange(current)
  }

  function blur(): void {
    const parsed = parseInput()
    if (parsed !== null) current = parsed
    renderValue()
    if (parsed !== null) onchange(current)
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const parsed = parseInput()
    if (parsed !== null) current = parsed
    renderValue()
    onsubmit()
  }

  function selectValue(event: FocusEvent): void {
    const input = event.currentTarget as HTMLInputElement
    requestAnimationFrame(() => input.select())
  }
</script>

<div class="big-number-input">
  <div class="big-number-display">
    <input
      class="big-number-value"
      type="text"
      inputmode="decimal"
      pattern="[0-9]*[.,]?[0-9]*"
      autocomplete="off"
      aria-label="Weight in kilograms"
      placeholder="0"
      data-autofocus
      bind:value={text}
      oninput={input}
      onfocus={selectValue}
      onblur={blur}
      onkeydown={keydown}
    />
    <span class="big-number-unit" aria-hidden="true">kg</span>
  </div>
  <div class="big-number-steppers">
    <NumberStepButton direction={-1} {step} {unit} onstep={() => adjust(-1)} />
    <span class="step-hint" aria-hidden="true">0.1 kg</span>
    <NumberStepButton direction={1} {step} {unit} onstep={() => adjust(1)} />
  </div>
</div>
