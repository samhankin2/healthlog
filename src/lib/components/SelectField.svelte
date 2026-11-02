<script lang="ts">
  interface Props {
    id: string
    label: string
    value: string
    options: { value: string; label: string }[]
    hint?: string
    error?: string
    disabled?: boolean
    onchange?: (value: string) => void
  }

  let {
    id,
    label,
    value,
    options,
    hint,
    error,
    disabled = false,
    onchange,
  }: Props = $props()

  const hintId = $derived(hint ? `${id}-hint` : undefined)
  const errorId = $derived(error ? `${id}-error` : undefined)
  const describedBy = $derived([hintId, errorId].filter(Boolean).join(' ') || undefined)
</script>

<div class="field">
  <label class="field-label" for={id}>
    <span class="field-label-text">{label}</span>
  </label>
  <select
    class="field-input field-select"
    {id}
    name={id}
    {value}
    {disabled}
    aria-describedby={describedBy}
    aria-invalid={error ? 'true' : undefined}
    onchange={(event) => onchange?.(event.currentTarget.value)}
  >
    {#each options as option (option.value)}
      <option value={option.value}>{option.label}</option>
    {/each}
  </select>
  {#if hint}
    <p class="field-hint" id={hintId}>{hint}</p>
  {/if}
  {#if error}
    <p class="field-error" id={errorId} role="alert">{error}</p>
  {/if}
</div>
