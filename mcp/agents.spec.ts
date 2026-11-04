import { expect, test } from 'bun:test'

import { ACP_AGENTS } from '../core/options'
import { acpCommands } from './agents'

const GEMINI = ['gemini', '--experimental-acp']
const STUB = ['bun', '/tmp/stub-worker.ts']

test('MELD_ACP_AGENTS adds ACP agents, and gives a built-in agent another command', () => {
  expect(acpCommands(JSON.stringify({ gemini: GEMINI, codex: STUB }))).toEqual({ ...ACP_AGENTS, gemini: GEMINI, codex: STUB })
})

test('without MELD_ACP_AGENTS, meld mcp runs the built-in ACP agents', () => {
  expect(acpCommands(undefined)).toEqual(ACP_AGENTS)
  expect(acpCommands('')).toEqual(ACP_AGENTS)
})

test('an entry that is no list of texts is left out, and text that is no JSON object gives the built-in agents', () => {
  expect(acpCommands(JSON.stringify({ gemini: GEMINI, empty: [], word: 'gemini', mixed: ['gemini', 1] }))).toEqual({ ...ACP_AGENTS, gemini: GEMINI })
  expect(acpCommands('not json')).toEqual(ACP_AGENTS)
  expect(acpCommands(JSON.stringify(['gemini']))).toEqual(ACP_AGENTS)
})
