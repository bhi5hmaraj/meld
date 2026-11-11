import type { LaneKind, LanePart } from '../core/metrics'
import { PART_WORDS, partWords } from '../core/report'
import type { TimeSpan } from '../core/report'
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
export const BAR_WIDTH = 240
export const BAR_HEIGHT = 10
const BAR_GAP = 2

export function agentColor(index: number): { light: string; dark: string } {
  return AGENT_COLORS[index] ?? AGENT_COLORS[AGENT_COLORS.length - 1]!
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

export const FLOW_WIDTH = 240
export const FLOW_HEIGHT = 12
/** Each kind has its own height, so the parts of a lane read with no colour. A sleep is a band over the whole height. */
const PART_BOX: Record<Exclude<LaneKind, 'asleep'>, { y: number; height: number; paint: (fill: string) => string }> = {
  working: { y: 1, height: 10, paint: fill => `class="${fill}"` },
  merging: { y: 1, height: 10, paint: fill => `class="${fill}" opacity="0.5"` },
  waiting: { y: 3, height: 6, paint: () => `fill="${STATUS.warning}"` },
  idle: { y: 5, height: 2, paint: () => `fill="${MUTED}"` },
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
