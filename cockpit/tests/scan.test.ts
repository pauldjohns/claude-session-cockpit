import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { scanRecent, listSessionFiles } from '../lib/scan.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, 'fixtures', 'projects');

/** All fixture files, dated to a fixed instant so window tests are deterministic. */
const NOW = Date.parse('2026-08-22T00:00:00.000Z');

function touchAll(root: string, whenMs: number): void {
  const s = whenMs / 1000;
  for (const f of listSessionFiles(root).files) utimesSync(f.filePath, s, s);
}

describe('session file discovery', () => {
  test('accepts only depth-2 uuid-named files', () => {
    const listed = listSessionFiles(ROOT);
    const names = listed.files.map((f) => f.sessionId).sort();
    assert.deepEqual(names, [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
      '88888888-8888-4888-8888-888888888888',
      '99999999-9999-4999-8999-999999999999',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
    assert.equal(listed.projectDirs, 2);
  });

  test('rejects the depth-2 foreign schema and counts it', () => {
    const listed = listSessionFiles(ROOT);
    assert.equal(listed.nonSessionFilesAtDepth2, 1, 'journal.jsonl sits at depth 2 and is not a session');
    assert.equal(listed.filesAtDepth2, listed.files.length + listed.nonSessionFilesAtDepth2);
    assert.ok(!listed.files.some((f) => f.filePath.endsWith('journal.jsonl')));
  });

  test('never descends into subagent transcripts', () => {
    const listed = listSessionFiles(ROOT);
    assert.ok(
      !listed.files.some((f) => f.filePath.includes('/subagents/')),
      'a subagent transcript would collide with its parent sessionId',
    );
    assert.ok(!listed.files.some((f) => f.sessionId === '55555555-5555-4555-8555-555555555555'));
  });

  test('a missing root returns empty rather than throwing', () => {
    const listed = listSessionFiles(join(ROOT, 'does-not-exist'));
    assert.deepEqual(listed, { files: [], filesAtDepth2: 0, nonSessionFilesAtDepth2: 0, projectDirs: 0 });
  });
});

describe('scanRecent', () => {
  test('parses every session in the window and reports stats', () => {
    touchAll(ROOT, NOW - 60_000);
    const r = scanRecent({ root: ROOT, now: NOW });

    assert.equal(r.stats.matched, 9);
    assert.equal(r.stats.parsed, 9);
    assert.equal(r.stats.failed, 0);
    assert.equal(r.errors.length, 0);
    assert.equal(r.stats.nonSessionFilesAtDepth2, 1);
    assert.equal(r.sessions.length, 9);
    assert.ok(r.stats.totalMs >= 0);
    assert.ok(r.stats.bytesRead > 0);
  });

  test('the mtime window actually excludes', () => {
    touchAll(ROOT, NOW - 60_000);
    const one = listSessionFiles(ROOT).files.find((f) => f.sessionId.startsWith('1111'))!;
    const old = (NOW - 30 * 24 * 3600 * 1000) / 1000;
    utimesSync(one.filePath, old, old);

    const inWindow = scanRecent({ root: ROOT, now: NOW, windowMs: 7 * 24 * 3600 * 1000 });
    assert.equal(inWindow.stats.matched, 8);
    assert.equal(inWindow.stats.outsideWindow, 1);
    assert.ok(!inWindow.sessions.some((s) => s.sessionId.startsWith('1111')));

    const wideWindow = scanRecent({ root: ROOT, now: NOW, windowMs: 365 * 24 * 3600 * 1000 });
    assert.equal(wideWindow.stats.matched, 9);
    assert.ok(wideWindow.sessions.some((s) => s.sessionId.startsWith('1111')));

    touchAll(ROOT, NOW - 60_000);
  });

  test('sorts by last activity, newest first', () => {
    const files = listSessionFiles(ROOT).files.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    files.forEach((f, i) => {
      const t = (NOW - (files.length - i) * 60_000) / 1000;
      utimesSync(f.filePath, t, t);
    });
    const r = scanRecent({ root: ROOT, now: NOW });
    const ids = r.sessions.map((s) => s.sessionId);
    assert.deepEqual(ids, files.map((f) => f.sessionId).reverse());
    touchAll(ROOT, NOW - 60_000);
  });

  test('limit is applied after sorting', () => {
    const files = listSessionFiles(ROOT).files.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    files.forEach((f, i) => {
      const t = (NOW - (files.length - i) * 60_000) / 1000;
      utimesSync(f.filePath, t, t);
    });
    const r = scanRecent({ root: ROOT, now: NOW, limit: 2 });
    assert.equal(r.sessions.length, 2);
    assert.equal(r.sessions[0].sessionId, files[files.length - 1].sessionId);
    touchAll(ROOT, NOW - 60_000);
  });

  test('derives activity from turn state and file staleness', () => {
    touchAll(ROOT, NOW - 60_000);
    const fresh = scanRecent({ root: ROOT, now: NOW, stalledAfterMs: 5 * 60_000 });
    const midTurn = fresh.sessions.find((s) => s.sessionId.startsWith('2222'))!;
    assert.equal(midTurn.turnState, 'mid-turn');
    assert.equal(midTurn.activity, 'running', 'mid-turn and the file moved a minute ago');

    const stale = scanRecent({ root: ROOT, now: NOW, stalledAfterMs: 10_000 });
    const sameSession = stale.sessions.find((s) => s.sessionId.startsWith('2222'))!;
    assert.equal(sameSession.turnState, 'mid-turn');
    assert.equal(sameSession.activity, 'stalled', 'mid-turn but the file has not moved');

    const done = fresh.sessions.find((s) => s.sessionId.startsWith('1111'))!;
    assert.equal(done.activity, 'awaiting-user');
  });

  test('background subagent activity flips an awaiting-user session to running', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-sub-'));
    try {
      const proj = join(root, '-tmp-sub');
      const sid = 'cccccccc-3333-4333-8333-333333333333';
      mkdirSync(proj, { recursive: true });
      const main = join(proj, `${sid}.jsonl`);
      writeFileSync(main, JSON.stringify({
        type: 'assistant', cwd: '/tmp', sessionId: sid, uuid: 'u',
        timestamp: '2026-08-21T00:00:00.000Z', version: '2.1.222',
        message: { model: 'claude-opus-5', role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' },
      }) + '\n');

      const now = Date.parse('2026-08-22T00:00:00.000Z');
      const mainT = (now - 120_000) / 1000;
      utimesSync(main, mainT, mainT);

      // Without any subagent the session is plainly awaiting the user.
      const before = scanRecent({ root, now });
      assert.equal(before.sessions[0].turnState, 'awaiting-user');
      assert.equal(before.sessions[0].activity, 'awaiting-user');
      assert.equal(before.sessions[0].backgroundAgentActive, false);
      assert.equal(before.sessions[0].subagentMtimeMs, undefined);

      // A subagent transcript newer than the main file means work is still in flight.
      const subDir = join(proj, sid, 'subagents', 'workflows', 'wf_abc');
      mkdirSync(subDir, { recursive: true });
      const sub = join(subDir, 'agent-a0123456789abcdef.jsonl');
      writeFileSync(sub, '{"type":"assistant"}\n');
      const subT = (now - 5_000) / 1000;
      utimesSync(sub, subT, subT);

      const after = scanRecent({ root, now });
      assert.equal(after.sessions[0].turnState, 'awaiting-user', 'the transcript still says the turn ended');
      assert.equal(after.sessions[0].backgroundAgentActive, true);
      assert.equal(after.sessions[0].activity, 'running');
      assert.match(after.sessions[0].activitySignal, /background subagent/);
      assert.equal(after.sessions[0].subagentMtimeMs, now - 5_000);

      // The subagent transcript is never itself listed as a session.
      assert.equal(after.sessions.length, 1);

      // Opting out restores the transcript-only answer.
      const off = scanRecent({ root, now, checkSubagents: false });
      assert.equal(off.sessions[0].activity, 'awaiting-user');
      assert.equal(off.sessions[0].backgroundAgentActive, false);

      // A subagent that finished long ago does not count as active.
      const oldT = (now - 3 * 3600_000) / 1000;
      utimesSync(sub, oldT, oldT);
      const stale = scanRecent({ root, now });
      assert.equal(stale.sessions[0].backgroundAgentActive, false);
      assert.equal(stale.sessions[0].activity, 'awaiting-user');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('reports cwdExists and groups worktrees by repo root', () => {
    touchAll(ROOT, NOW - 60_000);
    const r = scanRecent({ root: ROOT, now: NOW });
    const wt = r.sessions.find((s) => s.sessionId.startsWith('2222'))!;
    assert.equal(wt.cwd, '/Users/test/repos/widget/.claude/worktrees/eager-hopper-1a2b3c');
    assert.equal(wt.repoRoot, '/Users/test/repos/widget');
    assert.equal(wt.cwdExists, false, 'this fixture cwd does not exist on disk');

    // A cwd that does exist must come back true, or the flag is decorative.
    const tmp = mkdtempSync(join(tmpdir(), 'mc-cwd-'));
    try {
      const root = mkdtempSync(join(tmpdir(), 'mc-root-'));
      const proj = join(root, '-tmp-real');
      mkdirSync(proj, { recursive: true });
      const sid = 'abcdefab-1111-4111-8111-111111111111';
      writeFileSync(join(proj, `${sid}.jsonl`), JSON.stringify({
        type: 'assistant', cwd: tmp, gitBranch: 'main', sessionId: sid,
        uuid: 'u', timestamp: '2026-08-21T00:00:00.000Z', version: '2.1.222',
        message: { model: 'claude-opus-5', role: 'assistant', content: [], stop_reason: 'end_turn' },
      }) + '\n');
      const rr = scanRecent({ root, now: Date.now() });
      assert.equal(rr.sessions.length, 1);
      assert.equal(rr.sessions[0].cwdExists, true);
      rmSync(root, { recursive: true, force: true });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('aggregates drift across files and surfaces first sightings', () => {
    touchAll(ROOT, NOW - 60_000);
    const r = scanRecent({ root: ROOT, now: NOW });
    assert.equal(r.drift.hasDrift, true);
    assert.equal(r.drift.unknownTypes['quantum-entanglement'], 2);
    assert.equal(r.drift.unknownKeys['assistant.brandNewFieldName'], 1);
    assert.equal(r.drift.unknownVersions['9.9.999'], 1);
    assert.equal(r.drift.firstSightings.length, 3);
    for (const s of r.drift.firstSightings) assert.ok(s.filePath.endsWith('444444444444.jsonl'));
  });

  test('malformed lines are counted into a rate, and the rate is real', () => {
    touchAll(ROOT, NOW - 60_000);
    const r = scanRecent({ root: ROOT, now: NOW });
    assert.equal(r.stats.skippedLines, 2, 'only the deliberately broken fixture contributes');
    assert.ok(r.stats.malformedRate > 0 && r.stats.malformedRate < 0.2);
    assert.equal(r.stats.recordsRead > 0, true);

    const broken = r.sessions.find((s) => s.sessionId.startsWith('7777'))!;
    assert.equal(broken.skippedLines, 2);
    const clean = r.sessions.find((s) => s.sessionId.startsWith('1111'))!;
    assert.equal(clean.skippedLines, 0);
  });

  test('a zero-byte session still produces a row', () => {
    touchAll(ROOT, NOW - 60_000);
    const r = scanRecent({ root: ROOT, now: NOW });
    const empty = r.sessions.find((s) => s.sessionId.startsWith('3333'))!;
    assert.equal(empty.fileSize, 0);
    assert.equal(empty.recordCount, 0);
    assert.equal(empty.activity, 'unknown');
    assert.equal(empty.cwdExists, false);
  });

  test('an unreadable file is reported as an error, not a crash', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-err-'));
    try {
      const proj = join(root, '-tmp-proj');
      mkdirSync(proj, { recursive: true });
      const sid = 'bbbbbbbb-2222-4222-8222-222222222222';
      const p = join(proj, `${sid}.jsonl`);
      writeFileSync(p, '{"type":"user"}\n');
      // Removing read permission is the portable way to make open() fail while stat() still works,
      // so the file is listed and then fails at parse time — the path this test is about.
      chmodSync(p, 0o000);
      const r = scanRecent({ root, now: Date.now() });
      assert.equal(r.sessions.length, 0);
      assert.equal(r.stats.failed, 1);
      assert.equal(r.errors.length, 1);
      assert.equal(r.errors[0].filePath, p);
    } finally {
      try { chmodSync(join(root, '-tmp-proj', 'bbbbbbbb-2222-4222-8222-222222222222.jsonl'), 0o644); } catch {}
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('an empty root scans clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'mc-empty-'));
    try {
      const r = scanRecent({ root, now: Date.now() });
      assert.deepEqual(r.sessions, []);
      assert.equal(r.stats.matched, 0);
      assert.equal(r.stats.malformedRate, 0);
      assert.equal(r.drift.hasDrift, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
