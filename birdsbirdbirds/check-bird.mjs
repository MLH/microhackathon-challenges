// Checks a bird.json entry before the page injects its keyframes into a
// <style> element. `checkBird` is pure and returns actionable error strings;
// run as `node check-bird.mjs [path]` it checks a file (default bird.json).
//
// css_keyframes goes through a small strict tokenizer and parser that accepts
// exactly one `@keyframes <animation_name> { ... }` rule built from an
// allowlist of properties, transform functions, and units, so nothing else
// can reach the page's stylesheet.

import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const MAX_BIRD_FILE_BYTES = 8192
export const MAX_KEYFRAMES_BYTES = 4096
export const MAX_BIRD_NAME_LENGTH = 40
export const MAX_ORIGIN_LENGTH = 60
export const MAX_TIMING_FUNCTION_LENGTH = 100
export const MIN_DURATION_SECONDS = 2
export const MAX_DURATION_SECONDS = 60

const ENTRY_KEYS = ['bird_name', 'origin', 'animation']
const ANIMATION_KEYS = ['css_keyframes', 'animation_name', 'duration', 'timing_function']
const ALLOWED_PROPERTIES = ['transform', 'opacity', 'animation-timing-function']
const TIMING_KEYWORDS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']
const ALLOWED_UNITS = ['vw', 'vh', 'px', '%', 'deg', 'turn', 'em', 'rem']
const RESERVED_ANIMATION_NAMES = ['none', 'initial', 'inherit', 'unset', 'revert', 'revert-layer', 'default']

/** Argument counts each allowed transform function takes, as [minimum, maximum]. */
const TRANSFORM_ARITY = {
  translate: [1, 2],
  translateX: [1, 1],
  translateY: [1, 1],
  translate3d: [3, 3],
  rotate: [1, 1],
  rotateZ: [1, 1],
  scale: [1, 2],
  scaleX: [1, 1],
  scaleY: [1, 1],
  skew: [1, 2],
  skewX: [1, 1],
  skewY: [1, 1],
}

/** Raw substrings rejected before tokenizing, each with the fix Pi should make. */
const FORBIDDEN_TEXT = [
  { pattern: /url\(/i, message: '"url(" is not allowed; the bird image comes from bird.png, so keyframes need no URLs' },
  { pattern: /@import/i, message: '"@import" is not allowed; css_keyframes holds only one @keyframes block' },
  { pattern: /\\/, message: 'backslash escapes are not allowed; write plain CSS with no "\\"' },
  { pattern: /["']/, message: 'quotes are not allowed; keyframes need no strings, so remove every " and \'' },
  { pattern: /</, message: '"<" is not allowed; css_keyframes is CSS only, never HTML' },
  { pattern: /\/\*/, message: 'comments ("/*") are not allowed; remove them' },
  { pattern: /!\s*important/i, message: '"!important" is not allowed and does nothing in keyframes; remove it' },
]

const ANIMATION_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const DURATION_PATTERN = /^\d+(\.\d+)?s$/
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u
const KEYFRAMES_FIELD = 'animation.css_keyframes'
const PUNCTUATION = new Set(['{', '}', ':', ';', ',', ')'])
const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f'])

/** A parse failure carrying the actionable message to report. */
class CheckError extends Error {}

/**
 * Checks a parsed bird.json value against the birds-v1 shape.
 * Returns an array of actionable error strings; an empty array means valid.
 */
export function checkBird(entry) {
  if (!isPlainObject(entry)) {
    return ['bird.json must hold one JSON object like {"bird_name": ..., "origin": ..., "animation": {...}}']
  }

  const errors = [
    ...unknownKeyErrors(entry, ENTRY_KEYS, ''),
    ...labelErrors(entry, 'bird_name', MAX_BIRD_NAME_LENGTH, "the bird's name"),
    ...labelErrors(entry, 'origin', MAX_ORIGIN_LENGTH, 'where the bird is from'),
  ]
  if (!Object.hasOwn(entry, 'animation')) return [...errors, 'animation is missing; add an "animation" object with css_keyframes, animation_name, duration, timing_function']
  if (!isPlainObject(entry.animation)) return [...errors, 'animation must be an object with css_keyframes, animation_name, duration, timing_function']

  return [...errors, ...animationErrors(entry.animation)]
}

/**
 * Reads and checks a bird.json file, reading at most MAX_BIRD_FILE_BYTES + 1
 * bytes. Returns `{ entry, errors }`; `entry` is undefined when the file could
 * not be read or parsed.
 */
export function loadBirdFile(filePath) {
  let text
  try {
    text = readCappedFile(filePath)
  } catch (error) {
    if (error instanceof CheckError) return { entry: undefined, errors: [error.message] }
    return { entry: undefined, errors: [`${filePath}: cannot read the file (${error.code ?? error.message}); write bird.json in the workspace, then run the checker again`] }
  }

  let entry
  try {
    entry = JSON.parse(text)
  } catch (error) {
    return { entry: undefined, errors: [`${filePath}: not valid JSON (${error.message}); rewrite it as one JSON object`] }
  }

  return { entry, errors: checkBird(entry) }
}

/** Reads a file as UTF-8, failing with an actionable message when it is over the byte cap. */
function readCappedFile(filePath) {
  const descriptor = openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(MAX_BIRD_FILE_BYTES + 1)
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_BIRD_FILE_BYTES) {
      const size = fstatSync(descriptor).size
      throw new CheckError(`${filePath}: file is ${size} bytes, over the ${MAX_BIRD_FILE_BYTES}-byte cap; use fewer keyframes and shorter names`)
    }

    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } catch (error) {
    if (error instanceof TypeError) throw new CheckError(`${filePath}: is not valid UTF-8; save it as UTF-8 text`)
    throw error
  } finally {
    closeSync(descriptor)
  }
}

/** True for a non-null, non-array object. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lists keys of `object` outside `allowedKeys`, naming where they sit. */
function unknownKeyErrors(object, allowedKeys, prefix) {
  const where = prefix === '' ? 'bird.json' : prefix.slice(0, -1)

  return Object.keys(object)
    .filter((key) => !allowedKeys.includes(key))
    .map((key) => `${quote(`${prefix}${key}`)} is an unknown key; remove it (${where} holds only ${allowedKeys.join(', ')})`)
}

/** Checks a short display string such as bird_name or origin. */
function labelErrors(entry, key, maxLength, meaning) {
  if (!Object.hasOwn(entry, key)) return [`${key} is missing; add ${meaning} as a string`]

  const value = entry[key]
  if (typeof value !== 'string') return [`${key} must be a string holding ${meaning}`]
  if (value.trim() === '') return [`${key} is empty; give ${meaning}`]
  if (CONTROL_CHARACTER_PATTERN.test(value)) return [`${key} contains a control character such as a newline or tab; use plain text on one line`]

  const length = [...value].length
  if (length > maxLength) return [`${key} is ${length} characters, over the ${maxLength}-character limit; shorten it`]

  return []
}

/** Checks the animation object and every field in it. */
function animationErrors(animation) {
  const errors = unknownKeyErrors(animation, ANIMATION_KEYS, 'animation.')
  const missing = ANIMATION_KEYS.filter((key) => !Object.hasOwn(animation, key))
  for (const key of missing) errors.push(`animation.${key} is missing; add it as a string`)
  for (const key of ANIMATION_KEYS) {
    if (!missing.includes(key) && typeof animation[key] !== 'string') errors.push(`animation.${key} must be a string`)
  }
  if (errors.length > 0) return errors

  const nameErrors = animationNameErrors(animation.animation_name)

  return [
    ...nameErrors,
    ...durationErrors(animation.duration),
    ...timingFunctionErrors(animation.timing_function),
    ...(nameErrors.length === 0 ? keyframesErrors(animation.css_keyframes, animation.animation_name) : []),
  ]
}

/** Checks animation_name is a safe, non-reserved CSS identifier. */
function animationNameErrors(name) {
  if (!ANIMATION_NAME_PATTERN.test(name)) {
    return [`animation.animation_name ${quote(name)} is not allowed; use a letter or _ then up to 63 letters, digits, _ or -, e.g. "fly_robin"`]
  }
  if (RESERVED_ANIMATION_NAMES.includes(name.toLowerCase())) {
    return [`animation.animation_name ${quote(name)} is a reserved CSS word; pick a unique name such as "fly_robin"`]
  }

  return []
}

/** Checks duration is seconds like "14s" within the allowed range. */
function durationErrors(duration) {
  if (!DURATION_PATTERN.test(duration)) {
    return [`animation.duration ${quote(duration)} is not allowed; write whole or decimal seconds like "14s"`]
  }

  const seconds = Number(duration.slice(0, -1))
  if (seconds < MIN_DURATION_SECONDS || seconds > MAX_DURATION_SECONDS) {
    return [`animation.duration ${quote(duration)} is out of range; use ${MIN_DURATION_SECONDS}s to ${MAX_DURATION_SECONDS}s`]
  }

  return []
}

/** Checks timing_function with the same rule as animation-timing-function inside keyframes. */
function timingFunctionErrors(timingFunction) {
  const field = 'animation.timing_function'
  if (timingFunction.length > MAX_TIMING_FUNCTION_LENGTH) {
    return [`${field} is over ${MAX_TIMING_FUNCTION_LENGTH} characters; use ${TIMING_KEYWORDS.join(', ')}, or cubic-bezier(x1, y1, x2, y2)`]
  }

  try {
    checkTimingValue(tokenize(timingFunction, field), field)
  } catch (error) {
    if (!(error instanceof CheckError)) throw error
    return [error.message]
  }

  return []
}

/** Checks css_keyframes: byte cap, forbidden text, then a strict parse. */
function keyframesErrors(css, animationName) {
  const bytes = Buffer.byteLength(css, 'utf8')
  if (bytes > MAX_KEYFRAMES_BYTES) {
    return [`${KEYFRAMES_FIELD} is ${bytes} bytes, over the ${MAX_KEYFRAMES_BYTES}-byte cap; use fewer keyframes`]
  }

  const forbidden = FORBIDDEN_TEXT
    .filter(({ pattern }) => pattern.test(css))
    .map(({ message }) => `${KEYFRAMES_FIELD}: ${message}`)
  if (forbidden.length > 0) return forbidden

  try {
    parseKeyframes(tokenize(css, KEYFRAMES_FIELD), animationName)
  } catch (error) {
    if (!(error instanceof CheckError)) throw error
    return [error.message]
  }

  return []
}

/** Builds a CheckError for css_keyframes with the given detail. */
function keyframesError(detail) {
  return new CheckError(`${KEYFRAMES_FIELD}: ${detail}`)
}

/**
 * Splits CSS text into tokens: `at-keyword`, `ident`, `function` (an ident
 * with its opening parenthesis), `number` (with `unit`, '' when unitless),
 * and single-character punctuation. Throws CheckError on any other character.
 */
function tokenize(source, field) {
  const tokens = []
  let index = 0

  /** Reads an identifier starting at `index`; returns '' when none starts there. */
  const readIdentifier = () => {
    const start = index
    if (source[index] === '-' && isIdentifierStart(source[index + 1])) index += 1
    if (!isIdentifierStart(source[index])) {
      index = start
      return ''
    }
    while (isIdentifierCharacter(source[index])) index += 1

    return source.slice(start, index)
  }

  while (index < source.length) {
    const character = source[index]

    if (WHITESPACE.has(character)) {
      index += 1
    } else if (PUNCTUATION.has(character)) {
      tokens.push({ type: character })
      index += 1
    } else if (character === '@') {
      index += 1
      const name = readIdentifier()
      if (name === '') throw new CheckError(`${field}: "@" must start "@keyframes"; remove the stray "@"`)
      tokens.push({ type: 'at-keyword', value: name })
    } else if (startsNumber(source, index)) {
      const start = index
      if (source[index] === '+' || source[index] === '-') index += 1
      while (isDigit(source[index])) index += 1
      if (source[index] === '.' && isDigit(source[index + 1])) {
        index += 1
        while (isDigit(source[index])) index += 1
      }
      const value = Number(source.slice(start, index))
      let unit = ''
      if (source[index] === '%') {
        unit = '%'
        index += 1
      } else {
        const unitStart = index
        while (isLetter(source[index])) index += 1
        unit = source.slice(unitStart, index)
      }
      tokens.push({ type: 'number', value, unit, text: source.slice(start, index) })
    } else {
      const name = readIdentifier()
      if (name === '') throw new CheckError(`${field}: unexpected character ${quote(character)} (U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}); use only letters, digits, spaces and { } : ; , ( ) . % -`)
      if (source[index] === '(') {
        index += 1
        tokens.push({ type: 'function', value: name })
      } else {
        tokens.push({ type: 'ident', value: name })
      }
    }
  }

  return tokens
}

/** True when a number token starts at `index`: a digit, or a sign or dot before one. */
function startsNumber(source, index) {
  const character = source[index]
  if (isDigit(character)) return true
  if (character === '.') return isDigit(source[index + 1])
  if (character === '+' || character === '-') {
    return isDigit(source[index + 1]) || (source[index + 1] === '.' && isDigit(source[index + 2]))
  }

  return false
}

/** True for an ASCII digit. */
function isDigit(character) {
  return character !== undefined && character >= '0' && character <= '9'
}

/** True for an ASCII letter. */
function isLetter(character) {
  return character !== undefined && ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z'))
}

/** True for a character that may open an identifier. */
function isIdentifierStart(character) {
  return isLetter(character) || character === '_'
}

/** True for a character that may continue an identifier. */
function isIdentifierCharacter(character) {
  return isIdentifierStart(character) || isDigit(character) || character === '-'
}

/** Describes a token for an error message. */
function describe(token) {
  if (token === undefined) return 'the end'
  if (token.type === 'at-keyword') return quote(`@${token.value}`)
  if (token.type === 'function') return quote(`${token.value}(`)
  if (token.type === 'ident') return quote(token.value)
  if (token.type === 'number') return quote(token.text)

  return quote(token.type)
}

/**
 * Parses tokens as exactly `@keyframes <animationName> { <frame>+ }` and
 * nothing else. Throws CheckError naming the first problem and its fix.
 */
function parseKeyframes(tokens, animationName) {
  checkBraceBalance(tokens)
  const atRules = tokens.filter((token) => token.type === 'at-keyword')
  if (atRules.length > 1) {
    throw keyframesError(`found a second at-rule ${describe(atRules[1])}; css_keyframes holds exactly one @keyframes block`)
  }

  let position = 0
  const peek = () => tokens[position]
  const next = () => tokens[position++]
  const expect = (type, context) => {
    const token = next()
    if (token?.type !== type) throw keyframesError(`expected "${type}" ${context} but found ${describe(token)}`)
  }

  const opening = next()
  if (opening?.type !== 'at-keyword' || opening.value !== 'keyframes') {
    throw keyframesError(`must start with "@keyframes ${animationName} {" but starts with ${describe(opening)}`)
  }
  const nameToken = next()
  if (nameToken?.type !== 'ident') {
    throw keyframesError(`"@keyframes" must be followed by the name ${quote(animationName)}, found ${describe(nameToken)}`)
  }
  if (nameToken.value !== animationName) {
    throw keyframesError(`the @keyframes name ${quote(nameToken.value)} does not match animation.animation_name ${quote(animationName)}; make them the same`)
  }
  expect('{', `after "@keyframes ${animationName}"`)

  let frameCount = 0
  while (peek()?.type !== '}') {
    position = parseFrame(tokens, position)
    frameCount += 1
  }
  next()

  if (frameCount === 0) throw keyframesError('the @keyframes block has no frames; add frames such as "0% { ... } 100% { ... }"')
  if (position < tokens.length) {
    throw keyframesError(`found ${describe(peek())} after the closing "}" of @keyframes; every frame must sit inside the one @keyframes block, so remove or move anything after its final "}"`)
  }
}

/** Fails unless every "{" has a matching "}" and none closes early below depth zero. */
function checkBraceBalance(tokens) {
  const opens = tokens.filter((token) => token.type === '{').length
  const closes = tokens.filter((token) => token.type === '}').length
  if (opens !== closes) {
    throw keyframesError(`braces are unbalanced (${opens} "{" and ${closes} "}"); each frame needs one "{" and one "}", plus one pair around the whole @keyframes block`)
  }
}

/** Parses one frame starting at `position`: selectors, then a declaration block. Returns the next position. */
function parseFrame(tokens, position) {
  let cursor = position
  for (;;) {
    checkFrameSelector(tokens[cursor])
    cursor += 1
    if (tokens[cursor]?.type !== ',') break
    cursor += 1
  }
  if (tokens[cursor]?.type !== '{') {
    throw keyframesError(`expected "{" after a frame selector but found ${describe(tokens[cursor])}; write frames like "50% { transform: ... }"`)
  }
  cursor += 1

  while (tokens[cursor]?.type !== '}') {
    if (tokens[cursor]?.type === ';') {
      cursor += 1
      continue
    }
    cursor = parseDeclaration(tokens, cursor)
  }

  return cursor + 1
}

/** Fails unless the token is `from`, `to`, or a percentage from 0% to 100%. */
function checkFrameSelector(token) {
  if (token?.type === 'ident' && (token.value === 'from' || token.value === 'to')) return
  if (token?.type === 'number' && token.unit === '%' && token.value >= 0 && token.value <= 100) return

  throw keyframesError(`frame selector ${describe(token)} is not allowed; use from, to, or a percentage from 0% to 100%`)
}

/** Parses `property: value` starting at `position`; returns the position of the ";" or "}" after it. */
function parseDeclaration(tokens, position) {
  const property = tokens[position]
  if (property?.type !== 'ident') {
    throw keyframesError(`expected a property name inside a frame but found ${describe(property)}; write declarations like "transform: translate(10vw, 40vh)"`)
  }
  if (!ALLOWED_PROPERTIES.includes(property.value)) {
    throw keyframesError(`property ${quote(property.value)} is not allowed; move the bird with transform: translate(...) (allowed: ${ALLOWED_PROPERTIES.join(', ')})`)
  }
  if (tokens[position + 1]?.type !== ':') {
    throw keyframesError(`expected ":" after ${quote(property.value)} but found ${describe(tokens[position + 1])}`)
  }

  let end = position + 2
  while (end < tokens.length && tokens[end].type !== ';' && tokens[end].type !== '}') {
    if (tokens[end].type === '{') throw keyframesError(`found "{" inside the ${quote(property.value)} value; end the declaration with ";" and close the frame with "}"`)
    end += 1
  }
  const value = tokens.slice(position + 2, end)
  if (value.length === 0) throw keyframesError(`${quote(property.value)} has no value; give it one or remove it`)

  if (property.value === 'transform') checkTransformValue(value)
  if (property.value === 'opacity') checkOpacityValue(value)
  if (property.value === 'animation-timing-function') checkTimingValue(value, `${KEYFRAMES_FIELD}: animation-timing-function`)

  return end
}

/** Fails unless the value is `none` or allowed transform functions with numeric arguments. */
function checkTransformValue(value) {
  if (value.length === 1 && value[0].type === 'ident' && value[0].value === 'none') return

  let position = 0
  while (position < value.length) {
    const transformFunction = value[position]
    if (transformFunction.type !== 'function' || !Object.hasOwn(TRANSFORM_ARITY, transformFunction.value)) {
      throw keyframesError(`transform ${describe(transformFunction)} is not allowed; use none or these functions: ${Object.keys(TRANSFORM_ARITY).join(', ')}`)
    }
    const { argumentTokens, next } = readArguments(value, position + 1, `transform ${transformFunction.value}(`)
    const [minimum, maximum] = TRANSFORM_ARITY[transformFunction.value]
    if (argumentTokens.length < minimum || argumentTokens.length > maximum) {
      const expected = minimum === maximum ? `${minimum}` : `${minimum} or ${maximum}`
      throw keyframesError(`transform ${transformFunction.value}() takes ${expected} argument${maximum === 1 ? '' : 's'} but got ${argumentTokens.length}`)
    }
    for (const argument of argumentTokens) {
      if (argument.unit !== '' && !ALLOWED_UNITS.includes(argument.unit)) {
        throw keyframesError(`unit in ${describe(argument)} is not allowed in transform ${transformFunction.value}(); use ${ALLOWED_UNITS.join(', ')}, or a plain number`)
      }
    }
    position = next
  }
}

/** Reads comma-separated number arguments up to ")" starting at `position`. Returns them and the position after ")". */
function readArguments(tokens, position, context) {
  const argumentTokens = []
  let cursor = position
  for (;;) {
    const token = tokens[cursor]
    if (token?.type !== 'number') {
      throw new CheckError(`${context} arguments must be numbers like 10vw or 15deg, found ${describe(token)}`)
    }
    argumentTokens.push(token)
    cursor += 1
    if (tokens[cursor]?.type === ')') return { argumentTokens, next: cursor + 1 }
    if (tokens[cursor]?.type !== ',') {
      throw new CheckError(`${context} arguments must be separated by "," and end with ")", found ${describe(tokens[cursor])}`)
    }
    cursor += 1
  }
}

/** Fails unless the value is a single unitless number from 0 to 1. */
function checkOpacityValue(value) {
  const [number] = value
  if (value.length !== 1 || number.type !== 'number' || number.unit !== '' || number.value < 0 || number.value > 1) {
    throw keyframesError(`opacity must be one plain number from 0 to 1, like "opacity: 0.5"; found ${value.map(describe).join(' ')}`)
  }
}

/** Fails unless the tokens are a timing keyword or cubic-bezier with four plain numbers, x values in 0–1. */
function checkTimingValue(value, field) {
  const allowed = `use ${TIMING_KEYWORDS.join(', ')}, or cubic-bezier(x1, y1, x2, y2) with plain numbers`
  const [first] = value
  if (value.length === 1 && first.type === 'ident' && TIMING_KEYWORDS.includes(first.value)) return
  if (first?.type !== 'function' || first.value !== 'cubic-bezier') {
    throw new CheckError(`${field} ${first === undefined ? 'is empty' : `${describe(first)} is not allowed`}; ${allowed}`)
  }

  let parsed
  try {
    parsed = readArguments(value, 1, `${field} cubic-bezier(`)
  } catch (error) {
    if (!(error instanceof CheckError)) throw error
    throw new CheckError(`${error.message}; ${allowed}`)
  }
  const { argumentTokens, next } = parsed
  if (next !== value.length) throw new CheckError(`${field} has extra text after cubic-bezier(...); ${allowed}`)
  if (argumentTokens.length !== 4 || argumentTokens.some((argument) => argument.unit !== '')) {
    throw new CheckError(`${field} cubic-bezier() needs exactly four plain numbers with no units; ${allowed}`)
  }
  if ([argumentTokens[0], argumentTokens[2]].some((argument) => argument.value < 0 || argument.value > 1)) {
    throw new CheckError(`${field} cubic-bezier() x values (the 1st and 3rd numbers) must be from 0 to 1`)
  }
}

/** Quotes a value for a message, shortened so a long input never floods the output. */
function quote(value) {
  const text = String(value)

  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}...` : text)
}

/** Checks the file named by `argv[0]` (default bird.json) and returns the exit code. */
export function main(argv) {
  const filePath = argv[0] ?? 'bird.json'
  const { entry, errors } = loadBirdFile(filePath)

  if (errors.length > 0) {
    for (const error of errors) console.error(error)
    return 1
  }

  console.log(`ok: ${entry.bird_name} from ${entry.origin} passes`)
  return 0
}

/** True when this module is the script node was asked to run, symlinks resolved. */
function isRunDirectly() {
  if (process.argv[1] === undefined) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
  } catch {
    return false
  }
}

if (isRunDirectly()) process.exitCode = main(process.argv.slice(2))
