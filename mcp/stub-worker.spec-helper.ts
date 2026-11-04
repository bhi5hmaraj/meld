/**
 * An ACP agent that works as a meld worker, for the run specs of the leader. It connects to the MCP server that the leader
 * gives it, its own meld mcp --worker. Each prompt goes on with its claimed task, or waits for a ready open task whose
 * detail names a file and claims it. It asks for permission to write that file in its folder, commits it, and finishes the task.
 * When every task is done, it integrates: it merges the integration line and declares the final commit.
 */
import { Peer } from './json-rpc'

type Server = { command: string; args: string[]; env: { name: string; value: string }[] }
type BoardTask = { id: number; title: string; detail: string; state: string; owner?: string; version: number; needs?: number[] }
type BoardView = { you: { id: string; path: string; ref: string }; state: string; tasks: BoardTask[]; integrator?: string }
type Reply = { ok?: boolean; error?: string }

const SESSION = 'stub-worker-session'
const WAIT_MS = 10_000
const POLL_MS = 50
const MCP_VERSION = '2025-06-18'

let cwd = ''
let meld: Peer | undefined
let toolCalls = 0

const acp = new Peer(line => process.stdout.write(`${line}\n`), {
  request: async (method, params) => {
    if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] }
    if (method === 'session/new') {
      cwd = String(params.cwd)
      meld = await connect((params.mcpServers as Server[])[0])
      return { sessionId: SESSION }
    }
    if (method === 'session/prompt') {
      await work()
      return { stopReason: 'end_turn' }
    }
    throw new Error(`the stub worker has no method ${method}`)
  },
  notify: () => undefined,
})

async function connect(server: Server | undefined): Promise<Peer> {
  if (!server) throw new Error('the leader gave no MCP server')
  const env = Object.fromEntries(server.env.map(pair => [pair.name, pair.value]))
  const child = Bun.spawn([server.command, ...server.args], { env: { ...process.env, ...env }, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  const peer = new Peer(
    line => {
      child.stdin.write(`${line}\n`)
      void child.stdin.flush()
    },
    { request: async () => null, notify: () => undefined },
  )
  void readLines(child.stdout, line => peer.receive(line))
  await peer.request('initialize', { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'stub-worker', version: '1' } })
  peer.notify('notifications/initialized', {})
  return peer
}

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await meld?.request('tools/call', { name, arguments: args })) as { content: { text: string }[] }
  return JSON.parse(result.content[0]?.text ?? 'null') as T
}

async function work(): Promise<void> {
  const task = await openTask()
  if (task) await doTask(task)
  const view = await call<BoardView>('board')
  const allDone = view.tasks.length > 0 && view.tasks.every(one => one.state === 'done')
  if (view.state === 'working' && allDone && (!view.integrator || view.integrator === view.you.id)) await integrate(view)
}

/** The task this worker claimed, or the first ready open task whose detail names a file, while the run works and some task is not done. */
async function openTask(): Promise<BoardTask | undefined> {
  for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
    const view = await call<BoardView>('board')
    const open = view.tasks.find(task => (task.state === 'claimed' && task.owner === view.you.id) || (task.state === 'open' && task.detail && isReady(view.tasks, task)))
    const allDone = view.tasks.length > 0 && view.tasks.every(task => task.state === 'done')
    if (open || view.state !== 'working' || allDone) return open
    await Bun.sleep(POLL_MS)
  }
  return undefined
}

function isReady(tasks: readonly BoardTask[], task: BoardTask): boolean {
  return (task.needs ?? []).every(need => tasks.find(one => one.id === need)?.state === 'done')
}

async function doTask(task: BoardTask): Promise<void> {
  if (task.state === 'open' && !(await call<Reply>('claim', { task: task.id, version: task.version })).ok) return
  const path = `${cwd}/${task.detail}`
  if (!(await allowed(`Write ${path}`, 'edit', path))) return
  await Bun.write(path, `${task.title}\n`)
  await git('add', task.detail)
  await git('commit', '-q', '-m', task.title)
  const claimed = (await call<BoardView>('board')).tasks.find(one => one.id === task.id)
  await call('finish_task', { task: task.id, version: claimed?.version, commit: 'HEAD', summary: `Added ${task.detail}` })
}

async function integrate(view: BoardView): Promise<void> {
  if (!(await call<Reply>('integrate')).ok) return
  await git('merge', '-q', '--no-edit', view.you.ref.replace(/[^/]+$/, 'integration'))
  await call('finish', { commit: 'HEAD', summary: 'Every task of the request' })
}

/** Reports a tool call to the client, and asks for permission when it edits. */
async function allowed(title: string, kind: string, path: string): Promise<boolean> {
  toolCalls += 1
  const toolCall = { toolCallId: `t${toolCalls}`, title, kind, locations: [{ path }] }
  acp.notify('session/update', { sessionId: SESSION, update: { sessionUpdate: 'tool_call', status: 'pending', ...toolCall } })
  const options = [
    { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ]
  const verdict = (await acp.request('session/request_permission', { sessionId: SESSION, toolCall, options })) as { outcome: { optionId?: string } }
  return verdict.outcome.optionId === 'yes'
}

async function git(...args: string[]): Promise<void> {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' })
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(child.stderr).text()}`)
}

async function readLines(stream: ReadableStream<Uint8Array>, take: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (line) take(line)
    }
  }
}

await readLines(Bun.stdin.stream(), line => acp.receive(line))
