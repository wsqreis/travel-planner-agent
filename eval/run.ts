// Measures the memory: does the model save what the traveller said about themselves,
// and only that? Each case checks the profile changes decided for one message.
//
//   npm run eval                                   # the configured model chain
//   npm run eval -- --models a/model:free,b/model  # each model on its own
//
// A case passes when every expected change happened and nothing else changed.
// Values match by keyword ("vegan" matches "vegan diet"), since wording varies.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { decideUpdates } from '../src/agent/remember.ts';
import { loadConfig } from '../src/config.ts';
import { OpenRouterModel } from '../src/llm/model.ts';
import type { Field, MemoryUpdate } from '../src/memory/profile.ts';
import { SqliteProfileStore } from '../src/memory/store.ts';

type Expected = { op: MemoryUpdate['op']; field: Field; value?: string };
type Case = {
  id: string;
  profile?: MemoryUpdate[];
  assistant?: string;
  message: string;
  expect: Expected[];
  /** Changes that are acceptable but not required. */
  allow?: Array<{ field: Field; value: string }>;
};

const PAUSE_MS = 1500; // free models are rate limited

const config = loadConfig();
if (!config.llm.apiKey) {
  console.error('Set OPENROUTER_API_KEY in .env first.');
  process.exit(1);
}
const flag = process.argv.indexOf('--models');
const runs = flag > -1 ? (process.argv[flag + 1] ?? '').split(',').filter(Boolean) : [config.llm.models.join(',')];
const cases: Case[] = JSON.parse(await readFile(new URL('./cases.json', import.meta.url), 'utf8'));

// "set"/"add" both mean "store this", and "clear"/"remove" both mean "forget this":
// which one fits depends on the field type and how much the traveller asked to forget.
const GROUPS = [['set', 'add'], ['clear', 'remove']];
const sameOp = (a: string, b: string) => a === b || GROUPS.some((group) => group.includes(a) && group.includes(b));
const matches = (update: MemoryUpdate, expected: { op?: string; field: Field; value?: string }) =>
  update.field === expected.field &&
  (!expected.op || sameOp(update.op, expected.op)) &&
  (!expected.value || (update.value ?? '').toLowerCase().includes(expected.value));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(new URL('./results/', import.meta.url), { recursive: true });

for (const run of runs) {
  const model = new OpenRouterModel({ ...config.llm, models: run.split(',') });
  const label = run.split(',')[0]!;
  console.log(`\n== ${label}${run.includes(',') ? ' (with fallbacks)' : ''}`);

  let expectedTotal = 0;
  let expectedFound = 0;
  let appliedTotal = 0;
  let spuriousTotal = 0;
  const results = [];

  for (const testCase of cases) {
    const store = new SqliteProfileStore(':memory:');
    if (testCase.profile) store.update('eval', testCase.profile);
    try {
      const started = performance.now();
      const decided = await decideUpdates(model, store.get('eval'), testCase.message, testCase.assistant);
      const latencyMs = performance.now() - started;
      // Score what actually changed the profile, the same way the agent applies it.
      const { applied } = store.update('eval', decided);

      const missing = testCase.expect.filter((expected) => !applied.some((update) => matches(update, expected)));
      const spurious = applied.filter(
        (update) =>
          !testCase.expect.some((expected) => matches(update, expected)) &&
          !(testCase.allow ?? []).some((allowed) => matches(update, allowed)),
      );
      expectedTotal += testCase.expect.length;
      expectedFound += testCase.expect.length - missing.length;
      appliedTotal += applied.length;
      spuriousTotal += spurious.length;

      const passed = missing.length === 0 && spurious.length === 0;
      results.push({ id: testCase.id, passed, applied, missing, spurious, latencyMs });
      const detail = passed ? '' : `  missing=${JSON.stringify(missing)} unexpected=${JSON.stringify(spurious)}`;
      console.log(`${passed ? 'pass' : 'FAIL'}  ${testCase.id}${detail}`);
    } catch (error) {
      results.push({ id: testCase.id, passed: false, error: String(error) });
      console.log(`ERR   ${testCase.id}  ${error instanceof Error ? error.message : error}`);
    } finally {
      store.close();
    }
    await sleep(PAUSE_MS);
  }

  const passed = results.filter((result) => result.passed).length;
  const pct = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '-');
  console.log(`\ncases passed:     ${passed}/${cases.length} (${pct(passed, cases.length)})`);
  console.log(`recall:           ${pct(expectedFound, expectedTotal)}  (expected facts that were saved)`);
  console.log(`precision:        ${pct(appliedTotal - spuriousTotal, appliedTotal)}  (saved changes that were right)`);

  const file = new URL(`./results/${label.replace(/[^\w.-]+/g, '_')}-${Date.now()}.json`, import.meta.url);
  await writeFile(file, JSON.stringify({ model: run, ranAt: new Date().toISOString(), passed, total: cases.length, results }, null, 2));
}
