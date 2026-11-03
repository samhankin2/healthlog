<script lang="ts">
  interface Props {
    /** 0..100 */
    value: number
    size?: number
    stroke?: number
    label: string
    caption?: string
  }
  let { value, size = 168, stroke = 12, label, caption }: Props = $props()

  const r = $derived((size - stroke) / 2)
  const c = $derived(2 * Math.PI * r)
  // 300° arc with the gap at the bottom, like a gauge.
  const ARC = 300 / 360
  const track = $derived(c * ARC)
  const filled = $derived(track * Math.max(0, Math.min(100, value)) / 100)
</script>

<div class="ring" style:width="{size}px" style:height="{size}px">
  <svg width={size} height={size} viewBox="0 0 {size} {size}" role="img" aria-label="{label}: {value} out of 100{caption ? `, ${caption}` : ''}">
    <defs>
      <linearGradient id="ring-grad" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" style="stop-color: color-mix(in oklab, var(--color-accent) 50%, var(--color-surface))" />
        <stop offset="100%" style="stop-color: var(--color-accent)" />
      </linearGradient>
    </defs>
    <g transform="rotate(120 {size / 2} {size / 2})">
      <circle cx={size / 2} cy={size / 2} {r} fill="none" stroke="var(--color-surface-sunken)" stroke-width={stroke} stroke-linecap="round" stroke-dasharray="{track} {c}" />
      <circle class="fill" cx={size / 2} cy={size / 2} {r} fill="none" stroke="url(#ring-grad)" stroke-width={stroke} stroke-linecap="round" stroke-dasharray="{filled} {c}" />
    </g>
  </svg>
  <div class="center" aria-hidden="true">
    <span class="value">{value}</span>
    {#if caption}<span class="caption">{caption}</span>{/if}
  </div>
</div>

<style>
  .ring { position: relative; flex: 0 0 auto; }
  svg { display: block; }
  .fill { transition: stroke-dasharray 700ms var(--ease-enter); }
  .center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; }
  .value { font-size: clamp(2.75rem, 9vw, 3.5rem); font-weight: var(--weight-bold); letter-spacing: -0.05em; line-height: 1; }
  .caption { margin-top: 0.3rem; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  @media (prefers-reduced-motion: reduce) { .fill { transition: none; } }
</style>
