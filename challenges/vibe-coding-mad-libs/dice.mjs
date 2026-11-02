// The optional dice tables, parsed from dice-sheet.md: the one copy the form
// shows and setup gives the workspace.

import { readFileSync } from 'node:fs'

import { FIELDS } from './prompt.mjs'

const DICE_SHEET = new URL('./dice-sheet.md', import.meta.url)

const TABLE_HEADING = /^## (\w+) \(d(\d+)\)$/
const TABLE_ROW = /^\| (\d+) \| (.+?) \|$/

/**
 * Parses a dice sheet's `## <Label> (d<sides>)` tables into one entry per
 * field, in field order: `{ field, die, options }`, where `options[roll - 1]`
 * is the option for that roll. Throws naming the field when its table is
 * missing or its rolls aren't 1 to the die's sides, in order.
 */
export function parseDiceSheet(markdown) {
  const tablesByLabel = new Map()
  let current
  for (const line of markdown.split('\n')) {
    const heading = TABLE_HEADING.exec(line)
    if (heading) {
      current = { sides: Number(heading[2]), rows: [] }
      tablesByLabel.set(heading[1], current)
      continue
    }

    const row = TABLE_ROW.exec(line)
    if (row && current) current.rows.push({ roll: Number(row[1]), option: row[2] })
  }

  return FIELDS.map((field) => {
    const table = tablesByLabel.get(field.label)
    if (!table) throw new Error(`The dice sheet has no ${field.label} table`)

    const inOrder = table.rows.length === table.sides && table.rows.every(({ roll }, index) => roll === index + 1)
    if (!inOrder) throw new Error(`The dice sheet's ${field.label} table must list rolls 1 to ${table.sides} in order`)

    return { field, die: `d${table.sides}`, options: table.rows.map(({ option }) => option) }
  })
}

/** Reads and parses the package's own dice-sheet.md, as {@link parseDiceSheet} does. */
export function readDiceTables() {
  return parseDiceSheet(readFileSync(DICE_SHEET, 'utf8'))
}
