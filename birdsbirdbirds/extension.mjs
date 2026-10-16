// Pi extension: tells Pi when the participant saves their drawing, so the
// step advances without the participant saying so. Each save becomes a
// hidden `[birdsbirdbirds]` message the start-challenge skill knows how to
// answer: it starts a turn when Pi is idle and follows the current turn
// otherwise. Uses Node built-ins only, so the package needs no install hook.

import path from 'node:path'

import { watchWorkspace } from './bird-watcher.mjs'

/** The `customType` of every message this extension sends. */
export const MESSAGE_TYPE = 'birdsbirdbirds'

export const BIRD_SAVED_MESSAGE = '[birdsbirdbirds] The participant saved their bird as bird.png. Read it, describe it, and report draw-bird.'

/** Watches the workspace from each session start until its shutdown. */
export default function birdsbirdbirds(pi) {
  let watcher

  /** Sends `content` to Pi now when idle, or after the current turn. */
  const notify = (content) => pi.sendMessage(
    { customType: MESSAGE_TYPE, content, display: false },
    { triggerTurn: true, deliverAs: 'followUp' },
  )

  pi.on('session_start', (_event, ctx) => {
    watcher?.stop()
    watcher = watchWorkspace({
      workspace: path.resolve(process.env.BOOTHSTRAP_WORKSPACE || ctx.cwd),
      onBirdSaved: () => notify(BIRD_SAVED_MESSAGE),
      onError: (error) => ctx.ui.notify(`birdsbirdbirds: watching for saves failed: ${error.message}`, 'warning'),
    })
  })

  pi.on('session_shutdown', () => {
    watcher?.stop()
    watcher = undefined
  })
}
