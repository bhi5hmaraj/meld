import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import manifest from '../.claude-plugin/plugin.json'
import { serveStdio } from './protocol'
import { SqliteBoards } from './sqlite-store'
import { boardTools } from './tools'
import { workerIo, workerTools } from './worker'

/**
 * `meld mcp`: the board store of meld, an MCP server over standard input and output. Each session that runs meld starts
 * one; all of them on a machine share one SQLite file, MELD_DB or ~/.meld/meld.db. With --worker, it serves the board
 * tools of the agent MELD_AGENT on the board MELD_BOARD, as the ACP runner starts it for a worker such as Codex.
 */
const path = process.env.MELD_DB || join(homedir(), '.meld', 'meld.db')
const info = { name: 'meld', version: manifest.version }
const asWorker = process.argv.includes('--worker')
const place = { board: process.env.MELD_BOARD ?? '', agent: process.env.MELD_AGENT ?? '' }
if (asWorker && (!place.board || !place.agent)) {
  console.error('meld mcp --worker needs MELD_BOARD and MELD_AGENT')
  process.exit(1)
}
mkdirSync(dirname(path), { recursive: true })
const boards = new SqliteBoards(path)
await serveStdio(asWorker ? workerTools(workerIo(boards, place), place) : boardTools(boards, Date.now), info)
boards.close()
