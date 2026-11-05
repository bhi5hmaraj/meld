import { MemoryStore } from '../core/memory-store'
import type { AgentState, Files, FolderEntry, Io, ProcessResult, RunRecord, RunRecords, SpawnArgs, Spawned } from '../core/ports'
import type { Run } from '../types'

export const HEAD = 'abc1234def5678abc1234def5678abc1234def56'

/** The engine as the logic of meld sees it: the run in a memory store, commands that answer from tables, and every call recorded. */
export class FakeIo extends MemoryStore implements Io, Files, RunRecords {
  repos = ['/repo', '/elsewhere']
  answers: Record<string, string> = {}
  /** Whole results by command, for a command that fails with an output, as git merge-tree does on a conflict. */
  outcomes: Record<string, ProcessResult> = {}
  failing: string[] = []
  missing: string[] = []
  dirty = false
  spawnDeny: string | undefined = undefined
  spawnDenies: Record<string, string> = {}
  commands: string[] = []
  cwds: Record<string, string> = {}
  files: Record<string, string> = {}
  spawned: SpawnArgs[] = []
  ranCommands: string[] = []
  sent: string[] = []
  /** The prompts that resume gave to agents in their own sessions. */
  resumed: string[] = []
  /** Agents that resume cannot reach. */
  gone: string[] = []
  toasts: string[] = []
  usd: number | undefined = undefined
  agentStates: Map<string, AgentState> | undefined = undefined
  /** What the board file of meld mcp keeps of each run beside the boards. */
  records: RunRecord[] = []
  /** The entries of each folder that list answers; a folder that is not here is missing. An rm -rf of a folder drops it. */
  listings: Record<string, FolderEntry[]> = {}
  /** Folders that are gone: a command that runs in one cannot start. */
  goneDirs: string[] = []
  /** Commands that wait for their promise before they answer, as a merge that is still running. */
  gates: Record<string, Promise<void>> = {}
  /** A change of the run while a command or a spawn runs, by the command or the description of the spawn: a stop, a final, another run. */
  during: Record<string, (run: Run) => Run | null> = {}

  random(count: number): Uint8Array {
    return new Uint8Array(count)
  }

  async run(argv: string[], cwd: string): Promise<ProcessResult> {
    const command = argv.join(' ')
    this.commands.push(command)
    this.cwds[command] = cwd
    const gate = this.gates[command]
    if (gate) await gate
    this.change(command)
    if (argv[0] === 'cat' && argv[1] === '--') return this.catOf(argv[2] ?? '')
    if (this.missing.includes(argv[0] ?? '')) throw new Error(`spawn ${argv[0]} ENOENT`)
    if (this.goneDirs.includes(cwd)) throw new Error(`spawn ${argv[0]} ENOENT: no such directory ${cwd}`)
    if (this.failing.some(prefix => command.startsWith(prefix))) return refusal(`${argv[0]}: failed`)
    if (command.startsWith('rm -rf -- ')) this.drop(argv[argv.length - 1] ?? '')
    const outcome = this.outcomes[command]
    if (outcome !== undefined) return outcome
    const known = this.answers[command]
    if (known !== undefined) return answer(known)
    if (command === 'git rev-parse --show-toplevel') return this.rootOf(cwd)
    if (command === 'git rev-parse HEAD') return answer(HEAD)
    if (command === 'git status --porcelain' || command === 'git status --porcelain --untracked-files=all') return answer(this.dirty ? ' M src/a.ts' : '')
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

  async writeFile(path: string, text: string): Promise<void> {
    this.files[path] = text
  }

  async spawn(args: SpawnArgs): Promise<Spawned> {
    this.spawned.push(args)
    this.change(args.description)
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

  async resume(agentId: string, text: string): Promise<boolean> {
    if (this.gone.includes(agentId)) return false
    this.resumed.push(`${agentId}: ${text}`)
    return true
  }

  toast(text: string): unknown {
    this.toasts.push(text)
    return undefined
  }

  async openPane(): Promise<unknown> {
    return undefined
  }

  async runRecords(): Promise<RunRecord[]> {
    return this.records
  }

  async list(path: string): Promise<FolderEntry[]> {
    const entries = this.listings[path]
    if (!entries) throw new Error(`ENOENT: no such file or directory, scandir '${path}'`)
    return entries
  }

  catOf(path: string): ProcessResult {
    const text = this.files[path]
    return text === undefined ? refusal(`cat: ${path}: No such file or directory`) : answer(text)
  }

  change(key: string): void {
    const change = this.during[key]
    if (change && this.current) this.current = change(this.current)
  }

  /** Drops a folder from the listings, as rm -rf removes it. The written files stay, so a test still sees what was written. */
  drop(path: string): void {
    for (const folder of Object.keys(this.listings)) if (folder === path || folder.startsWith(`${path}/`)) delete this.listings[folder]
    const cut = path.lastIndexOf('/')
    const parent = path.slice(0, cut)
    const entries = this.listings[parent]
    if (entries) this.listings[parent] = entries.filter(entry => entry.name !== path.slice(cut + 1))
  }
}

export function answer(stdout: string): ProcessResult {
  return { exitCode: 0, stdout, stderr: '' }
}

export function refusal(stderr: string): ProcessResult {
  return { exitCode: 1, stdout: '', stderr }
}
