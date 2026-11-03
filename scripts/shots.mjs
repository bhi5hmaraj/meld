#!/usr/bin/env node
// Draws the pictures of the README from the real pane: scripts/scenes.tsx mounts the pane on the desktop surface for
// sample runs and prints each drawn tree; this script lays each tree out as HTML and takes a picture in a light and a
// dark theme. The trees, the lanes and the bars are the ones meld draws; the fonts and the spacing stand in for the app.
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'docs', 'images')
const THEMES = ['light', 'dark']
const PANE_WIDTH = 520
const SPACE = { xs: 4, sm: 8, md: 12, lg: 18, xl: 24 }
const CELL = 8
const JUSTIFY = { 'space-between': 'space-between', center: 'center', 'flex-start': 'flex-start', 'flex-end': 'flex-end' }

const STYLE = `
:root { color-scheme: light; --pane: #ffffff; --line: #e4e2db; --text: #1f1e1d; --dim: #6f6d66; --button: #f4f3ee;
  --success: #2c7a39; --error: #ab2b3f; --warning: #966c1e; --suggestion: #5769f7; --inactive: #8a8880; --accent: #c96442; }
@media (prefers-color-scheme: dark) {
  :root { color-scheme: dark; --pane: #262624; --line: #3b3a37; --text: #ecebe6; --dim: #a3a199; --button: #30302d;
    --success: #4eba65; --error: #ff6b80; --warning: #ffc107; --suggestion: #b1b9f9; --inactive: #8f8d86; --accent: #d97757; }
}
html, body { margin: 0; background: transparent; }
.shot { display: inline-block; padding: 24px; }
.pane { width: ${PANE_WIDTH}px; box-sizing: border-box; padding: 18px; background: var(--pane); color: var(--text);
  border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.08);
  font: 13px/1.45 Inter, 'DejaVu Sans', sans-serif; }
.box { display: flex; min-width: 0; }
.text { flex: none; white-space: pre-wrap; }
.cut { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.dim { color: var(--dim); }
.bold { font-weight: 600; }
.tabular { font-variant-numeric: tabular-nums; }
.button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid var(--line); border-radius: 6px;
  background: var(--button); white-space: nowrap; font-size: 12.5px; }
.button.plain { padding: 0; border: 0; background: none; font-size: 13px; }
.button.primary { background: var(--accent); border-color: var(--accent); color: #ffffff; font-weight: 600; }
kbd { font: 11px 'JetBrains Mono', monospace; padding: 0 4px; border: 1px solid currentColor; border-radius: 4px; opacity: 0.7; }
.label { font-size: 12px; color: var(--dim); margin-bottom: 3px; }
.field { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 28px; box-sizing: border-box;
  padding: 4px 10px; border: 1px solid var(--line); border-radius: 6px; }
.select .field { min-width: 120px; }
svg { display: block; flex: none; }
pre { margin: 0; font: 12px/1.4 'JetBrains Mono', monospace; }
`

function plugin() {
  const folder = mkdtempSync(join(tmpdir(), 'meld-shots-'))
  for (const part of ['.claude-plugin', 'hooks', 'types']) cpSync(join(ROOT, part), join(folder, part), { recursive: true })
  mkdirSync(join(folder, 'tests'))
  cpSync(join(ROOT, 'scripts', 'scenes.tsx'), join(folder, 'tests', 'scenes.test.tsx'))
  return folder
}

/** The test runner prints what a test logs on stderr, and its report on stdout. */
function scenes(folder) {
  const ran = spawnSync('claude', ['plugin', 'test', folder], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (ran.status !== 0) throw new Error(`The scenes failed:\n${ran.stdout}\n${ran.stderr}`)
  return `${ran.stdout}\n${ran.stderr}`
    .split('\n')
    .filter(line => line.startsWith('SCENE '))
    .map(line => JSON.parse(line.slice('SCENE '.length)))
}

function escape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function space(value) {
  return typeof value === 'number' ? value * CELL : (SPACE[value] ?? 0)
}

function color(value) {
  return value.startsWith('#') ? value : `var(--${value})`
}

function children(node) {
  return (node.children ?? []).map(html).join('')
}

function boxStyle(props) {
  const style = [`flex-direction: ${props.flexDirection ?? 'row'}`]
  if (props.gap !== undefined) style.push(`gap: ${space(props.gap)}px`)
  if (props.justifyContent) style.push(`justify-content: ${JUSTIFY[props.justifyContent] ?? props.justifyContent}`)
  if (props.alignItems) style.push(`align-items: ${props.alignItems}`)
  if (props.flexWrap) style.push(`flex-wrap: ${props.flexWrap}`)
  if (props.paddingLeft) style.push(`padding-left: ${space(props.paddingLeft)}px`)
  if (props.paddingX) style.push(`padding-left: ${space(props.paddingX)}px; padding-right: ${space(props.paddingX)}px`)
  if (props.paddingY) style.push(`padding-top: ${space(props.paddingY)}px; padding-bottom: ${space(props.paddingY)}px`)
  if (props.borderStyle) style.push(`border: 1px solid ${color(props.borderColor ?? 'line')}; border-radius: 10px`)
  return style.join('; ')
}

function textClass(props) {
  return ['text', props.dimColor ? 'dim' : '', props.bold || props.weight ? 'bold' : '', props.tabular ? 'tabular' : '', props.wrap?.startsWith('truncate') ? 'cut' : '']
    .filter(Boolean)
    .join(' ')
}

function button(props) {
  const kind = ['button', props.plain ? 'plain' : '', props.variant === 'primary' ? 'primary' : '', props.dimColor ? 'dim' : ''].filter(Boolean).join(' ')
  const hotkey = props.hotkey ? `<kbd>${escape(props.hotkey)}</kbd>` : ''
  return `<span class="${kind}">${escape(props.label ?? '')}${hotkey}</span>`
}

/** The app draws submitLabel beside a field that has the focus; a picture shows no focus. */
function input(props) {
  const shown = props.value ? escape(props.value) : `<span class="dim">${escape(props.placeholder ?? '')}</span>`
  return `<div><div class="label">${escape(props.label ?? '')}</div><div class="field">${shown}</div></div>`
}

function select(props) {
  const picked = props.options?.find(option => option.value === props.value)?.label ?? props.value
  return `<div class="select"><div class="label">${escape(props.label ?? '')}</div><div class="field">${escape(picked)}<span class="dim">▾</span></div></div>`
}

function code(props) {
  const lines = String(props.source ?? '').split('\n')
  return `<pre>${lines.map(line => `<span style="color: ${line.startsWith('+') ? 'var(--success)' : line.startsWith('-') ? 'var(--error)' : 'inherit'}">${escape(line)}</span>`).join('\n')}</pre>`
}

function html(node) {
  if (typeof node === 'string') return escape(node)
  const props = node.props ?? {}
  if (node.type === 'Box') return `<div class="box" style="${boxStyle(props)}">${children(node)}</div>`
  if (node.type === 'Text') return `<span class="${textClass(props)}"${props.color ? ` style="color: ${color(props.color)}"` : ''}>${children(node)}</span>`
  if (node.type === 'Button') return button(props)
  if (node.type === 'Input') return input(props)
  if (node.type === 'Select') return select(props)
  if (node.type === 'Svg') return props.source
  if (node.type === 'Code') return code(props)
  throw new Error(`The stand-in draws no ${node.type}.`)
}

function page(tree) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body><div class="shot"><div class="pane">${html(tree)}</div></div></body></html>`
}

async function photograph(browser, scene, folder) {
  const file = join(folder, `${scene.scene}.html`)
  writeFileSync(file, page(scene.tree))
  for (const theme of THEMES) {
    const context = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2, viewport: { width: PANE_WIDTH + 80, height: 400 } })
    const view = await context.newPage()
    await view.goto(`file://${file}`)
    await view.locator('.shot').screenshot({ path: join(OUT, `${scene.scene}-${theme}.png`), omitBackground: true })
    await context.close()
  }
}

const folder = plugin()
try {
  const drawn = scenes(folder)
  if (!drawn.length) throw new Error('scripts/scenes.tsx printed no scene.')
  mkdirSync(OUT, { recursive: true })
  const { chromium } = createRequire(import.meta.url)('playwright')
  const browser = await chromium.launch()
  for (const scene of drawn) await photograph(browser, scene, folder)
  await browser.close()
  console.log(`Wrote ${drawn.length * THEMES.length} pictures to docs/images.`)
} finally {
  rmSync(folder, { recursive: true, force: true })
}
