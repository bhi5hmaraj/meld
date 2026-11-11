import { expect, test } from 'claude-code/testing'

import { barCells, partsBarSvg } from '../hooks/drawing'

test('the parts bar names its progress class apart from the lanes', () => {
  expect(partsBarSvg({ done: 1, claimed: 1, open: 1 })).toContain('class="progress"')
})

test('a parts bar has the width it is given', () => {
  expect(partsBarSvg({ done: 0.5, claimed: 0, open: 0.5 }, 64)).toContain('width="64"')
})

test('the done cells of a text bar are cut down, so a full bar means that all is done', () => {
  expect(barCells({ done: 1, claimed: 0, open: 0 }, 8)).toEqual({ done: 8, claimed: 0, open: 0 })
  expect(barCells({ done: 0.99, claimed: 0, open: 0.01 }, 8)).toEqual({ done: 7, claimed: 0, open: 1 })
  expect(barCells({ done: 4 / 12, claimed: 7 / 12, open: 1 / 12 }, 24)).toEqual({ done: 8, claimed: 14, open: 2 })
})

test('a text bar with no parts is an open track', () => {
  expect(barCells({ done: 0, claimed: 0, open: 0 }, 8)).toEqual({ done: 0, claimed: 0, open: 8 })
})
