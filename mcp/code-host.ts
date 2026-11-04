import type { CodeHost } from '../core/ports'

/** How long one command may run, as in the plugin: git and jj on a large repository. */
const PROCESS_TIMEOUT_MS = 120_000

/** The CodeHost of `meld mcp`: commands by their argument vector with no shell, and files through Bun. A missing command or folder rejects. */
export const bunCodeHost: CodeHost = {
  async run(argv, cwd) {
    const child = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: PROCESS_TIMEOUT_MS })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { exitCode, stdout, stderr }
  },
  async writeFile(path, text) {
    await Bun.write(path, text)
  },
}
