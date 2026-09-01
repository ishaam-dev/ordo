/**
 * Items v1 — discrete obligations extracted from a thread (the long-running-DM fix).
 * The rules that matter: identity is (thread, slug); the model updates by slug and
 * never silently drops stored items; the user's own "done" beats the model; caps and
 * slug validation keep a verbose extractor from flooding the feed.
 */
import './helpers/env.js';
import { assertIsolated } from './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { raw, resetDb, seedThread, seedMessage } from './helpers/fixtures.js';
import { makeFakeHarness } from './helpers/fake-harness.js';

const db = await import('../src/db.js');
assertIsolated(db.DB_PATH);

const harness = await import('../src/harness/index.js');
const probe = await import('../src/harness/probe.js');
const analyzer = await import('../src/analyzer.js');

function item(overrides: Partial<import('../src/db.js').AnalyzedItem>): import('../src/db.js').AnalyzedItem {
  return {
    slug: 'revise-memo',
    title: 'Revise the cadence memo',
    status: 'open',
    urgency: 'P1',
    why: 'Ellen is waiting on it',
    due: null,
    anchorTs: '1000.000100',
    ...overrides,
  };
}

test('reconcileItems: insert, update by slug, and leave unmentioned items alone', () => {
  resetDb();
  const id = seedThread({});
  let r = db.reconcileItems(id, [item({}), item({ slug: 'confirm-checkr', title: 'Confirm the Checkr charges' })]);
  assert.deepEqual(r, { added: 2, updated: 0, skipped: 0 });

  // Second run mentions only one slug: the other persists untouched.
  r = db.reconcileItems(id, [item({ slug: 'confirm-checkr', status: 'done', title: 'Confirm the Checkr charges' })]);
  assert.deepEqual(r, { added: 0, updated: 1, skipped: 0 });
  const rows = db.listItemsForThread(id);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((i) => i.slug === 'revise-memo')?.status, 'open', 'unmentioned item kept');
  assert.equal(rows.find((i) => i.slug === 'confirm-checkr')?.status, 'done');
});

test('reconcileItems: the user\'s done beats the model; invalid slugs and floods are skipped', () => {
  resetDb();
  const id = seedThread({});
  db.reconcileItems(id, [item({})]);
  const row = db.listItemsForThread(id)[0];
  db.setItemDone(row.id, true);

  // Model tries to reopen it — refused.
  const r = db.reconcileItems(id, [item({ status: 'open', why: 'model thinks it is back' })]);
  assert.equal(r.skipped, 1);
  assert.equal(db.getItemById(row.id)?.status, 'done');
  assert.equal(db.getItemById(row.id)?.user_done, 1);

  // Unticking reopens.
  db.setItemDone(row.id, false);
  assert.equal(db.getItemById(row.id)?.status, 'open');
  assert.equal(db.getItemById(row.id)?.user_done, 0);

  // Garbage slugs and a flood of new open items are contained.
  const junk = db.reconcileItems(id, [
    item({ slug: 'Bad Slug!' }),
    item({ slug: '../etc' }),
  ]);
  assert.equal(junk.added, 0);
  assert.equal(junk.skipped, 2);
  const flood = db.reconcileItems(
    id,
    Array.from({ length: 20 }, (_, i) => item({ slug: `extra-${i}`, title: `Extra ${i}` })),
  );
  assert.ok(flood.added <= 12, 'open-item cap holds');
  assert.ok(flood.skipped >= 8);
});

test('getFeed counts open+waiting items, not done/fyi ones', () => {
  resetDb();
  const id = seedThread({ last_activity: '1000.000100' });
  seedMessage({ thread_id: id, text: 'hello' });
  db.reconcileItems(id, [
    item({}),
    item({ slug: 'waiting-x', status: 'waiting', title: 'Waiting on Ellen' }),
    item({ slug: 'fyi-x', status: 'fyi', urgency: null, title: 'FYI thing' }),
    item({ slug: 'done-x', status: 'done', title: 'Already done' }),
  ]);
  const row = db.getFeed().find((f) => f.id === id);
  assert.equal(row?.open_items, 2);
});

test('the analyzer extracts items end to end, and feeds existing ones back by slug', async () => {
  resetDb();
  const id = seedThread({ last_activity: '1000.000100' });
  seedMessage({ thread_id: id, text: 'Please revise the memo and confirm the charges.' });

  const verdict = {
    urgency: 'P1',
    why: 'w',
    summary: 's',
    suggested_action: 'a',
    context_notes: '',
    items: [
      { slug: 'Revise-Memo', title: 'Revise the cadence memo', status: 'open', urgency: 'P1', why: 'x', anchor_ts: '1000.000100', due: '2026-08-08' },
      { slug: 'bad slug', title: 'dropped', status: 'open' },
    ],
  };
  const fake = makeFakeHarness({
    id: 'items-fake',
    script: [
      { type: 'session', id: 'sess-items' },
      { type: 'result', text: JSON.stringify(verdict), usage: null },
    ],
  });
  await probe.ensureSafetyProof(fake.provider, {});
  harness.setActiveHarness(fake.provider);
  try {
    await analyzer.analyzeThread(db.getThreadById(id)!);
    let rows = db.listItemsForThread(id);
    assert.equal(rows.length, 1, 'the malformed slug is dropped, the good one lands');
    assert.equal(rows[0].slug, 'revise-memo', 'slug normalized to lowercase');
    assert.equal(rows[0].due, '2026-08-08');

    // Re-analysis must see the stored item, by slug, in the prompt.
    db.markAnalysisStale(id);
    await analyzer.analyzeThread(db.getThreadById(id)!);
    const secondPrompt = fake.requests[1].prompt;
    assert.ok(secondPrompt.includes('BEGIN EXISTING ITEMS'));
    assert.ok(secondPrompt.includes('[revise-memo]'));
    rows = db.listItemsForThread(id);
    assert.equal(rows.length, 1, 'same slug updates in place — no duplicate');
  } finally {
    harness.setActiveHarness(null);
  }
});

test('SYSTEM_PROMPT and schema carry the items contract', () => {
  assert.ok(analyzer.SYSTEM_PROMPT.includes('ITEMS'));
  assert.ok(analyzer.SYSTEM_PROMPT.includes('NEVER renamed'));
  assert.ok(analyzer.SYSTEM_PROMPT.includes('"items":[{'));
  // Out-of-thread completion: verified with a cited lookup, never guessed.
  assert.ok(analyzer.SYSTEM_PROMPT.includes('OUTSIDE the thread'));
  assert.ok(analyzer.SYSTEM_PROMPT.includes("search the user's sent mail"));
  assert.ok(analyzer.SYSTEM_PROMPT.includes('Never mark an item done on a guess'));
  const parsed = analyzer.parseAnalysis(
    '{"urgency":"P1","why":"w","summary":"s","suggested_action":"a","context_notes":"","items":"nonsense"}',
  );
  assert.deepEqual(parsed.items, [], 'malformed items never sink the verdict');
});

// ---------------------------------------------------------------------------
// due-date re-checks: quiet threads whose items may have been settled outside Slack
// ---------------------------------------------------------------------------

/** Local YYYY-MM-DD, offset in days — matching how the model writes `due`. */
function localDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const hoursAgo = (h: number): string => new Date(Date.now() - h * 3_600_000).toISOString();

function seedAnalysis(threadId: number, analyzedAt: string, covered = '1000.000100'): void {
  db.upsertAnalysis({
    threadId,
    urgency: 'P2',
    why: 'w',
    summary: 's',
    suggestedAction: 'a',
    contextNotes: '',
    coveredThroughTs: covered,
    analyzedAt,
    sessionId: null,
  });
}

test('listThreadsNeedingItemRecheck: a due item on a stale analysis re-checks; fresh/undue ones do not', () => {
  resetDb();
  const cutoff = hoursAgo(6);

  const dueToday = seedThread({ thread_ts: 'rc1.1', channel_id: 'CRC1' });
  seedAnalysis(dueToday, hoursAgo(8));
  db.reconcileItems(dueToday, [item({ due: localDay(0) })]);

  const freshAnalysis = seedThread({ thread_ts: 'rc1.2', channel_id: 'CRC2' });
  seedAnalysis(freshAnalysis, hoursAgo(1)); // looked at recently — paced out
  db.reconcileItems(freshAnalysis, [item({ due: localDay(0) })]);

  const dueTomorrow = seedThread({ thread_ts: 'rc1.3', channel_id: 'CRC3' });
  seedAnalysis(dueTomorrow, hoursAgo(8));
  db.reconcileItems(dueTomorrow, [item({ due: localDay(1) })]);

  const noDue = seedThread({ thread_ts: 'rc1.4', channel_id: 'CRC4' });
  seedAnalysis(noDue, hoursAgo(8));
  db.reconcileItems(noDue, [item({})]);

  const ids = db.listThreadsNeedingItemRecheck(cutoff).map((t) => t.id);
  assert.deepEqual(ids, [dueToday]);

  // The feed exposes analyzed_at so the UI can notice a re-check landing on a
  // quiet thread (the pane keys its cache on it).
  const feedRow = db.getFeed().find((f) => f.id === dueToday);
  assert.equal(typeof feedRow?.analyzed_at, 'string');
});

test('listThreadsNeedingItemRecheck: ticked, model-done, done-thread and email rows never re-check', () => {
  resetDb();
  const cutoff = hoursAgo(6);

  const ticked = seedThread({ thread_ts: 'rc2.1', channel_id: 'CRC1' });
  seedAnalysis(ticked, hoursAgo(8));
  db.reconcileItems(ticked, [item({ due: localDay(0) })]);
  db.setItemDone(db.listItemsForThread(ticked)[0].id, true);

  const modelDone = seedThread({ thread_ts: 'rc2.2', channel_id: 'CRC2' });
  seedAnalysis(modelDone, hoursAgo(8));
  db.reconcileItems(modelDone, [item({ status: 'done', due: localDay(0) })]);

  const doneThread = seedThread({ thread_ts: 'rc2.3', channel_id: 'CRC3', status: 'done' });
  seedAnalysis(doneThread, hoursAgo(8));
  db.reconcileItems(doneThread, [item({ due: localDay(0) })]);

  const email = seedThread({ thread_ts: 'rc2.4', channel_id: 'CRC4' });
  seedAnalysis(email, hoursAgo(8));
  db.reconcileItems(email, [item({ due: localDay(0) })]);
  raw().prepare("UPDATE threads SET source = 'gmail' WHERE id = ?").run(email);

  assert.deepEqual(db.listThreadsNeedingItemRecheck(cutoff), []);
});

test('listThreadsNeedingItemRecheck: a long-lapsed item gets exactly one post-expiry look', () => {
  resetDb();
  const cutoff = hoursAgo(6);

  // Analyzed on its due day eleven days ago, never since: the backlog case.
  const lapsed = seedThread({ thread_ts: 'rc3.1', channel_id: 'CRC1' });
  seedAnalysis(lapsed, hoursAgo(11 * 24));
  db.reconcileItems(lapsed, [item({ due: localDay(-11) })]);
  assert.deepEqual(db.listThreadsNeedingItemRecheck(cutoff).map((t) => t.id), [lapsed]);

  // The look happened (analysis is now post-expiry) and the model kept it open:
  // its one look is spent — it never comes back.
  seedAnalysis(lapsed, new Date().toISOString());
  assert.deepEqual(db.listThreadsNeedingItemRecheck(cutoff), []);
});

test('pickNext falls through to due-item re-checks when no thread has new words', () => {
  resetDb();
  const id = seedThread({ thread_ts: 'rc4.1', channel_id: 'CRC1', last_activity: '1000.000100' });
  seedMessage({ thread_id: id, text: 'please send the details by Friday' });
  seedAnalysis(id, hoursAgo(8), '1000.000100'); // covered == last_activity: not stale
  db.reconcileItems(id, [item({ due: localDay(0) })]);
  assert.equal(analyzer.pickNext()?.id, id);
});
