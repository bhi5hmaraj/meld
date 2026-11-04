import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import manifest from '../.claude-plugin/plugin.json'
import { serveStdio } from './protocol'
import { SqliteBoards } from './sqlite-store'
import { boardTools } from './tools'

/**
 * `meld mcp`: the board store of meld, an MCP server over standard input and output. Each session that runs meld starts
 * one; all of them on a machine share one SQLite file, MELD_DB or ~/.meld/meld.db.
 */
const path = process.env.MELD_DB || join(homedir(), '.meld', 'meld.db')
mkdirSync(dirname(path), { recursive: true })
const boards = new SqliteBoards(path)
await serveStdio(boardTools(boards, Date.now), { name: 'meld', version: manifest.version })
boards.close()
