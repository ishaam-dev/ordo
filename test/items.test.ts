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
import { resetDb, seedThread, seedMessage } from './helpers/fixtures.js';
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
  const parsed = analyzer.parseAnalysis(
    '{"urgency":"P1","why":"w","summary":"s","suggested_action":"a","context_notes":"","items":"nonsense"}',
  );
  assert.deepEqual(parsed.items, [], 'malformed items never sink the verdict');
});
