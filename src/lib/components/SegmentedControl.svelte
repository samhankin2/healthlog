<script lang="ts">
  interface Props {
    options: { value: string; label: string }[]
    value: string
    ariaLabel?: string
    onchange: (value: string) => void
  }

  let { options, value, ariaLabel = 'Choose an option', onchange }: Props = $props()

  const selected = $derived(options.some((option) => option.value === value) ? value : (options[0]?.value ?? ''))

  function choose(next: string): void {
    if (next !== value) onchange(next)
  }

  function onkeydown(event: KeyboardEvent, index: number): void {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % options.length
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + options.length) % options.length
    if (event.key === 'Home') nextIndex = 0
    if (event.key === 'End') nextIndex = options.length - 1
    if (nextIndex === null) return

    event.preventDefault()
    const next = options[nextIndex]
    if (!next) return
    choose(next.value)
    const group = event.currentTarget as HTMLElement
    const buttons = group.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    buttons?.[nextIndex]?.focus()
  }
</script>

<div class="segmented-control" role="radiogroup" aria-label={ariaLabel}>
  {#each options as option, index (option.value)}
    <button
      class="segmented-option"
      type="button"
      role="radio"
      aria-checked={option.value === selected}
      tabindex={option.value === selected ? 0 : -1}
      onclick={() => choose(option.value)}
      onkeydown={(event) => onkeydown(event, index)}
    >
      {option.label}
    </button>
  {/each}
</div>
