import { expect, test } from 'claude-code/testing'

import { barCells, laneSvg, partsBarSvg, ROW_BAR_WIDTH } from '../hooks/drawing'

const LANE = { id: 'w2' as const, commits: [{ commit: 'f'.repeat(40), subject: 'Add add()', parents: 1, conflict: false }], edits: true }

test('each lane names its color classes after its agent, so lanes in one page keep their colors', () => {
  const second = laneSvg({ lane: LANE, color: 1, checks: [] })
  expect(second).toContain('.f1{fill:#eb6834}')
  expect(second).toContain('class="f1"')
  expect(second).not.toContain('class="f"')
  expect(laneSvg({ lane: LANE, color: 2, checks: [] })).toContain('.f2{fill:#1baf7a}')
})

test('the parts bar names its progress class apart from the lanes', () => {
  expect(partsBarSvg({ done: 1, claimed: 1, open: 1 })).toContain('class="progress"')
})

test('the bar of a row has the width it is given', () => {
  expect(partsBarSvg({ done: 0.5, claimed: 0, open: 0.5 }, ROW_BAR_WIDTH)).toContain(`width="${ROW_BAR_WIDTH}"`)
})

test('the done cells of a text bar are cut down, so a full bar means that all is done', () => {
  expect(barCells({ done: 1, claimed: 0, open: 0 }, 8)).toEqual({ done: 8, claimed: 0, open: 0 })
  expect(barCells({ done: 0.99, claimed: 0, open: 0.01 }, 8)).toEqual({ done: 7, claimed: 0, open: 1 })
  expect(barCells({ done: 4 / 12, claimed: 7 / 12, open: 1 / 12 }, 24)).toEqual({ done: 8, claimed: 14, open: 2 })
})

test('a text bar with no parts is an open track', () => {
  expect(barCells({ done: 0, claimed: 0, open: 0 }, 8)).toEqual({ done: 0, claimed: 0, open: 8 })
})
