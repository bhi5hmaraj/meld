import type { CommitFact, Entry, LaneFacts } from '../types'
import type { LaneKind, LanePart } from '../core/metrics'
import { floored } from '../core/progress'
import type { Parts } from '../core/progress'

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
export const ROW_BAR_WIDTH = 64
export const BAR_HEIGHT = 10
const LANE_Y = 13
const FIRST_X = 20
const MAX_STEP = 16
const MAX_DOTS = 12
const BAR_GAP = 2

export type LaneMarks = { lane: LaneFacts; color: number; checks: Entry[]; final?: string }

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

/** The work of a task or of the request as one bar: done, claimed and open, with a gap between the parts. */
export function partsBarSvg(shares: Parts, width = BAR_WIDTH): string {
  const total = shares.done + shares.claimed + shares.open
  if (!total) return svg(width, BAR_HEIGHT, [`<rect x="0" y="2" width="${width}" height="6" rx="3" fill="${MUTED}" opacity="0.35"/>`])
  const parts = [`<style>${colorRule('progress', 'fill', PROGRESS)}</style>`]
  const segments: [number, string][] = [
    [shares.done, `fill="${STATUS.good}"`],
    [shares.claimed, 'class="progress"'],
    [shares.open, `fill="${MUTED}"`],
  ]
  const shown = segments.filter(([share]) => share > 0)
  const room = width - BAR_GAP * (shown.length - 1)
  let x = 0
  for (const [share, paint] of shown) {
    const part = Math.max(4, (room * share) / total)
    parts.push(`<rect x="${round(x)}" y="1" width="${round(part)}" height="8" rx="3" ${paint}/>`)
    x += part + BAR_GAP
  }
  return svg(width, BAR_HEIGHT, parts)
}

/** The same bar in text cells. The done cells are cut down, so a full bar means that all the work is done. */
export function barCells(shares: Parts, cells: number): Parts {
  const done = floored(cells * shares.done)
  const claimed = Math.min(cells - done, Math.round(cells * shares.claimed))
  return { done, claimed, open: cells - done - claimed }
}

/** A span of time, as a Flow window or a sleep of the machine. */
export type TimeSpan = { from: number; to: number }

/** The shape of each kind of part of a Flow lane on the terminal, so each kind reads with no colour. */
export const FLOW_SHAPE: Record<LaneKind, string> = { working: '█', merging: '◆', waiting: '▒', idle: '·', asleep: 'z' }
export const FLOW_CELLS = 30
export const FLOW_WIDTH = 240
export const FLOW_HEIGHT = 12
const PART_WORDS: Record<LaneKind, string> = { working: 'working', merging: 'merging', waiting: 'waiting on meld', idle: 'idle', asleep: 'asleep' }
const TASK_WORDS: Partial<Record<LaneKind, string>> = { working: ' on #', merging: ' #' }
export const FLOW_LEGEND = (Object.keys(FLOW_SHAPE) as LaneKind[]).map(kind => `${FLOW_SHAPE[kind]} ${PART_WORDS[kind]}`).join('  ')
/** Each kind has its own height, so the parts of a lane read with no colour. A sleep is a band over the whole height. */
const PART_BOX: Record<Exclude<LaneKind, 'asleep'>, { y: number; height: number; paint: (fill: string) => string }> = {
  working: { y: 1, height: 10, paint: fill => `class="${fill}"` },
  merging: { y: 1, height: 10, paint: fill => `class="${fill}" opacity="0.5"` },
  waiting: { y: 3, height: 6, paint: () => `fill="${STATUS.warning}"` },
  idle: { y: 5, height: 2, paint: () => `fill="${MUTED}"` },
}

/** The parts of a lane inside the window, cut at its edges. */
export function partsIn(parts: readonly LanePart[], window: TimeSpan): LanePart[] {
  return parts.flatMap(part => {
    const from = Math.max(part.from, window.from)
    const to = Math.min(part.to, window.to)
    return to > from ? [{ ...part, from, to }] : []
  })
}

export function partWords(part: LanePart): string {
  if (part.kind === 'idle' && part.reason === 'background') return 'waiting for its background work'
  const join = TASK_WORDS[part.kind]
  const task = join && part.task !== undefined ? `${join}${part.task}` : ''
  const reason = part.kind === 'waiting' && part.reason ? `: ${part.reason}` : ''
  return `${PART_WORDS[part.kind]}${task}${reason}`
}

/**
 * A Flow lane in text cells over the window: each cell shows the kind that covers the most of its time. The sleeps of the
 * machine cover every lane, and a cell outside the worker time is a space.
 */
export function flowCells(parts: readonly LanePart[], sleeps: readonly TimeSpan[], window: TimeSpan, cells: number): string {
  const size = (window.to - window.from) / cells
  const covers = [...parts.filter(part => part.kind !== 'asleep'), ...sleeps.map(span => ({ ...span, kind: 'asleep' as const }))]
  return Array.from({ length: cells }, (_, index) => {
    const from = window.from + index * size
    const to = from + size
    const ms = new Map<LaneKind, number>()
    for (const part of covers) {
      const overlap = Math.min(to, part.to) - Math.max(from, part.from)
      if (overlap > 0) ms.set(part.kind, (ms.get(part.kind) ?? 0) + overlap)
    }
    const top = [...ms].reduce<[LaneKind, number] | undefined>((best, one) => (!best || one[1] > best[1] ? one : best), undefined)
    return top ? FLOW_SHAPE[top[0]] : ' '
  }).join('')
}

/** A Flow lane as a picture over the window, in the colour of its agent, with the sleeps of the machine as bands. */
export function flowSvg(parts: readonly LanePart[], sleeps: readonly TimeSpan[], window: TimeSpan, color: number): string {
  const fill = `f${color}`
  const scale = FLOW_WIDTH / Math.max(1, window.to - window.from)
  const xOf = (at: number) => round((Math.min(Math.max(at, window.from), window.to) - window.from) * scale)
  const rect = (span: TimeSpan, y: number, height: number, paint: string, title: string) =>
    `<rect x="${xOf(span.from)}" y="${y}" width="${round(xOf(span.to) - xOf(span.from))}" height="${height}" ${paint}><title>${escapeXml(title)}</title></rect>`
  const marks = parts.flatMap(part => {
    if (part.kind === 'asleep') return []
    const box = PART_BOX[part.kind]
    return [rect(part, box.y, box.height, box.paint(fill), partWords(part))]
  })
  const bands = sleeps.filter(span => span.to > window.from && span.from < window.to).map(span => rect(span, 0, FLOW_HEIGHT, `fill="${MUTED}" opacity="0.3"`, PART_WORDS.asleep))
  return svg(FLOW_WIDTH, FLOW_HEIGHT, [`<style>${colorRule(fill, 'fill', agentColor(color))}</style>`, ...marks, ...bands])
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
