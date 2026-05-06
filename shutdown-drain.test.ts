// shutdown-drain.test.ts — real-subprocess test for the SIGTERM drain
// added in v0.4.1 (closes #4). Per the user's standing memory:
// "Real-subprocess test for plugin/boot-path code — for code in a
// daemon's start() boot loop, spawn the real binary with a tmp config;
// in-process tests miss mixed-key bugs that only crash when start()
// runs."
//
// What we pin:
//   1. SIGTERM produces the v0.4.1 "shutting down (draining N
//      in-flight poll(s))" log line — proves the new shutdown path
//      runs end-to-end.
//   2. The drain message names the in-flight count, so an operator
//      seeing 0 vs N knows whether the race window was open.
//   3. The process exits with status 0 (clean exit, not killed).
//
// We DON'T attempt to assert that all N pollers actually drained vs
// hit the 8s deadline — that depends on real network timing against
// `https://t.example/` which we can't control. Either path is fine
// behavior; the regression mode #4 was about (silent process.exit
// racing fetch) is gone in both.

import { describe, expect, test } from 'bun:test'
import { spawn } from 'bun'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('SIGTERM drain (#4)', () => {
  test('logs shutdown + drain progress + exits cleanly', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'shutdown-drain-test-'))
    try {
      // Spawn the real server.ts. stdin: 'pipe' keeps the MCP stdio
      // transport from EOFing immediately on /dev/null — without this
      // the process exits naturally before we can SIGTERM it (the
      // unref'd setIntervals don't hold the loop).
      const proc = spawn(['bun', 'server.ts'], {
        env: {
          ...process.env,
          MOLECULE_STATE_DIR: stateDir,
          MOLECULE_PLATFORM_URL: 'https://t.example/',
          MOLECULE_WORKSPACE_IDS: 'ws-a,ws-b',
          MOLECULE_WORKSPACE_TOKENS: 'tok-a,tok-b',
          MOLECULE_AUTO_REGISTER_POLL: 'false',
          // Probe failure is non-fatal; we want to see the drain
          // log on SIGTERM, not exit code 2 from a probe-too-old
          // failure (which we won't get either against a fake URL,
          // but defensive).
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Give the server time to wire up signal handlers + start the
      // first poll cycle (which we'll catch mid-flight on SIGTERM,
      // hopefully — but even if all polls have settled by then, the
      // shutdown-line log still fires with N=0 in-flight).
      await new Promise(r => setTimeout(r, 1500))

      proc.kill('SIGTERM')

      const exitCode = await proc.exited
      const stderrText = await new Response(proc.stderr).text()

      // Pin 1: the v0.4.1 drain log line fires.
      expect(stderrText).toContain('shutting down (draining')
      expect(stderrText).toMatch(/in-flight poll\(s\)/)

      // Pin 2: the per-workspace stop lines fire — proves we walked
      // through every watched id, not just the canary.
      expect(stderrText).toContain('stopped watching ws-a')
      expect(stderrText).toContain('stopped watching ws-b')

      // Pin 3: clean exit. SIGTERM-default would be 143 (128+15);
      // our handler exits with 0 explicitly to signal "graceful".
      expect(exitCode).toBe(0)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 15_000)  // generous — drain has an 8s deadline + spawn cost
})
