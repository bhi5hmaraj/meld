/** One end of a JSON-RPC 2.0 link with one message on each line, as MCP and ACP use over standard input and output. */

/** What one end answers to the other: a request gets its value or, from a throw, an error reply. */
export type Handlers = {
  request(method: string, params: Record<string, unknown>): Promise<unknown>
  notify(method: string, params: Record<string, unknown>): void
}

type Message = { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
type Waiter = { resolve(value: unknown): void; reject(error: Error): void }

const INTERNAL_ERROR = -32603

export class Peer {
  private nextId = 1
  private readonly waiting = new Map<number, Waiter>()
  private closedFor: string | undefined

  constructor(
    private readonly write: (line: string) => void,
    private readonly handlers: Handlers,
  ) {}

  request(method: string, params: object): Promise<unknown> {
    if (this.closedFor) return Promise.reject(new Error(this.closedFor))
    const id = this.nextId++
    const reply = new Promise<unknown>((resolve, reject) => this.waiting.set(id, { resolve, reject }))
    this.send({ id, method, params })
    return reply
  }

  notify(method: string, params: object): void {
    if (!this.closedFor) this.send({ method, params })
  }

  /** Takes one line from the other end. A line that is not a JSON message is skipped. */
  receive(line: string): void {
    const message = parsed(line)
    if (!message) return
    const params = isRecord(message.params) ? message.params : {}
    if (message.method === undefined) this.settle(message)
    else if (message.id === undefined) this.handlers.notify(message.method, params)
    else void this.answer(message.id, message.method, params)
  }

  /** Ends the link: each request that waits for a reply rejects with the reason, and so does each later one. */
  close(reason: string): void {
    this.closedFor = reason
    for (const waiter of this.waiting.values()) waiter.reject(new Error(reason))
    this.waiting.clear()
  }

  private settle(message: Message): void {
    const id = Number(message.id)
    const waiter = this.waiting.get(id)
    if (!waiter) return
    this.waiting.delete(id)
    if (message.error) waiter.reject(new Error(message.error.message ?? 'the other end gave an error'))
    else waiter.resolve(message.result)
  }

  private async answer(id: number | string, method: string, params: Record<string, unknown>): Promise<void> {
    try {
      this.send({ id, result: (await this.handlers.request(method, params)) ?? null })
    } catch (error) {
      this.send({ id, error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } })
    }
  }

  private send(message: object): void {
    if (this.closedFor) return
    this.write(JSON.stringify({ jsonrpc: '2.0', ...message }))
  }
}

/** Gives each line of the stream that is not empty, in order. A line waits for the one before it. */
export async function readLines(stream: ReadableStream<Uint8Array>, take: (line: string) => void | Promise<void>): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (line) await take(line)
    }
  }
}

function parsed(line: string): Message | undefined {
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? (value as Message) : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
