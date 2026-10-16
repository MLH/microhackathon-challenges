// Builds the label under a flying bird. The name and origin are participant
// text, so they go in through textContent only, never as HTML.

/**
 * Returns `<div class="bird-label"><span class="name">name</span>
 * <span class="origin">· origin</span></div>` built with createElement and
 * textContent on `documentObject`.
 */
export function createBirdLabel(documentObject, { birdName, origin }) {
  const label = documentObject.createElement('div')
  label.className = 'bird-label'

  const nameSpan = documentObject.createElement('span')
  nameSpan.className = 'name'
  nameSpan.textContent = birdName
  label.appendChild(nameSpan)

  const originSpan = documentObject.createElement('span')
  originSpan.className = 'origin'
  originSpan.textContent = `· ${origin}`
  label.appendChild(originSpan)

  return label
}
