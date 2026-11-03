<script lang="ts" module>
  import type { IntakeChartSpec } from './IntakeHistoryChart.svelte'

  export type CarouselSlide = IntakeChartSpec & { average: number | null }
</script>

<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import IntakeHistoryChart from './IntakeHistoryChart.svelte'
  import { fmtNumber } from '../format'
  import type { DayString, IntakeHistoryDay } from '../types'

  interface Props { days: IntakeHistoryDay[]; slides: CarouselSlide[]; todayDay: DayString }
  let { days, slides, todayDay }: Props = $props()

  let active = $state(0)
  let track: HTMLDivElement | undefined = $state()
  let tabs: HTMLButtonElement[] = $state([])
  let current = $derived(slides[active] ?? slides[0])
  const uid = `intake-carousel-${Math.random().toString(36).slice(2, 8)}`

  function reducedMotion(): boolean {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  function go(index: number, focusTab = false): void {
    const next = (index + slides.length) % slides.length
    active = next
    track?.scrollTo({ left: next * track.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' })
    if (focusTab) tabs[next]?.focus()
  }

  // Swiping moves the track; follow it so the tabs stay in step.
  function onScroll(): void {
    if (!track || track.clientWidth === 0) return
    const index = Math.round(track.scrollLeft / track.clientWidth)
    if (index !== active && index >= 0 && index < slides.length) active = index
  }

  // A resize changes the slide width but not scrollLeft, which would leave the
  // track between two slides. Re-align to the active one without animating.
  $effect(() => {
    if (!track) return
    const el = track
    const observer = new ResizeObserver(() => {
      el.scrollTo({ left: active * el.clientWidth, behavior: 'instant' })
    })
    observer.observe(el)
    return () => observer.disconnect()
  })

  function onTabKey(event: KeyboardEvent): void {
    const moves: Record<string, number> = { ArrowRight: active + 1, ArrowLeft: active - 1, Home: 0, End: slides.length - 1 }
    if (!(event.key in moves)) return
    event.preventDefault()
    go(moves[event.key]!, true)
  }

  function summaryLine(slide: CarouselSlide): string {
    const unit = slide.unit === 'kcal' ? 'kcal/day' : 'g/day'
    const avg = slide.average === null ? 'No completed days yet' : `Average ${fmtNumber(slide.average, 0)} ${unit}`
    return slide.target ? `${avg} · target ${fmtNumber(slide.target, 0)} ${slide.unit}` : avg
  }
</script>

<div class="intake-carousel">
  <div class="carousel-controls">
    <button class="icon-button carousel-arrow" type="button" aria-label="Previous chart" onclick={() => go(active - 1)}><Icon name="chevron-left" size={20} /></button>
    <div class="carousel-tabs" role="tablist" aria-label="Intake charts">
      {#each slides as slide, index (slide.metric)}
        <button
          bind:this={tabs[index]}
          class="carousel-tab"
          type="button"
          role="tab"
          id={`${uid}-tab-${index}`}
          aria-controls={`${uid}-panel-${index}`}
          aria-selected={index === active}
          tabindex={index === active ? 0 : -1}
          onclick={() => go(index)}
          onkeydown={onTabKey}
        >
          <span class="tab-dot" style:background-color={`var(${slide.colorVar})`} aria-hidden="true"></span>{slide.label}
        </button>
      {/each}
    </div>
    <button class="icon-button carousel-arrow" type="button" aria-label="Next chart" onclick={() => go(active + 1)}><Icon name="chevron-right" size={20} /></button>
  </div>

  <div class="carousel-track" bind:this={track} onscroll={onScroll}>
    {#each slides as slide, index (slide.metric)}
      <div
        class="carousel-slide"
        role="tabpanel"
        id={`${uid}-panel-${index}`}
        aria-labelledby={`${uid}-tab-${index}`}
        inert={index !== active}
      >
        <p class="slide-summary">{summaryLine(slide)}</p>
        <IntakeHistoryChart {days} spec={slide} {todayDay} />
      </div>
    {/each}
  </div>

  <ul class="chart-legend" aria-label="Chart legend">
    <li><span class="legend-bar" style:background-color={`var(${current.colorVar})`} aria-hidden="true"></span>Daily {current.label.toLowerCase()}</li>
    <li><span class="legend-bar legend-bar--today" style:border-color={`var(${current.colorVar})`} style:background-color={`var(${current.softVar})`} aria-hidden="true"></span>Today (in progress)</li>
    <li><span class="legend-line" aria-hidden="true"></span>7-day average</li>
    {#if current.target}<li><span class="legend-target" aria-hidden="true"></span>Target</li>{/if}
  </ul>
</div>

<style>
  .intake-carousel { min-width: 0; }
  .carousel-controls { display: flex; margin-bottom: var(--space-3); align-items: center; gap: var(--space-2); }
  .carousel-arrow { display: none; flex: 0 0 auto; }
  .carousel-tabs {
    display: grid;
    min-width: 0;
    flex: 1;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--space-1);
    padding: var(--space-1);
    border-radius: var(--radius-pill);
    background: var(--color-surface-sunken);
  }
  .carousel-tab {
    display: inline-flex;
    min-width: 0;
    min-height: var(--touch-target);
    padding: 0 var(--space-2);
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    color: var(--color-text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }
  .carousel-tab[aria-selected='true'] {
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
    color: var(--color-text);
    font-weight: var(--weight-semibold);
  }
  .tab-dot { width: 0.55rem; height: 0.55rem; flex: 0 0 auto; border-radius: 50%; }

  .carousel-track {
    display: flex;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .carousel-track::-webkit-scrollbar { display: none; }
  .carousel-slide { min-width: 0; flex: 0 0 100%; scroll-snap-align: start; scroll-snap-stop: always; }
  .slide-summary { margin: 0 0 var(--space-3); color: var(--color-text-muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums; text-align: center; }

  .chart-legend { display: flex; margin: var(--space-3) 0 0; padding: 0; flex-wrap: wrap; justify-content: center; gap: var(--space-4); color: var(--color-text-muted); font-size: var(--text-xs); list-style: none; }
  .chart-legend li { display: flex; align-items: center; gap: var(--space-2); }
  .legend-bar { width: 0.7rem; height: 0.8rem; border-radius: 2px; }
  .legend-bar--today { border: 1.5px solid; }
  .legend-line { width: 1.25rem; height: 2px; border-radius: 2px; background: var(--color-text); }
  .legend-target { width: 1.25rem; height: 0; border-top: 2px dashed var(--color-text-muted); }

  @media (max-width: 24rem) {
    .tab-dot { display: none; }
    .carousel-tab { padding: 0 var(--space-1); }
  }
  @media (min-width: 43.75rem) {
    .carousel-arrow { display: inline-flex; }
  }
  @media (prefers-reduced-motion: no-preference) {
    .carousel-track { scroll-behavior: smooth; }
  }
</style>
