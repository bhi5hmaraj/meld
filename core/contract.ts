import type { Run, Task, Worker, WorkerId } from '../types'
import { CONTEXT_KINDS, CONTEXT_TEXT_LIMIT } from './board'
import { vcsFor } from './vcs'
import type { ToolSpec } from './ports'
import type { LineMerge } from './vcs'

/** The start of the name of each tool of meld, as Claude Code names the tools of the plugin meld. */
export const TOOL_PREFIX = 'mcp__meld__'

/** The board view that gives the main session its compact status; a board read with no view gives the full board. */
export const STATUS_VIEW = 'status'

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
  deliver: 'mcp__meld__deliver',
  discard: 'mcp__meld__discard',
  addWorker: 'mcp__meld__add_worker',
} as const

/** What the main session does to a run with a tool or a command, as the meld pane does. */
export type Control = 'steer' | 'stop' | 'deliver' | 'discard' | 'add_worker'

/** The tools of the main session. A worker that calls one gets NOT_ALLOWED. */
export const SESSION_TOOLS = [TOOL.start, TOOL.steer, TOOL.stop, TOOL.deliver, TOOL.discard, TOOL.addWorker]

export const CONTROL_TOOLS: ReadonlyMap<string, Control> = new Map<string, Control>([
  [TOOL.steer, 'steer'],
  [TOOL.stop, 'stop'],
  [TOOL.deliver, 'deliver'],
  [TOOL.discard, 'discard'],
  [TOOL.addWorker, 'add_worker'],
])

export const COMMAND_CONTROLS = {
  'meld-steer': 'steer',
  'meld-stop': 'stop',
  'meld-deliver': 'deliver',
  'meld-discard': 'discard',
  'meld-add': 'add_worker',
} as const satisfies Record<string, Control>

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

/**
 * What an agent of the type meld:worker may call: the shell, the file tools and the board tools. Its first request is
 * then about a third of the size, as it carries no list of skills and no other tools.
 */
export const WORKER_TOOLS = ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', ...BOARD_TOOLS]

/** The instructions behind the steer buttons of the pane: each a fixed text, so a press needs no typing. */
export const STEER_PRESETS = [
  { key: 'tests', label: '+ Tests', text: 'Add tests for each change, and record each test run with check.' },
  { key: 'smaller', label: 'Smaller', text: 'Make the change smaller: drop what the request does not need.' },
  { key: 'checks', label: 'Fix checks', text: 'Make the failing checks pass before any new work.' },
  { key: 'integrate', label: 'Integrate now', text: 'Start no new work. One worker integrates what is done now and declares the final commit.' },
] as const

/** The end of each turn of a worker goes to the session of the person: the system prompt and the spawn prompt ask for one line. */
const LAST_MESSAGE = 'Your last message goes to the session of the person. Make it one line, for example: finished #4, commit 4a0bde04. The board keeps the detail.'

export const WORKER_SYSTEM = `You are a meld worker: one of several agents that make one result together, each in its own folder, through a shared board. Call ${TOOL.board} first. Its first reply holds your rules, your folder, the other workers and the tasks. Follow those rules, and keep each message short. When your conversation starts with a summary of earlier work, call ${TOOL.board} before anything else: its reply gives your rules again. ${LAST_MESSAGE}`

/** What the summary of a compacted worker keeps: the facts that its work needs and that no board read gives again. */
export const COMPACT_KEEP =
  'This agent is a meld worker. Keep the id and version of each task that it claimed, its folder and ref, each commit that it made and what the commit does, what is left to do, the checks that fail and why, and every steer of the person. Leave out file contents and command output that it can read again.'

const TASK_VERSION = {
  task: { type: 'number', description: 'The task number, #n on the board.' },
  version: { type: 'number', description: 'The task version from your last board read.' },
}

const COMMIT = { type: 'string', description: 'A revision that names one commit in your folder: HEAD or a hash for git, @- or a commit id for jj.' }

const SEEN = { type: 'number', description: 'The taskList version of your last board read, or of your last add_tasks or split reply.' }

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
    name: 'deliver',
    description:
      "Deliver the final commit of the meld run when the person asks: meld merges it into the branch of the person's checkout, with the subject 'meld: ' and the summary of the final commit, and removes the workspaces of the run. Only the main session delivers a run.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'discard',
    description: 'Discard the meld run when the person asks: meld stops its workers and removes its workspaces, with their commits and edits. Only the main session discards a run.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_worker',
    description:
      'Add a worker to the meld run when the person asks: meld makes its workspace from the head of the integration line, or from the base when the run has no line, and starts its agent. A run has 8 workers at most. Only the main session adds a worker.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'A model (opus), an agent type (Explore), or type@model. Default: the agent of w1.' } },
    },
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
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Gives the whole of one item: request, tasks, tasks/<id>, log/<id> or context/<id>.' },
        view: {
          type: 'string',
          enum: [STATUS_VIEW],
          description:
            'For the main session only. status gives a compact board: the run state, the task counts, one row for each task and each worker, and the log entries since the last status read. With no view, the main session gets the full board.',
        },
      },
    },
  },
  {
    name: 'add_tasks',
    description:
      'Add one or more tasks to the meld board in one call, with the taskList version of your last board read. If tasks were added since that read, the call fails and returns the current tasks: claim the ones that cover your work, and add only what is still missing. Keep each task small, so that the workers can do tasks at the same time.',
    inputSchema: {
      type: 'object',
      properties: {
        seen: SEEN,
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
      'Split a task that you claimed into smaller tasks, in one change, with the taskList version of your last board read. If tasks were added since that read, the split fails with STALE_VERSION and returns the current tasks: check the needs of your parts against them, and split again with the new version. The task becomes their parent: it has no commit of its own, and it is done when all its parts are done. You keep the first part as your claim, and the other parts are open for the other workers.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TASK_VERSION,
        seen: SEEN,
        tasks: {
          type: 'array',
          minItems: 2,
          description: 'The parts of the task. You keep the first part.',
          items: { type: 'object', properties: PART, required: ['title'] },
        },
      },
      required: ['task', 'version', 'seen', 'tasks'],
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
        used: { type: 'array', items: { type: 'number' }, description: 'The ids of the shared-context entries that helped you do this task.' },
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

/** What meld gives each worker at its spawn: who it is, where to start, what meld asks of it now, and how to end. Its rules come with its first board read. */
export function workerPrompt(run: Run, id: WorkerId, step?: string): string {
  const asked = step ? `\n\nWhat meld asks of you now: ${step}` : ''
  return `You are meld worker ${id} of run ${run.id}. Call ${TOOL.board} first: its reply gives your rules, your folder, the other workers and the tasks.

The request of the person:
${run.request}${asked}

${LAST_MESSAGE}`
}

export function workerRules(run: Run, id: WorkerId): string {
  const you = workerIn(run, id)
  const line = vcsFor(run.vcs).lineName(run)
  const peers = run.workers.filter(worker => worker.id !== id)
  return `You are ${id}, one of ${run.workers.length} meld workers in run ${run.id}. Together you make one result for this request of the person:

${run.request}

Your folder: ${you.path}. Your ref: ${you.ref}. The other workers: ${peers.map(peer => `${peer.id} (${peer.ref})`).join(', ') || 'none'}. All start from commit ${run.base.slice(0, 12)} of ${run.repo}.

The rules for a meld worker:
1. Write only in your own folder. Never edit the main checkout or the folder of another worker, with a tool or with a command. Read CLAUDE.md or AGENTS.md in your folder if they exist. Install dependencies in your folder if your checks need them, and keep dependency folders out of your commits.
2. Read the board with ${TOOL.board}. Plan the request as a few small tasks that can go on at the same time, and add them all in one call with ${TOOL.addTasks}, with the taskList version of your read. If another worker added tasks since your read, the call fails and shows its tasks: claim the ones that cover your work, and add only what is still missing. Claim a task with ${TOOL.claim} before you start it. The reply of a claim gives the handovers of the tasks that your task needs: their commits, interfaces and unfinished work.
3. Give each task a title in plain words, 8 words at most, with no file paths. Give needs when a task needs the result of another task. Until those tasks are done, a claim of that task fails with WAITING. Split a task that has more than one deliverable with ${TOOL.split}: you keep the first part, and the other parts are open. A task with parts has no commit of its own. It is done when all its parts are done.
4. Commit after each step. When a task is done, call ${TOOL.finishTask} with the commit and a one-line summary, and in used the ids of the shared-context entries that helped you. Give the contracts that other tasks use in interfaces, and the work that you did not do in unfinished. Tell the other workers about each decision with ${TOOL.note}.
5. Each board reply carries the shared context, newest first: the first reply to you carries the current entries, 20 at most, and each later reply only the entries that are new since your last reply. Read it before you start a task, and do not try the approach of a fail. Share with ${TOOL.share}: a fact when a peer can use it, a fail when an approach did not work, and an interface before a peer depends on it. Give a fact with its evidence, a fail with its reason, and an interface as a name and its shape. To correct an entry, share a new entry with replaces and the id of the old entry.
6. Use the work of the other workers through version control, as below. Merge the branch of a peer only when your own task needs that code: the integration line gathers the finished tasks (rule 8). Do not do again what another worker did.
7. Record each test or build you run with ${TOOL.check}, with the commit it ran on.
8. meld merges the commit of each finished task into the integration line ${line}, with no agent. Do not move or rewrite the line. When a merge conflicts, meld adds a task integrate #N: its owner merges the line and the commit of #N in its folder, fixes the conflicts, runs the checks, commits, and finishes the task. When every task is done, one worker integrates: it calls ${TOOL.integrate}, starts from the line, runs one final build and the checks, then calls ${TOOL.finish} with the final commit and a summary. While another worker integrates, hand back as in rule 10.
9. A board reply can carry a notice: the person changed the request. Follow the newest instruction.
10. After ${TOOL.finishTask}, hand back: end your run. Do not claim the next task: meld starts a new agent for you when a task is ready. End each turn with one line, for example: finished #4, commit 4a0bde04. The board keeps the detail, and the person reads each line in the main session. Do not wait with sleep or loops. When nothing is left for you, end your run the same way. When there is new work, meld starts a new agent for you in your folder, and it reads the board to go on.
11. A board error (STALE_VERSION, TAKEN, NOT_OWNER, WAITING, CONFLICT, INVALID) fails only that call. Read the board again, fix the call, and go on. WAITING names the task that the claim waits for. Claim another task.
12. A board reply is short. tasks has one line for each task, and yours has the tasks that you claim, in full. A long item comes as its first words with a ref. Get the whole item with ${TOOL.board} and its ref, or search the files of the board that the reply names in more, with rg, jq, sed -n or head. Do not print a whole file.

Share the machine. The other workers run on this machine too. A type check, a type-aware lint, a test runner or a build can start a worker for each core and hold gigabytes of memory. Your folder has its own dependencies, so two such commands share no memory. When memory runs out, the machine swaps, and a type check runs many times slower, so the slow commands overlap more and starve each other.
- Before a heavy command, look at the machine: the load against the number of cores (uptime, and nproc or sysctl -n hw.ncpu), the free memory and the swap (free -m, or vm_stat and sysctl vm.swapusage).
- Start it only when the load is under the number of cores and the swap does not grow. Else run a smaller command, such as the tests of your change, limit its workers, or wait. Tell the others with ${TOOL.note} when a heavy command starts and when it ends.
- Watch your own commands. A command that runs much slower than it should, or that makes the swap grow, starves the machine: stop it, and run it again when the machine has room.
- Run the full checks once, before you finish a task. Between steps, run only the tests of your change.
- Stop each process that you started, such as a dev server or a watcher, before you hand back. Give each wait a timeout, and never wait on a command that does not end, such as tail -f.

${run.vcs === 'jj' ? jjGuide(you, peers, line) : gitGuide(you, peers, line)}`
}

function gitGuide(you: Worker, peers: Worker[], line: string): string {
  const branches = peers.map(peer => peer.ref).join(', ') || 'none'
  return `Version control: git. Your folder is a git worktree on branch ${you.ref}.
- Your shell starts in the folder of the session, not in yours. Run each git command as git -C ${you.path} <command>, with no cd, one command in each call. meld allows status, diff, log, show, add, commit, rev-parse, ls-files, merge and cherry-pick in this form. Use plain words in quotes, with no $, backtick or backslash.
- Commit: git -C ${you.path} add the files, then git -C ${you.path} commit -m "<message>". Give HEAD or the commit hash to the board tools.
- Take the work of another worker: git merge <its branch>, or git cherry-pick <hash>. Their branches: ${branches}.
- The integration line is the branch ${line}. To integrate #N: git merge ${line}, then git merge <the commit of #N>, fix the conflicts, commit, and finish the task with HEAD.
- Final integration: git merge ${line}, run one final build and the checks, commit what they need, and give HEAD to finish.`
}

function jjGuide(you: Worker, peers: Worker[], line: string): string {
  const lasts = peers.map(peer => `${peer.id}@-`)
  return `Version control: jj. Your folder is a jj workspace with no branch: jj names your working copy ${you.ref}, and the last commit of each other worker is ${lasts.join(', ') || 'none'}.
- Your shell starts in the folder of the session, not in yours. Run each jj command as jj -R ${you.path} <command>, with no cd, one command in each call. meld allows status, st, log, diff, show, commit, new and workspace update-stale in this form. Use plain words in quotes, with no $, backtick or backslash.
- Each jj command records your edits in ${you.ref}. Commit: jj -R ${you.path} commit -m "<message>". The commit is then @-, and ${you.ref} is a new empty change on top. Give @- or its id (jj log -r @- --no-graph -T commit_id) to the board tools.
- Always give -m. Never run a command that opens an editor or a screen: jj split, jj squash -i, jj diffedit, jj resolve.
- See the work of the run: jj log. Take the work of another worker: commit first, then jj new @- <its commit> makes your next change on top of both.
- A conflict does not stop jj: jj st lists the files with conflicts. Edit the files to remove the conflict markers; the next jj command records the fix. A commit with a conflict cannot be the final commit.
- Do not rewrite a commit that you gave to the board or that another worker uses: no jj describe, squash, rebase or abandon on it. Make a new commit on top.
- If jj says the working copy is stale, run jj workspace update-stale.
- The integration line is the bookmark ${line}. To integrate #N: jj new ${line} <the commit of #N> -m "integrate #N", fix the conflicts, run the checks, jj commit -m "integrate #N", and finish the task with @-.
- Final integration: commit your work, then jj new ${line} -m "meld: integrate", run one final build and the checks, jj commit -m "meld: integrate", and give @- to finish.`
}

/** What meld tells the owner of a leaf after the SPLIT_CALLS of its size, with no finish and no split: S 30, M 60, L 120 tool calls. */
export function splitNudge(task: number): string {
  return `Split #${task} into smaller tasks, or finish it.`
}

/** The longest reason of a failed merge that the detail of a task "integrate #N" quotes. */
const MERGE_ERROR_CHARS = 200

/** The detail of a task "integrate #N": why the commit of #N is not in the integration line, and the steps in the folder of a worker. */
export function integrateDetail(run: Run, task: Task, merge: Exclude<LineMerge, { state: 'merged' }>): string {
  const line = vcsFor(run.vcs).lineName(run)
  const commit = task.commit ?? ''
  const why =
    merge.state === 'conflict'
      ? `The commit ${commit} of #${task.id} (${task.title}) conflicts with the integration line ${line}${merge.files.length ? ` in ${merge.files.join(', ')}` : ''}.`
      : `meld could not merge the commit ${commit} of #${task.id} (${task.title}) into the integration line ${line}: ${merge.error.slice(0, MERGE_ERROR_CHARS)}.`
  const steps =
    run.vcs === 'jj'
      ? `jj new ${line} ${commit} -m "integrate #${task.id}", fix the conflicts, run the checks, jj commit -m "integrate #${task.id}", and finish this task with @-.`
      : `git merge ${line}, then git merge ${commit}, fix the conflicts, commit, run the checks, and finish this task with HEAD.`
  return `${why} In your folder: ${steps}`
}

/**
 * Why finish refuses a final commit: the done tasks whose commits it lacks, with their commits, and the steps that merge
 * them in the folder of the integrator. git merges one commit at a time, as an octopus merge stops at a conflict.
 */
export function missingWorkText(run: Run, final: string, missing: readonly Task[]): string {
  const commits = withoutIntegrated(missing).map(task => task.commit ?? '')
  const tasks = missing.map(task => `#${task.id} ${task.title} (${(task.commit ?? '').slice(0, 12)})`).join(', ')
  const steps =
    run.vcs === 'jj'
      ? `jj new ${final} ${commits.join(' ')} -m "meld: integrate", fix the conflicts, run the checks, jj commit -m "meld: integrate", and finish with @-.`
      : `git merge ${commits.join(', then git merge ')}, fix the conflicts, run the checks, commit, and finish with HEAD.`
  return `The final commit ${final.slice(0, 12)} lacks the commits of done tasks: ${tasks}. In your folder: ${steps}`
}

/**
 * What meld asks of the lead when every task is done. With a line: start from it, merge the commits it lacks, run one
 * final build and finish. A run that meld 0.7.0 stored has no line: merge the work of every worker, as 0.7.0 did.
 */
export function integrateStep(run: Run, lacking: readonly Task[]): string {
  if (!run.line) return `All tasks are done. Integrate: call ${TOOL.integrate}, merge the work of every worker into yours, run the checks, then call ${TOOL.finish}.`
  const line = vcsFor(run.vcs).lineName(run)
  const start = run.vcs === 'jj' ? `jj new ${line} -m "meld: integrate"` : `git merge ${line}`
  const merges = withoutIntegrated(lacking)
  const lacks = merges.length ? ` The line lacks ${merges.map(task => `#${task.id} (${(task.commit ?? '').slice(0, 12)})`).join(', ')}: merge those commits too.` : ''
  return `All tasks are done, and the integration line ${line} holds them at ${run.line.head.slice(0, 12)}. Integrate: call ${TOOL.integrate}, start from the line (${start}).${lacks} Run one final build and the checks, commit, then call ${TOOL.finish} with that commit.`
}

/**
 * The tasks whose commits a merge needs: a task "integrate #N" in the list holds #N with its conflicts fixed, so a merge
 * of #N first would conflict again.
 */
function withoutIntegrated(tasks: readonly Task[]): Task[] {
  const integrated = new Set(tasks.map(task => task.integrates))
  return tasks.filter(task => !integrated.has(task.id))
}

/** What the reply of a finish_task tells a worker that claims no other task: a new agent takes the next task. */
export const HAND_BACK = 'Your task is done. Hand back now with one line, for example: finished #4, commit 4a0bde04. Claim no other task: meld starts a new agent for you when a task is ready.'

export function wakeText(reason: string): string {
  return `meld: ${reason} Read the board with ${TOOL.board}, then go on.`
}

function workerIn(run: Run, id: WorkerId): Worker {
  const worker = run.workers.find(one => one.id === id)
  if (!worker) throw new Error(`meld: no worker ${id}`)
  return worker
}
