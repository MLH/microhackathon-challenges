// The BirdsBirdBirds page: a canvas to draw the bird and save it as
// bird.png, then a sky where it flies once Pi's bird.json passes the checker.
// The server only ever serves a checked bird.json, so its keyframes are safe
// to put in the page's keyframes <style>.

import { createBirdLabel } from './bird-label.mjs'

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
const POLL_INTERVAL_MS = 2000

// The gallery slows every flight down three times so birds float gently.
const FLIGHT_SLOWDOWN = 3

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
const waitingNote = document.getElementById('waiting-note')
const toSkyButton = document.getElementById('to-sky-button')
const drawAgainButton = document.getElementById('draw-again-button')
const sky = document.getElementById('sky')
const keyframesStyle = document.getElementById('bird-keyframes')

const pen = { colour: COLOURS[0].value, width: PEN_SIZES[1].width, erasing: false }
const stroke = { pointerId: undefined, lastPoint: undefined }
const undoSnapshots = []
const flight = { entryText: undefined, entry: undefined, imageVersion: 0 }

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

/** Encodes the canvas as a PNG blob. */
function canvasToPng() {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error('the browser could not encode the drawing')) : resolve(blob)), 'image/png')
  })
}

/** Saves the drawing to the workspace as bird.png and reports how it went. */
async function saveBird() {
  if (isCanvasBlank()) return setStatus('The canvas is empty. Draw your bird first!', 'error')

  saveButton.disabled = true
  setStatus('Saving…')
  try {
    const png = await canvasToPng()
    const response = await fetch('/bird.png', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png })
    if (response.status === 413) return setStatus('That drawing is too big to save. Try Clear and a simpler bird.', 'error')
    if (!response.ok) return setStatus(`Saving failed (${response.status}). Try again, or ask the booth staff.`, 'error')
    setStatus('Saved! Tell Pi your bird is ready.', 'success')
  } catch (error) {
    setStatus(`Saving failed: ${error.message}. Try again, or ask the booth staff.`, 'error')
  } finally {
    saveButton.disabled = false
  }
}

/** Puts the bird from a checked entry in the sky, replacing any bird and keyframes already there. */
function renderFlyingBird(entry) {
  const { bird_name: birdName, origin, animation } = entry
  keyframesStyle.textContent = animation.css_keyframes
  flight.imageVersion += 1

  const wrapper = document.createElement('div')
  wrapper.className = 'bird-wrapper'
  const durationSeconds = Number.parseFloat(animation.duration) * FLIGHT_SLOWDOWN
  wrapper.style.animation = `${animation.animation_name} ${durationSeconds}s ${animation.timing_function} infinite`

  const image = document.createElement('img')
  image.className = 'bird'
  image.alt = 'Your bird'
  image.src = `/bird.png?v=${flight.imageVersion}`
  wrapper.appendChild(image)
  wrapper.appendChild(createBirdLabel(document, { birdName, origin }))

  sky.replaceChildren(wrapper)
}

/** Shows the sky with the latest checked bird. */
function showSky() {
  renderFlyingBird(flight.entry)
  drawMode.hidden = true
  skyMode.hidden = false
}

/** Goes back to the canvas, keeping the drawing. */
function showDraw() {
  skyMode.hidden = true
  drawMode.hidden = false
  sky.replaceChildren()
  toSkyButton.hidden = flight.entry === undefined
}

/** Fetches bird.json and flies the bird whenever a new checked entry appears. */
async function pollBirdEntry() {
  let response
  try {
    response = await fetch('/bird.json', { cache: 'no-store' })
  } catch {
    waitingNote.textContent = 'Can’t reach the page server right now. Retrying…'
    waitingNote.hidden = false
    return
  }

  if (response.status === 422) {
    waitingNote.textContent = 'Waiting for Pi’s flight plan…'
    waitingNote.hidden = flight.entry !== undefined
    return
  }
  waitingNote.hidden = true
  if (!response.ok) return

  const entryText = await response.text()
  if (entryText === flight.entryText) return
  flight.entryText = entryText
  flight.entry = JSON.parse(entryText)
  showSky()
}

/** Polls bird.json now and then every POLL_INTERVAL_MS, never overlapping requests. */
async function keepPolling() {
  try {
    await pollBirdEntry()
  } finally {
    setTimeout(keepPolling, POLL_INTERVAL_MS)
  }
}

/** Ctrl+Z or Cmd+Z undoes while drawing. */
function handleKeyDown(event) {
  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z'
  if (!isUndo || drawMode.hidden) return

  event.preventDefault()
  undo()
}

/** Wires up the page and starts watching for bird.json. */
function start() {
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
  toSkyButton.addEventListener('click', showSky)
  drawAgainButton.addEventListener('click', showDraw)
  document.addEventListener('keydown', handleKeyDown)
  keepPolling()
}

start()
