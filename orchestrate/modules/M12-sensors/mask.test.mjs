import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeMasker, findCredentials, looksHighEntropy, collectCredentialValues, redactCredentialValues } from './mask.mjs';
import { FAKE, run } from './fakes.mjs';

const { maskSecrets } = makeMasker();
const clean = (s) => maskSecrets(s).text;
const KINDS = ['github', 'githubShort', 'githubApp', 'githubPat', 'vercelPrefixed', 'supabasePat', 'supabaseSecret',
  'supabaseJwt', 'anthropic', 'skShort', 'generic'];

// R-0b-125: every known shape, planted in a log line, a commit message and a check output, is masked.
for (const k of KINDS) {
  for (const [where, line] of [
    ['log line', `2026-11-03T10:00:00Z deploy step used ${FAKE[k]} and finished`],
    ['commit message', `fix: rotate the key\n\nOld value was ${FAKE[k]}, do not reuse`],
    ['check output', `Error: request failed (auth ${FAKE[k]}) at step 4`],
  ]) {
    test(`masks a planted ${k} key in a ${where}`, () => {
      const out = clean(line);
      assert.ok(!out.includes(FAKE[k]), out);
      assert.match(out, /\[REDACTED(:[a-z-]+)?\]/);
      assert.equal(findCredentials(out).length, 0, out);
    });
  }
}

test('Vercel classic 24-character token is masked by name, flag and Bearer, not by shape alone', () => {
  const t = FAKE.vercelClassic;
  for (const line of [`VERCEL_TOKEN=${t}`, `vercel deploy --token ${t} --prod`, `vercel --token=${t}`,
    `Authorization: Bearer ${t}`, `{"vercel_token": "${t}"}`]) {
    assert.ok(!clean(line).includes(t), line);
  }
});

test('passwords inside connection addresses, and values after secret-sounding names', () => {
  const url = `postgres://app_user:${FAKE.dbPassword}@db.example.internal:5432/main`;
  assert.equal(clean(url), 'postgres://app_user:[REDACTED:url-password]@db.example.internal:5432/main');
  for (const line of [`DB_PASSWORD=${FAKE.dbPassword}`, `client_secret: ${FAKE.dbPassword}`, `"api_key": "${FAKE.dbPassword}"`]) {
    assert.ok(!clean(line).includes(FAKE.dbPassword), line);
  }
});

test('exact values from the Sensors environment are masked even without their name (Archon port)', () => {
  const secret = 'plain-words-but-secret-' + run(6, 30);
  const m = makeMasker({ env: { ROBOT_PRIVATE_KEY: secret, HOME: '/somewhere', DATABASE_URL: 'x-db-value-' + run(5, 31) } });
  assert.equal(m.maskSecrets(`echoed: ${secret} done`).text, 'echoed: [REDACTED] done');
  assert.equal(m.maskSecrets('home is /somewhere').text, 'home is /somewhere');
  // the port keeps Archon's order: longest first, so a value inside another is replaced whole
  assert.deepEqual(collectCredentialValues({ A_TOKEN: 'abcdefgh', B_TOKEN: 'abcdefghijkl' }), ['abcdefghijkl', 'abcdefgh']);
  assert.equal(redactCredentialValues('xabcdefx', ['abcdef', 'abc']), 'x[REDACTED]x');
});

test('never masks what the history file needs: SHAs, paths, ordinary prose', () => {
  const sha = 'a3f9c0e1b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2';
  const lines = [
    `commit ${sha}`,
    'orchestrate/modules/M12-sensors/history.test.mjs',
    'docs/research/2026-11-03-competitor-pricing-review.md',
    'Merge pull request #142 from robot/card-C-12-tier2-filter-remembers-value',
    'fix: the token refresh retries now back off',
  ];
  for (const l of lines) assert.equal(clean(l), l, l);
  assert.equal(looksHighEntropy(sha), false);
});

test('maskDeep masks every string at any depth, keys included', () => {
  const { maskDeep } = makeMasker();
  const out = maskDeep({ a: [`x ${FAKE.github}`], b: { c: FAKE.anthropic, [FAKE.generic]: 1 }, n: 3 });
  const s = JSON.stringify(out);
  for (const k of ['github', 'anthropic', 'generic']) assert.ok(!s.includes(FAKE[k]));
  assert.equal(out.n, 3);
});

test('planted failure: the scanner itself finds an unmasked key (so a 0 from it means something)', () => {
  assert.ok(findCredentials(`left in: ${FAKE.github}`).length >= 1);
  assert.ok(findCredentials(`left in: ${FAKE.generic}`).length >= 1);
});

// review-0b-7 M5 and round 2: identifiers stay exact; a typed NAME alone never exempts a value.
test('SHAs, sha256 hashes, UUIDs and deployment ids pass through unchanged', () => {
  const { maskSecrets } = makeMasker();
  const ids = [
    'a'.repeat(7) + run(33, 3).toLowerCase().replace(/[^0-9a-f]/g, 'e'),
    run(64, 4).toLowerCase().replace(/[^0-9a-f]/g, 'c'),
    '3f2b8c1e-9a4d-4e6f-8b2a-1c7d5e9f0a3b',
    ['dpl', run(28, 5)].join('_'),
    ['prj', run(28, 6)].join('_'),
  ];
  for (const id of ids) assert.equal(maskSecrets(`deploy ${id} ok`).text, `deploy ${id} ok`, id);
});

test('maskDeep keeps typed fields exact, but masks a token under a typed name', () => {
  const { maskDeep } = makeMasker();
  const sha = 'b'.repeat(40);
  const uid = ['dpl', run(28, 7)].join('_');
  const out = maskDeep({ head_sha: sha, uid, created_at: '2026-10-29T17:00:00Z', external_id: FAKE.github, run_id: '12345', note: FAKE.generic });
  assert.equal(out.head_sha, sha);
  assert.equal(out.uid, uid);
  assert.equal(out.created_at, '2026-10-29T17:00:00Z');
  assert.equal(out.run_id, '12345');
  assert.equal(out.external_id, '[REDACTED:github]');
  assert.ok(!JSON.stringify(out).includes(FAKE.generic));
});

test('0b-7 audit M-4: the default masker (and cleanOutside) masks a planted value from its own environment', async () => {
  const secret = 'bare-value-no-name-' + run(6, 40);
  const envObj = globalThis.process['env'];
  envObj.ORCH_TEST_PLANTED_TOKEN = secret;
  try {
    assert.equal(makeMasker().maskSecrets(`x ${secret} y`).text, 'x [REDACTED] y');
    const { makePrepare } = await import('./escape.mjs');
    assert.equal(makePrepare()(`x ${secret} y`, 'log-line').includes(secret), false);
  } finally { delete envObj.ORCH_TEST_PLANTED_TOKEN; }
});

test('a short exact value (FEATURE_KEY=1) is not masked everywhere; the old "token" header form is', () => {
  const m = makeMasker({ env: { FEATURE_KEY: '1' } });
  assert.equal(m.maskSecrets('step 1 of 1').text, 'step 1 of 1');
  assert.equal(m.maskSecrets(`Authorization: token ${'a1'.repeat(20)}`).text.includes('a1a1a1'), false);
});

test('0b-7 audit round 3 M-A: a value under a secret-sounding key is masked whatever its shape, at any depth', () => {
  const { maskDeep } = makeMasker({ env: {} });
  // Built at run time (fakes.mjs rule): short values under 20 characters, below every shape and entropy rule.
  const v = [run(17, 3), run(14, 5), run(4, 9), run(9, 13), run(8, 17)];
  const out = maskDeep({ password: v[0], env: { STRIPE_SECRET_KEY: v[1], DB_PASSWORD: v[2], PIN_TOKEN: 123456 }, list: [{ api_key: v[3] }], deep: { a: { client_secret: v[4] } } });
  const all = JSON.stringify(out);
  for (const leaked of [...v, '123456']) assert.equal(all.includes(leaked), false, leaked);
  assert.match(all, /REDACTED:named-key/);
  const kept = maskDeep({ idempotency_key: 'push-1', kind: 'fact.x', key: 'product 1|alert|x', has_token: true, monkey: 'banana' });
  assert.deepEqual(kept, { idempotency_key: 'push-1', kind: 'fact.x', key: 'product 1|alert|x', has_token: true, monkey: 'banana' }, 'ordinary keys and lowercase "key" untouched');
});

test('0b-7 audit round 3 M-B: a token at the end of a URL path is masked, by both the masker and the scan', () => {
  const tok = [run(10, 21), run(12, 22), run(14, 23), run(16, 24), run(14, 25)].join('_').replace(/_(?=[^_]*$)/, '-');
  const line = `POST https://chat.example.test/api/webhooks/1234567890/${tok} 204`;
  const { maskSecrets } = makeMasker({ env: {} });
  const r = maskSecrets(line);
  assert.equal(r.text.includes(tok), false);
  assert.match(r.text, /webhooks\/1234567890\/\[REDACTED:high-entropy\] 204/);
  assert.ok(findCredentials(line).some((f) => f.kind === 'high-entropy' && line.slice(f.at).startsWith(tok)));
  assert.equal(maskSecrets('src/components/very-long-file-name_for-testing/index.tsx').hits.length, 0, 'plain paths stay');
});

test('0b-7 audit round 4 minor: count-like names keep their numbers; a PIN under a secret name is still masked', () => {
  const { maskDeep } = makeMasker({ env: {} });
  const out = maskDeep({ input_tokens: 1234, token_count: 5, tokens_used: 77, PIN_TOKEN: 123456 });
  assert.equal(out.input_tokens, 1234); assert.equal(out.token_count, 5); assert.equal(out.tokens_used, 77);
  assert.equal(out.PIN_TOKEN, '[REDACTED:named-key]');
});
