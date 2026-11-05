import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import manifest from '../.claude-plugin/plugin.json'
import { runHome } from '../core/vcs'
import { acpCommands } from './agents'
import { backUp } from './backup'
import { BoardChannel } from './channel'
import { chatTools } from './chat'
import { mcpIo } from './io'
import { AcpRunner } from './leader'
import { serveStdio } from './protocol'
import type { ServedTool } from './protocol'
import { SqliteBoards } from './sqlite-store'
import { boardTools, channelTool, runnerTools } from './tools'
import { workerTools } from './worker'

/**
 * `meld mcp`: the board store of meld, an MCP server over standard input and output. All the processes on a machine
 * share one SQLite file, MELD_DB or ~/.meld/meld.db. It has three modes:
 *
 * - The plugin mode, with no flag: each Claude Code session that runs meld starts one. It keeps the boards of the plugin,
 *   runs the ACP workers of its session, and answers the reads of boards on a Unix socket in the folder `channels` next
 *   to the board file.
 * - `--chat`: an MCP client, such as a chat of Cursor, leads a run on the board MELD_BOARD, or `chat:<folder>`. All its
 *   workers are ACP agents; MELD_CHAT_AGENT names the default one, codex when absent.
 * - `--worker`: the board tools of the agent MELD_AGENT on the board MELD_BOARD, as the ACP runner starts it for a worker.
 *
 * MELD_ACP_AGENTS adds ACP agents (mcp/agents.ts). The plugin and chat modes stop their agents when the session ends.
 * At their start, they copy the board file to `backups` next to it once a day, then remove the rows that no step needs
 * any more.
 */
/** The signals that end a session: Claude Code sends SIGINT to its MCP servers, a closed terminal SIGHUP. */
const END_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
const CHAT_AGENT = 'codex'
/** A new folder of the board file is open to its user only, as the file holds the runs of every session. */
const PRIVATE_FOLDER = 0o700
/** The owner of the board of a chat: it writes with no lease, so no other session holds it. */
const CHAT_OWNER = 'chat'
const path = process.env.MELD_DB || join(homedir(), '.meld', 'meld.db')
const info = { name: 'meld', version: manifest.version }
const mode = process.argv.includes('--worker') ? 'worker' : process.argv.includes('--chat') ? 'chat' : 'plugin'
const place = { board: process.env.MELD_BOARD ?? '', agent: process.env.MELD_AGENT ?? '' }
if (mode === 'worker' && (!place.board || !place.agent)) {
  console.error('meld mcp --worker needs MELD_BOARD and MELD_AGENT')
  process.exit(1)
}
mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_FOLDER })
const boards = new SqliteBoards(path)
if (mode === 'worker') {
  await serveStdio(workerTools(mcpIo(boards, place.board), place), info)
} else {
  keepUp(boards)
  const runner = new AcpRunner(boards, { commands: acpCommands(process.env.MELD_ACP_AGENTS) })
  const channel = mode === 'plugin' ? BoardChannel.open(boards, join(dirname(path), 'channels')) : undefined
  let closing: Promise<void> | undefined
  const close = () => (closing ??= runner.stopAll().finally(() => channel?.stop()))
  for (const signal of END_SIGNALS) process.on(signal, () => void close().finally(() => process.exit(0)))
  await serveStdio(mode === 'chat' ? chatServed(runner) : [...boardTools(boards, Date.now), channelTool(channel?.socketPath ?? ''), ...runnerTools(runner, boards)], info)
  await close()
}
boards.close()

/**
 * The upkeep of the board file at the start of a session: the backup of the day, then the prune, so the backup holds the
 * rows that the prune removes. A failure stops no session: the next start tries again.
 */
function keepUp(file: SqliteBoards): void {
  try {
    backUp(file, Date.now())
  } catch (error) {
    console.error(`meld mcp: the backup of the board file failed: ${String(error)}`)
  }
  try {
    file.prune(Date.now(), run => existsSync(runHome(run)))
  } catch (error) {
    console.error(`meld mcp: the prune of old rows failed: ${String(error)}`)
  }
}

function chatServed(runner: AcpRunner): ServedTool[] {
  const chat = { board: place.board || `chat:${process.cwd()}`, cwd: process.cwd(), defaultAgent: process.env.MELD_CHAT_AGENT || CHAT_AGENT }
  runner.lead(chat.board, CHAT_OWNER)
  return chatTools(mcpIo(boards, chat.board, runner.runnerFor(chat.board)), boards, chat)
}
