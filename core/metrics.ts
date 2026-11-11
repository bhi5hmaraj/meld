import type { Activity } from '../types'

/** The classes of a command, in order: the first rule that matches wins (section 4.3 of docs/design/pane-metrics-logs.md). */
export const ACTIVITY_RULES: [Activity, RegExp][] = [
  ['tests', /\b(pytest|vitest|jest|bun test|go test|cargo test|npm test|npm run test|plugin test)\b/],
  ['builds', /\b(tsc|build|compile)\b|\b(npm|bun|pnpm|yarn|pip3?|uv|cargo|go|brew) (install|add|ci|i)\b/],
  ['app', /\blocalhost\b|\b127\.0\.0\.1\b|\b(npm|bun|pnpm|yarn) (run )?(dev|start)\b|\bdev server\b/],
  ['background', /\btail -f\b|\bsleep\b|\buntil\b/],
]
const BOARD_TOOL = /^mcp__(plugin_)?meld/
const BROWSER_TOOL = /browser|chrome|playwright/i
const NAMES_TESTS = /\btests?\b/i

/** The class of one tool call, for the time by activity and the words of a card. */
export function activityOf(tool: string, command = '', description = ''): Activity {
  if (BOARD_TOOL.test(tool)) return 'board'
  if (BROWSER_TOOL.test(tool)) return 'app'
  if (NAMES_TESTS.test(description)) return 'tests'
  return ACTIVITY_RULES.find(([, rule]) => rule.test(command))?.[0] ?? 'tools'
}
