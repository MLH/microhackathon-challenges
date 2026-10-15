// The Mad Libs sentence: its four blanks, how answers fill them, and how to
// tell a finished sentence from one that still has a blank.

/** The four blanks, in sentence order, with the form's hint for each. */
export const FIELDS = [
  { key: 'theme', label: 'Theme', placeholder: 'the kind of app, like a game or a dashboard' },
  { key: 'subject', label: 'Subject', placeholder: 'what it is about' },
  { key: 'audience', label: 'Audience', placeholder: 'who it is for' },
  { key: 'style', label: 'Style', placeholder: 'how it looks' },
]

/** The sentence with every blank unfilled, for typing by hand. */
export const PROMPT_TEMPLATE = 'Build a [Theme] about [Subject] for [Audience] in [Style] style.'

const UNFILLED_BLANK = /\[(?:Theme|Subject|Audience|Style)\]/i
const FINISHED_SENTENCE = /^Build an? (.+?) about (.+?) for (.+?) in (.+?) style\.$/i

/** True when `answer` is empty, spans lines, or still holds a bracketed blank. */
function isBlank(answer) {
  const trimmed = answer.trim()

  return trimmed === '' || /[\r\n]/.test(trimmed) || UNFILLED_BLANK.test(trimmed)
}

/**
 * Returns the first field of `answers` (an object keyed by each field's
 * `key`) left blank, or undefined when all four are filled.
 */
export function findBlankField(answers) {
  return FIELDS.find((field) => isBlank(answers[field.key] ?? ''))
}

/**
 * Fills the sentence from `answers`, trimming each one. Throws naming the
 * first blank field, so a sentence with a blank never reaches the model.
 */
export function assemblePrompt(answers) {
  const blankField = findBlankField(answers)
  if (blankField) throw new Error(`${blankField.label} is blank`)

  const [theme, subject, audience, style] = FIELDS.map((field) => answers[field.key].trim())

  return `Build a ${theme} about ${subject} for ${audience} in ${style} style.`
}

/** True when `text` is the whole sentence with all four blanks filled. */
export function isFinishedPrompt(text) {
  const match = FINISHED_SENTENCE.exec(text.trim())
  if (!match) return false

  return match.slice(1).every((answer) => !isBlank(answer))
}
