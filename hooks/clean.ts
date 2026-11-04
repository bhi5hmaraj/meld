import type { VcsKind, WorkerId } from '../types'
import { LIVE_STATES } from './actions'
import { command } from './git'
import type { Files, Io } from './io'
import { heldWork, MELD_ROOT, removeFolder, runHome, SAFE_ID, vcsFor, workspaceOf } from './vcs'
import type { HeldWork, LanePlace } from './vcs'

/** A board.json that changed in the last 24 hours can be the board of a live run of another session on this computer. */
export const MAYBE_LIVE_MS = 24 * 60 * 60 * 1000
const BOARD_FILE = 'board.json'
const ALL = '--all'
const WORKER_ID = /^w\d+$/
/** A commit id in hex, so that the base in a board.json cannot pass for an option or a path when git reads a lane. */
const COMMIT_ID = /^[0-9a-f]{7,64}$/
const NOTHING = `No folder under ${MELD_ROOT} is left from another run.`
const NO_BOARD = 'no board.json'
const BOARD_NOT_READABLE = 'board.json not readable'

/** What board.json tells of the run of its folder: its state, and what a read of its workspaces and a removal need. */
type Board = { state: string; vcs: VcsKind; repo: string; base: string; workers: WorkerId[] }

/** A folder under /tmp/meld that is not the run of this session. */
type Folder = {
  id: string
  /** When its board.json last changed; absent when it has none. */
  changedAt?: number
  /** Absent when it has no board.json, or one that is not JSON of a run of this folder. */
  board?: Board
}

/** A folder that --all keeps, and why, in the words that end its list line. */
type Kept = { id: string; why: string }

/**
 * /meld-clean. With no argument, it lists each folder under /tmp/meld that is not the run of this session, with the
 * work in its workspaces. With ids, it removes those folders as Discard does, with the version control and the
 * repository of their board.json. --all removes only each folder whose board.json meld can read, that is not maybe
 * live, and whose workspaces hold no work; it keeps the others, and says why. The run of this session is never listed
 * nor removed: Discard in the pane removes it.
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
    `/meld-clean <id> removes a folder with its workspaces and any work in them. /meld-clean ${ALL} removes only the folders that hold no work: it keeps those maybe live, as a run of another session can use them, those that hold work or whose workspaces meld cannot read, and those with no board.json that meld can read.`,
  ].join('\n')
}

/**
 * One folder: its id, the state of its board.json and when that changed, its size, and where its workspaces live. A
 * folder that is not maybe live ends with the work in its workspaces; meld reads no workspace that a run can use.
 */
async function lineOf(io: Io, folder: Folder, now: number): Promise<string> {
  const parts: string[] = []
  if (folder.changedAt === undefined) parts.push(NO_BOARD)
  else if (!folder.board) parts.push(BOARD_NOT_READABLE, `changed ${ageOf(now - folder.changedAt)} ago`)
  else parts.push(folder.board.state, `board.json changed ${ageOf(now - folder.changedAt)} ago`)
  const size = await sizeOf(io, folder.id)
  if (size) parts.push(size)
  if (folder.board) parts.push(`${folder.board.vcs} in ${folder.board.repo}`)
  if (isMaybeLive(folder, now)) parts.push('maybe live')
  else if (folder.board) parts.push(workText(await heldWork(io, placeOf(folder.id, folder.board))))
  return `${folder.id}: ${parts.join(', ')}`
}

async function removeChosen(io: Io & Files, folders: Folder[], words: string[], stored: string | undefined, now: number): Promise<string> {
  const ids = [...new Set(words.filter(word => word !== ALL))]
  const notes: string[] = []
  const chosen: Folder[] = []
  for (const id of ids) {
    const folder = folders.find(one => one.id === id)
    if (id === stored) notes.push(`${id} is the run of this session: Discard it with /meld-discard or in the meld pane.`)
    else if (folder) chosen.push(folder)
    else notes.push(`There is no folder ${id} under ${MELD_ROOT}.`)
  }
  const others = words.includes(ALL) ? folders.filter(folder => !ids.includes(folder.id)) : []
  const skipped = others.filter(folder => isMaybeLive(folder, now)).map(folder => folder.id)
  const kept: Kept[] = []
  for (const folder of others.filter(folder => !isMaybeLive(folder, now))) {
    const why = await keptBecause(io, folder)
    if (why) kept.push({ id: folder.id, why })
    else chosen.push(folder)
  }
  for (const folder of chosen) await removeOne(io, folder)
  const left = new Set(await folderIds(io))
  const removed = chosen.filter(folder => !left.has(folder.id)).map(folder => folder.id)
  const stayed = chosen.filter(folder => left.has(folder.id)).map(folder => folder.id)
  const replies = [
    removed.length ? `Removed ${listed(removed)}.` : '',
    stayed.length ? `${listed(stayed)} ${stayed.length === 1 ? 'is still there: meld could not remove it' : 'are still there: meld could not remove them'}.` : '',
    ...leftText(kept, skipped),
    ...notes,
  ].filter(Boolean)
  return replies.length ? replies.join(' ') : NOTHING
}

/**
 * Why --all keeps a folder that is not maybe live: no board.json that meld can read, so meld cannot read its
 * workspaces; workspaces that meld cannot read; or the work they hold. Undefined when they hold no work.
 */
async function keptBecause(io: Io, folder: Folder): Promise<string | undefined> {
  if (folder.changedAt === undefined) return NO_BOARD
  if (!folder.board) return BOARD_NOT_READABLE
  const work = await heldWork(io, placeOf(folder.id, folder.board))
  return holdsNoWork(work) ? undefined : workText(work)
}

/** The folders that --all left, each with why, and how to remove one all the same. */
function leftText(kept: Kept[], skipped: string[]): string[] {
  const left = [...kept.map(folder => folder.id), ...skipped]
  if (!left.length) return []
  const one = left.length === 1
  return [
    kept.length ? `Kept ${listed(kept.map(folder => `${folder.id} (${folder.why})`))}.` : '',
    skipped.length ? `Skipped ${listed(skipped)}, maybe live: a run of another session can use ${skipped.length === 1 ? 'it' : 'them'}.` : '',
    `/meld-clean ${one ? left[0] : '<id>'} removes ${one ? 'it' : 'one'}${kept.length ? ', with any work in it' : ''}.`,
  ]
}

/** Whether meld read each workspace, and found no commit since the base and no uncommitted edit. */
function holdsNoWork(work: HeldWork): boolean {
  return !work.unread.length && !work.commits && !work.edits.length
}

/** What the workspaces of a folder hold, as its list line ends: no work, the work, or that meld cannot read them. */
function workText(work: HeldWork): string {
  if (work.unread.length) return 'workspaces not readable'
  if (holdsNoWork(work)) return 'no work'
  const commits = work.commits ? [`${work.commits} commit${work.commits === 1 ? '' : 's'}`] : []
  const edits = work.edits.length ? [`uncommitted edits in ${listed(work.edits)}`] : []
  return `holds work: ${[...commits, ...edits].join(' and ')}`
}

/**
 * The run of a folder as a read of its lanes and a removal need it: the version control, the repository and the base
 * of its board.json. The workspaces come from the id of the folder and the worker ids, never from the paths and refs in
 * the file, so meld reads and removes only what it made for that run.
 */
function placeOf(id: string, board: Board): LanePlace & { vcs: VcsKind } {
  const workers = board.workers.map(worker => ({ id: worker, ...workspaceOf(board.vcs, id, worker) }))
  return { id, vcs: board.vcs, repo: board.repo, base: board.base, workers }
}

/** Removes a folder as Discard removes a run, in the place that its board.json gives. With no board of the folder, only the folder goes. */
async function removeOne(io: Io, folder: Folder): Promise<void> {
  const board = folder.board
  if (!board) return removeFolder(io, folder.id)
  await vcsFor(board.vcs).remove(io, placeOf(folder.id, board))
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

/**
 * What a board.json tells of the run of the folder `id`; undefined when it is not JSON of a run with that id, a commit
 * id as its base, and workers that meld names. A list with no workers, or with an entry that is not a worker of meld,
 * would leave workspaces of the folder out of the work check, so --all would find no work in them and remove them.
 */
function boardOf(id: string, text: string): Board | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(value) || value.id !== id || typeof value.state !== 'string' || typeof value.repo !== 'string' || !value.repo.startsWith('/')) return undefined
  if ((value.vcs !== 'git' && value.vcs !== 'jj') || !Array.isArray(value.workers)) return undefined
  if (typeof value.base !== 'string' || !COMMIT_ID.test(value.base)) return undefined
  const entries: unknown[] = value.workers
  const workers = entries.flatMap(worker => (isRecord(worker) && typeof worker.id === 'string' && WORKER_ID.test(worker.id) ? [worker.id as WorkerId] : []))
  if (!workers.length || workers.length < entries.length) return undefined
  return { state: value.state, vcs: value.vcs, repo: value.repo, base: value.base, workers }
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
