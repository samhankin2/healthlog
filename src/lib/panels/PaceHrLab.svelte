<script lang="ts">
  import Icon from '../components/Icon.svelte'
  import SegmentedControl from '../components/SegmentedControl.svelte'
  import PaceTrend from '../viz/PaceTrend.svelte'
  import PaceScatter from '../viz/PaceScatter.svelte'
  import { fmtDayShort } from '../viz/scale'
  import { dayNum, fmtRace, fmtSigned, isNum, shiftDay } from '../insights'
  import { buildLab, paceAt, type Run } from '../paceHr'
  import type { InsightActivity } from '../types'

  interface Props { acts: InsightActivity[]; today: string; lthr?: number | null }
  let { acts, today, lthr = null }: Props = $props()

  const PREFS = 'healthlog.pacehr'
  const saved = (() => { try { return JSON.parse(localStorage.getItem(PREFS) ?? '{}') as { ref?: number; minKm?: number; treadmill?: boolean } } catch { return {} } })()
  let ref = $state(saved.ref ?? 150)
  let minKm = $state(saved.minKm ?? 0)
  let treadmill = $state(saved.treadmill ?? true)
  let zoom = $state<{ from: string; to: string; label: string } | null>(null)

  function persist(): void {
    localStorage.setItem(PREFS, JSON.stringify({ ref, minKm, treadmill }))
  }

  const allRuns = $derived(buildLab(acts, { minKm, treadmill }, ref, '0000-01-01', today).runs)
  const firstDay = $derived(allRuns[0]?.day ?? shiftDay(today, -365))
  const from = $derived(zoom?.from ?? firstDay)
  const to = $derived(zoom?.to ?? today)
  const lab = $derived(buildLab(acts, { minKm, treadmill }, ref, from, to))

  const REFS = $derived([130, 140, 150, 160, 170, ...(isNum(lthr) && ![130, 140, 150, 160, 170].includes(lthr) ? [lthr] : [])])
  const fmtDate = (d: string): string => `${fmtDayShort(d)} ’${d.slice(2, 4)}`
  const detail = (r: Run): string => `${(r.distanceM / 1000).toFixed(1)} km at ${fmtRace(r.paceS)} /km · ${Math.round(r.hr)} bpm${isNum(r.cadence) ? ` · ${Math.round(r.cadence)} spm` : ''}${r.treadmill ? ' · treadmill' : ''}`

  const presets = $derived.by(() => {
    const out: { from: string; to: string; label: string }[] = [
      { from: shiftDay(today, -89), to: today, label: 'Last 90 days' },
      { from: shiftDay(today, -364), to: today, label: 'Last year' },
    ]
    for (const b of lab.blocks.filter((x) => x.runs.length >= 4)) {
      out.push({ from: b.from, to: b.to, label: `Block ${fmtDate(b.from).replace(/^\d+ /, '')} – ${fmtDate(b.to).replace(/^\d+ /, '')} · ${b.runs.length} runs` })
    }
    return out
  })
  function zoomTo(a: string, b: string, label = `${fmtDate(a)} – ${fmtDate(b)}`): void {
    zoom = { from: a < firstDay ? firstDay : a, to: b > today ? today : b, label }
  }
  const earlierLabel = $derived(lab.earlier.length ? `${fmtDate(lab.earlier[0].day)} – ${fmtDate(lab.earlier[lab.earlier.length - 1].day)}` : '')
  const recentLabel = $derived(lab.recent.length ? `${fmtDate(lab.recent[0].day)} – ${fmtDate(lab.recent[lab.recent.length - 1].day)}` : '')
  const changeAtRef = $derived.by(() => {
    const e = lab.earlierFit ? paceAt(lab.earlierFit, ref) : null
    const r = lab.recentFit ? paceAt(lab.recentFit, ref) : null
    return isNum(e) && isNum(r) ? { e, r, pct: ((e - r) / e) * 100 } : null
  })
  const weeks = (d: number): string => (d >= 14 ? `${Math.round(d / 7)} weeks` : `${d} days`)
</script>

<div class="lab">
  <div class="controls">
    <div class="ctl">
      <span class="ctl-label">Reference heart rate</span>
      <SegmentedControl ariaLabel="Reference heart rate" options={REFS.map((h) => ({ value: String(h), label: h === lthr ? `${h} LT` : String(h) }))} value={String(ref)} onchange={(v) => { ref = Number(v); persist() }} />
    </div>
    <div class="ctl">
      <span class="ctl-label">Runs of at least</span>
      <SegmentedControl ariaLabel="Minimum run distance" options={[{ value: '0', label: 'Any' }, { value: '3', label: '3 km' }, { value: '5', label: '5 km' }, { value: '8', label: '8 km' }]} value={String(minKm)} onchange={(v) => { minKm = Number(v); persist() }} />
    </div>
    <label class="toggle"><input type="checkbox" bind:checked={treadmill} onchange={persist} /> Include treadmill</label>
  </div>

  <div class="zoom" role="group" aria-label="Zoom to a period">
    <button type="button" class:on={!zoom} onclick={() => (zoom = null)}>All time</button>
    {#each presets as p (p.label)}
      <button type="button" class:on={zoom?.label === p.label} onclick={() => zoomTo(p.from, p.to, p.label)}>{p.label}</button>
    {/each}
    {#if zoom && !presets.some((p) => p.label === zoom?.label)}
      <span class="zoom-custom"><Icon name="target" size={14} /> {zoom.label}<button type="button" aria-label="Reset zoom" onclick={() => (zoom = null)}><Icon name="x" size={14} /></button></span>
    {/if}
  </div>

  {#if lab.inWindow.length < 4}
    <p class="empty">Not enough runs with heart rate in this window ({lab.inWindow.length}). Widen the zoom or lower the distance filter.</p>
  {:else}
    <div class="stats">
      <div class="stat"><span>Pace at {ref} bpm {zoom ? 'at end of window' : 'now'}</span><b>{fmtRace(lab.nowPace)}<small> /km</small></b><em>median of the last 4 weeks of the window</em></div>
      <div class="stat"><span>Best 4-week stretch</span><b>{lab.bestPace ? fmtRace(lab.bestPace.value) : '—'}<small> /km</small></b><em>{lab.bestPace ? `around ${fmtDate(lab.bestPace.day)}` : ''}</em></div>
      <div class="stat"><span>Across this window</span><b class:good={(lab.startPace ?? 0) > (lab.nowPace ?? 0)} class:bad={(lab.startPace ?? 0) < (lab.nowPace ?? 0)}>{isNum(lab.startPace) && isNum(lab.nowPace) ? `${lab.nowPace < lab.startPace ? '−' : '+'}${fmtRace(Math.abs(lab.nowPace - lab.startPace))}` : '—'}<small> /km</small></b><em>{isNum(lab.startPace) ? `from ${fmtRace(lab.startPace)}` : ''}</em></div>
      <div class="stat"><span>Metres per heartbeat</span><b>{isNum(lab.effNow) ? lab.effNow.toFixed(2) : '—'}</b><em>{isNum(lab.effStart) && isNum(lab.effNow) ? `${fmtSigned(((lab.effNow - lab.effStart) / lab.effStart) * 100, 1)}% vs start · 1 bpm ≈ ${lab.slopeSecPerBpm?.toFixed(1)} s/km` : ''}</em></div>
    </div>

    <article class="card">
      <div class="head">
        <h3>Pace at {ref} bpm, every run</h3>
        <p>Drag across the chart to zoom. Grey bands are breaks of 2+ weeks.</p>
      </div>
      <PaceTrend label="Pace normalised to {ref} bpm" points={lab.trend.map((t) => ({ day: t.day, adj: t.adj, roll: t.roll, detail: detail(t.run), seg: t.seg, inBreak: t.inBreak }))} breaks={lab.breaks} {from} {to} onzoom={(a, b) => zoomTo(a, b)} />
      <ul class="legend"><li><i class="dot"></i>One run, adjusted to {ref} bpm</li><li><i class="line"></i>4-week rolling median (restarts after each break)</li><li><i class="dot lone"></i>One-off run during a break</li></ul>
    </article>

    <div class="grid">
      <article class="card">
        <div class="head">
          <h3>The whole curve: pace against heart rate</h3>
          <p>Each dot is a run at its real pace and heart rate. Lines are fitted for the earlier and later half of the window.</p>
        </div>
        <PaceScatter label="Pace against heart rate" refHr={ref} groups={[
          { label: `Earlier (${earlierLabel})`, color: 'var(--color-border-strong)', dots: lab.earlier.map((r) => ({ hr: r.hr, paceS: r.paceS, day: r.day, detail: detail(r) })), line: lab.earlierFit ? (hr) => paceAt(lab.earlierFit!, hr) : null },
          { label: `Recent (${recentLabel})`, color: 'var(--viz-run)', dots: lab.recent.map((r) => ({ hr: r.hr, paceS: r.paceS, day: r.day, detail: detail(r) })), line: lab.recentFit ? (hr) => paceAt(lab.recentFit!, hr) : null },
        ]} />
        <ul class="legend"><li><i class="dot grey"></i>Earlier · {earlierLabel}</li><li><i class="dot"></i>Recent · {recentLabel}</li><li><i class="vline"></i>{ref} bpm</li></ul>
        {#if changeAtRef}
          <p class="callout" class:good={changeAtRef.pct > 0}>At {ref} bpm you went from <b>{fmtRace(changeAtRef.e)}</b> to <b>{fmtRace(changeAtRef.r)} /km</b>: {Math.abs(changeAtRef.pct).toFixed(1)}% {changeAtRef.pct > 0 ? 'faster' : 'slower'} for the same effort.</p>
        {/if}
      </article>
      <article class="card">
        <div class="head"><h3>Pace at each heart rate</h3><p>From the fitted lines. Rows outside the heart rates you actually ran at are left out.</p></div>
        <table class="tbl">
          <thead><tr><th scope="col">Heart rate</th><th scope="col" class="num">Earlier</th><th scope="col" class="num">Recent</th><th scope="col" class="num">Change</th></tr></thead>
          <tbody>
            {#each lab.table as row (row.hr)}
              <tr class:refrow={row.hr === ref}>
                <th scope="row">{row.hr} bpm</th>
                <td class="num">{fmtRace(row.earlier)}</td>
                <td class="num">{fmtRace(row.recent)}</td>
                <td class="num" class:good={(row.changePct ?? 0) > 0.5} class:bad={(row.changePct ?? 0) < -0.5}>{isNum(row.changePct) ? `${row.changePct > 0 ? '▲' : '▼'} ${Math.abs(row.changePct).toFixed(1)}%` : '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
        <p class="note">▲ = faster at that heart rate. Fit quality r = {isNum(lab.global?.r) ? lab.global!.r!.toFixed(2) : '—'} across {lab.runs.length} runs (1 = perfect).</p>
      </article>
    </div>

    <article class="card">
      <div class="head"><h3>Breaks and comebacks</h3><p>Pace at {ref} bpm in the 6 weeks before each 2+ week break, the first runs back, and how long until you matched it again. Tap one to zoom in.</p></div>
      {#if lab.breaks.length}
        <ul class="breaks">
          {#each lab.breaks as b (b.from)}
            <li>
              <button type="button" onclick={() => zoomTo(shiftDay(b.from, -45), dayNum(shiftDay(b.to, 90)) > dayNum(today) ? today : shiftDay(b.to, 90), `Around the ${weeks(b.days)} break`)}>
                <span class="b-when"><b>{weeks(b.days)} off</b>{fmtDate(b.from)} → {fmtDate(b.to)}</span>
                <span class="b-pace">{fmtRace(b.before)} <Icon name="chevron-right" size={14} /> {fmtRace(b.after)}<small> /km</small></span>
                <span class="b-loss" class:bad={(b.lossPct ?? 0) > 1} class:good={(b.lossPct ?? 0) < -1}>{isNum(b.lossPct) ? (b.lossPct > 1 ? `${b.lossPct.toFixed(1)}% slower` : b.lossPct < -1 ? `${Math.abs(b.lossPct).toFixed(1)}% faster` : 'no loss') : '—'}</span>
                <span class="b-back">{b.backAfterDays === 0 ? 'Straight back to form' : isNum(b.backAfterDays) ? `Back to form in ${weeks(b.backAfterDays)} (${b.backRuns} runs)` : b.ongoing ? 'Not back to pre-break pace yet' : 'Never fully regained before the next break'}</span>
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">No breaks of 2+ weeks in this window.</p>
      {/if}
    </article>
  {/if}
</div>

<style>
  .lab { display: flex; flex-direction: column; gap: var(--space-4); }
  .controls { display: flex; align-items: flex-end; gap: var(--space-3) var(--space-5); flex-wrap: wrap; }
  .ctl { display: flex; min-width: min(100%, 16rem); flex-direction: column; gap: 4px; }
  .ctl-label { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .toggle { display: inline-flex; min-height: var(--touch-target); align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
  .toggle input { width: 1.1rem; height: 1.1rem; accent-color: var(--color-accent); }
  .zoom { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .zoom button { min-height: 2.25rem; padding: 0 var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-pill); background: var(--color-surface); color: var(--color-text); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .zoom button.on { border-color: var(--color-accent); background: var(--color-accent-soft); color: var(--color-accent); }
  .zoom-custom { display: inline-flex; min-height: 2.25rem; padding: 0 var(--space-1) 0 var(--space-3); align-items: center; gap: var(--space-2); border-radius: var(--radius-pill); background: var(--color-accent); color: var(--color-on-accent); font-size: var(--text-xs); font-weight: var(--weight-semibold); }
  .zoom-custom button { display: grid; min-height: 1.75rem; width: 1.75rem; padding: 0; place-items: center; border: 0; background: color-mix(in oklab, var(--color-on-accent) 20%, transparent); color: inherit; }
  .empty { margin: 0; color: var(--color-text-muted); font-size: var(--text-sm); }
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); }
  .stat { display: flex; min-width: 0; padding: var(--space-4); flex-direction: column; gap: 2px; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); }
  .stat span { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .stat b { font-size: var(--text-2xl); font-weight: var(--weight-bold); letter-spacing: -0.03em; font-variant-numeric: tabular-nums; }
  .stat b small { color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); letter-spacing: 0; }
  .stat em { color: var(--color-text-muted); font-size: var(--text-xs); font-style: normal; }
  .good { color: var(--color-up); }
  .bad { color: var(--color-down); }
  .card { min-width: 0; padding: var(--space-5); border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); box-shadow: var(--shadow-card); }
  .head { margin-bottom: var(--space-3); }
  .head h3 { margin: 0; font-size: var(--text-md); }
  .head p { margin: 2px 0 0; color: var(--color-text-muted); font-size: var(--text-xs); }
  .grid { display: grid; gap: var(--space-4); align-items: start; }
  .grid > * { min-width: 0; }
  .legend { display: flex; margin: var(--space-2) 0 0; padding: 0; flex-wrap: wrap; gap: var(--space-1) var(--space-4); list-style: none; color: var(--color-text-muted); font-size: var(--text-xs); }
  .legend li { display: inline-flex; align-items: center; gap: 6px; }
  .legend .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--viz-run); }
  .legend .dot.grey { background: var(--color-border-strong); }
  .legend .dot.lone { background: var(--color-surface); box-shadow: inset 0 0 0 1.5px color-mix(in oklab, var(--viz-run) 55%, var(--color-surface)); }
  .legend .line { width: 14px; height: 3px; border-radius: 2px; background: var(--viz-run); }
  .legend .vline { width: 1px; height: 12px; background: var(--color-text-muted); }
  .callout { margin: var(--space-3) 0 0; padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--color-surface-sunken); font-size: var(--text-sm); }
  .callout.good { background: var(--color-up-soft); color: var(--color-text); }
  .tbl { width: 100%; border-collapse: collapse; font-size: var(--text-sm); font-variant-numeric: tabular-nums; }
  .tbl th, .tbl td { padding: var(--space-2); border-top: 1px solid var(--color-border); text-align: left; }
  .tbl thead th { border-top: 0; color: var(--color-text-muted); font-size: var(--text-xs); font-weight: var(--weight-medium); }
  .tbl .num { text-align: right; }
  .tbl tbody th { font-weight: var(--weight-medium); }
  .tbl tr.refrow { background: var(--color-accent-soft); }
  .tbl tr.refrow th { font-weight: var(--weight-bold); }
  .note { margin: var(--space-2) 0 0; color: var(--color-text-muted); font-size: var(--text-xs); }
  .breaks { display: grid; margin: 0; padding: 0; gap: var(--space-2); list-style: none; }
  .breaks button { display: grid; width: 100%; padding: var(--space-3) var(--space-4); align-items: center; grid-template-columns: minmax(10rem, 1.2fr) minmax(8rem, 1fr) minmax(6rem, 0.8fr) minmax(10rem, 1.4fr); gap: var(--space-2) var(--space-4); border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); color: var(--color-text); font-size: var(--text-sm); text-align: left; }
  .breaks button:hover { border-color: var(--color-accent); }
  .b-when { display: flex; flex-direction: column; color: var(--color-text-muted); font-size: var(--text-xs); }
  .b-when b { color: var(--color-text); font-size: var(--text-sm); }
  .b-pace { display: inline-flex; align-items: center; gap: 4px; font-weight: var(--weight-semibold); font-variant-numeric: tabular-nums; }
  .b-pace small { color: var(--color-text-muted); font-weight: var(--weight-regular); }
  .b-loss { font-weight: var(--weight-semibold); }
  .b-back { color: var(--color-text-muted); font-size: var(--text-xs); }
  @media (min-width: 43.75rem) { .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @media (min-width: 62rem) { .grid { grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); } }
  @media (max-width: 40rem) { .breaks button { grid-template-columns: 1fr 1fr; } }
</style>
