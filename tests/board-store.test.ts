import { expect, test } from 'claude-code/testing'

import { boardVerdict, problemOf, storeNote, withNote } from '../hooks/board-store'

const SERVER = 'plugin:meld:board'
const READ = 'mcp__plugin_meld_board__read_board'
const ONLY_MELD = { decision: 'deny', reason: 'Only meld calls the board store of meld mcp.' }
const UNLISTED = 'This plugin\'s manifest lists no MCP server named "board".'

test('the permission check allows a call of meld itself of a tool of meld mcp, as meld keeps its board there', () => {
  expect(boardVerdict(READ, SERVER, 'meld')).toEqual({ decision: 'allow', reason: 'meld keeps the board of its run in meld mcp.' })
})

test('the permission check refuses a call of a tool of meld mcp from the model or from another plugin', () => {
  expect(boardVerdict(READ, SERVER, 'engine')).toEqual(ONLY_MELD)
  expect(boardVerdict(READ, SERVER, 'notes')).toEqual(ONLY_MELD)
})

test('the permission check gives no verdict for another tool, or when meld mcp did not connect', () => {
  expect(boardVerdict('mcp__meld__claim', SERVER, 'engine')).toBeUndefined()
  expect(boardVerdict(READ, '', 'engine')).toBeUndefined()
})

test('an unlisted meld mcp names the reload that starts it, and another refusal keeps its message', () => {
  expect(problemOf({ reason: 'unlisted', message: UNLISTED })).toBe(`${UNLISTED} This session loaded meld before its manifest listed meld mcp: /reload-plugins or a new session starts it.`)
  expect(problemOf({ reason: 'failed', message: 'bun: not found' })).toBe('bun: not found')
})

test('the note of the store names the board in meld mcp, or why meld mcp is not there', () => {
  expect(storeNote({ server: SERVER, id: 's1', owner: 's1', problem: '' })).toEqual({ store: 'meld mcp, ~/.meld/meld.db', board: 's1' })
  expect(storeNote({ server: '', id: 's1', owner: 's1', problem: 'bun: not found' })).toEqual({ store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
})

test('the note goes into the reply of the board tool of the main session, next to its fields', () => {
  const replied = withNote({ result: JSON.stringify({ state: 'none' }) }, { store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
  expect(JSON.parse(replied.result)).toEqual({ state: 'none', store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
})
