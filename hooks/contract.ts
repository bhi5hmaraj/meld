import type { ToolSpec } from 'claude-code'

import type { Run } from '../types'

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
} as const

const TASK_VERSION = {
  task: { type: 'number', description: 'The task number, #n on the board.' },
  version: { type: 'number', description: 'The task version from your last board read.' },
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'board',
    description:
      'Read the meld board: who you are, your worktree and branch, the other worker, the request and the steers of the person, the tasks, and news from the other worker since your last read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_tasks',
    description:
      'Add one or more tasks to the meld board in one call, with the taskList version of your last board read. If tasks were added since that read, the call fails and returns the current tasks: claim the ones that cover your work, and add only what is still missing. Keep each task small, so that the two workers can do tasks at the same time.',
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
    description: 'Give back a task you claimed, with a note on what is done and where (your branch and commit).',
    inputSchema: {
      type: 'object',
      properties: { ...TASK_VERSION, note: { type: 'string' } },
      required: ['task', 'version'],
    },
  },
  {
    name: 'finish_task',
    description: 'Mark a task you claimed as done, with the commit on your branch that does it.',
    inputSchema: {
      type: 'object',
      properties: { ...TASK_VERSION, commit: { type: 'string' }, summary: { type: 'string' } },
      required: ['task', 'version', 'commit', 'summary'],
    },
  },
  {
    name: 'note',
    description: 'Tell the other worker something it needs: an interface, a decision, a file you changed, a problem.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, commit: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'check',
    description: 'Record a test or build you ran: the command, the commit it ran on, and whether it passed.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        commit: { type: 'string' },
        passed: { type: 'boolean' },
        output: { type: 'string', description: 'The last lines of the output.' },
      },
      required: ['command', 'commit', 'passed'],
    },
  },
  {
    name: 'integrate',
    description: 'Take the integration: you merge the work of both workers on your branch and declare the final commit. One worker integrates at a time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'finish',
    description: 'As the integrator, declare the final commit that holds the whole result, with a summary for the person.',
    inputSchema: {
      type: 'object',
      properties: { commit: { type: 'string' }, summary: { type: 'string' } },
      required: ['commit', 'summary'],
    },
  },
]

export function workerRules(run: Run): string {
  const [one, two] = run.workers
  return `meld run ${run.id}. Two workers, w1 and w2, make one result for this request of the person, together:

${run.request}

w1 works in ${one?.path} on branch ${one?.branch}. w2 works in ${two?.path} on branch ${two?.branch}. Both start from commit ${run.base.slice(0, 12)} of ${run.repo}.

The rules for a meld worker:
1. Work only in your own worktree. Never edit the main checkout or the worktree of the other worker. Install the dependencies in your worktree if your checks need them.
2. Read the board with ${TOOL.board} first. Plan the request as a few small tasks that can go on at the same time, and add them all in one call with ${TOOL.addTasks}, with the taskList version of your read. If the other worker added tasks since your read, the call fails and shows its tasks: claim the ones that cover your work, and add only what is still missing. Claim a task with ${TOOL.claim} before you start it.
3. Commit often on your branch. When a task is done, call ${TOOL.finishTask} with the commit and a one-line summary. Tell the other worker about interfaces and decisions early with ${TOOL.note}.
4. Use the work of the other worker through git: its branch is on the board (git merge or git cherry-pick). Do not do again what the other worker did.
5. Record each test or build you run with ${TOOL.check}.
6. One worker integrates: call ${TOOL.integrate}, merge both branches into yours, run the checks, then call ${TOOL.finish} with the final commit and a summary. While the other worker integrates, do useful work: review its commits, add tests, fix what the checks show.
7. A board reply can carry a notice: the person changed the request. Follow the newest instruction.
8. Do not wait with sleep or loops. When nothing is left for you, end your turn with a one-line summary. meld wakes you when there is new work.
9. A board error (STALE_VERSION, TAKEN, NOT_OWNER) fails only that call. Read the board again and go on.`
}

export function launchPrompt(run: Run): string {
  return `Start meld run ${run.id} now. In one response, call the Agent tool two times, with subagent_type "fork", the descriptions "meld w1" and "meld w2", and this prompt for each: "You are a meld worker. Call ${TOOL.board} first, then follow the meld rules." Do not do the work of the request yourself. After the two calls, tell the person in one line that the two workers started and that the meld pane shows them.`
}

export function wakeText(reason: string): string {
  return `meld: ${reason} Read the board with ${TOOL.board}, then go on.`
}
