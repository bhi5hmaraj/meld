import type { CodeHost, Store } from './ports'
import { sameRun } from './remote-store'
import { runHome } from './vcs'

/** The record of a run in the folder of the run, for a store that ends with the session. */
export const BOARD_FILE = 'board.json'

let writing: Promise<void> = Promise.resolve()

export function boardFileOf(id: string): string {
  return `${runHome(id)}/${BOARD_FILE}`
}

/**
 * A store that ends with the session, as the session state does, with a record of its run in board.json: after each
 * write that changes the run, meld writes the newest run there, so /meld-clean of a later session can read the run.
 * One record writes at a time. A delivered run has no folder, and a record that fails fails no write.
 */
export function withBoardFile(store: Store, writeFile: CodeHost['writeFile']): Store {
  return {
    read: () => store.read(),
    async write(change) {
      let changed = false
      const written = await store.write(run => {
        const next = change(run)
        changed = !sameRun(run, next)
        return next
      })
      if (changed) await record(store, writeFile)
      return written
    },
  }
}

function record(store: Store, writeFile: CodeHost['writeFile']): Promise<void> {
  writing = writing
    .then(async () => {
      const run = await store.read()
      if (run && run.state !== 'delivered') await writeFile(boardFileOf(run.id), `${JSON.stringify(run, null, 2)}\n`)
    })
    .catch(() => undefined)
  return writing
}
