import { afterEach, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeMirror } from './mirror'

const FILES = { 'tasks.md': '#1 open: Theme tokens\n', 'tasks/1.md': '# #1 Theme tokens\n' }
const OWNER_ONLY = 0o600
const folders: string[] = []

/** The folder of a run, as a start makes it, and the root of its board files. */
function runFolder(): { home: string; root: string } {
  const home = mkdtempSync(join(tmpdir(), 'meld-mirror-'))
  folders.push(home)
  return { home, root: join(home, 'board') }
}

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

test('the board files show under the root, each open to its user only', () => {
  const { root } = runFolder()
  expect(writeMirror(root, FILES, 1)).toBe(true)
  expect(readFileSync(join(root, 'tasks/1.md'), 'utf8')).toBe(FILES['tasks/1.md'])
  expect(statSync(join(root, 'tasks.md')).mode & 0o777).toBe(OWNER_ONLY)
})

test('a new version takes the root in one step: the root is a link, and a reader sees one whole version', () => {
  const { root } = runFolder()
  writeMirror(root, FILES, 1)
  writeMirror(root, { ...FILES, 'tasks.md': '#1 done: Theme tokens\n' }, 2)
  expect(lstatSync(root).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(root, 'tasks.md'), 'utf8')).toBe('#1 done: Theme tokens\n')
})

test('the version before the newest stays for a reader that still reads it, and older ones go', () => {
  const { home, root } = runFolder()
  for (const version of [1, 2, 3]) writeMirror(root, FILES, version)
  expect(readdirSync(home).sort()).toEqual(['board', 'board-2', 'board-3'])
})

test('with no folder of the run, nothing is written: a late write does not make the folder of a removed run again', () => {
  const { home, root } = runFolder()
  rmSync(home, { recursive: true })
  expect(writeMirror(root, FILES, 1)).toBe(false)
  expect(existsSync(home)).toBe(false)
})

test('a file in a folder that is not there yet gets its folder, under the root only', () => {
  const { home, root } = runFolder()
  mkdirSync(join(home, 'w1'))
  writeMirror(root, FILES, 1)
  expect(readdirSync(home).sort()).toEqual(['board', 'board-1', 'w1'])
})
