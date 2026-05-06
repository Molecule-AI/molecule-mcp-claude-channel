// shutdown-drain.test.ts — real-subprocess tests for the SIGTERM
// drain added in v0.4.1 (closes #4) + the deterministic in-flight
// pin added in v0.4.2 (closes #30 weak spot 1).
//
// Per the user's standing memory: "Real-subprocess test for plugin/
// boot-path code — for code in a daemon's start() boot loop, spawn
// the real binary with a tmp config; in-process tests miss mixed-key
// bugs that only crash when start() runs."
//
// Two scenarios:
//
//   1. Fast-fail URL — pins drain SHAPE end-to-end. Cheap, stable,
//      runs in <2s. Catches the regression mode #4 was about
//      (silent process.exit racing fetch) regardless of whether N
//      pollers happened to be in-flight at SIGTERM.
//
//   2. Deterministic in-flight — spins up a local Bun.serve fixture
//      that holds poll responses until the test releases them. By
//      construction, when SIGTERM fires, exactly N pollers are
//      mid-flight (the test waits for the server to observe N hits
//      before signalling). Pins the EXACT in-flight count in the
//      drain log + pins the deadline-hit path (drain doesn't return
//      cleanly because the held responses never resolve).
//
// Together they cover the two production cases: drain-with-no-work
// (test 1) and drain-with-wedged-work (test 2).

import { describe, expect, test } from 'bun:test'
import { spawn, serve, type Subprocess } from 'bun'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

describe('SIGTERM drain (#4)', () => {
  test('fast-fail URL: drain shape pinned + clean exit (no in-flight work to drain)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'shutdown-drain-fastfail-'))
    try {
      // stdin: 'pipe' keeps the MCP stdio transport from EOFing
      // immediately on /dev/null — without this the process exits
      // naturally before we can SIGTERM it (the unref'd setIntervals
      // don't hold the loop).
      const proc = spawn(['bun', 'server.ts'], {
        env: {
          ...process.env,
          MOLECULE_STATE_DIR: stateDir,
          MOLECULE_PLATFORM_URL: 'https://t.example/',
          MOLECULE_WORKSPACE_IDS: 'ws-a,ws-b',
          MOLECULE_WORKSPACE_TOKENS: 'tok-a,tok-b',
          MOLECULE_AUTO_REGISTER_POLL: 'false',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // 1.5s lets the boot path complete (signal handlers wired,
      // first poll dispatched). Polls against t.example fail fast
      // — by SIGTERM time inFlightPolls is likely 0, which is the
      // POINT of this test case (fast-fail path still produces the
      // drain log + clean exit).
      await new Promise(r => setTimeout(r, 1500))

      proc.kill('SIGTERM')
      const exitCode = await proc.exited
      const stderrText = await new Response(proc.stderr).text()

      expect(stderrText).toContain('shutting down (draining')
      expect(stderrText).toMatch(/in-flight poll\(s\)/)
      expect(stderrText).toContain('stopped watching ws-a')
      expect(stderrText).toContain('stopped watching ws-b')
      expect(exitCode).toBe(0)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 15_000)

  test('deterministic in-flight: held local server pins N=2 in drain log + deadline-hit path (#30 weak spot 1)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'shutdown-drain-inflight-'))
    // Track how many real polls have hit the server (probes don't
    // count). Held responses stay in `heldResponses` so the test can
    // release them after SIGTERM (otherwise server.stop() would block
    // forever waiting for in-flight requests).
    let realPollsObserved = 0
    const heldResponses = new Set<(r: Response) => void>()

    // Local fixture server. Two response paths:
    //   - probe: ?since_id=00000000-0000-0000-0000-000000000000
    //     → 410 Gone instantly so probeCursorSupport says 'ok'
    //   - real poll: anything else → hold response open until test
    //     resolves it
    //
    // port: 0 lets the OS pick — avoids collisions with concurrent
    // test runs.
    const fixture = serve({
      port: 0,
      async fetch(req) {
        const u = new URL(req.url)
        const sinceId = u.searchParams.get('since_id')
        if (sinceId === '00000000-0000-0000-0000-000000000000') {
          return new Response('Gone', { status: 410 })
        }
        realPollsObserved++
        return new Promise<Response>((resolve) => {
          heldResponses.add(resolve)
        })
      },
    })

    let proc: Subprocess<'pipe', 'pipe', 'pipe'> | null = null
    try {
      proc = spawn(['bun', 'server.ts'], {
        env: {
          ...process.env,
          MOLECULE_STATE_DIR: stateDir,
          MOLECULE_PLATFORM_URL: `http://localhost:${fixture.port}`,
          MOLECULE_WORKSPACE_IDS: 'ws-a,ws-b',
          MOLECULE_WORKSPACE_TOKENS: 'tok-a,tok-b',
          // POLL_INTERVAL_MS is set HIGH (30s) deliberately. Each
          // workspace's FIRST poll fires per the i*500 startup
          // stagger regardless of this value, so ws-a polls at t=0
          // and ws-b at t=500ms. After that, the setInterval
          // wouldn't fire its next tick until t=30000ms+ — well
          // past the test's SIGTERM window.
          //
          // The earlier (v0.4.2 first attempt) value of 500ms caused
          // a CI race: ws-a's setInterval fired a SECOND poll at
          // t≈500ms (concurrent with ws-b's first), pushing
          // realPollsObserved to 3 between "wait until >=2" and
          // SIGTERM. The test then asserted "draining 2 in-flight"
          // but the actual count was 3 → flake.
          //
          // Lifting POLL_INTERVAL_MS to 30s eliminates the second-
          // tick window entirely; only the first polls (one per
          // workspace, by stagger) hit the server before SIGTERM.
          MOLECULE_POLL_INTERVAL_MS: '30000',
          MOLECULE_AUTO_REGISTER_POLL: 'false',
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      })

      // Wait deterministically until BOTH pollers (one per watched
      // workspace) have hit the server with a real /activity request.
      // Polling on `realPollsObserved` is the only deterministic
      // signal — sleeping for a fixed duration would be flaky.
      const waitDeadline = Date.now() + 10_000
      while (realPollsObserved < 2) {
        if (Date.now() > waitDeadline) {
          throw new Error(
            `timed out waiting for both pollers to hit fixture server ` +
            `(observed ${realPollsObserved}/2 within 10s)`,
          )
        }
        if (proc.exitCode !== null) {
          // Plugin exited before in-flight condition met — drain stderr
          // for diagnostics so the failure is debuggable.
          const stderrText = await new Response(proc.stderr).text()
          throw new Error(
            `plugin exited (code ${proc.exitCode}) before reaching ` +
            `in-flight=2; observed ${realPollsObserved} real polls. ` +
            `stderr: ${stderrText}`,
          )
        }
        await new Promise(r => setTimeout(r, 50))
      }

      // SIGTERM with both pollers genuinely mid-flight.
      proc.kill('SIGTERM')
      const exitCode = await proc.exited
      const stderrText = await new Response(proc.stderr).text()

      // Pin 1 (the load-bearing assertion #30 weak spot 1 was about):
      // drain log names the EXACT in-flight count. The fast-fail test
      // above only pins the SHAPE; here we pin the COUNT, which is
      // what proves the inFlightPolls tracker actually tracks.
      expect(stderrText).toMatch(/draining 2 in-flight poll\(s\)/)

      // Pin 2: drain hits the 8s deadline (held responses never
      // resolved → polls never completed → drain can't return
      // cleanly). The deadline path is the regression mode that
      // would have shipped silently if we only tested the
      // happy-drain (clean drain) case.
      expect(stderrText).toContain('drain hit')
      expect(stderrText).toContain('deadline')
      expect(stderrText).toMatch(/poll\(s\) still in-flight; exiting anyway/)

      // Pin 3: still exits cleanly (code 0) despite hitting the
      // deadline — graceful-with-warning, not crashed-with-error.
      expect(exitCode).toBe(0)

      // Pin 4: per-workspace stop lines fire even on deadline-hit
      // path — proves the loop-after-drain executes regardless of
      // which Promise.race arm won.
      expect(stderrText).toContain('stopped watching ws-a')
      expect(stderrText).toContain('stopped watching ws-b')
    } finally {
      // Release held responses so the fixture server can stop. If
      // we don't, server.stop() blocks forever on in-flight requests
      // and the test process never exits.
      for (const resolve of heldResponses) {
        resolve(new Response('[]', { headers: { 'Content-Type': 'application/json' } }))
      }
      fixture.stop()
      rmSync(stateDir, { recursive: true, force: true })
    }
  }, 20_000)  // 10s wait-for-inflight + 8s drain + 2s safety
})
