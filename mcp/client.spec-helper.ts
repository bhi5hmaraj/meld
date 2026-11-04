import { join } from 'node:path'

const MAIN = join(import.meta.dir, 'main.ts')

export type Reply = { id: number | null; result?: { content?: { type: string; text: string }[]; isError?: boolean; [field: string]: unknown }; error?: { code: number; message: string } }

/** A client of meld mcp over its standard input and output, one JSON-RPC message on each line. */
export class Client {
  private readonly server: Bun.Subprocess<'pipe', 'pipe', 'pipe'>
  private readonly replies: Reply[] = []
  private nextId = 1

  constructor(db: string, args: string[] = [], env: Record<string, string> = {}) {
    this.server = Bun.spawn(['bun', MAIN, ...args], { env: { ...process.env, MELD_DB: db, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
    void this.collect()
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const id = this.nextId++
    this.send({ jsonrpc: '2.0', id, method, params })
    return this.replyTo(id)
  }

  send(message: object | string): void {
    this.server.stdin.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`)
    void this.server.stdin.flush()
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = await this.request('tools/call', { name, arguments: args })
    return JSON.parse(reply.result?.content?.[0]?.text ?? 'null')
  }

  async replyTo(id: number | null): Promise<Reply> {
    for (let wait = 0; wait < 200; wait++) {
      const found = this.replies.find(reply => reply.id === id)
      if (found) return found
      await Bun.sleep(10)
    }
    throw new Error(`no reply to ${id}`)
  }

  async end(): Promise<number> {
    this.server.stdin.end()
    return this.server.exited
  }

  private async collect(): Promise<void> {
    let buffer = ''
    for await (const chunk of this.server.stdout) {
      buffer += new TextDecoder().decode(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) this.replies.push(JSON.parse(line) as Reply)
    }
  }
}
