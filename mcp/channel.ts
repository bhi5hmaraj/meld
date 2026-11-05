import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { isAlive } from './processes'
import type { SqliteBoards } from './sqlite-store'

const PRIVATE = 0o700
/** The longest socket path that `$.http.fetch` of the engine takes. */
const SOCKET_PATH_BYTES = 100
const BOARD_PATH = /^\/boards\/([^/]+)$/
const SOCKET_NAME = /^(\d+)\.sock$/

/**
 * The board channel of `meld mcp`: the reads of its boards over HTTP on a Unix socket, in a folder that only its user
 * opens. A timer of the plugin runs outside every hook, so it cannot call meld mcp. It reads the board here instead,
 * with `$.http.fetch`, while ACP workers write to it through their own meld mcp.
 */
export class BoardChannel {
  private constructor(
    readonly socketPath: string,
    private readonly server: ReturnType<typeof Bun.serve>,
  ) {}

  /**
   * Opens the socket of this process in the folder, after it removes the sockets of processes that ended. No channel when
   * the path is too long for the engine, or the socket cannot listen.
   */
  static open(boards: SqliteBoards, folder: string, pid = process.pid): BoardChannel | undefined {
    const socketPath = join(folder, `${pid}.sock`)
    if (Buffer.byteLength(socketPath) > SOCKET_PATH_BYTES) return undefined
    try {
      mkdirSync(folder, { recursive: true, mode: PRIVATE })
      chmodSync(folder, PRIVATE)
      removeEnded(folder, pid)
      const server = Bun.serve({ unix: socketPath, fetch: request => answer(boards, request) })
      return new BoardChannel(socketPath, server)
    } catch {
      return undefined
    }
  }

  stop(): void {
    void this.server.stop(true)
    rmSync(this.socketPath, { force: true })
  }
}

function answer(boards: SqliteBoards, request: Request): Response {
  const board = BOARD_PATH.exec(new URL(request.url).pathname)?.[1]
  if (!board) return new Response(null, { status: 404 })
  if (request.method !== 'GET') return new Response(null, { status: 405 })
  return Response.json(boards.read(decodeURIComponent(board)))
}

/** Removes the socket that this pid left before, and each socket whose process ended. */
function removeEnded(folder: string, pid: number): void {
  for (const name of readdirSync(folder)) {
    const owner = Number(SOCKET_NAME.exec(name)?.[1] ?? Number.NaN)
    if (owner === pid || (Number.isInteger(owner) && !isAlive(owner))) rmSync(join(folder, name), { force: true })
  }
}
