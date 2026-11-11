import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const PRIVATE_FOLDER = 0o700
const OWNER_ONLY = 0o600
/** The newest version and the one before it: a reader that started on the older one reads it to its end. */
const VERSIONS_KEPT = 2

/**
 * Writes the files of a board as version `version`, and makes `root` show them. Each version is a folder next to the
 * root, and the root is a link that moves to the new folder in one rename, so a reader sees one whole version. Gives
 * false, and writes nothing, when the folder that holds the root is not there: the folder of a run that meld removed
 * stays removed.
 */
export function writeMirror(root: string, files: Readonly<Record<string, string>>, version: number): boolean {
  const home = dirname(root)
  const name = `${basename(root)}-${version}`
  const folder = join(home, name)
  try {
    rmSync(folder, { recursive: true, force: true })
    mkdirSync(folder, { mode: PRIVATE_FOLDER })
    for (const [path, text] of Object.entries(files)) {
      makeFolders(folder, dirname(path))
      writeFileSync(join(folder, path), text, { mode: OWNER_ONLY })
    }
    const link = `${root}.next-${process.pid}`
    rmSync(link, { force: true })
    symlinkSync(name, link)
    renameSync(link, root)
  } catch {
    return false
  }
  removeOld(home, basename(root))
  return true
}

/** Makes each folder of `path` under `folder`, one at a time: a recursive mkdir would also make a run folder that meld removed. */
function makeFolders(folder: string, path: string): void {
  let made = folder
  for (const part of path.split('/').filter(one => one !== '.')) {
    made = join(made, part)
    if (!existsSync(made)) mkdirSync(made, { mode: PRIVATE_FOLDER })
  }
}

/** Removes the version folders beyond the newest VERSIONS_KEPT. The number in each name sorts them. */
function removeOld(home: string, base: string): void {
  const versions = readdirSync(home)
    .flatMap(name => (name.startsWith(`${base}-`) && /^\d+$/.test(name.slice(base.length + 1)) ? [Number(name.slice(base.length + 1))] : []))
    .sort((one, other) => one - other)
  for (const version of versions.slice(0, -VERSIONS_KEPT)) rmSync(join(home, `${base}-${version}`), { recursive: true, force: true })
}
