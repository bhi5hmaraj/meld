/**
 * Keeps this Mac from idle sleep, until the returned stop runs or this process ends: `caffeinate -i -w <pid>`. A sleep
 * killed the sessions of the workers in the middle of their tasks. Undefined where meld knows no such command.
 */
// ponytail: macOS only, as the sleeps came from a Mac. Linux has systemd-inhibit, for when a run there sleeps.
export function keepAwake(): (() => void) | undefined {
  if (process.platform !== 'darwin') return undefined
  const child = Bun.spawn(['caffeinate', '-i', '-w', String(process.pid)], { stdout: 'ignore', stderr: 'ignore' })
  return () => child.kill()
}
