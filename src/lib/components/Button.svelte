<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
    type?: 'button' | 'submit'
    disabled?: boolean
    full?: boolean
    onclick?: (event: MouseEvent) => void
    children: Snippet
  }

  let {
    variant = 'primary',
    type = 'button',
    disabled = false,
    full = false,
    onclick,
    children,
  }: Props = $props()
</script>

<button
  class="button button--{variant}"
  class:button--full={full}
  {type}
  {disabled}
  {onclick}
>
  {@render children()}
</button>

<style>
  .button--full {
    width: 100%;
  }

  .button--ghost {
    border-color: transparent;
    background: transparent;
    color: var(--color-accent);
  }

  .button--ghost:hover {
    background: var(--color-accent-soft);
  }
</style>
