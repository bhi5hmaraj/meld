import type { Run } from '../types'

const AT = 1_800_000_000_000

/** A run as meld 0.6.0 stored it: two workers, and tasks with no parent, size, needs or times. */
export const STORED_BY_0_6_0: Run = {
  id: 'r060',
  request: 'Add a dark theme',
  revision: 1,
  state: 'working',
  vcs: 'jj',
  repo: '/repo',
  base: 'abc1234def5678',
  startedAt: AT,
  costAtStart: 1.5,
  workers: [
    {
      id: 'w1',
      agent: { type: 'meld:worker' },
      agentId: 'agent-1',
      path: '/tmp/meld/r060/w1',
      ref: 'w1@',
      state: 'working',
      briefed: true,
      seenRevision: 1,
      seenEntry: 4,
      activity: 'Edit theme.css',
      activityAt: AT + 4000,
      tokens: 1200,
      calls: 9,
    },
    {
      id: 'w2',
      agent: { type: 'meld:worker', model: 'sonnet' },
      agentId: 'agent-2',
      path: '/tmp/meld/r060/w2',
      ref: 'w2@',
      state: 'idle',
      briefed: true,
      seenRevision: 1,
      seenEntry: 4,
      activity: 'finished #1',
      activityAt: AT + 3000,
      tokens: 900,
      calls: 6,
    },
  ],
  tasks: [
    { id: 1, title: 'Theme tokens', detail: 'CSS variables', state: 'done', owner: 'w2', version: 3, commit: 'def5678', summary: 'Tokens added' },
    { id: 2, title: 'Dark toggle', detail: '', state: 'claimed', owner: 'w1', version: 2 },
    { id: 3, title: 'Docs', detail: '', state: 'open', version: 1 },
  ],
  log: [
    { id: 1, at: AT + 1000, by: 'w1', kind: 'task', text: 'added #1 Theme tokens; #2 Dark toggle; #3 Docs' },
    { id: 2, at: AT + 1500, by: 'w2', kind: 'task', text: 'claimed #1' },
    { id: 3, at: AT + 2000, by: 'w1', kind: 'task', text: 'claimed #2' },
    { id: 4, at: AT + 3000, by: 'w2', kind: 'task', text: 'finished #1: Tokens added', commit: 'def5678' },
  ],
  context: [{ id: 1, at: AT + 2500, kind: 'fact', by: 'w2', text: 'The theme lives in theme.css', files: ['src/theme.css'], seenBy: ['w1'] }],
  nudges: 0,
  taskList: 1,
}
