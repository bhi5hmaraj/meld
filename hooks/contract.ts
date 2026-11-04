import type { ToolSpec } from 'claude-code'

import type { Run, Worker, WorkerId } from '../types'
import { CONTEXT_KINDS, CONTEXT_TEXT_LIMIT } from './board'

export const TOOL = {
  board: 'mcp__meld__board',
  addTasks: 'mcp__meld__add_tasks',
  claim: 'mcp__meld__claim',
  split: 'mcp__meld__split',
  release: 'mcp__meld__release',
  finishTask: 'mcp__meld__finish_task',
  note: 'mcp__meld__note',
  share: 'mcp__meld__share',
  check: 'mcp__meld__check',
  integrate: 'mcp__meld__integrate',
  finish: 'mcp__meld__finish',
  start: 'mcp__meld__start',
  stop: 'mcp__meld__stop',
  steer: 'mcp__meld__steer',
} as const

/** The tools of a worker, which the board hook serves. */
export const BOARD_TOOLS = [
  TOOL.board,
  TOOL.addTasks,
  TOOL.claim,
  TOOL.split,
  TOOL.release,
  TOOL.finishTask,
  TOOL.note,
  TOOL.share,
  TOOL.check,
  TOOL.integrate,
  TOOL.finish,
] as const

/** The instructions behind the steer buttons of the pane: each a fixed text, so a press needs no typing. */
export const STEER_PRESETS = [
  { key: 'tests', label: '+ Tests', text: 'Add tests for each change, and record each test run with check.' },
  { key: 'smaller', label: 'Smaller', text: 'Make the change smaller: drop what the request does not need.' },
  { key: 'checks', label: 'Fix checks', text: 'Make the failing checks pass before any new work.' },
  { key: 'integrate', label: 'Integrate now', text: 'Start no new work. One worker integrates what is done now and declares the final commit.' },
] as const

export const WORKER_SYSTEM = `You are a meld worker: one of several agents that make one result together, each in its own folder, through a shared board. Call ${TOOL.board} first. Its first reply holds your rules, your folder, the other workers and the tasks. Follow those rules, and keep each message short.`

const TASK_VERSION = {
  task: { type: 'number', description: 'The task number, #n on the board.' },
  version: { type: 'number', description: 'The task version from your last board read.' },
}

const COMMIT = { type: 'string', description: 'A revision that names one commit in your folder: HEAD or a hash for git, @- or a commit id for jj.' }

const PART = {
  title: { type: 'string', description: 'Plain words, 8 words at most, with no file paths.' },
  detail: { type: 'string' },
  size: { type: 'string', enum: ['S', 'M', 'L'], description: 'The weight of the task in the percent: S 1, M 3, L 8. M when absent.' },
  needs: { type: 'array', items: { type: 'number' }, description: 'The tasks whose results this task needs. Until they are done, a claim of this task fails with WAITING.' },
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'steer',
    description: 'Give every meld worker a new instruction when the person asks. A running worker gets it as a message; when every worker has ended, meld starts them again with it within a few seconds. Only the main session steers a run.',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'The instruction, in the words of the person.' } }, required: ['text'] },
  },
  {
    name: 'stop',
    description: 'Stop the meld run when the person asks: every worker ends its turn, and the workspaces stay for review. Only the main session stops a run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start',
    description:
      'Start a meld run when the person asks for one: several agents work on the request at the same time, each in its own workspace, and the person watches and steers them in the meld pane. Only the main session starts a run.',
    inputSchema: {
      type: 'object',
      properties: {
        request: { type: 'string', description: 'The task, in the words of the person. Begin it with the path of another repository to work there.' },
        agents: { type: 'string', description: 'A count from 1 to 8, or a list split by commas: a model (opus), an agent type (Explore), or type@model. Default 2.' },
        model: { type: 'string', description: 'The model of the agents that name none.' },
        vcs: { type: 'string', enum: ['auto', 'jj', 'git'], description: 'auto (the default) uses jj when it is installed, else git.' },
      },
      required: ['request'],
    },
  },
  {
    name: 'board',
    description:
      'Read the meld board: who you are, your folder, the other workers, the request and the steers of the person, the tasks, the news from the other workers since your last read, and the shared-context entries that are new for you. The first read also gives your rules.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_tasks',
    description:
      'Add one or more tasks to the meld board in one call, with the taskList version of your last board read. If tasks were added since that read, the call fails and returns the current tasks: claim the ones that cover your work, and add only what is still missing. Keep each task small, so that the workers can do tasks at the same time.',
    inputSchema: {
      type: 'object',
      properties: {
        seen: { type: 'number', description: 'The taskList version of your last board read, or of your last add_tasks reply.' },
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { ...PART, parent: { type: 'number', description: 'The task that this task is a part of.' } },
            required: ['title'],
          },
        },
      },
      required: ['seen', 'tasks'],
    },
  },
  {
    name: 'claim',
    description: 'Claim an open task before you start it. While a task that it needs is not done, the claim fails with WAITING.',
    inputSchema: { type: 'object', properties: TASK_VERSION, required: ['task', 'version'] },
  },
  {
    name: 'split',
    description:
      'Split a task that you claimed into smaller tasks, in one change. The task becomes their parent: it has no commit of its own, and it is done when all its parts are done. You keep the first part as your claim, and the other parts are open for the other workers.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TASK_VERSION,
        tasks: {
          type: 'array',
          minItems: 2,
          description: 'The parts of the task. You keep the first part.',
          items: { type: 'object', properties: PART, required: ['title'] },
        },
      },
      required: ['task', 'version', 'tasks'],
    },
  },
  {
    name: 'release',
    description: 'Give back a task you claimed, with a note on what is done and where (your ref and commit).',
    inputSchema: { type: 'object', properties: { ...TASK_VERSION, note: { type: 'string' } }, required: ['task', 'version'] },
  },
  {
    name: 'finish_task',
    description: 'Mark a task you claimed as done, with the commit in your folder that does it. Its interfaces and the work it leaves show in the shared context.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TASK_VERSION,
        commit: COMMIT,
        summary: { type: 'string' },
        interfaces: { type: 'string', maxLength: CONTEXT_TEXT_LIMIT, description: 'The contracts that this task gives to other tasks: each name and its shape.' },
        unfinished: { type: 'string', maxLength: CONTEXT_TEXT_LIMIT, description: 'The work that this task leaves for other tasks.' },
      },
      required: ['task', 'version', 'commit', 'summary'],
    },
  },
  {
    name: 'note',
    description: 'Tell the other workers something they need: a decision, a file you changed, a problem. For a fact, a fail or an interface, use share.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, commit: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'share',
    description:
      'Add an entry to the shared context. The next board reply to each other worker carries it. A fact is a finding with its evidence. A fail is an approach that did not work, with the reason, so that no worker tries it again. An interface is a contract between tasks: a name and its shape.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...CONTEXT_KINDS] },
        text: { type: 'string', maxLength: CONTEXT_TEXT_LIMIT },
        commit: COMMIT,
        files: { type: 'array', items: { type: 'string' }, description: 'The paths of the files that the entry is about.' },
        replaces: { type: 'number', description: 'The id of an older entry that this entry corrects. The older entry leaves the context.' },
      },
      required: ['kind', 'text'],
    },
  },
  {
    name: 'check',
    description: 'Record a test or build you ran: the command, the commit it ran on, and whether it passed.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        commit: COMMIT,
        passed: { type: 'boolean' },
        output: { type: 'string', description: 'The last lines of the output.' },
      },
      required: ['command', 'commit', 'passed'],
    },
  },
  {
    name: 'integrate',
    description: 'Take the integration: you merge the work of every worker into yours and declare the final commit. One worker integrates at a time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'finish',
    description: 'As the integrator, declare the final commit that holds the whole result, with a summary of one line for the person.',
    inputSchema: { type: 'object', properties: { commit: COMMIT, summary: { type: 'string' } }, required: ['commit', 'summary'] },
  },
]

/** What meld gives each worker at its spawn: who it is and where to start. Its rules come with its first board read. */
export function workerPrompt(run: Run, id: WorkerId): string {
  return `You are meld worker ${id} of run ${run.id}. Call ${TOOL.board} first: its reply gives your rules, your folder, the other workers and the tasks.

The request of the person:
${run.request}`
}

export function workerRules(run: Run, id: WorkerId): string {
  const you = workerIn(run, id)
  const peers = run.workers.filter(worker => worker.id !== id)
  return `You are ${id}, one of ${run.workers.length} meld workers in run ${run.id}. Together you make one result for this request of the person:

${run.request}

Your folder: ${you.path}. Your ref: ${you.ref}. The other workers: ${peers.map(peer => `${peer.id} (${peer.ref})`).join(', ') || 'none'}. All start from commit ${run.base.slice(0, 12)} of ${run.repo}.

The rules for a meld worker:
1. Work only in your folder. Never edit the main checkout or the folder of another worker. Read CLAUDE.md or AGENTS.md in your folder if they exist. Install dependencies in your folder if your checks need them, and keep dependency folders out of your commits.
2. Read the board with ${TOOL.board}. Plan the request as a few small tasks that can go on at the same time, and add them all in one call with ${TOOL.addTasks}, with the taskList version of your read. If another worker added tasks since your read, the call fails and shows its tasks: claim the ones that cover your work, and add only what is still missing. Claim a task with ${TOOL.claim} before you start it.
3. Give each task a title in plain words, 8 words at most, with no file paths. Give needs when a task needs the result of another task. Until those tasks are done, a claim of that task fails with WAITING. Split a task that has more than one deliverable with ${TOOL.split}: you keep the first part, and the other parts are open. A task with parts has no commit of its own. It is done when all its parts are done.
4. Commit after each step. When a task is done, call ${TOOL.finishTask} with the commit and a one-line summary. Give the contracts that other tasks use in interfaces, and the work that you did not do in unfinished. Tell the other workers about each decision with ${TOOL.note}.
5. Each board reply carries the shared context, newest first: the first reply to you carries the current entries, 20 at most, and each later reply only the entries that are new since your last reply. Read it before you start a task, and do not try the approach of a fail. Share with ${TOOL.share}: a fact when a peer can use it, a fail when an approach did not work, and an interface before a peer depends on it. Give a fact with its evidence, a fail with its reason, and an interface as a name and its shape. To correct an entry, share a new entry with replaces and the id of the old entry.
6. Use the work of the other workers through version control, as below. Do not do again what another worker did.
7. Record each test or build you run with ${TOOL.check}, with the commit it ran on.
8. When every task is done, one worker integrates: it calls ${TOOL.integrate}, merges the work of every worker into its own, runs the checks, then calls ${TOOL.finish} with the final commit and a summary. While another worker integrates, review its commits, add tests, or fix what the checks show.
9. A board reply can carry a notice: the person changed the request. Follow the newest instruction.
10. Do not wait with sleep or loops. When nothing is left for you, end your run with a short report. When there is new work, meld starts a new agent for you in your folder, and it reads the board to go on.
11. A board error (STALE_VERSION, TAKEN, NOT_OWNER, WAITING, CONFLICT, INVALID) fails only that call. Read the board again, fix the call, and go on. WAITING names the task that the claim waits for. Claim another task.

${run.vcs === 'jj' ? jjGuide(you, peers) : gitGuide(you, peers)}`
}

function gitGuide(you: Worker, peers: Worker[]): string {
  const branches = peers.map(peer => peer.ref).join(', ') || 'none'
  return `Version control: git. Your folder is a git worktree on branch ${you.ref}.
- Commit: git add the files, then git commit -m "<message>". Give HEAD or the commit hash to the board tools.
- Take the work of another worker: git merge <its branch>, or git cherry-pick <hash>. Their branches: ${branches}.
- Integrate: merge the branch of every other worker into yours, one at a time, fix the conflicts, commit, and give that commit to finish.`
}

function jjGuide(you: Worker, peers: Worker[]): string {
  const lasts = peers.map(peer => `${peer.id}@-`)
  return `Version control: jj. Your folder is a jj workspace with no branch: jj names your working copy ${you.ref}, and the last commit of each other worker is ${lasts.join(', ') || 'none'}.
- Each jj command records your edits in ${you.ref}. Commit: jj commit -m "<message>". The commit is then @-, and ${you.ref} is a new empty change on top. Give @- or its id (jj log -r @- --no-graph -T commit_id) to the board tools.
- Always give -m. Never run a command that opens an editor or a screen: jj split, jj squash -i, jj diffedit, jj resolve.
- See the work of the run: jj log. Take the work of another worker: commit first, then jj new @- <its commit> makes your next change on top of both.
- A conflict does not stop jj: jj st lists the files with conflicts. Edit the files to remove the conflict markers; the next jj command records the fix. A commit with a conflict cannot be the final commit.
- Do not rewrite a commit that you gave to the board or that another worker uses: no jj describe, squash, rebase or abandon on it. Make a new commit on top.
- If jj says the working copy is stale, run jj workspace update-stale.
- Integrate: commit your work, then jj new ${['@-', ...lasts].join(' ')} -m "meld: integrate", fix the conflicts, run the checks, jj commit -m "meld: integrate", and give @- to finish.`
}

/** What meld tells the owner of a leaf after SPLIT_CALLS tool calls on it, with no finish and no split. */
export function splitNudge(task: number): string {
  return `Split #${task} into smaller tasks, or finish it.`
}

export function wakeText(reason: string): string {
  return `meld: ${reason} Read the board with ${TOOL.board}, then go on.`
}

function workerIn(run: Run, id: WorkerId): Worker {
  const worker = run.workers.find(one => one.id === id)
  if (!worker) throw new Error(`meld: no worker ${id}`)
  return worker
}
