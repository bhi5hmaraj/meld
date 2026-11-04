import type { McpToolResult } from 'claude-code'

import type { Store } from '../core/ports'
import { remoteStore } from '../core/remote-store'
import type { Adopted, BoardServer } from '../core/remote-store'
import type { Run } from '../types'

/** Where this session keeps its run: the board server of meld mcp (empty without it), the board, and the owner of its writes. */
export type SessionBoard = { server: string; id: string; owner: string }

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

/** The names that the model sees for the tools of a board server: meld refuses its calls, as only meld calls them. */
export function boardToolPrefix(server: string): string {
  return `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__`
}

function sameRun(cached: Run | null, run: Run | null): boolean {
  return JSON.stringify(cached) === JSON.stringify(run)
}
