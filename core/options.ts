import type { AgentSpec, VcsChoice } from '../types'

export const WORKER_TYPE = 'meld:worker'
export const MAX_AGENTS = 8
export const DEFAULT_AGENTS = 2
export const MODELS = ['opus', 'sonnet', 'haiku', 'fable'] as const
/** The start of the type of an agent that meld runs through ACP, such as acp:codex. */
export const ACP_PREFIX = 'acp:'
/** The start of the agent id of each agent that meld mcp runs through ACP: the plugin sends its messages there. */
export const ACP_AGENT_PREFIX = 'acp-'
/** The ACP agents that meld knows by name, with the command that starts each one. */
export const ACP_AGENTS: Readonly<Record<string, readonly string[]>> = {
  codex: ['npx', '-y', '@agentclientprotocol/codex-acp'],
  gemini: ['npx', '-y', '@google/gemini-cli', '--acp'],
  cursor: ['agent', 'acp'],
}

const FLAG = /^--([a-z-]+)(?:\s+(\S+))?\s*/
const VCS_CHOICES = new Set<string>(['auto', 'jj', 'git'])
const MODEL_SEPARATOR = '@'
const COUNT_REFUSAL = { error: `meld runs 1 to ${MAX_AGENTS} workers.` }

export type StartOptions = { request: string; agents: AgentSpec[]; vcs: VcsChoice }
export type Refusal = { error: string }

/**
 * Reads `/meld [--agents <count|list>] [--model <model>] [--vcs auto|jj|git] [/path/to/repo] <task>`.
 * A list item is a model (`opus`), an agent type (`Explore`), or a type and a model (`general-purpose@haiku`).
 */
export function parseStart(text: string): StartOptions | Refusal {
  let rest = text.trim()
  let count = DEFAULT_AGENTS
  let list: AgentSpec[] | undefined
  let model: string | undefined
  let vcs: VcsChoice = 'auto'
  for (let flag = FLAG.exec(rest); flag; flag = FLAG.exec(rest)) {
    const [whole, name = '', value = ''] = flag
    rest = rest.slice(whole.length)
    if (name === 'agents' && /^\d+$/.test(value)) count = Number(value)
    else if (name === 'agents') list = value.split(',').filter(Boolean).map(agentSpecOf)
    else if (name === 'model' && value) model = value
    else if (name === 'vcs' && VCS_CHOICES.has(value)) vcs = value as VcsChoice
    else if (name === 'vcs') return { error: 'Use --vcs auto, jj or git.' }
    else return { error: `meld has no option --${name}.` }
  }
  const agents = list ? list.map(spec => withModel(spec, model)) : agentsOf(count, model)
  if (agents.length < 1 || agents.length > MAX_AGENTS) return COUNT_REFUSAL
  if (!rest) return { error: 'Write the task after /meld.' }
  return { request: rest, agents, vcs }
}

/** The options of a start as /meld reads them, so a start from the pane or the tool goes through the meld command. */
export function formatStart(options: StartOptions): string {
  const agents = options.agents.map(agent => (agent.model ? `${agent.type}${MODEL_SEPARATOR}${agent.model}` : agent.type))
  return `--agents ${agents.join(',')} --vcs ${options.vcs} ${options.request}`
}

/** `count` meld workers, each on `model` when one is given. */
export function agentsOf(count: number, model?: string): AgentSpec[] {
  return Array.from({ length: count }, () => withModel({ type: WORKER_TYPE }, model))
}

/** One agent as /meld --agents names it: a model (opus), an agent type (Explore), type@model, or an ACP agent (codex). */
export function agentSpecOf(item: string): AgentSpec {
  const cut = item.lastIndexOf(MODEL_SEPARATOR)
  if (cut > 0) return { type: typeOf(item.slice(0, cut)), model: item.slice(cut + 1) }
  return isModel(item) ? { type: WORKER_TYPE, model: item } : { type: typeOf(item) }
}

export function isAcpAgent(agentId: string): boolean {
  return agentId.startsWith(ACP_AGENT_PREFIX)
}

export function isAcpSpec(spec: AgentSpec): boolean {
  return spec.type.startsWith(ACP_PREFIX)
}

/** The command that starts the ACP agent of a spec; undefined for an agent of the engine, or an ACP agent that meld does not know. */
export function acpCommandOf(spec: AgentSpec): readonly string[] | undefined {
  return isAcpSpec(spec) ? ACP_AGENTS[spec.type.slice(ACP_PREFIX.length)] : undefined
}

function typeOf(name: string): string {
  return Object.hasOwn(ACP_AGENTS, name) ? `${ACP_PREFIX}${name}` : name
}

function withModel(spec: AgentSpec, model: string | undefined): AgentSpec {
  return spec.model || !model || model === 'inherit' ? spec : { ...spec, model }
}

function isModel(word: string): boolean {
  return (MODELS as readonly string[]).includes(word) || word.startsWith('claude-')
}
