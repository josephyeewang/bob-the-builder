import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectLearning } from './learning-check.mjs';

const cli = fileURLToPath(new URL('./learning-check.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'bob-learning-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'evidence'));
  writeFileSync(join(root, 'evidence', 'proof.md'), 'Synthetic receipt, not product evidence.');
  const prevention = {
    invariant: 'Never overwrite a newer order.', mechanism: 'One revision-checked writer.',
    command: 'node --test test/orders.test.mjs', builder: 'builder', reviewer: 'reviewer',
    scope_evidence: 'evidence/proof.md', regression_evidence: 'evidence/proof.md',
    clean_control_evidence: 'evidence/proof.md', new_instance_evidence: 'evidence/proof.md',
    adoption: { status: 'verified', evidence: 'evidence/proof.md' },
  };
  const ledger = { entries: [{ retained: true }], learning: { version: 1,
    incidents: [{ id: 'order-one', class: 'stale-write', kind: 'repeat', change_id: 'save-repair', source: 'evidence/proof.md',
      check: 'Does a late edit survive?', status: 'closed', prevention }],
    changes: [{ id: 'save-repair', material_remaining: 0, rounds: [
      { id: 'first-review', kind: 'initial', material_found: 1 },
      { id: 'repair-review', kind: 'follow-up', material_found: 0 },
    ] }],
  } };
  const check = options => inspectLearning(ledger, { baseDir: root, ...options });
  const run = args => {
    writeFileSync(join(root, 'audit-ledger.json'), JSON.stringify(ledger));
    return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });
  };
  return { root, ledger, check, run, incident: ledger.learning.incidents[0], change: ledger.learning.changes[0] };
}

test('complete recurring proof closes and retains parent ledger unchanged', t => {
  const f = fixture(t), before = JSON.stringify(f.ledger);
  assert.equal(f.check({ stage: 'close' }).code, 0);
  assert.equal(JSON.stringify(f.ledger), before);
  assert.match(f.check().messages.join('\n'), /NOT verified/);
});
test('plan feeds closed prevention and check command to the next builder', t => {
  const f = fixture(t), result = f.check();
  assert.match(result.messages.join('\n'), /Does a late edit survive/);
  assert.match(result.messages.join('\n'), /node --test test\/orders.test.mjs/);
});
test('missing block and empty block cannot judge', t => {
  const f = fixture(t);
  assert.equal(inspectLearning({}, { baseDir: f.root }).code, 2);
  f.ledger.learning.incidents = []; f.ledger.learning.changes = [];
  assert.equal(f.check().code, 2);
});
test('malformed block and unknown fields fail, including outside selected class', t => {
  const f = fixture(t);
  f.ledger.learning.incident = [];
  assert.equal(f.check({ className: 'unrelated' }).code, 1);
  delete f.ledger.learning.incident;
  f.incident.prevention.adoption.staus = 'verified';
  assert.equal(f.check().code, 1);
});
test('duplicate incident IDs cannot inflate recurrence', t => {
  const f = fixture(t);
  f.ledger.learning.incidents.push(structuredClone(f.incident));
  assert.match(f.check().errors.join('\n'), /duplicate incident/);
});
test('duplicate round IDs are refused rather than counted twice', t => {
  const f = fixture(t); f.change.rounds.push(structuredClone(f.change.rounds[0]));
  assert.match(f.check().errors.join('\n'), /duplicate round/);
});
test('multiple rounds alone do not make one new incident recurrent', t => {
  const f = fixture(t); f.incident.kind = 'newly-discovered'; delete f.incident.prevention;
  assert.equal(f.check({ stage: 'close' }).code, 0);
  assert.match(f.check().messages.join('\n'), /first recorded occurrence/);
});
test('distinct incidents of one class make recurrence even without repeat kind', t => {
  const f = fixture(t); f.incident.kind = 'newly-discovered'; delete f.incident.prevention;
  f.ledger.learning.incidents.push({ ...f.incident, id: 'order-two', kind: 'fix-induced' });
  assert.equal(f.check({ stage: 'close' }).code, 1);
});
test('open recurring prevention is visible in plan but blocks close', t => {
  const f = fixture(t); f.incident.status = 'open'; delete f.incident.prevention;
  assert.equal(f.check().code, 0);
  assert.match(f.check().messages.join('\n'), /OPEN/);
  assert.equal(f.check({ stage: 'close' }).code, 1);
});
test('falsely closed recurrence fails plan too', t => {
  const f = fixture(t); delete f.incident.prevention;
  assert.match(f.check().errors.join('\n'), /falsely closed/);
});
test('unknown adoption is distinct from verified and cannot close recurrence', t => {
  const f = fixture(t); f.incident.status = 'open';
  f.incident.prevention.adoption = { status: 'unknown' };
  assert.equal(f.check().code, 0);
  assert.match(f.check().messages.join('\n'), /adoption: unknown/);
  assert.equal(f.check({ stage: 'close' }).code, 1);
});
test('same builder and reviewer cannot supply independence', t => {
  const f = fixture(t); f.incident.prevention.reviewer = ' builder ';
  assert.match(f.check().errors.join('\n'), /must differ/);
});
test('all prevention proof types and actionable mechanisms are required', t => {
  const f = fixture(t);
  for (const key of ['invariant', 'mechanism', 'command', 'scope_evidence', 'regression_evidence', 'clean_control_evidence', 'new_instance_evidence']) {
    const saved = f.incident.prevention[key]; delete f.incident.prevention[key];
    assert.equal(f.check().code, 1, key); f.incident.prevention[key] = saved;
  }
});
test('missing evidence cannot be labelled verified', t => {
  const f = fixture(t); f.incident.prevention.adoption.evidence = 'evidence/missing.md';
  assert.equal(f.check().code, 1);
});
test('evidence rejects traversal, absolute, secret and directory paths', t => {
  const f = fixture(t);
  for (const p of ['../proof.md', '/tmp/proof.md', '.env', '.env.local', '.ssh/config', 'evidence/../proof.md', 'evidence\\proof.md', 'evidence', './evidence/proof.md']) {
    f.incident.prevention.scope_evidence = p;
    assert.equal(f.check().code, 1, p);
  }
});
test('evidence rejects file and parent-directory symlinks even to safe files', t => {
  const f = fixture(t);
  symlinkSync(join(f.root, 'evidence/proof.md'), join(f.root, 'linked.md'));
  symlinkSync(join(f.root, 'evidence'), join(f.root, 'linked-dir'));
  for (const p of ['linked.md', 'linked-dir/proof.md']) {
    f.incident.prevention.scope_evidence = p; assert.equal(f.check().code, 1);
  }
});
test('evidence contents need not be readable; existence is not semantic verification', t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'evidence/proof.md'), '{invalid JSON; not proof}');
  assert.equal(f.check().code, 0);
  assert.match(f.check().messages.join('\n'), /contents.*NOT verified/);
});
test('third and later finding rounds warn but do not cap audits or block clean close', t => {
  const f = fixture(t);
  f.change.rounds = Array.from({ length: 4 }, (_, n) => ({ id: `round-${n}`, kind: n ? 'follow-up' : 'initial', material_found: 1 }));
  const result = f.check({ stage: 'close' });
  assert.equal(result.code, 0);
  assert.match(result.messages.join('\n'), /DIAGNOSTIC.*1 initial, 3 follow-up/);
  assert.match(result.messages.join('\n'), /not an audit cap/);
});
test('current Material blocks close regardless of prevention or review count', t => {
  const f = fixture(t); f.change.material_remaining = 1;
  assert.equal(f.check().code, 0);
  assert.match(f.check({ stage: 'close' }).errors.join('\n'), /Material finding/);
});
test('exact class filter excludes unrelated open changes without hiding schema errors', t => {
  const f = fixture(t);
  f.ledger.learning.changes.push({ id: 'unrelated-change', material_remaining: 2 });
  f.ledger.learning.incidents.push({ id: 'other-incident', class: 'wrong-total', kind: 'newly-discovered', change_id: 'unrelated-change', source: 'evidence/proof.md', check: 'Does total reconcile?', status: 'open' });
  assert.equal(f.check({ stage: 'close', className: 'stale-write' }).code, 0);
  assert.equal(f.check({ stage: 'close' }).code, 1);
  assert.equal(f.check({ className: 'stale' }).code, 2);
  f.ledger.learning.incidents[1].status = 'unknown';
  assert.equal(f.check({ className: 'stale-write' }).code, 1);
});
test('changes without incidents still block current Material at close', t => {
  const f = fixture(t); f.ledger.learning.incidents = []; f.change.material_remaining = 1;
  assert.equal(f.check({ stage: 'close' }).code, 1);
});
test('bad references, counts, categories and duplicated changes fail', t => {
  const f = fixture(t);
  f.incident.change_id = 'missing'; assert.equal(f.check().code, 1); f.incident.change_id = 'save-repair';
  f.change.material_remaining = -1; assert.equal(f.check().code, 1); f.change.material_remaining = 0;
  f.incident.kind = 'other'; assert.equal(f.check().code, 1); f.incident.kind = 'repeat';
  f.ledger.learning.changes.push(structuredClone(f.change)); assert.equal(f.check().code, 1);
});
test('CLI help, missing data, malformed JSON and bad arguments have clear exit codes', t => {
  const f = fixture(t);
  assert.equal(f.run(['--help']).status, 0);
  assert.equal(f.run(['missing.json']).status, 2);
  assert.equal(f.run(['audit-ledger.json', '--stage', 'no']).status, 1);
  assert.equal(f.run(['audit-ledger.json', '--class']).status, 1);
  assert.equal(f.run(['audit-ledger.json', '--stage', 'plan', '--stage', 'close']).status, 1);
  writeFileSync(join(f.root, 'bad.json'), '{bad');
  assert.equal(f.run(['bad.json']).status, 1);
});
test('CLI never executes recorded commands and refuses sensitive ledger paths', t => {
  const f = fixture(t); f.incident.prevention.command = 'touch marker';
  assert.equal(f.run(['audit-ledger.json', '--stage', 'close']).status, 0);
  assert.equal(existsSync(join(f.root, 'marker')), false);
  assert.equal(f.run(['.env']).status, 1);
});
test('CLI refuses symlink ledger without reading its target', t => {
  const f = fixture(t); symlinkSync(join(f.root, 'audit-ledger.json'), join(f.root, 'alias.json'));
  assert.equal(f.run(['alias.json']).status, 1);
});
test('uncertain historical provenance is explicit; source evidence remains required', t => {
  const f = fixture(t); f.incident.kind = 'unknown';
  assert.equal(f.check().code, 0);
  assert.match(f.check().messages.join('\n'), /\[unknown, closed\]/);
  delete f.incident.source;
  assert.equal(f.check().code, 1);
});

const ledgerCli = fileURLToPath(new URL('./audit-ledger-check.mjs', import.meta.url));
function integratedFixture(t) {
  const f = fixture(t);
  const base = JSON.parse(readFileSync(new URL('../templates/audit-ledger.json', import.meta.url), 'utf8'));
  base.entries = [{ audit: 'Synthetic order-save review', ran: '2026-11-13', tier: 1,
    class_of_work: 'outputs', material_found: 1, material_remaining: 0,
    minor: 0, cosmetic: 0, auditor_context: 'fresh subagent', rounds: 2 }];
  base.learning = f.ledger.learning;
  const path = join(f.root, 'audit-ledger.json');
  return { ...f, base, path, integrated: (args = []) => {
    const before = JSON.stringify(base, null, 2);
    writeFileSync(path, before);
    const result = spawnSync(process.execPath, [ledgerCli, path, ...args], { cwd: f.root, encoding: 'utf8' });
    assert.equal(readFileSync(path, 'utf8'), before, 'integrated checker must not rewrite any ledger entries or evidence');
    return result;
  } };
}
test('integration: legacy template remains readable without learning data', t => {
  const f = integratedFixture(t); delete f.base.learning; f.base.entries = [];
  const result = f.integrated();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /does not show that any audit ran/);
});
test('integration: valid learning and audit entries pass ordinary and close-stage checks', t => {
  const f = integratedFixture(t);
  for (const args of [[], ['--since', '2026-11-13']]) {
    const result = f.integrated(args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /check command \(not executed\)/);
    assert.match(result.stdout, /audit-ledger-check: OK/);
  }
});
test('integration: ordinary check reports unresolved recurrence; dated gate refuses it', t => {
  const f = integratedFixture(t); f.incident.status = 'open'; delete f.incident.prevention;
  const plan = f.integrated();
  assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  assert.match(plan.stdout, /OPEN:.*recurring prevention remains unresolved/);
  const close = f.integrated(['--since', '2026-11-13']);
  assert.equal(close.status, 1);
  assert.match(close.stderr, /learning evidence did not pass/);
});
test('integration: malformed and empty learning blocks propagate distinct failure codes', t => {
  const f = integratedFixture(t);
  f.base.learning = { version: 1, incidents: [], changes: [], misspelled: true };
  assert.equal(f.integrated().status, 1);
  f.base.learning = { version: 1, incidents: [], changes: [] };
  assert.equal(f.integrated().status, 2);
  assert.equal(f.integrated(['--since', '2026-11-13']).status, 2);
});
test('integration: current Material refuses dated closure even with completed prevention receipts', t => {
  const f = integratedFixture(t); f.change.material_remaining = 1;
  const result = f.integrated(['--since', '2026-11-13']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Material finding\(s\) remain open/);
});
