import { ACP_AGENTS } from '../core/options'

/**
 * The commands of the ACP agents that `meld mcp` runs: the built-in agents, and the agents of MELD_ACP_AGENTS, a JSON
 * object from a name to the command and its arguments, such as {"gemini":["gemini","--experimental-acp"]}. A name of
 * MELD_ACP_AGENTS replaces a built-in agent of that name, and an entry that is no list of texts is left out.
 */
export function acpCommands(json: string | undefined): Readonly<Record<string, readonly string[]>> {
  const given = parsed(json)
  const valid = Object.entries(given).filter((entry): entry is [string, string[]] => isCommand(entry[1]))
  return { ...ACP_AGENTS, ...Object.fromEntries(valid) }
}

function parsed(json: string | undefined): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || '{}')
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function isCommand(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string' && part !== '')
}
