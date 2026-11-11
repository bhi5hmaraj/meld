import type { BoardView, Entry, Run, Task, WorkerId } from '../types'
import { steersOf } from './board'
import { TOOL } from './contract'
import type { Store } from './ports'
import { runHome } from './vcs'

/**
 * The items of the board, each with a ref: `request`, `tasks`, `tasks/<id>`, `log/<id>` and `context/<id>`. One text for
 * each item serves a board reply, a read by ref and a file of the board, so the three cannot differ. A reply carries what
 * changes (states, owners, versions) and what is short. A long item goes as its first words and its ref: the text behind a
 * ref of a done task, a log entry or a context entry does not change.
 */

/** The most characters of an item that a board reply carries whole. */
export const INLINE_CHARS = 600

/** The characters of a long item that a board reply carries before its ref. */
const HEAD_CHARS = 160

const REFS = 'request, tasks, tasks/<id>, log/<id> and context/<id>'

/** A task as one line of a board reply: what a claim needs, and nothing long. */
export type TaskLine = Pick<Task, 'id' | 'title' | 'state' | 'version' | 'owner' | 'parent' | 'size' | 'needs'> & { ref: string }

/** An item whose long text a reply cut: the first words, the size of the whole text, and the ref that gives it. */
type Cut = { ref: string; chars: number }

/** The board reply of a worker. The request and the steers come at its first read, with its rules. */
export type ShortView = Omit<BoardView, 'request' | 'steers' | 'tasks' | 'news'> & {
  request?: string
  steers?: string[]
  tasks: TaskLine[]
  /** The tasks that the reader claims, in full. */
  yours?: Task[]
  news: (Entry | (Entry & Cut))[]
  /** How to get the whole of an item with a ref. */
  more: string
}

export function taskLine(task: Task): TaskLine {
  const { id, title, state, version, owner, parent, size, needs } = task
  return { id, title, state, version, owner, parent, size, needs, ref: `tasks/${id}` }
}

/**
 * Where the files of the board are on this machine, or undefined when no host writes them: meld mcp writes them for a
 * run in the board file.
 */
// ponytail: one folder on the machine of the host. A host with workers on other machines gives each worker its own root.
export function viewRoot(io: Pick<Store, 'store'>, run: Run): string | undefined {
  return io.store === 'file' ? `${runHome(run.id)}/board` : undefined
}

/** The short reply of a board read: `first` for the read that briefs the agent of the worker. */
export function shortView(view: BoardView, reader: { id: WorkerId; first: boolean; root?: string }): ShortView {
  const { request, steers, tasks, news, ...rest } = view
  const yours = tasks.filter(task => task.owner === reader.id && task.state === 'claimed')
  return {
    ...rest,
    ...(reader.first ? { request, steers } : {}),
    tasks: tasks.map(taskLine),
    ...(yours.length ? { yours } : {}),
    news: news.map(entry => cut(entry, `log/${entry.id}`)),
    more: moreText(reader.root),
  }
}

function cut<T extends { text: string }>(item: T, ref: string): T | (T & Cut) {
  return item.text.length <= INLINE_CHARS ? item : { ...item, text: `${item.text.slice(0, HEAD_CHARS)}...`, ref, chars: item.text.length }
}

function moreText(root: string | undefined): string {
  const byRef = `A ref names a whole item: ${REFS}. Call ${TOOL.board} with ref to get one.`
  return root ? `${byRef} The same items are files in ${root}: search them with rg, jq, sed -n or head, one command in each call, and do not print a whole file.` : byRef
}

/** The text of the item that a ref names, or undefined for a ref that names nothing. */
export function nodeText(run: Run, ref: string): string | undefined {
  if (ref === 'request') return requestText(run)
  if (ref === 'tasks') return tasksText(run)
  const [kind, id] = ref.split('/')
  if (kind === 'tasks') return textOf(run.tasks.find(task => task.id === Number(id)), taskText)
  if (kind === 'log') return textOf(run.log.find(entry => entry.id === Number(id)), JSON.stringify)
  if (kind === 'context') return textOf((run.context ?? []).find(entry => entry.id === Number(id)), JSON.stringify)
  return undefined
}

function textOf<T>(item: T | undefined, render: (item: T) => string): string | undefined {
  return item === undefined ? undefined : render(item)
}

/** What a read by ref answers: the text, or a refusal that names the refs. */
export function refReply(run: Run, ref: string): { ref: string; text: string } | { error: 'INVALID'; message: string } {
  const text = nodeText(run, ref)
  return text === undefined ? { error: 'INVALID', message: `No item of the board has the ref ${ref}. The refs are ${REFS}.` } : { ref, text }
}

/** The files of the board by their path under its root. Each file holds the text that its ref gives. */
// ponytail: the files come from the run, which keeps its newest log entries. A host with the full rows writes all of them.
export function viewFiles(run: Run): Record<string, string> {
  return {
    'README.md': README,
    'request.md': requestText(run),
    'tasks.md': tasksText(run),
    ...Object.fromEntries(run.tasks.map(task => [`tasks/${task.id}.md`, taskText(task)])),
    'context.jsonl': jsonLines(run.context ?? []),
    'log.jsonl': jsonLines(run.log),
  }
}

const README = `# The board of a meld run, as files

meld writes these files from the board. Read them, and change the board only with the meld tools.

- request.md: the request and the steers of the person.
- tasks.md: one line for each task. tasks/<id>.md: one task with its detail, its summary and its handover.
- context.jsonl: the shared context, one entry in each line.
- log.jsonl: the log of the run, one entry in each line.

Search with rg, jq, sed -n or head. A task can change after these files were written: a claim checks its version.
`

function requestText(run: Run): string {
  const steers = steersOf(run).map((steer, index) => `${index + 1}. ${steer}`)
  return [`# Request (revision ${run.revision})`, '', run.request, ...(steers.length ? ['', '## Steers of the person, oldest first', '', ...steers] : []), ''].join('\n')
}

function tasksText(run: Run): string {
  return `${run.tasks.map(task => `#${task.id} ${task.state}${task.owner ? ` ${task.owner}` : ''}${task.needs?.length ? ` needs ${task.needs.map(need => `#${need}`).join(' ')}` : ''}: ${task.title}`).join('\n')}\n`
}

function taskText(task: Task): string {
  const facts = [
    `state: ${task.state}`,
    `version: ${task.version}`,
    ...(task.owner ? [`owner: ${task.owner}`] : []),
    ...(task.parent ? [`part of: #${task.parent}`] : []),
    ...(task.needs?.length ? [`needs: ${task.needs.map(need => `#${need}`).join(' ')}`] : []),
    ...(task.commit ? [`commit: ${task.commit}`] : []),
  ]
  const sections = [
    ['Detail', task.detail],
    ['Summary', task.summary],
    ['Interfaces', task.handover?.interfaces],
    ['Unfinished', task.handover?.unfinished],
  ].flatMap(([title, text]) => (text ? [`## ${title}`, '', text, ''] : []))
  return [`# #${task.id} ${task.title}`, '', ...facts, '', ...sections].join('\n')
}

function jsonLines(items: readonly object[]): string {
  return items.map(item => `${JSON.stringify(item)}\n`).join('')
}
