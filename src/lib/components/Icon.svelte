<script lang="ts">
  import { icons, type IconName } from '../icons'

  interface Props {
    name: IconName
    size?: number
    /** When omitted the icon is decorative and hidden from assistive tech. */
    label?: string
  }

  let { name, size = 20, label }: Props = $props()
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  role={label ? 'img' : undefined}
  aria-label={label}
  aria-hidden={label ? undefined : 'true'}
>
  {#each icons[name] as d (d)}
    <path {d} />
  {/each}
</svg>
