/**
 * An ACP agent for the specs of the ACP runner, over standard input and output. Each prompt reports its turn and the
 * text it got, edits one file after it asks for permission, and ends the turn. A prompt with [outside] edits a file
 * outside the folder of the session, one with [pause] ends after 300 ms, one with [wait] ends only when the client
 * cancels it, and one with [crash] exits. The marks are in brackets, so no text of meld sets one off.
 */

type Message = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> }

let cwd = ''
let turns = 0
let nextId = 1
let cancelled: (() => void) | undefined
const answers = new Map<number, (result: Record<string, unknown>) => void>()

function send(message: object): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function update(sessionUpdate: string, fields: object): void {
  send({ method: 'session/update', params: { sessionId: 'stub-session', update: { sessionUpdate, ...fields } } })
}

function ask(method: string, params: object): Promise<Record<string, unknown>> {
  const id = nextId++
  send({ id, method, params })
  return new Promise(resolve => answers.set(id, resolve))
}

async function prompt(id: number, params: Record<string, unknown>): Promise<void> {
  turns += 1
  const blocks = params.prompt as { type: string; text: string }[]
  const text = blocks.map(block => block.text).join('')
  update('agent_message_chunk', { content: { type: 'text', text: `turn ${turns}: ${text}` } })
  if (text.includes('[crash]')) process.exit(3)
  if (text.includes('[pause]')) await Bun.sleep(300)
  if (text.includes('[wait]')) {
    await new Promise<void>(resolve => (cancelled = resolve))
    send({ id, result: { stopReason: 'cancelled' } })
    return
  }
  const path = text.includes('[outside]') ? '/etc/stub-agent.txt' : `${cwd}/a.txt`
  update('tool_call', { toolCallId: `t${turns}`, title: `Edit ${path}`, kind: 'edit', status: 'pending', locations: [{ path }] })
  const verdict = await ask('session/request_permission', {
    sessionId: 'stub-session',
    toolCall: { toolCallId: `t${turns}`, title: `Edit ${path}`, kind: 'edit', locations: [{ path }] },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Reject', kind: 'reject_once' },
    ],
  })
  const outcome = verdict.outcome as { outcome: string; optionId?: string }
  update('tool_call_update', { toolCallId: `t${turns}`, status: outcome.optionId === 'yes' ? 'completed' : 'failed' })
  send({ id, result: { stopReason: 'end_turn' } })
}

function receive(message: Message): void {
  if (message.method === undefined && message.id !== undefined) {
    answers.get(message.id)?.(message.result ?? {})
    answers.delete(message.id)
    return
  }
  const params = message.params ?? {}
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } })
  if (message.method === 'session/new') {
    cwd = String(params.cwd)
    const servers = (params.mcpServers as { name: string }[]).map(server => server.name)
    send({ id: message.id, result: { sessionId: 'stub-session' } })
    update('agent_message_chunk', { content: { type: 'text', text: `session in ${cwd} with ${servers.join(', ')}` } })
  }
  if (message.method === 'session/prompt' && message.id !== undefined) void prompt(message.id, params)
  if (message.method === 'session/cancel') cancelled?.()
}

const decoder = new TextDecoder()
let buffer = ''
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true })
  for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
    const line = buffer.slice(0, end).trim()
    buffer = buffer.slice(end + 1)
    if (line) receive(JSON.parse(line) as Message)
  }
}
