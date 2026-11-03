import type { Facts, Run } from '../types'

export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string }

export type SpawnArgs = { prompt: string; description: string; subagentType: string; model?: string; cwd: string }

export type Spawned = { agentId?: string; deny?: string }

/**
 * What the logic of meld needs from the engine. A hooks module spells `$` only at its call sites, so each hook
 * builds an Io of closures over its own `$`, and the logic takes the Io. A test gives a fake one.
 */
export type Io = {
  run(argv: string[], cwd: string): Promise<ProcessResult>
  now(): Promise<number>
  /** The dollars the session has spent, where the host keeps a cost ledger. */
  cost(): Promise<number | undefined>
  sleep(ms: number): Promise<void>
  read(): Promise<Run | null>
  write(change: (run: Run | null) => Run | null): Promise<unknown>
  readFacts(): Promise<Facts | null>
  writeFacts(facts: Facts | null): Promise<unknown>
  writeFile(path: string, text: string): Promise<void>
  spawn(args: SpawnArgs): Promise<Spawned>
  command(name: string, args: string): Promise<{ text?: string }>
  send(agentId: string, text: string): Promise<unknown>
  toast(text: string): unknown
  openPane(focus: boolean): Promise<unknown>
}
