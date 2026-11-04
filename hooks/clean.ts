import type { VcsKind, WorkerId } from '../types'
import { LIVE_STATES } from './actions'
import { command } from './git'
import type { Files, Io } from './io'
import { MELD_ROOT, removeFolder, runHome, SAFE_ID, vcsFor, workspaceOf } from './vcs'

/** A board.json that changed in the last 24 hours can be the board of a live run of another session on this computer. */
export const MAYBE_LIVE_MS = 24 * 60 * 60 * 1000
const BOARD_FILE = 'board.json'
const ALL = '--all'
const WORKER_ID = /^w\d+$/
const NOTHING = `No folder under ${MELD_ROOT} is left from another run.`

/** What board.json tells of the run of its folder: its state, and what a removal needs. */
type Board = { state: string; vcs: VcsKind; repo: string; workers: WorkerId[] }

/** A folder under /tmp/meld that is not the run of this session. */
type Folder = {
  id: string
  /** When its board.json last changed; absent when it has none. */
  changedAt?: number
  /** Absent when it has no board.json, or one that is not JSON of a run of this folder. */
  board?: Board
}

/**
 * /meld-clean. With no argument, it lists each folder under /tmp/meld that is not the run of this session. With ids or
 * --all, it removes those folders as Discard does, with the version control and the repository of their board.json.
 * --all skips each folder that is maybe live, and its id removes it. The run of this session is never listed nor
 * removed: Discard in the pane removes it.
 */
export async function cleanFolders(io: Io & Files, args: string): Promise<string> {
  const words = args.split(/\s+/).filter(Boolean)
  const flag = words.find(word => word.startsWith('-') && word !== ALL)
  if (flag) return `/meld-clean takes run ids or ${ALL}, not ${flag}.`
  const stored = (await io.read())?.id
  const folders = await foldersOf(io, stored)
  const now = await io.now()
  if (!words.length) return folders.length ? listing(io, folders, now) : NOTHING
  return removeChosen(io, folders, words, stored, now)
}

async function listing(io: Io, folders: Folder[], now: number): Promise<string> {
  const lines: string[] = []
  for (const folder of folders) lines.push(await lineOf(io, folder, now))
  return [
    `The folders of other runs under ${MELD_ROOT}:`,
    ...lines,
    `/meld-clean <id> removes a folder with its workspaces. /meld-clean ${ALL} removes all but the maybe live ones, as a run of another session can use them.`,
  ].join('\n')
}

/** One folder: its id, the state of its board.json and when that changed, its size, and where its workspaces live. */
async function lineOf(io: Io, folder: Folder, now: number): Promise<string> {
  const parts: string[] = []
  if (folder.changedAt === undefined) parts.push('no board.json')
  else if (!folder.board) parts.push('board.json not readable', `changed ${ageOf(now - folder.changedAt)} ago`)
  else parts.push(folder.board.state, `board.json changed ${ageOf(now - folder.changedAt)} ago`)
  const size = await sizeOf(io, folder.id)
  if (size) parts.push(size)
  if (folder.board) parts.push(`${folder.board.vcs} in ${folder.board.repo}`)
  if (isMaybeLive(folder, now)) parts.push('maybe live')
  return `${folder.id}: ${parts.join(', ')}`
}

async function removeChosen(io: Io & Files, folders: Folder[], words: string[], stored: string | undefined, now: number): Promise<string> {
  const ids = [...new Set(words.filter(word => word !== ALL))]
  const notes: string[] = []
  const chosen: Folder[] = []
  for (const id of ids) {
    const folder = folders.find(one => one.id === id)
    if (id === stored) notes.push(`${id} is the run of this session: Discard it in the meld pane.`)
    else if (folder) chosen.push(folder)
    else notes.push(`There is no folder ${id} under ${MELD_ROOT}.`)
  }
  const others = words.includes(ALL) ? folders.filter(folder => !ids.includes(folder.id)) : []
  const skipped = others.filter(folder => isMaybeLive(folder, now)).map(folder => folder.id)
  chosen.push(...others.filter(folder => !isMaybeLive(folder, now)))
  for (const folder of chosen) await removeOne(io, folder)
  const left = new Set(await folderIds(io))
  const removed = chosen.filter(folder => !left.has(folder.id)).map(folder => folder.id)
  const stayed = chosen.filter(folder => left.has(folder.id)).map(folder => folder.id)
  const replies = [
    removed.length ? `Removed ${listed(removed)}.` : '',
    stayed.length ? `${listed(stayed)} ${stayed.length === 1 ? 'is still there: meld could not remove it' : 'are still there: meld could not remove them'}.` : '',
    skipped.length ? skippedText(skipped) : '',
    ...notes,
  ].filter(Boolean)
  return replies.length ? replies.join(' ') : NOTHING
}

function skippedText(ids: string[]): string {
  const one = ids.length === 1
  return `Skipped ${listed(ids)}, maybe live: a run of another session can use ${one ? 'it' : 'them'}. /meld-clean ${one ? ids[0] : '<id>'} removes ${one ? 'it' : 'one'}.`
}

/**
 * Removes a folder as Discard removes a run: with the version control and the repository that its board.json names.
 * The workspaces come from the id of the folder and the worker ids, never from the paths and refs in the file, so a
 * removal touches only what meld made for that run. With no board of the folder, only the folder goes.
 */
async function removeOne(io: Io, folder: Folder): Promise<void> {
  const board = folder.board
  if (!board) return removeFolder(io, folder.id)
  const workers = board.workers.map(worker => workspaceOf(board.vcs, folder.id, worker))
  await vcsFor(board.vcs).remove(io, { id: folder.id, repo: board.repo, workers })
}

async function foldersOf(io: Files, stored: string | undefined): Promise<Folder[]> {
  const folders: Folder[] = []
  for (const id of await folderIds(io)) if (id !== stored) folders.push(await folderOf(io, id))
  return folders
}

/** The folders under /tmp/meld whose names are run ids, sorted; none when /tmp/meld is missing. */
async function folderIds(io: Files): Promise<string[]> {
  const entries = await io.list(MELD_ROOT).catch(() => [])
  return entries
    .filter(entry => entry.kind === 'dir' && SAFE_ID.test(entry.name))
    .map(entry => entry.name)
    .sort()
}

async function folderOf(io: Files, id: string): Promise<Folder> {
  const entries = await io.list(runHome(id)).catch(() => [])
  const file = entries.find(entry => entry.name === BOARD_FILE && entry.kind === 'file')
  if (!file) return { id }
  const text = await io.readText(`${runHome(id)}/${BOARD_FILE}`).catch(() => undefined)
  const board = text === undefined ? undefined : boardOf(id, text)
  return board ? { id, changedAt: file.mtimeMs, board } : { id, changedAt: file.mtimeMs }
}

/** What a board.json tells of the run of the folder `id`; undefined when it is not JSON of a run with that id. */
function boardOf(id: string, text: string): Board | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.id !== id || typeof value.state !== 'string' || typeof value.repo !== 'string' || !value.repo.startsWith('/')) return undefined
  if ((value.vcs !== 'git' && value.vcs !== 'jj') || !Array.isArray(value.workers)) return undefined
  const workers = value.workers.flatMap(worker => (isRecord(worker) && typeof worker.id === 'string' && WORKER_ID.test(worker.id) ? [worker.id as WorkerId] : []))
  return { state: value.state, vcs: value.vcs, repo: value.repo, workers }
}

/**
 * A folder can hold the live run of another session on this computer when its board.json changed in the last 24 hours
 * and says starting, working or ready, or cannot be read while a run writes it. The state alone proves nothing: a run
 * that no session stores any more keeps the last state it wrote.
 */
function isMaybeLive(folder: Folder, now: number): boolean {
  if (folder.changedAt === undefined || now - folder.changedAt >= MAYBE_LIVE_MS) return false
  return !folder.board || LIVE_STATES.has(folder.board.state)
}

/** The size of a folder as du counts it; undefined when du gives no number. */
async function sizeOf(io: Io, id: string): Promise<string | undefined> {
  const counted = await command(io, MELD_ROOT, ['du', '-sk', runHome(id)])
  const kb = /^\d+/.exec(counted.out)?.[0]
  return kb === undefined ? undefined : sizeText(Number(kb))
}

function sizeText(kb: number): string {
  if (kb < 1024) return `${kb} KB`
  if (kb < 1024 * 1024) return `${Math.round(kb / 1024)} MB`
  return `${(kb / (1024 * 1024)).toFixed(1)} GB`
}

/** An age in words that a person reads at a glance: minutes, hours up to two days, then days. */
function ageOf(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} d`
}

/** Names as a list in words: "a", "a and b", "a, b and c". */
function listed(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
