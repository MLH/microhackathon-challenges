// The BirdsBirdBirds page: a canvas to draw the bird and save it as
// bird.png, then the display-only sky where Pi's flights draw themselves and
// fly. The page opens on the canvas until a drawing is saved, and on the sky
// after; Pi reopens the canvas for a redraw at /?draw. The sky polls
// /flight.json, which holds numbers only, never bird.json's CSS.

import { fitStage, setBirdImage, showFlights, showFlock } from './sky.mjs'
import { cropOf } from './trim.mjs'

const COLOURS = [
  { name: 'Black', value: '#1f1f1f' },
  { name: 'Red', value: '#e63946' },
  { name: 'Orange', value: '#f4a261' },
  { name: 'Yellow', value: '#ffd60a' },
  { name: 'Green', value: '#2a9d8f' },
  { name: 'Blue', value: '#3a6ff7' },
]
const PEN_SIZES = [
  { name: 'Thin', width: 6 },
  { name: 'Medium', width: 14 },
  { name: 'Thick', width: 28 },
]
const MAX_UNDO_STEPS = 20
const FLIGHT_POLL_INTERVAL_MS = 1500
const FLOCK_REFRESH_MS = 60_000

const drawMode = document.getElementById('draw-mode')
const skyMode = document.getElementById('sky-mode')
const canvas = document.getElementById('drawing')
const context = canvas.getContext('2d', { willReadFrequently: true })
const swatchContainer = document.getElementById('swatches')
const sizeContainer = document.getElementById('sizes')
const penButton = document.getElementById('pen-button')
const eraserButton = document.getElementById('eraser-button')
const undoButton = document.getElementById('undo-button')
const clearButton = document.getElementById('clear-button')
const saveButton = document.getElementById('save-button')
const statusLine = document.getElementById('status')

// The starting prompt is written once, in index.html, and read back here.
const INITIAL_PROMPT = statusLine.textContent
const DRAWN_PROMPT = 'Looking good! Press Save my bird when it’s done.'
const EMPTY_CANVAS_ERROR = 'The canvas is empty. Draw your bird first!'

const pen = { colour: COLOURS[0].value, width: PEN_SIZES[1].width, erasing: false }
const stroke = { pointerId: undefined, lastPoint: undefined }
const undoSnapshots = []
const sky = { polling: false, flightsText: undefined, flockText: undefined, imageVersion: 0 }

/** Shows `text` on the status line; `tone` is 'info', 'success', or 'error'. */
function setStatus(text, tone = 'info') {
  statusLine.textContent = text
  statusLine.dataset.tone = tone
}

/** Marks the one button in `buttons` that matches `selected` as pressed. */
function pressOnly(buttons, selected) {
  for (const button of buttons) button.setAttribute('aria-pressed', String(button === selected))
}

/** Builds one big swatch button per colour; picking a colour also switches back to the pen. */
function buildSwatches() {
  const buttons = COLOURS.map((colour) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'swatch'
    button.style.backgroundColor = colour.value
    button.setAttribute('aria-label', colour.name)
    button.title = colour.name
    button.addEventListener('click', () => {
      pen.colour = colour.value
      pressOnly(buttons, button)
      choosePen()
    })

    return button
  })
  pressOnly(buttons, buttons[0])
  swatchContainer.replaceChildren(...buttons)
}

/** Builds one button per pen size, each showing a dot of that size. */
function buildSizes() {
  const buttons = PEN_SIZES.map((size) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'size'
    button.setAttribute('aria-label', `${size.name} pen`)
    button.title = size.name
    const dot = document.createElement('span')
    dot.className = 'size-dot'
    dot.style.width = `${Math.max(size.width, 6)}px`
    dot.style.height = `${Math.max(size.width, 6)}px`
    button.appendChild(dot)
    button.addEventListener('click', () => {
      pen.width = size.width
      pressOnly(buttons, button)
    })

    return button
  })
  pressOnly(buttons, buttons[1])
  sizeContainer.replaceChildren(...buttons)
}

/** Switches to the pen. */
function choosePen() {
  pen.erasing = false
  pressOnly([penButton, eraserButton], penButton)
  canvas.classList.remove('erasing')
}

/** Switches to the eraser, which clears pixels back to transparent. */
function chooseEraser() {
  pen.erasing = true
  pressOnly([penButton, eraserButton], eraserButton)
  canvas.classList.add('erasing')
}

/** Converts a pointer event to canvas pixels, whatever size the canvas is shown at. */
function canvasPoint(event) {
  const bounds = canvas.getBoundingClientRect()

  return {
    x: (event.clientX - bounds.left) * (canvas.width / bounds.width),
    y: (event.clientY - bounds.top) * (canvas.height / bounds.height),
  }
}

/** Applies the current pen or eraser to the drawing context. */
function applyPen() {
  context.globalCompositeOperation = pen.erasing ? 'destination-out' : 'source-over'
  context.strokeStyle = pen.colour
  context.fillStyle = pen.colour
  context.lineWidth = pen.width
  context.lineCap = 'round'
  context.lineJoin = 'round'
}

/** Remembers the canvas so the next change can be undone, keeping at most MAX_UNDO_STEPS. */
function rememberForUndo() {
  undoSnapshots.push(context.getImageData(0, 0, canvas.width, canvas.height))
  if (undoSnapshots.length > MAX_UNDO_STEPS) undoSnapshots.shift()
  undoButton.disabled = false
}

/** Restores the canvas to before the last stroke or clear. */
function undo() {
  const snapshot = undoSnapshots.pop()
  if (snapshot === undefined) return

  context.putImageData(snapshot, 0, 0)
  undoButton.disabled = undoSnapshots.length === 0
  setStatus('Undone.')
}

/** Starts a stroke with a dot, so a single tap still leaves a mark. */
function startStroke(event) {
  if (stroke.pointerId !== undefined || event.button > 0) return

  event.preventDefault()
  canvas.setPointerCapture(event.pointerId)
  rememberForUndo()
  applyPen()
  const point = canvasPoint(event)
  context.beginPath()
  context.arc(point.x, point.y, pen.width / 2, 0, Math.PI * 2)
  context.fill()
  stroke.pointerId = event.pointerId
  stroke.lastPoint = point
}

/** Extends the stroke through every point the browser reported since the last event. */
function continueStroke(event) {
  if (event.pointerId !== stroke.pointerId) return

  const events = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event]
  for (const pointerEvent of events.length > 0 ? events : [event]) {
    const point = canvasPoint(pointerEvent)
    context.beginPath()
    context.moveTo(stroke.lastPoint.x, stroke.lastPoint.y)
    context.lineTo(point.x, point.y)
    context.stroke()
    stroke.lastPoint = point
  }
}

/** Ends the stroke for the pointer that started it. */
function endStroke(event) {
  if (event.pointerId !== stroke.pointerId) return

  stroke.pointerId = undefined
  stroke.lastPoint = undefined
  promptToSave()
}

/**
 * Swaps the initial prompt, or the empty-canvas error, for a nudge to save
 * once there is a drawing. Any other message (Undone, Cleared, Saved, a save
 * failure) is left alone, since it reports something the attendee just did.
 */
function promptToSave() {
  const showsPreDrawingMessage = statusLine.textContent === INITIAL_PROMPT || statusLine.textContent === EMPTY_CANVAS_ERROR
  if (showsPreDrawingMessage && !isCanvasBlank()) setStatus(DRAWN_PROMPT)
}

/** Clears the canvas to transparent, undoably. */
function clearCanvas() {
  rememberForUndo()
  context.clearRect(0, 0, canvas.width, canvas.height)
  setStatus('Cleared. Undo brings it back.')
}

/** True when no pixel on the canvas has any ink. */
function isCanvasBlank() {
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  for (let alphaIndex = 3; alphaIndex < data.length; alphaIndex += 4) {
    if (data[alphaIndex] !== 0) return false
  }

  return true
}

/**
 * Encodes the drawing as a PNG blob, cropped to its ink plus a little
 * padding, so a small drawing still fills its box in the sky. Call it only
 * on a canvas with ink.
 */
function canvasToPng() {
  const crop = cropOf(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)
  const cropped = document.createElement('canvas')
  cropped.width = crop.width
  cropped.height = crop.height
  cropped.getContext('2d').drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)

  return new Promise((resolve, reject) => {
    cropped.toBlob((blob) => (blob === null ? reject(new Error('the browser could not encode the drawing')) : resolve(blob)), 'image/png')
  })
}

/** Saves the drawing to the workspace as bird.png and reports how it went. */
async function saveBird() {
  if (isCanvasBlank()) return setStatus(EMPTY_CANVAS_ERROR, 'error')

  saveButton.disabled = true
  setStatus('Saving…')
  try {
    const png = await canvasToPng()
    const response = await fetch('/bird.png', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })
    if (response.status === 413) return setStatus('That drawing is too big to save. Try Clear and a simpler bird.', 'error')
    if (!response.ok) return setStatus(`Saving failed (${response.status}). Try again, or ask the booth staff.`, 'error')
    setStatus('Saved! Pi is taking a look.', 'success')
    sky.imageVersion += 1
    history.replaceState(null, '', '/')
    showSky()
  } catch (error) {
    setStatus(`Saving failed: ${error.message}. Try again, or ask the booth staff.`, 'error')
  } finally {
    saveButton.disabled = false
  }
}

/** True when the participant has saved a drawing. */
async function hasSavedBird() {
  try {
    return (await fetch('/bird.png', { cache: 'no-store' })).ok
  } catch {
    return false
  }
}

/** Shows the canvas. */
function showDraw() {
  skyMode.hidden = true
  drawMode.hidden = false
}

/** Shows the sky with the saved drawing, and starts following flights and the flock. */
function showSky() {
  setBirdImage(`/bird.png?v=${sky.imageVersion}`)
  drawMode.hidden = true
  skyMode.hidden = false
  fitStage()
  if (sky.polling) return

  sky.polling = true
  keepPolling(pollFlights, FLIGHT_POLL_INTERVAL_MS)
  keepPolling(pollFlock, FLOCK_REFRESH_MS)
}

/** Fetches /flight.json and redraws the sky whenever it changes. */
async function pollFlights() {
  const flightsText = await fetchText('/flight.json')
  if (flightsText === undefined || flightsText === sky.flightsText) return

  sky.flightsText = flightsText
  showFlights(JSON.parse(flightsText))
}

/** Fetches /flock.json and refreshes the flock whenever it changes. */
async function pollFlock() {
  const flockText = await fetchText('/flock.json')
  if (flockText === undefined || flockText === sky.flockText) return

  sky.flockText = flockText
  showFlock(JSON.parse(flockText))
}

/** The body of a successful GET of `url`, or undefined when the page server can't answer; the next poll retries. */
async function fetchText(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' })

    return response.ok ? await response.text() : undefined
  } catch {
    return undefined
  }
}

/** Runs `poll` now and then every `intervalMs`, never overlapping runs. */
async function keepPolling(poll, intervalMs) {
  try {
    await poll()
  } finally {
    setTimeout(() => keepPolling(poll, intervalMs), intervalMs)
  }
}

/** Ctrl+Z or Cmd+Z undoes while drawing. */
function handleKeyDown(event) {
  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z'
  if (!isUndo || drawMode.hidden) return

  event.preventDefault()
  undo()
}

/** Wires up the page, then opens the canvas until a drawing is saved, or for a redraw at /?draw, and the sky otherwise. */
async function start() {
  buildSwatches()
  buildSizes()
  canvas.addEventListener('pointerdown', startStroke)
  canvas.addEventListener('pointermove', continueStroke)
  canvas.addEventListener('pointerup', endStroke)
  canvas.addEventListener('pointercancel', endStroke)
  penButton.addEventListener('click', choosePen)
  eraserButton.addEventListener('click', chooseEraser)
  undoButton.addEventListener('click', undo)
  clearButton.addEventListener('click', clearCanvas)
  saveButton.addEventListener('click', saveBird)
  document.addEventListener('keydown', handleKeyDown)
  window.addEventListener('resize', fitStage)

  const wantsToDraw = new URLSearchParams(window.location.search).has('draw')
  if (wantsToDraw || !(await hasSavedBird())) return showDraw()
  showSky()
}

start()
