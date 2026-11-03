import { expect, test } from 'claude-code/testing'

import { laneSvg, taskBarSvg } from '../hooks/drawing'

const LANE = { id: 'w2' as const, commits: [{ commit: 'f'.repeat(40), subject: 'Add add()', parents: 1, conflict: false }], edits: true }

test('each lane names its color classes after its agent, so lanes in one page keep their colors', () => {
  const second = laneSvg({ lane: LANE, color: 1, checks: [] })
  expect(second).toContain('.f1{fill:#eb6834}')
  expect(second).toContain('class="f1"')
  expect(second).not.toContain('class="f"')
  expect(laneSvg({ lane: LANE, color: 2, checks: [] })).toContain('.f2{fill:#1baf7a}')
})

test('the task bar names its progress class apart from the lanes', () => {
  expect(taskBarSvg({ done: 1, doing: 1, open: 1 })).toContain('class="progress"')
})
