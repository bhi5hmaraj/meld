import { expect, test } from 'bun:test'
import { join } from 'node:path'

import { agentEnv, CODEX_SANDBOX_NOTE } from './codex-sandbox'

const WRAPPER = join(import.meta.dir, 'codex-sandbox.sh')

test('a Codex worker runs Codex through the wrapper, in the permission profile of a meld worker', () => {
  expect(agentEnv('codex', {})).toEqual({ CODEX_PATH: WRAPPER, INITIAL_AGENT_MODE: 'permission-profile:meld-worker' })
})

test('a Codex path of the person stays the Codex that the wrapper runs', () => {
  expect(agentEnv('codex', { CODEX_PATH: '/opt/codex' })).toMatchObject({ CODEX_PATH: WRAPPER, MELD_REAL_CODEX: '/opt/codex' })
})

test('an ACP agent other than Codex gets no sandbox settings', () => {
  expect(agentEnv('gemini', {})).toEqual({})
})

test('the wrapper runs Codex with its arguments, then the profile: network, local ports and the tool caches open', async () => {
  const ran = Bun.spawnSync([WRAPPER, 'app-server'], { env: { ...process.env, HOME: '/home/me', MELD_REAL_CODEX: '/bin/echo' } })
  expect(ran.stdout.toString().trim()).toBe(
    'app-server -c default_permissions="meld-worker" -c permissions.meld-worker.extends=":workspace" -c permissions.meld-worker.network.enabled=true -c permissions.meld-worker.network.allow_local_binding=true -c permissions.meld-worker.filesystem={"/home/me/.cache"="write", "/home/me/.npm"="write"}',
  )
})

test('the note of the board names what the sandbox opens and what it refuses', () => {
  expect(CODEX_SANDBOX_NOTE).toBe(
    'Codex workers run in the sandbox profile meld-worker: their folder, the network, local ports, shared memory, ~/.cache and ~/.npm are open. ps and sysctl are refused: use uptime, vm_stat and getconf _NPROCESSORS_ONLN.',
  )
})
