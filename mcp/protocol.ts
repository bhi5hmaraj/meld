/** The MCP protocol of `meld mcp` over standard input and output: one JSON-RPC message on each line, with no other package. */

/** A tool of the server: what the model or a plugin reads of it, and the value of a call, which the reply carries as JSON. */
export type ServedTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** A throw gives an error result with its message. */
  answer(args: Record<string, unknown>): unknown
}

export type ServerInfo = { name: string; version: string }

type Message = { id?: unknown; method?: unknown; params?: unknown }

/** The versions of the protocol that meld mcp speaks, the newest first. */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const NO_METHOD = -32601

/** The reply to one line of input, as one line; undefined for a notification, which gets no reply. */
export async function replyTo(line: string, tools: readonly ServedTool[], info: ServerInfo): Promise<string | undefined> {
  const message = parsed(line)
  if (message === undefined) return errorLine(null, PARSE_ERROR, 'The line is not JSON.')
  if (message === null || typeof message !== 'object') return errorLine(null, INVALID_REQUEST, 'A message is a JSON object.')
  if (message.id === undefined) return undefined
  const params = isRecord(message.params) ? message.params : {}
  const method = typeof message.method === 'string' ? message.method : ''
  if (method === 'initialize') return resultLine(message.id, initialized(params, info))
  if (method === 'ping') return resultLine(message.id, {})
  if (method === 'tools/list') return resultLine(message.id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  if (method === 'tools/call') return resultLine(message.id, await called(tools, params))
  return errorLine(message.id, NO_METHOD, `meld mcp has no method ${method}.`)
}

/** Answers each line of standard input in order, and ends when the input ends. */
export async function serveStdio(tools: readonly ServedTool[], info: ServerInfo): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      const reply = line ? await replyTo(line, tools, info) : undefined
      if (reply) process.stdout.write(`${reply}\n`)
    }
  }
}

function initialized(params: Record<string, unknown>, info: ServerInfo): object {
  const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
  return { protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: info }
}

async function called(tools: readonly ServedTool[], params: Record<string, unknown>): Promise<object> {
  const tool = tools.find(one => one.name === params.name)
  if (!tool) return failed(`meld mcp has no tool ${String(params.name)}.`)
  try {
    const value = await tool.answer(isRecord(params.arguments) ? params.arguments : {})
    return { content: [{ type: 'text', text: JSON.stringify(value) }] }
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
}

function failed(text: string): object {
  return { content: [{ type: 'text', text }], isError: true }
}

function parsed(line: string): Message | null | undefined {
  try {
    return JSON.parse(line) as Message | null
  } catch {
    return undefined
  }
}

function resultLine(id: unknown, result: object): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result })
}

function errorLine(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
