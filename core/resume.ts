import type { Run } from '../types'
import { readRun, restartIdleWorkers, writeRun } from './actions'
import * as board from './board'
import { command } from './git'
import type { Io } from './ports'
import type { Boards, BoardSummary } from './remote-store'
import { MELD_ROOT, runHome } from './vcs'
import { ageOf, listed } from './words'

const NEEDS_BUN = 'A resume needs Bun: meld keeps runs for a resume in ~/.meld/meld.db through meld mcp, which runs on Bun (https://bun.sh). This session keeps its run in its own state'
const RESUMABLE = new Set(['starting', 'working', 'ready', 'stopped'])
const LIVE = new Set(['starting', 'working', 'ready'])
const REQUEST_CHARACTERS = 60

/**
 * /meld-resume: with no board, the runs of other sessions on this machine; with a board, this session takes that run,
 * once its owner wrote nothing for the time of a lease, and starts its idle workers again. `boards` is a text when meld
 * mcp did not connect: why not.
 */
export async function resumeRun(io: Io, boards: Boards | string, choice: string): Promise<string> {
  if (typeof boards === 'string') return `${NEEDS_BUN}. meld mcp did not connect: ${boards}`
  const now = await io.now()
  if (!choice) return listing(await boards.list(), boards.current(), now)
  if (choice === boards.current()) return 'This session works on that board already.'
  const own = await readRun(io)
  if (own && LIVE.has(own.state)) return 'This session has a live run. Deliver, discard or stop it first: /meld-deliver, /meld-discard or /meld-stop.'
  const adopted = await boards.adopt(choice)
  if (adopted === 'missing') return `There is no run on the board ${choice}.`
  if (adopted !== 'adopted') {
    return `Another session wrote that run ${Math.round((now - adopted.ownerAt) / 1000)} s ago, so it can still work on it. A session resumes a run 60 s after its last write.`
  }
  await boards.use(choice)
  const run = await readRun(io)
  return run ? started(io, run, now) : `There is no run on the board ${choice}.`
}

/** The run of the session now: its workspaces must be there, and its idle workers start again. */
async function started(io: Io, run: Run, now: number): Promise<string> {
  const home = runHome(run.id)
  if (!(await command(io, MELD_ROOT, ['test', '-d', home])).ok) return `Resumed run ${run.id}, but its workspaces in ${home} are gone. /meld-discard removes the run.`
  const cost = await io.cost()
  await writeRun(io, current => board.adoptRun(current, cost, now))
  if (run.state === 'stopped') return `Resumed run ${run.id}, which is stopped. /meld-discard removes its workspaces.`
  if (run.state === 'ready') return `Resumed run ${run.id}, "${run.request}": its final commit waits. /meld-deliver merges it.`
  const restarted = await restartIdleWorkers(io)
  if (!restarted.length) return `Resumed run ${run.id}, "${run.request}". meld starts each worker again when its agent is idle.`
  return `Resumed run ${run.id}, "${run.request}": meld starts ${listed(restarted)} again.`
}

function listing(summaries: readonly BoardSummary[], current: string, now: number): string {
  const others = summaries.filter(one => one.board !== current && RESUMABLE.has(one.state))
  if (!others.length) return 'No run of another session is on this machine.'
  const lines = others.map(one => `- ${one.board}: run ${one.run}, ${one.state}, "${cut(one.request)}" in ${one.repo}, last write ${ageOf(now - (one.ownerAt ?? now))} ago`)
  return ['Runs of other sessions:', ...lines, '/meld-resume <board> resumes one, 60 s after its last write.'].join('\n')
}

function cut(text: string): string {
  return text.length > REQUEST_CHARACTERS ? `${text.slice(0, REQUEST_CHARACTERS - 1)}…` : text
}
