import type { Run } from '../types'

export type ProcessResult = { exitCode: number | null; stdout: string; stderr: string }

/**
 * What the logic of meld needs from the engine. A hooks module spells `$` only at its call sites, so each hook
 * builds an Io of closures over its own `$`, and the logic takes the Io. A test can give a fake one.
 */
export type Io = {
  run(argv: string[], cwd: string): Promise<ProcessResult>
  now(): Promise<number>
  sleep(ms: number): Promise<void>
  read(): Promise<Run | null>
  write(change: (run: Run | null) => Run | null): Promise<unknown>
  send(agentId: string, text: string): Promise<unknown>
  toast(text: string): unknown
  openPane(focus: boolean): Promise<unknown>
  submit(text: string): Promise<unknown>
}
