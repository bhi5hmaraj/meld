import { expect, test } from 'claude-code/testing'

import { activityOf } from '../core/metrics'

const BASH = 'Bash'

test('a command takes the first class of the table: tests, builds, app, background, then tools', () => {
  expect(activityOf(BASH, 'bun test mcp/')).toBe('tests')
  expect(activityOf(BASH, 'cd web && npm run test -- --watch=false')).toBe('tests')
  expect(activityOf(BASH, 'python -m pytest -q')).toBe('tests')
  expect(activityOf(BASH, 'npx -y -p typescript@5.9 tsc -p tsconfig.core.json')).toBe('builds')
  expect(activityOf(BASH, 'npm install')).toBe('builds')
  expect(activityOf(BASH, 'cargo build --release')).toBe('builds')
  expect(activityOf(BASH, 'curl -s http://localhost:3000/health')).toBe('app')
  expect(activityOf(BASH, 'npm run dev')).toBe('app')
  expect(activityOf(BASH, 'tail -f server.log')).toBe('background')
  expect(activityOf(BASH, 'until test -f done; do sleep 2; done')).toBe('background')
  expect(activityOf(BASH, 'git log --oneline')).toBe('tools')
})

test('a command that matches two rules takes the first', () => {
  expect(activityOf(BASH, 'npm run build && npm test')).toBe('tests')
  expect(activityOf(BASH, 'until curl -s localhost:3000; do sleep 1; done')).toBe('app')
})

test('a description that names tests makes the command a test run', () => {
  expect(activityOf(BASH, './check.sh', 'Run the unit tests')).toBe('tests')
})

test('the board tools, the browser tools and the other tools have their own class', () => {
  expect(activityOf('mcp__meld__finish_task')).toBe('board')
  expect(activityOf('mcp__plugin_meld_board__read_board')).toBe('board')
  expect(activityOf('mcp__browser__navigate')).toBe('app')
  expect(activityOf('Read')).toBe('tools')
  expect(activityOf('Edit')).toBe('tools')
})
