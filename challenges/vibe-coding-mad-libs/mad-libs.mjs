// Pi extension: the four-blank Mad Libs form. It opens once Pi's welcome
// finishes, reopens with /mad-libs, and sends the filled sentence as the
// participant's message. Typing the sentence in Pi's editor works without it.

import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

import { FIELDS, PROMPT_TEMPLATE, assemblePrompt, fillSentence, findBlankField, hasUnfilledBlank, isFinishedPrompt } from './prompt.mjs'

/** The form's focus stops: one per field, then the Build button. */
const BUILD_BUTTON = FIELDS.length
const FOCUS_STOPS = FIELDS.length + 1

/** How many lines of the sentence preview the form shows. */
const PREVIEW_LINES = 5

/** Lists the text parts of a message's `content`, a string or an array of parts. */
function textParts(content) {
  if (typeof content === 'string') return [content]

  return content.filter((part) => part.type === 'text').map((part) => part.text)
}

/** True when this session's branch already holds a finished sentence from the participant. */
function promptAlreadySent(ctx) {
  return ctx.sessionManager.getBranch().some((entry) => entry.type === 'message'
    && entry.message.role === 'user'
    && textParts(entry.message.content).some(isFinishedPrompt))
}

/**
 * Builds the form component for `ctx.ui.custom`. `draft` keeps answers
 * across closes, keyed by field; `keybindings` supplies Pi's submit and
 * cancel keys; `done` receives the sentence, or null when cancelled.
 */
function createForm({ tui, theme, keybindings, draft, done }) {
  const inputs = FIELDS.map((field) => {
    const input = new Input({ prompt: '', placeholder: field.placeholder })
    // setValue leaves the cursor at column zero; typing the draft puts it at the end.
    if (draft[field.key]) input.handleInput(draft[field.key])

    return input
  })
  let focusedStop = 0
  let hasFocus = true
  let error = ''

  /** Moves focus to stop `target`, wrapping around both ends. */
  function focusStop(target) {
    focusedStop = (target + FOCUS_STOPS) % FOCUS_STOPS
    inputs.forEach((input, index) => {
      input.focused = hasFocus && index === focusedStop
    })
    tui.requestRender()
  }

  /** Sends the sentence, or points at the first blank field. */
  function build() {
    const blankField = findBlankField(draft)
    if (blankField) {
      error = `Fill in ${blankField.label} first.`
      focusStop(FIELDS.indexOf(blankField))
      return
    }

    done(assemblePrompt(draft))
  }

  focusStop(0)

  return {
    get focused() {
      return hasFocus
    },
    set focused(value) {
      hasFocus = value
      focusStop(focusedStop)
    },
    handleInput(data) {
      if (keybindings.matches(data, 'tui.select.cancel')) return done(null)
      if (matchesKey(data, 'shift+tab')) return focusStop(focusedStop - 1)
      if (matchesKey(data, 'tab')) return focusStop(focusedStop + 1)
      if (keybindings.matches(data, 'tui.input.submit')) {
        return focusedStop === BUILD_BUTTON ? build() : focusStop(focusedStop + 1)
      }
      if (focusedStop === BUILD_BUTTON) return

      const field = FIELDS[focusedStop]
      inputs[focusedStop].handleInput(data)
      draft[field.key] = inputs[focusedStop].getValue()
      error = ''
      tui.requestRender()
    },
    render(width) {
      const fit = (text) => truncateToWidth(text, Math.max(1, width))
      const marker = (stop) => (focusedStop === stop ? '›' : ' ')
      const lines = [
        fit(theme.fg('accent', theme.bold('Fill in the blanks'))),
        fit(theme.fg('muted', 'Tab/Shift+Tab: move   Enter: next, then Build   Esc: back to chat')),
      ]
      FIELDS.forEach((field, index) => {
        lines.push(fit(`${marker(index)} ${field.label}`))
        lines.push(...inputs[index].render(width).map(fit))
      })
      lines.push(fit(`${marker(BUILD_BUTTON)} [ Build ]`), '')

      const preview = wrapTextWithAnsi(fillSentence(draft), Math.max(1, width))
      lines.push(...preview.slice(0, PREVIEW_LINES).map(fit))
      if (preview.length > PREVIEW_LINES) lines.push(fit(theme.fg('muted', '… (your answers are kept in full)')))
      if (error) lines.push(fit(theme.fg('warning', error)))

      return lines
    },
    invalidate() {
      inputs.forEach((input) => input.invalidate())
    },
  }
}

/** Registers the form, its /mad-libs command, and the typed-sentence check with Pi. */
export default function madLibs(pi) {
  const draft = Object.fromEntries(FIELDS.map((field) => [field.key, '']))
  let formOpen = false
  let openAfterWelcome = false

  /**
   * Opens the form in Pi's terminal UI and sends the sentence it returns.
   * Once the idea is sent, only an explicit /mad-libs (`requested`) says so.
   */
  async function openForm(ctx, { requested }) {
    if (ctx.mode !== 'tui' || formOpen) return
    if (promptAlreadySent(ctx)) {
      if (requested) ctx.ui.notify('Your idea is already sent. Ask Pi for a change to the app instead.', 'info')
      return
    }

    formOpen = true
    let sentence
    try {
      sentence = await ctx.ui.custom((tui, theme, keybindings, done) => createForm({ tui, theme, keybindings, draft, done }))
    } catch {
      ctx.ui.notify(`The form couldn't open. Type the sentence instead: ${PROMPT_TEMPLATE}`, 'warning')
      return
    } finally {
      formOpen = false
    }

    if (!sentence) {
      ctx.ui.notify('Form closed. Type /mad-libs to reopen it.', 'info')
      return
    }

    pi.sendUserMessage(sentence, ctx.isIdle() ? undefined : { deliverAs: 'followUp' })
  }

  pi.registerCommand('mad-libs', {
    description: 'Open the four-blank app idea form',
    handler: async (_args, ctx) => openForm(ctx, { requested: true }),
  })

  pi.on('session_start', (event, ctx) => {
    openAfterWelcome = event.reason === 'startup' && ctx.mode === 'tui' && !promptAlreadySent(ctx)
  })

  // Not awaited: the form stays open while the participant types, and
  // holding the event would stall Pi until they finish.
  pi.on('agent_settled', (_event, ctx) => {
    if (!openAfterWelcome) return

    openAfterWelcome = false
    openForm(ctx, { requested: false }).catch((error) => ctx.ui.notify(`The form failed: ${error.message}`, 'error'))
  })

  pi.on('input', (event, ctx) => {
    const typedSentenceWithBlank = event.source === 'interactive'
      && /^\s*Build an?\b/i.test(event.text)
      && hasUnfilledBlank(event.text)
      && !promptAlreadySent(ctx)
    if (!typedSentenceWithBlank) return { action: 'continue' }

    ctx.ui.setEditorText(event.text)
    ctx.ui.notify(`Fill in all four blanks: ${PROMPT_TEMPLATE}`, 'warning')

    return { action: 'handled' }
  })
}
