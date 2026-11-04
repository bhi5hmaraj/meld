import { expect, test } from 'claude-code/testing'

import { agentsOf, formatStart, parseStart, WORKER_TYPE } from '../core/options'

test('a task alone starts two meld workers and lets meld choose the version control', () => {
  expect(parseStart('Add a dark theme')).toEqual({
    request: 'Add a dark theme',
    agents: [{ type: WORKER_TYPE }, { type: WORKER_TYPE }],
    vcs: 'auto',
  })
})

test('a count and a model give that many workers on that model', () => {
  expect(parseStart('--agents 3 --model sonnet Add a dark theme')).toMatchObject({
    request: 'Add a dark theme',
    agents: [
      { type: WORKER_TYPE, model: 'sonnet' },
      { type: WORKER_TYPE, model: 'sonnet' },
      { type: WORKER_TYPE, model: 'sonnet' },
    ],
  })
})

test('a list gives one worker per item: a model, a type with a model, or a type', () => {
  expect(parseStart('--agents opus,general-purpose@haiku,Explore,meld:worker@sonnet Add a dark theme')).toMatchObject({
    agents: [
      { type: WORKER_TYPE, model: 'opus' },
      { type: 'general-purpose', model: 'haiku' },
      { type: 'Explore' },
      { type: WORKER_TYPE, model: 'sonnet' },
    ],
  })
})

test('the model option fills the list items that name no model', () => {
  expect(parseStart('--agents Explore,general-purpose@haiku --model opus Add a dark theme')).toMatchObject({
    agents: [{ type: 'Explore', model: 'opus' }, { type: 'general-purpose', model: 'haiku' }],
  })
})

test('the model inherit gives workers that name no model', () => {
  expect(parseStart('--agents 3 --model inherit Add a dark theme')).toStrictEqual({
    request: 'Add a dark theme',
    agents: [{ type: WORKER_TYPE }, { type: WORKER_TYPE }, { type: WORKER_TYPE }],
    vcs: 'auto',
  })
})

test('the model inherit keeps the models that a list names', () => {
  expect(parseStart('--agents opus,Explore,general-purpose@haiku --model inherit Add a dark theme')).toStrictEqual({
    request: 'Add a dark theme',
    agents: [{ type: WORKER_TYPE, model: 'opus' }, { type: 'Explore' }, { type: 'general-purpose', model: 'haiku' }],
    vcs: 'auto',
  })
})

test('a start on the model inherit names no model in the options of /meld', () => {
  expect(formatStart({ request: 'Add a dark theme', agents: agentsOf(2, 'inherit'), vcs: 'auto' })).toBe('--agents meld:worker,meld:worker --vcs auto Add a dark theme')
})

test('the version control can be chosen', () => {
  expect(parseStart('--vcs git Add a dark theme')).toMatchObject({ vcs: 'git' })
  expect(parseStart('--vcs jj Add a dark theme')).toMatchObject({ vcs: 'jj' })
})

test('the path of another repository stays in the request for the run to resolve', () => {
  expect(parseStart('--agents 2 /elsewhere Add a dark theme')).toMatchObject({ request: '/elsewhere Add a dark theme' })
})

test('more than eight workers is refused', () => {
  expect(parseStart('--agents 9 Add a dark theme')).toEqual({ error: 'meld runs 1 to 8 workers.' })
})

test('zero workers is refused', () => {
  expect(parseStart('--agents 0 Add a dark theme')).toEqual({ error: 'meld runs 1 to 8 workers.' })
})

test('an unknown option is refused', () => {
  expect(parseStart('--color red Add a dark theme')).toEqual({ error: 'meld has no option --color.' })
})

test('an unknown version control is refused', () => {
  expect(parseStart('--vcs svn Add a dark theme')).toEqual({ error: 'Use --vcs auto, jj or git.' })
})

test('options with no task are refused', () => {
  expect(parseStart('--agents 3')).toEqual({ error: 'Write the task after /meld.' })
})

test('the options of a start read back as the same start', () => {
  const starts = [
    { request: 'Add a dark theme', agents: [{ type: WORKER_TYPE }, { type: WORKER_TYPE }], vcs: 'auto' as const },
    { request: '/elsewhere Add docs', agents: [{ type: WORKER_TYPE, model: 'opus' }, { type: 'general-purpose', model: 'haiku' }, { type: 'Explore' }], vcs: 'git' as const },
    { request: 'Fix the tests', agents: [{ type: WORKER_TYPE, model: 'claude-sonnet-5-5' }], vcs: 'jj' as const },
  ]
  for (const start of starts) expect(parseStart(formatStart(start))).toEqual(start)
})
