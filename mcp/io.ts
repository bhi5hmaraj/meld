import { dirname, join } from 'node:path'

import { isAcpAgent } from '../core/options'
import type { Io, Runner } from '../core/ports'
import { bunCodeHost } from './code-host'
import type { SqliteBoards } from './sqlite-store'

/**
 * The ports of `meld mcp` for one board: the run in SQLite, commands in this process, and no facts. A runner that this
 * process holds reaches its ACP agents; a message to any other agent, and each toast, become actions for the plugin.
 */
export function mcpIo(boards: SqliteBoards, board: string, acp?: Runner): Io {
  const forPlugin = (kind: 'send' | 'toast', agent: string, text: string) => boards.addAction({ board, kind, agent, text, at: Date.now() })
  return {
    ...boards.board(board),
    store: 'file',
    readFacts: async () => null,
    writeFacts: async () => undefined,
    ...bunCodeHost,
    spawn: async args => (acp ? acp.spawn(args) : { deny: 'a worker of meld mcp starts no agent: the leader does' }),
    send: async (agent, text) => (acp && isAcpAgent(agent) ? acp.send(agent, text) : forPlugin('send', agent, text)),
    agents: async () => acp?.agents(),
    resume: async (agent, text) => (acp?.resume ? acp.resume(agent, text) : false),
    now: async () => Date.now(),
    sleep: ms => Bun.sleep(ms),
    random: count => crypto.getRandomValues(new Uint8Array(count)),
    toast: text => forPlugin('toast', '', text),
    openPane: async () => undefined,
    command: async () => ({}),
    cost: async () => undefined,
    archiveFolder: async () => join(dirname(boards.path), 'archive'),
  }
}
