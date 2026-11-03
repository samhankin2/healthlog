<script lang="ts">
  import { tick } from 'svelte'
  import { prefersReducedMotion } from 'svelte/motion'
  import { actions, app } from '../lib/state.svelte'
  import { fmtTime, today } from '../lib/format'
  import type { Analysis, ChatMessage, Meal, MealInput } from '../lib/types'
  import { showToast } from '../lib/toast.svelte'
  import Button from '../lib/components/Button.svelte'
  import EmptyState from '../lib/components/EmptyState.svelte'
  import Icon from '../lib/components/Icon.svelte'
  import AssistantMessage from '../lib/chat/AssistantMessage.svelte'
  import MealEditor from '../lib/chat/MealEditor.svelte'

  interface PendingRequest {
    text: string
    clientId: string
    save: boolean
    clearDraft: boolean
    createdAt: number
    reviseAnalysisId?: string
  }

  interface Revising {
    analysisId: string
    label: string
  }

  interface EditingMeal {
    message: ChatMessage
    analysis: Analysis
    meal: Meal | null
    prompt: string
  }

  const QUICK_PHRASES = ['2 eggs on toast', 'chicken salad', 'a coffee and a pastry']

  let draft = $state('')
  let sending = $state(false)
  let sendError = $state('')
  let pending = $state<PendingRequest | null>(null)
  let analyses = $state<Record<string, Analysis>>({})
  let editing = $state<EditingMeal | null>(null)
  let revising = $state<Revising | null>(null)
  let mealActionBusy = $state<string | null>(null)
  let chatScroll: HTMLElement | undefined = $state()
  let composerInput: HTMLTextAreaElement | undefined = $state()
  let stickToBottom = $state(true)
  const requestedAnalyses = new Set<string>()

  function resizeComposer(): void {
    if (!composerInput) return
    composerInput.style.height = 'auto'
    composerInput.style.height = `${Math.min(composerInput.scrollHeight, 160)}px`
  }

  function onScroll(): void {
    if (!chatScroll) return
    const distance = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight
    stickToBottom = distance < 80
  }

  async function loadMissingAnalyses(messages: ChatMessage[]): Promise<void> {
    for (const message of messages) {
      const id = message.analysisId
      if (!id || analyses[id] || requestedAnalyses.has(id)) continue
      requestedAnalyses.add(id)
      try {
        analyses[id] = await actions.loadAnalysis(id)
      } catch {
        // The server-provided plain-text reply remains visible if the detailed
        // analysis cannot be loaded. A later message refresh can retry it.
        requestedAnalyses.delete(id)
      }
    }
  }

  function promptFor(message: ChatMessage): string {
    const index = app.messages.findIndex((candidate) => candidate.id === message.id)
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = app.messages[cursor]
      if (candidate?.role === 'user') return candidate.content
    }
    return 'Please estimate this meal again.'
  }

  function mealFor(message: ChatMessage, analysis: Analysis): Meal | null {
    if (message.mealId) {
      const direct = app.meals.find((meal) => meal.id === message.mealId)
      if (direct) return direct
    }
    return app.meals.find((meal) => meal.analysisId === analysis.id) ?? null
  }

  async function runRequest(request: PendingRequest): Promise<void> {
    if (sending) return
    sending = true
    pending = request
    sendError = ''
    try {
      const response = await actions.sendChat({
        message: request.text,
        day: today(),
        save: request.save,
        clientId: request.clientId,
        ...(request.reviseAnalysisId ? { reviseAnalysisId: request.reviseAnalysisId } : {}),
      })
      if (response.analysis) analyses[response.analysis.id] = response.analysis
      pending = null
      if (request.clearDraft && draft.trim() === request.text.trim()) draft = ''
      await tick()
      resizeComposer()
    } catch (cause: unknown) {
      sendError = cause instanceof Error ? cause.message : 'Could not analyse that meal. Please try again.'
    } finally {
      sending = false
    }
  }

  function submitDraft(): void {
    const text = draft.trim()
    if (!text || sending) return
    // Nothing is saved until the user presses "Save meal", so an estimate can be
    // corrected first.
    const target = revising
    revising = null
    void runRequest({
      text,
      clientId: crypto.randomUUID(),
      save: false,
      clearDraft: true,
      createdAt: Date.now(),
      ...(target ? { reviseAnalysisId: target.analysisId } : {}),
    })
  }

  async function startCorrecting(analysis: Analysis): Promise<void> {
    if (sending) return
    const names = (analysis.reconciled?.meals?.length ? analysis.reconciled.meals.map((m) => m.name ?? m.items[0]?.name) : [analysis.reconciled?.items[0]?.name])
      .filter(Boolean)
      .join(', ')
    revising = { analysisId: analysis.id, label: names || 'this estimate' }
    sendError = ''
    await tick()
    composerInput?.focus()
  }

  function onComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    event.preventDefault()
    submitDraft()
  }

  async function usePhrase(phrase: string): Promise<void> {
    if (sending) return
    draft = phrase
    sendError = ''
    await tick()
    resizeComposer()
    composerInput?.focus()
  }

  function askAgain(prompt: string): void {
    if (sending) return
    void runRequest({
      text: prompt,
      clientId: crypto.randomUUID(),
      save: false,
      clearDraft: false,
      createdAt: Date.now(),
    })
  }

  async function saveMeal(message: ChatMessage, analysis: Analysis, prompt: string): Promise<void> {
    if (!analysis.reconciled || mealActionBusy) return
    mealActionBusy = message.id
    try {
      const groups = analysis.reconciled.meals?.length
        ? analysis.reconciled.meals
        : [{ name: null, items: analysis.reconciled.items, total: analysis.reconciled.total }]
      const baseTime = Date.now()
      for (const [index, group] of groups.entries()) {
        const input: MealInput = {
          name: group.name || group.items.slice(0, 3).map((item) => item.name).join(', ') || prompt,
          description: prompt,
          day: today(),
          eatenAt: new Date(baseTime + index).toISOString(),
          kcal: group.total.kcal,
          proteinG: group.total.protein_g,
          carbsG: group.total.carbs_g,
          fatG: group.total.fat_g,
          source: 'ai',
          analysisId: analysis.id,
          items: group.items.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            kcal: item.kcal,
            proteinG: item.protein_g,
            carbsG: item.carbs_g,
            fatG: item.fat_g,
          })),
        }
        await actions.createMeal(input)
      }
      showToast(groups.length > 1 ? `${groups.length} meals saved` : 'Meal saved', 'success')
      void actions.loadDashboard().catch(() => {})
    } catch (cause: unknown) {
      showToast(cause instanceof Error ? cause.message : 'Could not save the meal.', 'error')
    } finally {
      mealActionBusy = null
    }
  }

  function onMealSaved(): void {
    void actions.loadDashboard().catch(() => {})
  }

  $effect(() => {
    void loadMissingAnalyses(app.messages)
  })

  $effect(() => {
    const messageCount = app.messages.length
    const analysisCount = Object.keys(analyses).length
    const waiting = sending
    const failed = sendError
    if (!stickToBottom || !chatScroll) return
    void messageCount
    void analysisCount
    void waiting
    void failed
    const frame = window.requestAnimationFrame(() => {
      chatScroll?.scrollTo({
        top: chatScroll.scrollHeight,
        behavior: prefersReducedMotion.current ? 'auto' : 'smooth',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  })
</script>

<section class="view view--chat" aria-labelledby="chat-title">
  <header class="view-header">
    <h1 class="view-title" id="chat-title">Your food journal</h1>
    <p class="view-subtitle">Describe a meal in your own words. HealthLog will help with the numbers.</p>
  </header>

  <div class="chat-scroll" bind:this={chatScroll} onscroll={onScroll}>
    {#if app.messages.length === 0 && !pending}
      <EmptyState
        icon="chat"
        title="What did you eat?"
        message="A simple description is enough. Add rough portions when you can for a more useful estimate."
      >
        <div class="quick-phrases" aria-label="Suggested food descriptions">
          {#each QUICK_PHRASES as phrase (phrase)}
            <button class="chip" type="button" disabled={sending} onclick={() => usePhrase(phrase)}>{phrase}</button>
          {/each}
        </div>
      </EmptyState>
    {/if}

    <ol class="message-list">
      {#each app.messages as message (message.id)}
        <li class="message message--{message.role}">
          {#if message.role === 'user'}
            <div class="message-bubble">{message.content}</div>
          {:else if message.analysisId && analyses[message.analysisId]}
            {@const analysis = analyses[message.analysisId]}
            {@const meal = mealFor(message, analysis)}
            {@const prompt = promptFor(message)}
            <AssistantMessage
              {message}
              {analysis}
              saved={meal !== null}
              busy={sending || mealActionBusy === message.id}
              onsave={() => saveMeal(message, analysis, prompt)}
              onedit={() => (editing = { message, analysis, meal, prompt })}
              onaskagain={() => askAgain(prompt)}
              oncorrect={() => startCorrecting(analysis)}
            />
          {:else}
            <div class="message-bubble">{message.content}</div>
          {/if}
          <time class="message-time">{fmtTime(message.createdAt)}</time>
        </li>
      {/each}

      {#if pending}
        <li class="message message--user">
          <div class="message-bubble">{pending.text}</div>
          <time class="message-time">{fmtTime(pending.createdAt)}</time>
        </li>
      {/if}

      {#if sending}
        <li class="message message--assistant">
          <div class="message-bubble thinking" role="status" aria-live="polite">
            <span class="spinner" aria-hidden="true"></span>
            <span>
              <strong>Asking two models…</strong>
              <small>Comparing their estimates can take up to a minute.</small>
            </span>
          </div>
        </li>
      {:else if sendError && pending}
        <li class="message message--assistant">
          <div class="message-bubble send-error" role="alert">
            <p>{sendError}</p>
            <Button variant="secondary" onclick={() => runRequest(pending!)}>
              Try again with the same request
            </Button>
          </div>
        </li>
      {/if}
    </ol>
  </div>

  <div class="chat-composer-dock">
    <form
      class="composer"
      aria-busy={sending}
      onsubmit={(event) => { event.preventDefault(); submitDraft() }}
    >
      {#if revising}
        <div class="revising-banner" role="status">
          <span>Correcting: <strong>{revising.label}</strong> — say what's off, e.g. "the rice is 1/3 cup raw, about 250 kcal"</span>
          <button class="revising-cancel" type="button" onclick={() => (revising = null)}>Cancel</button>
        </div>
      {/if}
      <div class="composer-inner">
        <textarea
          bind:this={composerInput}
          bind:value={draft}
          class="composer-input"
          rows="1"
          maxlength="4000"
          placeholder={revising ? 'What should change?' : 'Describe what you ate…'}
          aria-label="Food description"
          aria-describedby="composer-hint"
          oninput={resizeComposer}
          onkeydown={onComposerKeydown}
        ></textarea>
        <button
          class="composer-send"
          type="submit"
          aria-label={sending ? 'Analysing food' : 'Send food description'}
          disabled={sending || !draft.trim()}
        >
          {#if sending}
            <span class="spinner" aria-hidden="true"></span>
          {:else}
            <Icon name="send" size={21} />
          {/if}
        </button>
      </div>
      <span class="sr-only" id="composer-hint">Press Enter to send. Press Shift and Enter for a new line.</span>
    </form>
  </div>
</section>

{#if editing}
  <MealEditor
    open
    analysis={editing.analysis}
    meal={editing.meal}
    prompt={editing.prompt}
    onclose={() => (editing = null)}
    onsaved={onMealSaved}
  />
{/if}

<style>
  .revising-banner {
    display: flex;
    margin-bottom: var(--space-2);
    padding: var(--space-2) var(--space-3);
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    border-left: 3px solid var(--color-accent);
    border-radius: var(--radius-sm);
    background: var(--color-accent-soft);
    font-size: var(--text-sm);
  }

  .revising-cancel {
    flex: 0 0 auto;
    padding: var(--space-1) var(--space-2);
    border: 0;
    background: transparent;
    color: var(--color-accent);
    font: inherit;
    font-weight: var(--weight-semibold);
    cursor: pointer;
  }

  .thinking {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .thinking > span:last-child {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .thinking small {
    color: var(--color-text-muted);
    font-size: var(--text-xs);
  }

  .send-error p {
    margin-bottom: var(--space-3);
  }
</style>
