import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isAlive } from './processes'
import type { SqliteBoards } from './sqlite-store'

/** How many daily copies of the board file stay in its folder `backups`. */
export const BACKUPS_KEPT = 5
const PRIVATE_FOLDER = 0o700
const OWNER_ONLY = 0o600
const BACKUP_NAME = /^meld-\d{4}-\d{2}-\d{2}\.db$/
const PART_OF = /\.part-(\d+)$/

/**
 * Copies the board file to `backups/meld-<UTC date>.db` next to it, once a day, and keeps the newest BACKUPS_KEPT
 * copies. The copy goes to a part file first and then takes its name, so a process that ends during the copy leaves no
 * broken backup, and a later backup removes its part file. Gives the path of the new copy, or undefined when the day
 * has one. The folder and the copies are open to their user only, as the board file is.
 */
export function backUp(boards: SqliteBoards, now: number, pid = process.pid): string | undefined {
  const folder = join(dirname(boards.path), 'backups')
  mkdirSync(folder, { recursive: true, mode: PRIVATE_FOLDER })
  chmodSync(folder, PRIVATE_FOLDER)
  removeEndedParts(folder)
  const path = join(folder, `meld-${new Date(now).toISOString().slice(0, 10)}.db`)
  if (existsSync(path)) return undefined
  const part = `${path}.part-${pid}`
  writeFileSync(part, '', { mode: OWNER_ONLY })
  chmodSync(part, OWNER_ONLY)
  try {
    boards.copyTo(part)
    renameSync(part, path)
  } finally {
    rmSync(part, { force: true })
  }
  removeOld(folder)
  return path
}

/** Removes each part file whose process ended: that process stopped during its copy. */
function removeEndedParts(folder: string): void {
  for (const name of readdirSync(folder)) {
    const owner = PART_OF.exec(name)?.[1]
    if (owner && !isAlive(Number(owner))) rmSync(join(folder, name), { force: true })
  }
}

/** Removes the copies beyond the newest BACKUPS_KEPT. The date in each name sorts them. */
function removeOld(folder: string): void {
  const copies = readdirSync(folder).filter(name => BACKUP_NAME.test(name)).sort()
  for (const name of copies.slice(0, -BACKUPS_KEPT)) rmSync(join(folder, name), { force: true })
}
