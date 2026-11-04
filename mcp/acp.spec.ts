import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AcpAgent } from './acp'
import type { AcpUpdate, PermissionAsk } from './acp'

const STUB = ['bun', join(import.meta.dir, 'stub-agent.spec-helper.ts')]
const MELD_SERVER = { name: 'meld', command: 'bun', args: ['main.ts', '--worker'], env: { MELD_WORKER: 'w1' } }
const folders: string[] = []
const agents: AcpAgent[] = []

function newFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'meld-acp-'))
  folders.push(folder)
  return folder
}

function texts(updates: readonly AcpUpdate[]): string[] {
  return updates.map(update => update.text)
}

async function until(check: () => boolean): Promise<void> {
  for (let wait = 0; wait < 200 && !check(); wait++) await Bun.sleep(5)
  if (!check()) throw new Error('the update did not come')
}

async function started(folder: string, updates: AcpUpdate[], asks: PermissionAsk[] = []): Promise<AcpAgent> {
  const agent = await AcpAgent.start({
    command: STUB,
    cwd: folder,
    mcpServers: [MELD_SERVER],
    onUpdate: update => updates.push(update),
    decide: ask => {
      asks.push(ask)
      return ask.paths.every(path => path.startsWith(`${folder}/`)) ? 'allow' : 'reject'
    },
  })
  agents.push(agent)
  return agent
}

afterEach(async () => {
  for (const agent of agents.splice(0)) await agent.stop()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

test('the runner starts an ACP agent with a session in the folder of the worker and its MCP servers', async () => {
  const folder = newFolder()
  const updates: AcpUpdate[] = []
  const agent = await started(folder, updates)
  expect(agent.sessionId).toBe('stub-session')
  expect(agent.state).toBe('idle')
  await until(() => texts(updates).includes(`session in ${folder} with meld`))
})

test('a prompt gives the updates of the agent and ends with its stop reason', async () => {
  const folder = newFolder()
  const updates: AcpUpdate[] = []
  const agent = await started(folder, updates)
  expect(await agent.prompt('Add a file')).toBe('end_turn')
  expect(texts(updates)).toContain('turn 1: Add a file')
  expect(updates).toContainEqual({ kind: 'tool_call', text: `Edit ${folder}/a.txt`, status: 'pending', toolCallId: 't1' })
  expect(updates).toContainEqual({ kind: 'tool_call_update', text: '', status: 'completed', toolCallId: 't1' })
  expect(agent.state).toBe('idle')
})

test('a permission request gets the verdict of the runner: an edit outside the folder is refused', async () => {
  const folder = newFolder()
  const updates: AcpUpdate[] = []
  const asks: PermissionAsk[] = []
  const agent = await started(folder, updates, asks)
  expect(await agent.prompt('Edit outside')).toBe('end_turn')
  expect(asks).toEqual([{ title: 'Edit /etc/stub-agent.txt', kind: 'edit', paths: ['/etc/stub-agent.txt'] }])
  expect(updates).toContainEqual({ kind: 'tool_call_update', text: '', status: 'failed', toolCallId: 't1' })
})

test('a second prompt continues the same session', async () => {
  const updates: AcpUpdate[] = []
  const agent = await started(newFolder(), updates)
  await agent.prompt('one')
  expect(await agent.prompt('two')).toBe('end_turn')
  expect(texts(updates)).toContain('turn 2: two')
})

test('a cancel ends the prompt as cancelled, and a prompt while another runs is refused', async () => {
  const updates: AcpUpdate[] = []
  const agent = await started(newFolder(), updates)
  const waiting = agent.prompt('wait')
  await until(() => texts(updates).includes('turn 1: wait'))
  expect(agent.state).toBe('busy')
  expect(await agent.prompt('again').then(() => 'ran', (error: unknown) => String(error))).toContain('runs a prompt')
  agent.cancel()
  expect(await waiting).toBe('cancelled')
})

test('an agent that exits ends its prompt with the exit code, and the runner is ended', async () => {
  const updates: AcpUpdate[] = []
  const agent = await started(newFolder(), updates)
  expect(await agent.prompt('crash').then(() => 'ran', (error: unknown) => String(error))).toContain('exited with code 3')
  expect(agent.state).toBe('ended')
  expect(await agent.exited).toBe(3)
})

test('a stop ends the agent', async () => {
  const agent = await started(newFolder(), [])
  await agent.stop()
  expect(agent.state).toBe('ended')
  expect(await agent.prompt('late').then(() => 'ran', (error: unknown) => String(error))).toContain('ended')
})
