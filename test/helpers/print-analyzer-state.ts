/**
 * Child-process probe for the spend guard: inject a harness that bills per token, call
 * startAnalyzer(), print what the health registry says. In its own process because
 * startAnalyzer() flips module-level state that can never be flipped back, and because
 * COPILOT_HARNESS_SPEND_OK is read once, at import.
 *
 * Refuses to run without an explicit COPILOT_DB_PATH so it can never touch the live db.
 */
if ((process.env.COPILOT_DB_PATH ?? '') === '') {
  throw new Error('REFUSING TO RUN: set COPILOT_DB_PATH to a throwaway database first');
}
process.env.TZ = 'UTC';

const { setActiveHarness } = await import('../../src/harness/index.js');
const { makeFakeHarness } = await import('./fake-harness.js');
const { startAnalyzer } = await import('../../src/analyzer.js');
const { analyzerHealth } = await import('../../src/health.js');

const billing = (process.env.FAKE_BILLING ?? 'api-key') as 'api-key' | 'subscription';
const fake = makeFakeHarness({ id: 'billed-fake', label: 'Pi-ish', shortLabel: 'Pi-ish', billing });
setActiveHarness(fake.provider);

startAnalyzer();
const health = analyzerHealth();
console.log(JSON.stringify({ state: health.state, note: health.note }));
process.exit(0);
