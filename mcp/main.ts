import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import manifest from '../.claude-plugin/plugin.json'
import { acpCommands } from './agents'
import { BoardChannel } from './channel'
import { mcpIo } from './io'
import { AcpRunner } from './leader'
import { serveStdio } from './protocol'
import { SqliteBoards } from './sqlite-store'
import { boardTools, channelTool, runnerTools } from './tools'
import { workerTools } from './worker'

/**
 * `meld mcp`: the board store of meld, an MCP server over standard input and output. Each session that runs meld starts
 * one; all of them on a machine share one SQLite file, MELD_DB or ~/.meld/meld.db. With --worker, it serves the board
 * tools of the agent MELD_AGENT on the board MELD_BOARD, as the ACP runner starts it for a worker such as Codex.
 * Without it, it also runs the ACP runner of the leader, and stops its agents when the session ends, and it answers the
 * reads of boards on a Unix socket in the folder `channels` next to the board file. MELD_ACP_AGENTS adds ACP agents
 * (mcp/agents.ts).
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
if (asWorker) {
  await serveStdio(workerTools(mcpIo(boards, place.board), place), info)
} else {
  const runner = new AcpRunner(boards, { commands: acpCommands(process.env.MELD_ACP_AGENTS) })
  const channel = BoardChannel.open(boards, join(dirname(path), 'channels'))
  const close = () => runner.stopAll().finally(() => channel?.stop())
  process.on('SIGTERM', () => void close().finally(() => process.exit(0)))
  await serveStdio([...boardTools(boards, Date.now), channelTool(channel?.socketPath ?? ''), ...runnerTools(runner, boards)], info)
  await close()
}
boards.close()
