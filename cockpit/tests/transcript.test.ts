import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTranscriptTail,
  parseTailText,
  readTail,
  resolveRepoRoot,
  isSessionFileName,
  decodeProjectDir,
  KNOWN_TYPES,
  KNOWN_KEYS,
  DEFAULT_TAIL_BYTES,
} from '../lib/transcript.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const P = join(HERE, 'fixtures', 'projects');
const ALPHA = join(P, '-Users-test-alpha');
const BETA = join(P, '-Users-test-beta');

const NORMAL = join(ALPHA, '11111111-1111-4111-8111-111111111111.jsonl');
const MID_TURN = join(ALPHA, '22222222-2222-4222-8222-222222222222.jsonl');
const EMPTY = join(ALPHA, '33333333-3333-4333-8333-333333333333.jsonl');
const DRIFT = join(BETA, '44444444-4444-4444-8444-444444444444.jsonl');
const TRUNCATED = join(BETA, '66666666-6666-4666-8666-666666666666.jsonl');
const MALFORMED = join(BETA, '77777777-7777-4777-8777-777777777777.jsonl');
const DUAL_ID = join(BETA, '88888888-8888-4888-8888-888888888888.jsonl');
const PROMPT_AFTER = join(BETA, '99999999-9999-4999-8999-999999999999.jsonl');
const NO_LAST_PROMPT = join(BETA, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl');

describe('normal transcript', () => {
  test('extracts every field the board needs', () => {
    const f = parseTranscriptTail(NORMAL);

    assert.equal(f.sessionIdFromFilename, '11111111-1111-4111-8111-111111111111');
    assert.equal(f.sessionId, '11111111-1111-4111-8111-111111111111');
    assert.equal(f.sessionIdMismatch, false);
    assert.equal(f.projectDir, '-Users-test-alpha');
    assert.equal(f.cwd, '/Users/test/repos/widget');
    assert.equal(f.gitBranch, 'main');
    assert.equal(f.title, 'Widget health check');
    assert.equal(f.titleSource, 'custom-title');

    assert.equal(f.lastUserMessage, 'add a health check endpoint');
    assert.equal(f.lastUserMessageSource, 'last-prompt');
    assert.equal(f.lastAssistantText, 'Added the health check at app/health/route.ts.');
    assert.equal(f.lastToolName, 'Bash');
    assert.equal(f.lastToolAt, '2026-08-20T10:00:06.000Z');

    // 2 user records + 3 assistant records.
    assert.equal(f.messageCount, 5);
    assert.equal(f.userCount, 2);
    assert.equal(f.assistantCount, 3);

    assert.deepEqual(f.models, ['claude-opus-5']);
    assert.deepEqual(f.versions, ['2.1.222']);
    assert.equal(f.firstTimestamp, '2026-08-20T10:00:00.000Z');
    assert.equal(f.lastTimestamp, '2026-08-20T10:00:14.000Z');

    assert.equal(f.prNumber, 412);
    assert.equal(f.prRepository, 'acme/widget');
    assert.equal(f.mode, 'normal');

    assert.deepEqual(f.tokens, { input: 600, output: 120, cacheRead: 6000, cacheCreation: 60 });

    assert.equal(f.skippedLines, 0);
    assert.equal(f.recordCount, 10);
    assert.equal(f.drift.hasDrift, false);
    assert.equal(f.windowTruncated, false);
    assert.equal(f.droppedPartialHead, false);
    assert.equal(f.droppedPartialTail, false);
  });

  test('reports awaiting-user when the newest assistant record ended its turn', () => {
    const f = parseTranscriptTail(NORMAL);
    assert.equal(f.lastStopReason, 'end_turn');
    assert.equal(f.turnState, 'awaiting-user');
    assert.match(f.turnStateSignal, /end_turn/);
  });

  test('does not mistake tool output for the user message', () => {
    const f = parseTranscriptTail(NORMAL);
    // The newest `user` record in this fixture is a tool_result carrying directory output.
    const raw = readFileSync(NORMAL, 'utf8');
    assert.ok(raw.includes('README.md'), 'fixture must contain tool output to make this meaningful');
    assert.ok(!String(f.lastUserMessage).includes('README.md'));
  });
});

describe('most recent request', () => {
  test('prefers the last-prompt record over any user record', () => {
    const f = parseTranscriptTail(PROMPT_AFTER);
    assert.equal(f.lastUserMessageSource, 'last-prompt');
    assert.equal(f.lastUserMessage, 'now do the second thing');
  });

  test('falls back to a human user record, never to tool output', () => {
    const raw = readFileSync(NO_LAST_PROMPT, 'utf8');
    assert.ok(!raw.includes('"last-prompt"'), 'fixture must have no last-prompt record');
    assert.ok(raw.includes('GADGET-RESTART-MARKER'), 'and must carry tool output newer than the prompt');

    const f = parseTranscriptTail(NO_LAST_PROMPT);
    assert.equal(f.lastUserMessageSource, 'user-record');
    assert.equal(f.lastUserMessage, 'restart the server');
    assert.ok(!String(f.lastUserMessage).includes('GADGET-RESTART-MARKER'),
      'a tool_result is not a user request');
  });

  test('a tool_result block disqualifies a record even when it looks like a prompt', () => {
    // Synthetic, not observed: today 0 of 26,413 tool_result records carry promptSource and none
    // mix block types. This pins the guard so a future writer that starts tagging tool results
    // cannot put a diff in the board's headline column.
    const lines = [
      JSON.stringify({ type: 'user', promptSource: 'typed', origin: { kind: 'human' },
        message: { role: 'user', content: 'the real ask' }, uuid: 'u1', timestamp: '2026-08-21T00:00:00.000Z' }),
      JSON.stringify({ type: 'user', promptSource: 'typed', origin: { kind: 'human' },
        message: { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'DIFF-MARKER +++ b/file' },
          { type: 'text', text: 'DIFF-MARKER trailing note' },
        ] }, uuid: 'u2', timestamp: '2026-08-21T00:00:01.000Z' }),
    ].join('\n') + '\n';
    const f = parseTailText(lines, NORMAL, false);
    assert.equal(f.lastUserMessageSource, 'user-record');
    assert.equal(f.lastUserMessage, 'the real ask');
    assert.ok(!String(f.lastUserMessage).includes('DIFF-MARKER'));
  });

  test('a user record without promptSource is not treated as a prompt', () => {
    // Machine-injected text: text-shaped, not meta, but no promptSource and a wrapper tag.
    const lines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '<task-notification> agent finished' },
        uuid: 'u1', timestamp: '2026-08-21T00:00:00.000Z', origin: { kind: 'task-notification' }, promptSource: 'sdk' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'no promptSource on this one' },
        uuid: 'u2', timestamp: '2026-08-21T00:00:01.000Z' }),
      JSON.stringify({ type: 'user', isMeta: true, promptSource: 'sdk',
        message: { role: 'user', content: [{ type: 'text', text: 'injected document body' }] },
        uuid: 'u3', timestamp: '2026-08-21T00:00:02.000Z' }),
    ].join('\n') + '\n';
    const f = parseTailText(lines, NORMAL, false);
    assert.equal(f.userCount, 3);
    assert.equal(f.lastUserMessageSource, 'none');
    assert.equal(f.lastUserMessage, undefined);
  });
});

describe('turn state', () => {
  test('mid-turn when the newest assistant record is waiting on a tool', () => {
    const f = parseTranscriptTail(MID_TURN);
    assert.equal(f.lastStopReason, 'tool_use');
    assert.equal(f.turnState, 'mid-turn');
    assert.equal(f.lastToolName, 'Read');
  });

  test('mid-turn when a human prompt is newer than the newest assistant record', () => {
    const f = parseTranscriptTail(PROMPT_AFTER);
    assert.equal(f.lastStopReason, 'end_turn', 'the last assistant record did finish its turn');
    assert.equal(f.turnState, 'mid-turn', 'but the user has spoken since');
    assert.match(f.turnStateSignal, /human prompt is newer/);
    assert.equal(f.lastUserMessage, 'now do the second thing');
  });

  test('unknown when the window holds no assistant record', () => {
    const f = parseTailText(
      '{"type":"last-prompt","lastPrompt":"hi","sessionId":"x"}\n',
      join(ALPHA, '11111111-1111-4111-8111-111111111111.jsonl'),
      false,
    );
    assert.equal(f.turnState, 'unknown');
    assert.match(f.turnStateSignal, /no assistant record/);
  });
});

describe('degraded inputs', () => {
  test('empty file yields empty facts and does not throw', () => {
    const f = parseTranscriptTail(EMPTY);
    assert.equal(f.fileSize, 0);
    assert.equal(f.recordCount, 0);
    assert.equal(f.skippedLines, 0);
    assert.equal(f.messageCount, 0);
    assert.equal(f.turnState, 'unknown');
    assert.equal(f.turnStateSignal, 'no records in window');
    assert.equal(f.lastUserMessageSource, 'none');
    assert.equal(f.drift.hasDrift, false);
    assert.equal(f.sessionIdFromFilename, '33333333-3333-4333-8333-333333333333');
  });

  test('truncated final line is dropped, not counted as malformed', () => {
    const bytes = readFileSync(TRUNCATED);
    assert.notEqual(bytes[bytes.length - 1], 0x0a, 'fixture must not end with a newline');

    const f = parseTranscriptTail(TRUNCATED);
    assert.equal(f.droppedPartialTail, true);
    assert.equal(f.skippedLines, 0, 'a half-written final line is not a malformed line');
    assert.equal(f.recordCount, 3);
    // The complete records before the truncation still produce facts.
    assert.equal(f.lastUserMessage, 'summarise the log');
    assert.equal(f.lastAssistantText, 'Here is the summary.');
    assert.equal(f.turnState, 'awaiting-user');
    // The title lived on the truncated line, so it must not appear.
    assert.equal(f.title, undefined);
  });

  test('a genuinely broken complete line is skipped and counted', () => {
    const f = parseTranscriptTail(MALFORMED);
    assert.equal(f.skippedLines, 2, 'one truncated-then-newlined line plus one non-JSON line');
    assert.equal(f.recordCount, 2);
    assert.equal(f.droppedPartialTail, false);
    // Parsing continues past the damage.
    assert.equal(f.lastAssistantText, 'Disk is fine.');
    assert.equal(f.lastUserMessageSource, 'user-record', 'last-prompt line was the broken one');
    assert.equal(f.lastUserMessage, 'check the disk');
  });

  test('a tail window starting mid-line drops the partial head without counting it', () => {
    const size = statSync(NORMAL).size;
    const text = readFileSync(NORMAL, 'utf8');
    // Land the window boundary strictly inside the final record, so the first line is a fragment.
    const lastNewline = text.lastIndexOf('\n', text.length - 2);
    const midOfLastLine = lastNewline + 30;
    const tailBytes = size - midOfLastLine;
    assert.ok(tailBytes > 0 && tailBytes < size, 'window must be a proper suffix');

    const f = parseTranscriptTail(NORMAL, { tailBytes });
    assert.equal(f.windowTruncated, true);
    assert.equal(f.droppedPartialHead, true);
    assert.equal(f.skippedLines, 0, 'starting mid-record is expected, not malformed');
    assert.equal(f.windowStart, midOfLastLine);
    assert.equal(f.fileSize, size);
  });

  test('a window that happens to contain no complete record still returns facts', () => {
    const f = parseTranscriptTail(NORMAL, { tailBytes: 20 });
    assert.equal(f.windowTruncated, true);
    assert.equal(f.recordCount, 0);
    assert.equal(f.skippedLines, 0);
    assert.equal(f.turnState, 'unknown');
  });

  test('unknown record types do not stop extraction', () => {
    const f = parseTranscriptTail(DRIFT);
    assert.equal(f.lastUserMessage, 'ship it');
    assert.equal(f.lastAssistantText, 'Shipped.');
    assert.equal(f.turnState, 'awaiting-user');
    assert.equal(f.skippedLines, 0, 'unknown types are valid JSON, not malformed lines');
    assert.equal(f.recordCount, 5);
  });
});

describe('drift detection', () => {
  test('reports unknown type, unknown key and unknown version with first sightings', () => {
    const f = parseTranscriptTail(DRIFT);
    assert.equal(f.drift.hasDrift, true);
    assert.equal(f.drift.unknownTypes['quantum-entanglement'], 2);
    assert.equal(f.drift.unknownKeys['assistant.brandNewFieldName'], 1);
    assert.equal(f.drift.unknownVersions['9.9.999'], 1);

    const kinds = f.drift.firstSightings.map((s) => `${s.kind}:${s.name}`);
    assert.deepEqual(kinds.sort(), [
      'key:brandNewFieldName',
      'type:quantum-entanglement',
      'version:9.9.999',
    ]);
    // First sighting is the FIRST one, not the last.
    const typeSighting = f.drift.firstSightings.find((s) => s.kind === 'type');
    assert.equal(typeSighting?.recordIndex, 1, 'the first of the two unknown records, not the second');
    assert.equal(typeSighting?.filePath, DRIFT);
  });

  test('a clean transcript reports no drift', () => {
    assert.equal(parseTranscriptTail(NORMAL).drift.hasDrift, false);
    assert.equal(parseTranscriptTail(MID_TURN).drift.hasDrift, false);
  });

  test('the known-schema baseline covers every type it claims to', () => {
    for (const t of KNOWN_TYPES) {
      assert.ok(KNOWN_KEYS[t], `KNOWN_KEYS is missing an entry for type ${t}`);
      assert.ok(KNOWN_KEYS[t].includes('type'), `KNOWN_KEYS[${t}] must include 'type'`);
    }
    assert.equal(Object.keys(KNOWN_KEYS).length, KNOWN_TYPES.length);
  });
});

describe('identity', () => {
  test('resolves camelCase sessionId when both spellings are present', () => {
    const raw = readFileSync(DUAL_ID, 'utf8');
    assert.ok(raw.includes('"session_id"'), 'fixture must carry the snake_case spelling');
    assert.ok(raw.includes('deadbeef-dead-4eef-8eef-deadbeefdead'), 'with a different uuid');

    const f = parseTranscriptTail(DUAL_ID);
    assert.equal(f.sessionId, '88888888-8888-4888-8888-888888888888');
    assert.notEqual(f.sessionId, 'deadbeef-dead-4eef-8eef-deadbeefdead');
    assert.equal(f.sessionIdMismatch, false);
  });

  test('flags a session whose in-file sessionId disagrees with its filename', () => {
    const f = parseTailText(
      '{"type":"user","sessionId":"00000000-0000-4000-8000-000000000000","message":{"role":"user","content":"x"}}\n',
      join(ALPHA, '11111111-1111-4111-8111-111111111111.jsonl'),
      false,
    );
    assert.equal(f.sessionIdMismatch, true);
  });

  test('session filename allowlist accepts uuids and rejects everything else', () => {
    assert.equal(isSessionFileName('11111111-1111-4111-8111-111111111111.jsonl'), true);
    assert.equal(isSessionFileName('journal.jsonl'), false);
    assert.equal(isSessionFileName('agent-a0123456789abcdef.jsonl'), false);
    assert.equal(isSessionFileName('skill-injections.jsonl'), false);
    assert.equal(isSessionFileName('11111111-1111-4111-8111-111111111111.json'), false);
    assert.equal(isSessionFileName('11111111-1111-4111-8111-11111111111.jsonl'), false);
  });
});

describe('paths', () => {
  test('resolveRepoRoot walks up past a claude worktree', () => {
    assert.equal(
      resolveRepoRoot('/Users/me/repos/widget/.claude/worktrees/eager-hopper-1a2b3c'),
      '/Users/me/repos/widget',
    );
    assert.equal(
      resolveRepoRoot('/Users/me/repos/widget/.claude/worktrees/eager-hopper/src/deep'),
      '/Users/me/repos/widget',
    );
  });

  test('resolveRepoRoot leaves a plain path alone', () => {
    assert.equal(resolveRepoRoot('/Users/me/repos/widget'), '/Users/me/repos/widget');
    assert.equal(resolveRepoRoot(undefined), undefined);
  });

  test('the worktree fixture resolves to its repo root', () => {
    const f = parseTranscriptTail(MID_TURN);
    assert.equal(f.cwd, '/Users/test/repos/widget/.claude/worktrees/eager-hopper-1a2b3c');
    assert.equal(f.repoRoot, '/Users/test/repos/widget');
  });

  test('decodeProjectDir is a best-effort inverse', () => {
    assert.equal(decodeProjectDir('-Users-test-alpha'), '/Users/test/alpha');
    assert.equal(decodeProjectDir('plain'), 'plain');
  });
});

describe('tail window mechanics', () => {
  test('readTail never reads more than asked', () => {
    const size = statSync(NORMAL).size;
    const w = readTail(NORMAL, 100);
    assert.equal(w.windowBytes, 100);
    assert.equal(w.windowStart, size - 100);
    assert.equal(w.windowTruncated, true);
    assert.equal(Buffer.byteLength(w.text, 'utf8'), 100);
  });

  test('readTail returns the whole of a file smaller than the window', () => {
    const size = statSync(MID_TURN).size;
    assert.ok(size < DEFAULT_TAIL_BYTES);
    const w = readTail(MID_TURN);
    assert.equal(w.windowBytes, size);
    assert.equal(w.windowStart, 0);
    assert.equal(w.windowTruncated, false);
  });

  test('readTail handles a zero-byte file', () => {
    const w = readTail(EMPTY);
    assert.deepEqual(
      { text: w.text, fileSize: w.fileSize, windowBytes: w.windowBytes, windowTruncated: w.windowTruncated },
      { text: '', fileSize: 0, windowBytes: 0, windowTruncated: false },
    );
  });

  test('text fields are clipped to maxTextChars', () => {
    const long = 'x'.repeat(5000);
    const line = JSON.stringify({
      type: 'last-prompt', lastPrompt: long, sessionId: '11111111-1111-4111-8111-111111111111',
    });
    const f = parseTailText(line + '\n', NORMAL, false, { maxTextChars: 50 });
    assert.equal(f.lastUserMessage?.length, 51, '50 characters plus an ellipsis');
  });

  test('the synthetic model is never reported as a model', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { model: '<synthetic>', role: 'assistant', content: [], stop_reason: 'end_turn' },
      uuid: 'x', timestamp: '2026-08-21T00:00:00.000Z',
    });
    const f = parseTailText(line + '\n', NORMAL, false);
    assert.deepEqual(f.models, []);
    assert.equal(f.assistantCount, 1);
  });
});
