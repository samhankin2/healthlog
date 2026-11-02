<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { IconName } from '../icons'
  import Icon from './Icon.svelte'

  interface Props {
    icon?: IconName
    title: string
    message?: string
    children?: Snippet
  }

  let { icon, title, message, children }: Props = $props()
</script>

<section class="empty-state">
  {#if icon}
    <div class="empty-state-icon"><Icon name={icon} size={28} /></div>
  {/if}
  <h2 class="empty-state-title">{title}</h2>
  {#if message}<p class="empty-state-message">{message}</p>{/if}
  {@render children?.()}
</section>
