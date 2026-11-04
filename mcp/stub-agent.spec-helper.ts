/**
 * An ACP agent for the specs of the ACP runner, over standard input and output. Each prompt reports its turn and the
 * text it got, edits one file after it asks for permission, and ends the turn. A prompt with [outside] edits a file
 * outside the folder of the session, one with [pause] ends after 300 ms, one with [wait] ends only when the client
 * cancels it, and one with [crash] exits. The marks are in brackets, so no text of meld sets one off.
 */
import { Peer, readLines } from './json-rpc'

const SESSION = 'stub-session'
const PAUSE_MS = 300
const CRASH_CODE = 3
const OPTIONS = [
  { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' },
]

let cwd = ''
let turns = 0
let cancelled: (() => void) | undefined

const client = new Peer(line => process.stdout.write(`${line}\n`), {
  request: async (method, params) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] }
    if (method === 'session/new') return opened(params)
    if (method === 'session/prompt') return prompt(params)
    throw new Error(`the stub agent has no method ${method}`)
  },
  notify: method => {
    if (method === 'session/cancel') cancelled?.()
  },
})

function update(sessionUpdate: string, fields: object): void {
  client.notify('session/update', { sessionId: SESSION, update: { sessionUpdate, ...fields } })
}

function opened(params: Record<string, unknown>): object {
  cwd = String(params.cwd)
  const servers = (params.mcpServers as { name: string }[]).map(server => server.name)
  update('agent_message_chunk', { content: { type: 'text', text: `session in ${cwd} with ${servers.join(', ')}` } })
  return { sessionId: SESSION }
}

async function prompt(params: Record<string, unknown>): Promise<object> {
  turns += 1
  const text = (params.prompt as { text: string }[]).map(block => block.text).join('')
  update('agent_message_chunk', { content: { type: 'text', text: `turn ${turns}: ${text}` } })
  if (text.includes('[crash]')) process.exit(CRASH_CODE)
  if (text.includes('[pause]')) await Bun.sleep(PAUSE_MS)
  if (text.includes('[wait]')) {
    await new Promise<void>(resolve => (cancelled = resolve))
    return { stopReason: 'cancelled' }
  }
  const path = text.includes('[outside]') ? '/etc/stub-agent.txt' : `${cwd}/a.txt`
  const toolCall = { toolCallId: `t${turns}`, title: `Edit ${path}`, kind: 'edit', locations: [{ path }] }
  update('tool_call', { ...toolCall, status: 'pending' })
  const verdict = (await client.request('session/request_permission', { sessionId: SESSION, toolCall, options: OPTIONS })) as { outcome: { optionId?: string } }
  update('tool_call_update', { toolCallId: toolCall.toolCallId, status: verdict.outcome.optionId === 'yes' ? 'completed' : 'failed' })
  return { stopReason: 'end_turn' }
}

await readLines(Bun.stdin.stream(), line => client.receive(line))
