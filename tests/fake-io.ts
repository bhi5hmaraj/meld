import type { AgentState, Io, ProcessResult, SpawnArgs, Spawned } from '../hooks/io'
import type { Facts, Run } from '../types'

export const HEAD = 'abc1234def5678abc1234def5678abc1234def56'

/** The engine as the logic of meld sees it: commands answer from tables, and every call is recorded. */
export class FakeIo implements Io {
  current: Run | null = null
  facts: Facts | null = null
  repos = ['/repo', '/elsewhere']
  answers: Record<string, string> = {}
  failing: string[] = []
  missing: string[] = []
  dirty = false
  untracked = false
  spawnDeny: string | undefined = undefined
  spawnDenies: Record<string, string> = {}
  commands: string[] = []
  cwds: Record<string, string> = {}
  files: Record<string, string> = {}
  spawned: SpawnArgs[] = []
  ranCommands: string[] = []
  sent: string[] = []
  toasts: string[] = []
  usd: number | undefined = undefined
  agentStates: Map<string, AgentState> | undefined = undefined

  async run(argv: string[], cwd: string): Promise<ProcessResult> {
    const command = argv.join(' ')
    this.commands.push(command)
    this.cwds[command] = cwd
    if (this.missing.includes(argv[0] ?? '')) throw new Error(`spawn ${argv[0]} ENOENT`)
    if (this.failing.some(prefix => command.startsWith(prefix))) return refusal(`${argv[0]}: failed`)
    const known = this.answers[command]
    if (known !== undefined) return answer(known)
    if (command === 'git rev-parse --show-toplevel') return this.rootOf(cwd)
    if (command === 'git rev-parse HEAD') return answer(HEAD)
    if (command === 'git status --porcelain') return answer([this.dirty ? ' M src/a.ts' : '', this.untracked ? '?? notes.md' : ''].filter(Boolean).join('\n'))
    if (command === 'git status --porcelain --untracked-files=no') return answer(this.dirty ? ' M src/a.ts' : '')
    if (command === 'jj --version') return refusal('jj: not found')
    return answer('')
  }

  rootOf(cwd: string): ProcessResult {
    const root = this.repos.find(repo => cwd === repo || cwd.startsWith(`${repo}/`))
    return root ? answer(root) : refusal('not a git repository')
  }

  ran(prefix: string): boolean {
    return this.commands.some(command => command.startsWith(prefix))
  }

  async now(): Promise<number> {
    return 1_800_000_000_000
  }

  async sleep(): Promise<void> {}

  async cost(): Promise<number | undefined> {
    return this.usd
  }

  async agents(): Promise<Map<string, AgentState> | undefined> {
    return this.agentStates
  }

  async read(): Promise<Run | null> {
    return this.current
  }

  async write(change: (run: Run | null) => Run | null): Promise<unknown> {
    this.current = change(this.current)
    return this.current
  }

  async readFacts(): Promise<Facts | null> {
    return this.facts
  }

  async writeFacts(facts: Facts | null): Promise<unknown> {
    this.facts = facts
    return facts
  }

  async writeFile(path: string, text: string): Promise<void> {
    this.files[path] = text
  }

  async spawn(args: SpawnArgs): Promise<Spawned> {
    this.spawned.push(args)
    const deny = this.spawnDenies[args.description] ?? this.spawnDeny
    return deny ? { deny } : { agentId: `spawned-${this.spawned.length}` }
  }

  async command(name: string, args: string): Promise<{ text?: string }> {
    this.ranCommands.push(`/${name} ${args}`)
    return { text: 'started' }
  }

  async send(agentId: string, text: string): Promise<unknown> {
    this.sent.push(`${agentId}: ${text}`)
    return undefined
  }

  toast(text: string): unknown {
    this.toasts.push(text)
    return undefined
  }

  async openPane(): Promise<unknown> {
    return undefined
  }
}

export function answer(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: '' }
}

export function refusal(stderr: string): ProcessResult {
  return { exitCode: 1, stdout: '', stderr }
}
