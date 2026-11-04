<script lang="ts">
  import { onDestroy } from 'svelte'
  import Icon from '../components/Icon.svelte'
  import { REST_PRESETS, adjustRest, lift, setRestPreset, startRest, stopRest } from '../lifting.svelte'

  let now = $state(Date.now())
  let doneAt = $state(0)
  let alerted = 0
  const tick = window.setInterval(() => {
    now = Date.now()
    const ends = lift.rest.endsAt
    if (ends && now >= ends && alerted !== ends) {
      alerted = ends
      doneAt = now
      stopRest()
      alertDone()
    }
  }, 250)
  onDestroy(() => window.clearInterval(tick))

  const left = $derived(lift.rest.endsAt ? Math.max(0, Math.ceil((lift.rest.endsAt - now) / 1000)) : 0)
  const running = $derived(lift.rest.endsAt > 0)
  const showDone = $derived(!running && doneAt > 0 && now - doneAt < 5000)
  const pct = $derived(running && lift.rest.total ? Math.min(100, (left / lift.rest.total) * 100) : 0)
  const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  let audio: AudioContext | null = null
  function alertDone(): void {
    try { navigator.vibrate?.([220, 120, 220]) } catch { /* unsupported */ }
    try {
      audio ??= new AudioContext()
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, audio.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.45)
      osc.connect(gain).connect(audio.destination)
      osc.start()
      osc.stop(audio.currentTime + 0.5)
    } catch { /* audio blocked: the vibration and the banner remain */ }
  }
</script>

{#if running || showDone}
  <div class="rest" class:done={showDone} role="timer" aria-live="off">
    <div class="rest-bar" aria-hidden="true"><span style:width="{pct}%"></span></div>
    <div class="rest-row">
      <span class="rest-copy">
        <Icon name="timer" size={18} />
        {#if running}
          <span class="rest-label">Rest</span><b class="rest-clock">{clock(left)}</b>
        {:else}
          <b role="status">Rest over — next set</b>
        {/if}
      </span>
      {#if running}
        <button class="rest-btn" type="button" aria-label="15 seconds less rest" onclick={() => adjustRest(-15)}>−15</button>
        <button class="rest-btn" type="button" aria-label="15 seconds more rest" onclick={() => adjustRest(15)}>+15</button>
        <button class="rest-btn skip" type="button" onclick={() => { stopRest(); doneAt = 0 }}>Skip</button>
      {:else}
        <button class="rest-btn" type="button" onclick={() => { doneAt = 0; startRest() }}>Again</button>
      {/if}
    </div>
    <label class="rest-preset">
      <span>Default rest</span>
      <select value={String(lift.rest.preset)} onchange={(e) => setRestPreset(Number((e.currentTarget as HTMLSelectElement).value))}>
        {#each REST_PRESETS as p (p)}<option value={String(p)}>{clock(p)}</option>{/each}
      </select>
    </label>
  </div>
{/if}

<style>
  .rest { position: fixed; z-index: var(--z-fab); right: var(--space-3); bottom: calc(var(--tab-bar-height) + var(--safe-bottom) + var(--space-2)); left: var(--space-3); display: grid; padding: var(--space-2) var(--space-3) var(--space-2); gap: var(--space-1); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: color-mix(in srgb, var(--color-surface) 96%, transparent); box-shadow: var(--shadow-raised); backdrop-filter: blur(14px); overflow: hidden; }
  .rest.done { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .rest-bar { position: absolute; top: 0; right: 0; left: 0; height: 4px; background: var(--color-surface-sunken); }
  .rest-bar span { display: block; height: 100%; background: var(--color-accent); transition: width 250ms linear; }
  .rest-row { display: flex; align-items: center; gap: var(--space-2); }
  .rest-copy { display: inline-flex; min-width: 0; flex: 1; align-items: center; gap: var(--space-2); color: var(--color-text); }
  .rest-label { color: var(--color-text-muted); font-size: var(--text-sm); }
  .rest-clock { font-size: 1.6rem; font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
  .rest-btn { min-width: 3rem; min-height: var(--touch-target); padding: 0 var(--space-3); border: 1px solid var(--color-border-strong); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-text); font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; touch-action: manipulation; }
  .rest-btn.skip { border-color: transparent; background: var(--color-accent); color: var(--color-on-accent); }
  .rest-preset { display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2); color: var(--color-text-muted); font-size: var(--text-xs); }
  .rest-preset select { min-height: 2.75rem; padding: 0 var(--space-2); border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-surface); color: var(--color-text); font-size: var(--text-sm); }
  @media (min-width: 56.25rem) {
    .rest { right: var(--space-6); bottom: var(--space-6); left: auto; width: 24rem; }
  }
  @media (prefers-reduced-motion: reduce) { .rest-bar span { transition: none; } }
</style>
