/**
 * Tests for the two-writer guard.
 *
 * Every test here was written to be able to go red. §12.4 of the design replaced an earlier
 * test precisely because it could not: asserting 409 when the registry says "running" cannot
 * catch the real bug, which happens when the registry is wrong. So:
 *
 *  - the liveness tests run against a **real live process**, not a stub;
 *  - the hazard test **causes the fork** with two concurrent `claude -r` calls and asserts the
 *    forensic detector sees it, before asserting the guard prevents it;
 *  - the procStart test asserts the refusal *disappears* when the recorded start time is wrong,
 *    which is the only way to show that comparison is load-bearing rather than decorative.
 *
 * The live section spawns real `claude -p` runs against **throwaway sessions under
 * /private/tmp** and never touches a real session. It takes ~60 s and costs a few haiku calls.
 * `MC_RUN_LIVE=1` opts into it; it is skipped by default.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  acquireSessionLock,
  assertSafeToWrite,
  findTranscriptPath,
  isProcessAlive,
  jumpUrlFor,
  readProcessStartMs,
  recheckBytes,
  resolveLiveness,
  resolveSessionPid,
} from '../lib/guard.ts';
import { continueSession, dispatchNew } from '../lib/dispatch.ts';

// Opt IN, not out: this block reads the runner's real ~/.claude and prints session paths.
// A fresh clone must not touch a stranger's transcripts to get a green suite.
const SKIP_LIVE = process.env.MC_RUN_LIVE !== '1';
const LIVE_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------
// Helpers — independent of the module under test wherever that matters
// ---------------------------------------------------------------------------

/**
 * Format an instant the way `~/.claude/sessions/<pid>.json` writes `procStart`: UTC, no zone
 * marker, `Sat Aug 22 03:39:22 2026`. Written out here rather than imported so the test's idea
 * of the format is independent of the guard's idea of it.
 */
function formatProcStartUtc(ms: number): string {
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`
  );
}

/** `ps -o lstart=` parsed as local time, called directly so the test does not lean on the guard. */
function psStartMs(pid: number): number {
  const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
  const ms = Date.parse(out);
  assert.ok(!Number.isNaN(ms), `could not parse ps lstart output: ${JSON.stringify(out)}`);
  return ms;
}

/** A pid that is not in use. Scans downward so the answer is an observation, not a guess. */
function findDeadPid(): number {
  for (let pid = 90_000; pid > 60_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return pid;
    }
  }
  throw new Error('no unused pid found in 60000..90000');
}

/** Live sessions on this machine, read straight from the registry and cross-checked with kill -0. */
function liveRegistrySessions(): { sessionId: string; pid: number; cwd: string }[] {
  const dir = join(homedir(), '.claude', 'sessions');
  const out: { sessionId: string; pid: number; cwd: string }[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return out;
  }
  for (const name of names) {
    try {
      const j = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
      if (typeof j.sessionId !== 'string' || typeof j.pid !== 'number') continue;
      process.kill(j.pid, 0);
      out.push({ sessionId: j.sessionId, pid: j.pid, cwd: String(j.cwd ?? '') });
    } catch {
      /* dead, or unparseable */
    }
  }
  return out;
}

interface ForkCensus {
  /** Parents with more than one child of any type. Normal transcripts have plenty of these. */
  anyMultiChild: number;
  /**
   * Parents with more than one child that is a real prompt — a `user` record that is not meta
   * and carries no `tool_result` block. Measured baseline across the user's 155 real session
   * transcripts: **0 files**. (647 parents there have >1 child of some kind, 511 of them the
   * ordinary `assistant:tool_use` + `user:tool_result` pair.) This is the two-writer signature.
   */
  promptForks: number;
  records: number;
}

/** Forensic census of a transcript. Split on \n only — never readline (SCHEMA-NOTES §2). */
function censusForks(transcriptPath: string): ForkCensus {
  const text = readFileSync(transcriptPath, 'utf8');
  const children = new Map<string, Map<string, Record<string, unknown>>>();
  let records = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof rec !== 'object' || rec === null) continue;
    records++;
    const uuid = rec.uuid;
    const parent = rec.parentUuid;
    if (typeof uuid !== 'string' || typeof parent !== 'string') continue;
    let bucket = children.get(parent);
    if (!bucket) {
      bucket = new Map();
      children.set(parent, bucket);
    }
    bucket.set(uuid, rec);
  }

  let anyMultiChild = 0;
  let promptForks = 0;
  for (const kids of children.values()) {
    if (kids.size < 2) continue;
    anyMultiChild++;
    let prompts = 0;
    for (const rec of kids.values()) {
      if (rec.type !== 'user' || rec.isMeta === true) continue;
      const msg = rec.message as Record<string, unknown> | undefined;
      if (!msg) continue;
      const content = msg.content;
      const isToolResult =
        Array.isArray(content) &&
        content.some(
          (b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'tool_result',
        );
      if (isToolResult) continue;
      prompts++;
    }
    if (prompts > 1) promptForks++;
  }
  return { anyMultiChild, promptForks, records };
}

function runClaude(
  args: string[],
  cwd: string,
  prompt: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('claude', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
    child.on('error', (e) => resolve({ code: null, stdout, stderr: stderr + e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. isProcessAlive
// ---------------------------------------------------------------------------

describe('isProcessAlive', () => {
  test('false for a pid that does not exist', () => {
    const dead = findDeadPid();
    assert.equal(isProcessAlive(dead), false);
    assert.equal(isProcessAlive(dead, formatProcStartUtc(Date.now())), false);
  });

  test('true for this process when procStart matches', () => {
    // The positive case is what makes the negative cases meaningful: without it, an
    // always-false implementation would satisfy every other assertion in this suite.
    const procStart = formatProcStartUtc(psStartMs(process.pid));
    assert.equal(
      isProcessAlive(process.pid, procStart),
      true,
      `own pid ${process.pid} with procStart ${procStart} should read as alive`,
    );
  });

  test('false for a live pid whose procStart does not match', () => {
    // PID reuse: the id exists, but it is a different program now.
    assert.equal(isProcessAlive(process.pid, 'Thu Jan 01 00:00:00 2015'), false);
  });

  test('procStart is UTC while ps prints local — instants are compared, not strings', () => {
    // The trap that would silently disable the whole guard. On this machine the two renderings
    // are 6 hours apart; a string compare, or parsing procStart as local, makes every live
    // session read as dead and permits every write.
    const psMs = psStartMs(process.pid);
    const utcText = formatProcStartUtc(psMs);
    const offsetMs = new Date(psMs).getTimezoneOffset() * 60_000;
    if (offsetMs !== 0) {
      assert.notEqual(
        Date.parse(utcText),
        psMs,
        'parsing the recorded procStart as local time must NOT give the real instant here',
      );
    }
    assert.equal(isProcessAlive(process.pid, utcText), true, 'UTC reading must still match');
    assert.equal(isProcessAlive(process.pid, psMs), true, 'epoch ms fallback must match');
  });

  test('conservative when the start time is unknown or unparseable', () => {
    assert.equal(isProcessAlive(process.pid), true);
    assert.equal(isProcessAlive(process.pid, 'not a date at all'), true);
  });

  test('readProcessStartMs agrees with an independent ps call, and is null for a dead pid', () => {
    assert.equal(readProcessStartMs(process.pid), psStartMs(process.pid));
    assert.equal(readProcessStartMs(findDeadPid()), null);
  });
});

// ---------------------------------------------------------------------------
// 2. assertSafeToWrite against live processes
// ---------------------------------------------------------------------------

describe('assertSafeToWrite refuses live sessions', () => {
  test('a real live Claude session on this machine is refused', async () => {
    const live = liveRegistrySessions();
    assert.ok(
      live.length > 0,
      'no live Claude session found in ~/.claude/sessions — open one and re-run; this test ' +
        'asserts against real machine state on purpose',
    );
    const target = live[0];
    const result = await assertSafeToWrite(target.sessionId);
    console.log('\n  REAL REFUSAL PAYLOAD: ' + JSON.stringify(result, null, 2).split('\n').join('\n  ') + '\n');
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'alive');
    assert.equal(result.pid, target.pid);
    assert.equal(result.jumpUrl, `claude://resume?session=${target.sessionId}`);

    const resolved = await resolveSessionPid(target.sessionId);
    assert.ok(resolved, 'the resolver must find the same process');
    assert.equal(resolved.pid, target.pid);
  });

  test('every live session on this machine is refused, not just the first', async () => {
    const live = liveRegistrySessions();
    assert.ok(live.length > 0, 'this test needs at least one live session');
    for (const s of live) {
      const r = await assertSafeToWrite(s.sessionId);
      assert.equal(r.ok, false, `session ${s.sessionId} (pid ${s.pid}) was NOT refused`);
      if (r.ok) continue;
      assert.equal(r.reason, 'alive');
    }
  });

  describe('synthetic session backed by a real live process', () => {
    let sessionsDir = '';
    let child: ChildProcess | null = null;
    let childPid = 0;
    const sessionId = randomUUID();

    before(async () => {
      sessionsDir = mkdtempSync(join(tmpdir(), 'mc-guard-sessions-'));
      // A real process, so kill -0 and ps both have something true to say about it.
      child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
      await new Promise((r) => setTimeout(r, 300));
      childPid = child.pid ?? 0;
      assert.ok(childPid > 0, 'the synthetic session needs a real child process');
      writeFileSync(
        join(sessionsDir, `${childPid}.json`),
        JSON.stringify({
          pid: childPid,
          sessionId,
          cwd: '/private/tmp',
          startedAt: psStartMs(childPid),
          procStart: formatProcStartUtc(psStartMs(childPid)),
          version: '2.1.222',
          kind: 'interactive',
          entrypoint: 'claude-desktop',
          name: 'synthetic',
        }),
      );
    });

    after(() => {
      child?.kill('SIGKILL');
      if (sessionsDir) rmSync(sessionsDir, { recursive: true, force: true });
    });

    test('refuses with reason "alive", the pid and the jump link', async () => {
      const result = await assertSafeToWrite(sessionId, { sessionsDir });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, 'alive');
      assert.equal(result.pid, childPid);
      assert.equal(result.jumpUrl, jumpUrlFor(sessionId));
      assert.match(result.detail, /is running this session/);
    });

    test('the procStart cross-check is load-bearing, not decorative', async () => {
      // Same live pid, wrong recorded start time => a different program now => not this session
      // => the "alive" refusal must disappear. If procStart were ignored this stays "alive" and
      // the test goes red.
      const wrongDir = mkdtempSync(join(tmpdir(), 'mc-guard-sessions-wrong-'));
      try {
        writeFileSync(
          join(wrongDir, `${childPid}.json`),
          JSON.stringify({
            pid: childPid,
            sessionId,
            cwd: '/private/tmp',
            startedAt: 0,
            procStart: 'Thu Jan 01 00:00:00 2015',
            kind: 'interactive',
          }),
        );
        const result = await assertSafeToWrite(sessionId, { sessionsDir: wrongDir });
        assert.equal(result.ok, false);
        if (result.ok) return;
        assert.equal(result.reason, 'missing-transcript', 'expected the liveness refusal to lift');
      } finally {
        rmSync(wrongDir, { recursive: true, force: true });
      }
    });

    test('resolveLiveness reports both sources as consulted', async () => {
      const r = await resolveLiveness(sessionId, { sessionsDir });
      assert.equal(r.registryAvailable, true);
      assert.equal(r.agentsAvailable, true, `claude agents was unavailable: ${r.agentsError ?? ''}`);
      assert.equal(r.candidates.length, 1);
      assert.equal(r.candidates[0].source, 'registry');
      assert.equal(r.candidates[0].pid, childPid);
    });

    test('an unreadable registry is "unresolvable", never "safe"', async () => {
      const r = await assertSafeToWrite(randomUUID(), {
        sessionsDir: '/private/tmp/mc-guard-no-such-registry',
      });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, 'unresolvable');
      assert.match(r.detail, /session registry unreadable/);
    });
  });

  test('a non-uuid session id is rejected before it reaches a path or an argv', async () => {
    const r = await assertSafeToWrite('../../etc/passwd');
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'unresolvable');
    assert.match(r.detail, /not a session id/);
  });

  test('an idle session with a transcript is allowed, and its byte count is the file size', async () => {
    // Exercises the ok branch against real data rather than a fixture.
    const live = new Set(liveRegistrySessions().map((s) => s.sessionId));
    const root = join(homedir(), '.claude', 'projects');
    const uuidFile = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

    let checked = 0;
    for (const dir of readdirSync(root)) {
      let entries: string[] = [];
      try {
        entries = readdirSync(join(root, dir));
      } catch {
        continue;
      }
      for (const name of entries) {
        const m = uuidFile.exec(name);
        if (!m || live.has(m[1])) continue;
        const path = join(root, dir, name);
        const r = await assertSafeToWrite(m[1]);
        if (!r.ok) continue; // a background agent may still own it; try the next one
        checked++;
        assert.equal(r.transcriptPath, path);
        assert.equal(r.bytes, statSync(path).size);
        assert.equal(findTranscriptPath(m[1]), path);
        return;
      }
    }
    assert.ok(checked > 0, 'expected at least one writable idle session transcript on this machine');
  });
});

// ---------------------------------------------------------------------------
// 3. recheckBytes — the TOCTOU closer
// ---------------------------------------------------------------------------

describe('recheckBytes', () => {
  test('true while the file is unchanged, false the moment it grows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-guard-bytes-'));
    const file = join(dir, 'transcript.jsonl');
    try {
      writeFileSync(file, '{"type":"user"}\n');
      const bytes = statSync(file).size;
      assert.equal(recheckBytes(file, bytes), true);

      appendFileSync(file, '{"type":"assistant"}\n');
      assert.equal(recheckBytes(file, bytes), false, 'a grown file must not be written to');

      assert.equal(recheckBytes(file, statSync(file).size), true, 're-arming on the new size works');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('false when the file shrank or is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc-guard-bytes-'));
    const file = join(dir, 'transcript.jsonl');
    try {
      writeFileSync(file, 'aaaaaaaaaa');
      assert.equal(recheckBytes(file, 10), true);
      writeFileSync(file, 'aaa');
      assert.equal(recheckBytes(file, 10), false);
      rmSync(file);
      assert.equal(recheckBytes(file, 10), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. The advisory lock
// ---------------------------------------------------------------------------

describe('session lock', () => {
  test('a second acquire is refused while the first is held, and works after release', () => {
    const lockDir = mkdtempSync(join(tmpdir(), 'mc-guard-locks-'));
    const id = randomUUID();
    try {
      const first = acquireSessionLock(id, lockDir);
      assert.ok(first);
      assert.equal(acquireSessionLock(id, lockDir), null, 'second acquire must be refused');
      first.release();
      const third = acquireSessionLock(id, lockDir);
      assert.ok(third, 'lock must be reusable after release');
      third.release();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });

  test('a lock held by a dead process is stolen, not honoured forever', () => {
    const lockDir = mkdtempSync(join(tmpdir(), 'mc-guard-locks-'));
    const id = randomUUID();
    try {
      writeFileSync(
        join(lockDir, `${id}.lock`),
        JSON.stringify({ pid: findDeadPid(), at: Date.now(), sessionId: id }),
      );
      const lock = acquireSessionLock(id, lockDir);
      assert.ok(lock, 'a crashed cockpit must not wedge a session permanently');
      lock.release();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The real one: cause the fork, then prove the guard prevents it
// ---------------------------------------------------------------------------

describe('the two-writer hazard, against throwaway sessions only', { skip: SKIP_LIVE }, () => {
  const workRoot = join(
    '/private/tmp',
    `mc-guard-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const created: string[] = [];

  before(() => {
    mkdirSync(workRoot, { recursive: true });
  });

  after(() => {
    // Removes only what this run created, under a uniquely named /private/tmp path, so the
    // board is not left with junk sessions. the user's own sessions are never touched: the guard on
    // every path is the literal `mc-guard-test-` marker this run minted.
    for (const p of created) {
      if (!p.includes('mc-guard-test-')) continue;
      try {
        rmSync(p, { force: true });
      } catch {
        /* leave it */
      }
      const projectDir = dirname(p);
      if (!projectDir.includes('mc-guard-test-')) continue;
      try {
        rmSync(projectDir, { recursive: true, force: true });
      } catch {
        /* leave it */
      }
    }
    rmSync(workRoot, { recursive: true, force: true });
  });

  async function makeThrowawaySession(
    label: string,
  ): Promise<{ sessionId: string; transcriptPath: string; cwd: string }> {
    const cwd = join(workRoot, label);
    mkdirSync(cwd, { recursive: true });
    const sessionId = randomUUID();
    const r = await runClaude(
      ['-p', '--session-id', sessionId, '--model', 'haiku'],
      cwd,
      'Reply with exactly: ready',
    );
    assert.equal(r.code, 0, `session create failed: ${r.stderr}`);
    const transcriptPath = findTranscriptPath(sessionId);
    assert.ok(transcriptPath, 'the new session must have a transcript');
    created.push(transcriptPath);
    return { sessionId, transcriptPath, cwd };
  }

  test(
    'two raw concurrent `claude -r` calls fork the transcript — the hazard is real',
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const s = await makeThrowawaySession('hazard');

      const pre = censusForks(s.transcriptPath);
      assert.equal(pre.promptForks, 0, 'a fresh session must start unforked');

      const [a, b] = await Promise.all([
        runClaude(['-p', '-r', s.sessionId, '--model', 'haiku'], s.cwd, 'Reply with exactly: alpha'),
        runClaude(['-p', '-r', s.sessionId, '--model', 'haiku'], s.cwd, 'Reply with exactly: bravo'),
      ]);

      // Both succeeding, with no lock and no warning, is the whole problem.
      assert.equal(a.code, 0, `first resume failed: ${a.stderr}`);
      assert.equal(b.code, 0, `second resume failed: ${b.stderr}`);

      const post = censusForks(s.transcriptPath);
      console.log(`\n  HAZARD CENSUS: before ${JSON.stringify(pre)} -> after ${JSON.stringify(post)}\n`);
      assert.ok(
        post.anyMultiChild > pre.anyMultiChild,
        'some parentUuid must have gained a second child',
      );
      assert.ok(
        post.promptForks >= 1,
        'two prompts must now hang off one parentUuid — that is the silently lost branch',
      );
    },
  );

  test(
    'two concurrent continueSession calls do NOT fork the transcript',
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const s = await makeThrowawaySession('guarded');
      const pre = censusForks(s.transcriptPath);
      assert.equal(pre.promptForks, 0);
      const bytesBefore = statSync(s.transcriptPath).size;

      // Fired without awaiting the first, which is exactly what two clicks look like.
      const p1 = continueSession({
        sessionId: s.sessionId,
        message: 'Reply with exactly: alpha',
        model: 'haiku',
      });
      const p2 = continueSession({
        sessionId: s.sessionId,
        message: 'Reply with exactly: bravo',
        model: 'haiku',
      });
      const [r1, r2] = await Promise.all([p1, p2]);

      const okCount = (r1.ok ? 1 : 0) + (r2.ok ? 1 : 0);
      console.log(
        `\n  GUARDED RESULT: r1=${r1.ok ? 'accepted' : `refused:${r1.reason}`} ` +
          `r2=${r2.ok ? 'accepted' : `refused:${r2.reason}`}\n`,
      );
      assert.equal(okCount, 1, 'exactly one writer may proceed');

      const refused = r1.ok ? r2 : r1;
      assert.equal(refused.ok, false);
      if (!refused.ok) {
        assert.ok(
          ['busy', 'alive', 'transcript-changed'].includes(refused.reason),
          `unexpected refusal reason ${refused.reason}: ${refused.detail}`,
        );
        assert.ok(refused.jumpUrl, 'a refusal must tell the user where to go instead');
      }

      const accepted = r1.ok ? r1 : r2;
      assert.ok(accepted.ok);
      if (accepted.ok) {
        const output = await drain(accepted.stream);
        assert.match(output, /cockpit_status/, 'the stream must terminate with a status line');
      }

      const post = censusForks(s.transcriptPath);
      const bytesAfter = statSync(s.transcriptPath).size;
      console.log(`\n  GUARDED CENSUS: before ${JSON.stringify(pre)} -> after ${JSON.stringify(post)}\n`);

      // The accepted run has to have actually happened, or "no fork" is trivially true.
      assert.ok(
        bytesAfter > bytesBefore,
        `the accepted run must have written to the transcript (${bytesBefore} -> ${bytesAfter})`,
      );
      assert.equal(post.promptForks, 0, 'no parentUuid may have two prompts under it');
    },
  );

  test(
    'continueSession refuses a session whose cwd and repo root are both gone',
    { timeout: LIVE_TIMEOUT_MS },
    async () => {
      const s = await makeThrowawaySession('deadcwd');
      rmSync(s.cwd, { recursive: true, force: true });
      const r = await continueSession({ sessionId: s.sessionId, message: 'hello', model: 'haiku' });
      assert.equal(r.ok, false);
      if (r.ok) return;
      assert.equal(r.reason, 'missing-cwd');
    },
  );

  test('dispatchNew returns a session id before any output exists', { timeout: LIVE_TIMEOUT_MS }, async () => {
    const cwd = join(workRoot, 'dispatch');
    mkdirSync(cwd, { recursive: true });
    const r = dispatchNew({ cwd, prompt: 'Reply with exactly: ready', model: 'haiku' });
    assert.ok(r.ok, r.ok ? '' : r.detail);
    if (!r.ok) return;
    assert.match(r.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.ok(r.pid > 0);
    // The id is a usable identity immediately — before the run has written anything.
    assert.equal(findTranscriptPath(r.sessionId), null);

    const out = await drain(r.stream);
    assert.match(out, /cockpit_status/);
    const path = findTranscriptPath(r.sessionId);
    assert.ok(path, 'the dispatched run must have created the session it was told to');
    created.push(path);
  });
});

// ---------------------------------------------------------------------------
// 6. Input hygiene
// ---------------------------------------------------------------------------

describe('input hygiene', () => {
  test('a model value that is really a CLI flag is refused', async () => {
    // `claude -p "--version"` prints the version instead of answering: verified on 2.1.228.
    // The message travels on stdin so it can never reach argv; `--model` can, so it is filtered.
    const r = await continueSession({
      sessionId: randomUUID(),
      message: 'hi',
      model: '--dangerously-skip-permissions',
    });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'bad-request');
  });

  test('an empty message is refused before anything is spawned', async () => {
    const r = await continueSession({ sessionId: randomUUID(), message: '   ' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'bad-request');
  });

  test('dispatchNew refuses a cwd that does not exist', () => {
    const r = dispatchNew({ cwd: '/private/tmp/definitely-not-here-mc-guard', prompt: 'hi' });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'missing-cwd');
  });

  test('no executable line in dispatch.ts contains a permission-bypass flag', () => {
    const src = readFileSync(new URL('../lib/dispatch.ts', import.meta.url), 'utf8');
    const offenders = src
      .split('\n')
      .filter(
        (l) =>
          l.includes('skip-permissions') &&
          !l.trimStart().startsWith('*') &&
          !l.trimStart().startsWith('//'),
      );
    assert.deepEqual(offenders, [], `permission-bypass flag appears in live code: ${offenders.join(' | ')}`);
  });
});

if (SKIP_LIVE) {
  test('LIVE SECTION SKIPPED', () => {
    console.log('\n  set MC_RUN_LIVE=1 to run the live concurrency proof against your own ~/.claude.\n');
  });
}
