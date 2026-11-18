import { join } from 'node:path'

/** The permission profile of Codex that codex-sandbox.sh defines for a meld worker. */
const PROFILE = 'meld-worker'
const WRAPPER = join(import.meta.dir, 'codex-sandbox.sh')

/** What the board says when the first Codex worker of a run starts: what its sandbox opens, and what it refuses. */
export const CODEX_SANDBOX_NOTE = `Codex workers run in the sandbox profile ${PROFILE}: their folder, the network, local ports, shared memory, ~/.cache and ~/.npm are open. ps and sysctl are refused: use uptime, vm_stat and getconf _NPROCESSORS_ONLN.`

/**
 * The environment of the ACP agent `name`: for Codex, the adapter runs Codex through the wrapper, and starts its session
 * in the profile. In the default sandbox of Codex, each check that needs the network, a local port or a cache failed
 * once, and passed again only after an approved escalation.
 */
export function agentEnv(name: string, env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  if (name !== 'codex') return {}
  return { CODEX_PATH: WRAPPER, INITIAL_AGENT_MODE: `permission-profile:${PROFILE}`, ...(env.CODEX_PATH ? { MELD_REAL_CODEX: env.CODEX_PATH } : {}) }
}
