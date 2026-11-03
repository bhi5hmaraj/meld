import type { ToolSpec } from 'claude-code'

import type { Run, Worker, WorkerId } from '../types'

export const TOOL = {
  board: 'mcp__meld__board',
  addTasks: 'mcp__meld__add_tasks',
  claim: 'mcp__meld__claim',
  release: 'mcp__meld__release',
  finishTask: 'mcp__meld__finish_task',
  note: 'mcp__meld__note',
  check: 'mcp__meld__check',
  integrate: 'mcp__meld__integrate',
  finish: 'mcp__meld__finish',
  start: 'mcp__meld__start',
  stop: 'mcp__meld__stop',
  steer: 'mcp__meld__steer',
} as const

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
      'Read the meld board: who you are, your folder, the other workers, the request and the steers of the person, the tasks, and news from the other workers since your last read. The first read also gives your rules.',
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
          items: { type: 'object', properties: { title: { type: 'string' }, detail: { type: 'string' } }, required: ['title'] },
        },
      },
      required: ['seen', 'tasks'],
    },
  },
  {
    name: 'claim',
    description: 'Claim an open task before you start it.',
    inputSchema: { type: 'object', properties: TASK_VERSION, required: ['task', 'version'] },
  },
  {
    name: 'release',
    description: 'Give back a task you claimed, with a note on what is done and where (your ref and commit).',
    inputSchema: { type: 'object', properties: { ...TASK_VERSION, note: { type: 'string' } }, required: ['task', 'version'] },
  },
  {
    name: 'finish_task',
    description: 'Mark a task you claimed as done, with the commit in your folder that does it.',
    inputSchema: {
      type: 'object',
      properties: { ...TASK_VERSION, commit: COMMIT, summary: { type: 'string' } },
      required: ['task', 'version', 'commit', 'summary'],
    },
  },
  {
    name: 'note',
    description: 'Tell the other workers something they need: an interface, a decision, a file you changed, a problem.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, commit: { type: 'string' } }, required: ['text'] },
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
3. Commit often. When a task is done, call ${TOOL.finishTask} with the commit and a one-line summary. Tell the other workers about interfaces and decisions early with ${TOOL.note}.
4. Use the work of the other workers through version control, as below. Do not do again what another worker did.
5. Record each test or build you run with ${TOOL.check}, with the commit it ran on.
6. When every task is done, one worker integrates: it calls ${TOOL.integrate}, merges the work of every worker into its own, runs the checks, then calls ${TOOL.finish} with the final commit and a summary. While another worker integrates, review its commits, add tests, or fix what the checks show.
7. A board reply can carry a notice: the person changed the request. Follow the newest instruction.
8. Do not wait with sleep or loops. When nothing is left for you, end your run with a short report. When there is new work, meld starts a new agent for you in your folder, and it reads the board to go on.
9. A board error (STALE_VERSION, TAKEN, NOT_OWNER, CONFLICT) fails only that call. Read the board again and go on.

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

export function wakeText(reason: string): string {
  return `meld: ${reason} Read the board with ${TOOL.board}, then go on.`
}

function workerIn(run: Run, id: WorkerId): Worker {
  const worker = run.workers.find(one => one.id === id)
  if (!worker) throw new Error(`meld: no worker ${id}`)
  return worker
}
