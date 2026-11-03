import type { CommitFact, Entry, LaneFacts } from '../types'

/** The categorical palette in its validated order, one hue per worker; light and dark steps of the same hue. */
export const AGENT_COLORS = [
  { light: '#2a78d6', dark: '#3987e5' },
  { light: '#eb6834', dark: '#d95926' },
  { light: '#1baf7a', dark: '#199e70' },
  { light: '#eda100', dark: '#c98500' },
  { light: '#e87ba4', dark: '#d55181' },
  { light: '#008300', dark: '#008300' },
  { light: '#6250d6', dark: '#9085e9' },
  { light: '#e34948', dark: '#e66767' },
] as const

/** Status colors, never used for a worker; each one ships with a shape or a word beside it. */
export const STATUS = { good: '#0ca30c', warning: '#fab219', critical: '#d03b3b' } as const

const MUTED = '#898781'
const PROGRESS = { light: '#2a78d6', dark: '#3987e5' }
export const LANE_WIDTH = 200
export const LANE_HEIGHT = 20
export const BAR_WIDTH = 240
export const BAR_HEIGHT = 10
const LANE_Y = 13
const FIRST_X = 20
const MAX_STEP = 16
const MAX_DOTS = 12
const BAR_GAP = 2

export type LaneMarks = { lane: LaneFacts; color: number; checks: Entry[]; final?: string }
export type TaskCounts = { done: number; doing: number; open: number }

export function agentColor(index: number): { light: string; dark: string } {
  return AGENT_COLORS[index] ?? AGENT_COLORS[AGENT_COLORS.length - 1]!
}

/**
 * One worker's lane: the base on the left, then its commits oldest to newest, with a check mark above a commit a check
 * ran on, a cross on a conflict, a diamond for a merge, a star for the final commit, and a hollow dot for edits not committed.
 */
export function laneSvg(marks: LaneMarks): string {
  const color = agentColor(marks.color)
  const fill = `f${marks.color}`
  const stroke = `s${marks.color}`
  const commits = [...marks.lane.commits].reverse().slice(-MAX_DOTS)
  const slots = commits.length + (marks.lane.edits ? 1 : 0)
  const step = Math.min(MAX_STEP, (LANE_WIDTH - FIRST_X - 10) / Math.max(1, slots))
  const xs = commits.map((_, index) => FIRST_X + index * step)
  const editsX = FIRST_X + commits.length * step
  const lastX = marks.lane.edits ? editsX : (xs.at(-1) ?? 6)
  const parts = [
    `<style>${colorRule(fill, 'fill', color)}${colorRule(stroke, 'stroke', color)}</style>`,
    `<line x1="6" y1="${LANE_Y}" x2="${lastX}" y2="${LANE_Y}" stroke-width="2" class="${stroke}"/>`,
    `<circle cx="6" cy="${LANE_Y}" r="3" fill="${MUTED}"><title>base</title></circle>`,
    ...commits.map((commit, index) => commitMark(commit, xs[index] ?? FIRST_X, marks, fill)),
  ]
  if (marks.lane.edits) parts.push(`<circle cx="${editsX}" cy="${LANE_Y}" r="4" fill="none" stroke-width="2" stroke-dasharray="2 1.5" class="${stroke}"><title>edits not committed</title></circle>`)
  return svg(LANE_WIDTH, LANE_HEIGHT, parts)
}

export function laneAlt(id: string, lane: LaneFacts): string {
  const commits = lane.commits.length
  return `${id}: ${commits} ${commits === 1 ? 'commit' : 'commits'}${lane.edits ? ', edits not committed' : ''}`
}

/** The same lane in glyphs, for a surface with no Svg. */
export function laneGlyphs(marks: LaneMarks): string {
  const commits = [...marks.lane.commits].reverse().slice(-MAX_DOTS)
  const glyphs = commits.map(commit => (commit.commit === marks.final ? '★' : commit.conflict ? '✕' : commit.parents > 1 ? '◆' : '●'))
  return `·${glyphs.join('')}${marks.lane.edits ? '○' : ''}`
}

/** The tasks as one bar: done, in progress and open, with a gap between the parts. */
export function taskBarSvg(counts: TaskCounts): string {
  const total = counts.done + counts.doing + counts.open
  if (!total) return svg(BAR_WIDTH, BAR_HEIGHT, [`<rect x="0" y="2" width="${BAR_WIDTH}" height="6" rx="3" fill="${MUTED}" opacity="0.35"/>`])
  const parts = [`<style>${colorRule('progress', 'fill', PROGRESS)}</style>`]
  const segments: [number, string][] = [
    [counts.done, `fill="${STATUS.good}"`],
    [counts.doing, 'class="progress"'],
    [counts.open, `fill="${MUTED}"`],
  ]
  const shown = segments.filter(([count]) => count > 0)
  const room = BAR_WIDTH - BAR_GAP * (shown.length - 1)
  let x = 0
  for (const [count, paint] of shown) {
    const width = Math.max(4, (room * count) / total)
    parts.push(`<rect x="${round(x)}" y="1" width="${round(width)}" height="8" rx="3" ${paint}/>`)
    x += width + BAR_GAP
  }
  return svg(BAR_WIDTH, BAR_HEIGHT, parts)
}

/** One commit on a lane, painted with the fill class of its agent: classes differ per lane, so lanes drawn in one page keep their colors. */
function commitMark(commit: CommitFact, x: number, marks: LaneMarks, fill: string): string {
  const title = `<title>${escapeXml(`${commit.commit.slice(0, 7)} · ${commit.subject}`)}</title>`
  const dot =
    commit.commit === marks.final
      ? `<path d="${starPath(x, LANE_Y, 6.5, 2.8)}" class="${fill}">${title}</path>`
      : commit.parents > 1
        ? `<rect x="${round(x - 4)}" y="${LANE_Y - 4}" width="8" height="8" transform="rotate(45 ${round(x)} ${LANE_Y})" class="${fill}">${title}</rect>`
        : `<circle cx="${round(x)}" cy="${LANE_Y}" r="4.5" class="${fill}">${title}</circle>`
  const check = latestCheck(marks.checks, commit.commit)
  const above = check === undefined ? '' : check ? checkMark(x) : crossMark(x, 4, STATUS.critical)
  const conflict = commit.conflict ? crossMark(x, LANE_Y, STATUS.critical) : ''
  return `${dot}${above}${conflict}`
}

function latestCheck(checks: Entry[], commit: string): boolean | undefined {
  const last = checks.filter(entry => entry.commit === commit).at(-1)
  return last?.passed
}

function checkMark(x: number): string {
  return `<path d="M${round(x - 3)} 3.5 L${round(x - 0.8)} 6 L${round(x + 3.2)} 1.5" fill="none" stroke="${STATUS.good}" stroke-width="1.8" stroke-linecap="round"/>`
}

function crossMark(x: number, y: number, color: string): string {
  return `<path d="M${round(x - 2.5)} ${y - 2.5} L${round(x + 2.5)} ${y + 2.5} M${round(x + 2.5)} ${y - 2.5} L${round(x - 2.5)} ${y + 2.5}" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`
}

function starPath(cx: number, cy: number, outer: number, inner: number): string {
  const points = Array.from({ length: 10 }, (_, index) => {
    const radius = index % 2 ? inner : outer
    const angle = (Math.PI / 5) * index - Math.PI / 2
    return `${round(cx + radius * Math.cos(angle))} ${round(cy + radius * Math.sin(angle))}`
  })
  return `M${points.join(' L')} Z`
}

function colorRule(name: string, property: 'fill' | 'stroke', color: { light: string; dark: string }): string {
  return `.${name}{${property}:${color.light}}@media (prefers-color-scheme: dark){.${name}{${property}:${color.dark}}}`
}

function svg(width: number, height: number, parts: string[]): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${parts.join('')}</svg>`
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
