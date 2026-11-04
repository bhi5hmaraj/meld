import type { McpToolResult } from 'claude-code'

import type { Store } from '../core/ports'
import { remoteStore } from '../core/remote-store'
import type { Adopted, BoardServer } from '../core/remote-store'
import type { Run } from '../types'

/**
 * Where this session keeps its run: the board server of meld mcp (empty without it), the board, the owner of its writes,
 * and why meld mcp did not connect.
 */
export type SessionBoard = { server: string; id: string; owner: string; problem: string }

/** Where the run of the session lives, for the board tool of the main session. */
export type StoreNote = { store: string; board?: string; why?: string }

/** The name of this plugin, as the origin of each call that one of its hooks makes. */
const MELD = 'meld'

/**
 * The store of a hook: the board of meld mcp, with the session state as the cache that the pane draws from; without
 * meld mcp, the session state alone, as in meld 0.8.
 */
export function sessionStore(session: SessionBoard, remote: BoardServer, local: Store): Store {
  if (!session.server) return local
  return remoteStore(remote, {
    run: run => local.write(current => (sameRun(current, run) ? current : run)),
    facts: facts => local.writeFacts(facts),
  })
}

/** The value of a tool of meld mcp: the JSON of its text. A failed call throws its text. */
export function valueOf<T>(result: McpToolResult): T {
  const text = result.content.find(block => block.type === 'text')?.text ?? ''
  if (result.isError) throw new Error(`meld mcp: ${text}`)
  return JSON.parse(text) as T
}

/** What adopt_board answers, as the resume reads it. */
export function adoptedOf(value: { result: string; owner?: string; ownerAt?: number }): Adopted {
  if (value.result === 'adopted' || value.result === 'missing') return value.result
  return { owner: value.owner ?? '', ownerAt: value.ownerAt ?? 0 }
}

/** The names that the model sees for the tools of a board server. */
export function boardToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__`
}

/**
 * Whether the guard refuses a call of a tool of meld mcp: only meld calls them. The engine sends each `$.mcp.call` of
 * the plugin through the tool hooks too, with meld as its origin; a call of a model has the engine as its origin.
 */
export function refusesBoardCall(tool: string, server: string, origin: string): boolean {
  return server !== '' && tool.startsWith(boardToolPrefix(server)) && origin !== MELD
}

export function storeNote(session: SessionBoard): StoreNote {
  if (session.server) return { store: 'meld mcp, ~/.meld/meld.db', board: session.id }
  return { store: 'the session state', why: `meld mcp did not connect: ${session.problem}` }
}

/** The reply of the board tool of the main session, with the note of the store next to its fields. */
export function withNote(replied: { result: string }, note: StoreNote): { result: string } {
  const value = JSON.parse(replied.result) as Record<string, unknown>
  return { result: JSON.stringify({ ...value, ...note }) }
}

function sameRun(cached: Run | null, run: Run | null): boolean {
  return JSON.stringify(cached) === JSON.stringify(run)
}
