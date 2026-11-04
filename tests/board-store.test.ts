import { expect, test } from 'claude-code/testing'

import { refusesBoardCall, storeNote, withNote } from '../hooks/board-store'

const SERVER = 'plugin:meld:board'
const READ = 'mcp__plugin_meld_board__read_board'

test('a model call of a tool of meld mcp is refused, as the engine is its origin', () => {
  expect(refusesBoardCall(READ, SERVER, 'engine')).toBe(true)
})

test('a call of meld itself passes, as the engine sends each $.mcp.call of the plugin through its tool hooks too', () => {
  expect(refusesBoardCall(READ, SERVER, 'meld')).toBe(false)
})

test('a call of another tool passes, and with no board server meld refuses nothing', () => {
  expect(refusesBoardCall('mcp__meld__claim', SERVER, 'engine')).toBe(false)
  expect(refusesBoardCall(READ, '', 'engine')).toBe(false)
})

test('the note of the store names the board in meld mcp, or why meld mcp is not there', () => {
  expect(storeNote({ server: SERVER, id: 's1', owner: 's1', problem: '' })).toEqual({ store: 'meld mcp, ~/.meld/meld.db', board: 's1' })
  expect(storeNote({ server: '', id: 's1', owner: 's1', problem: 'bun: not found' })).toEqual({ store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
})

test('the note goes into the reply of the board tool of the main session, next to its fields', () => {
  const replied = withNote({ result: JSON.stringify({ state: 'none' }) }, { store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
  expect(JSON.parse(replied.result)).toEqual({ state: 'none', store: 'the session state', why: 'meld mcp did not connect: bun: not found' })
})
