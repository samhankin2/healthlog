<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements'

  interface Props {
    id: string
    label: string
    type?: 'text' | 'email' | 'password' | 'number' | 'date'
    value?: string | number
    placeholder?: string
    hint?: string
    error?: string
    required?: boolean
    disabled?: boolean
    autocomplete?: string
    inputmode?: string
    oninput?: (value: string) => void
  }

  let {
    id,
    label,
    type = 'text',
    value = '',
    placeholder,
    hint,
    error,
    required = false,
    disabled = false,
    autocomplete,
    inputmode,
    oninput,
  }: Props = $props()

  const hintId = $derived(hint ? `${id}-hint` : undefined)
  const errorId = $derived(error ? `${id}-error` : undefined)
  const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined)
</script>

<div class="field">
  <label class="field-label" for={id}>
    <span class="field-label-text">{label}</span>
  </label>
  <input
    class="field-input"
    {id}
    name={id}
    {type}
    value={value ?? ''}
    {placeholder}
    {required}
    {disabled}
    autocomplete={autocomplete as HTMLInputAttributes['autocomplete']}
    inputmode={inputmode as HTMLInputAttributes['inputmode']}
    aria-describedby={describedBy}
    aria-invalid={error ? 'true' : undefined}
    oninput={(event) => oninput?.(event.currentTarget.value)}
  />
  {#if hint}
    <p class="field-hint" id={hintId}>{hint}</p>
  {/if}
  {#if error}
    <p class="field-error" id={errorId} role="alert">{error}</p>
  {/if}
</div>
