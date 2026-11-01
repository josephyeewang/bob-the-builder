// The R-0b-05 "done when" proofs, run as the owner's own Mac user (L90 m8): the folders the robots depend on cannot be
// written, and the robot keys cannot be read, by the person's own user (whose AI sessions are the workers). Read only:
// each proof runs `sudo -u <owner> <program>` from root and changes nothing.
//
// A proof that "it fails" proves nothing if the way of asking is broken, so two controls come first and must pass: the
// owner's user can be run as at all, and it CAN write its own worker-copies folder. Only then do the "cannot" proofs count.

import { join } from 'node:path';
import { REVIEW_ROLES } from '../shared/review-roles.mjs';

const SUDO = '/usr/bin/sudo';
const TEST = '/bin/test';
const LS = '/bin/ls';
const TRUE = '/usr/bin/true';

// The folders the owner's user must not write: the record, and the code and rules the robots run from.
const NO_WRITE = ['hooks', 'settings', 'launcher', 'lead-main', 'claude-code', 'bob', 'global-rules', 'frontdoor', 'mirror', 'private', 'keys', 'review', 'review-copies', 'outboxes', ...REVIEW_ROLES.map((r) => `outboxes/${r}`)];

/** The proofs: [{ what, args, expect: 'ok' | 'fail', control? }]. `args` are what follows `sudo -n -u <owner>`. */
export function proofList(cfg) {
  const p = (...s) => join(cfg.base, ...s);
  return [
    { what: `can run a program as ${cfg.owner}`, args: [TRUE], expect: 'ok', control: true },
    { what: `${cfg.owner} CAN write ${p('worker-copies')} (the control: "cannot write" below means something)`, args: [TEST, '-w', p('worker-copies')], expect: 'ok', control: true },
    ...cfg.products.map((prod) => ({ what: `${cfg.owner} cannot write the record ${p('products', prod, 'store')}`, args: [TEST, '-w', p('products', prod, 'store')], expect: 'fail' })),
    ...NO_WRITE.map((d) => ({ what: `${cfg.owner} cannot write ${p(d)}`, args: [TEST, '-w', p(d)], expect: 'fail' })),
    { what: `${cfg.owner} cannot read the robot keys (${p('keys')})`, args: [LS, p('keys')], expect: 'fail' },
  ];
}

/** → [{ ok, what, why? }]. Reads only. A failed control makes every later proof FAIL as well, since it would prove nothing. */
export function runProofs(io, cfg) {
  const out = []; let controlsHold = true;
  for (const pr of proofList(cfg)) {
    const r = io.run(SUDO, ['-n', '-u', cfg.owner, ...pr.args]);
    const gotOk = r.status === 0;
    if (pr.control) {
      const ok = gotOk; if (!ok) controlsHold = false;
      out.push({ ok, what: pr.what, ...(ok ? {} : { why: `did not work (${r.stderr.trim().slice(0, 100) || `exit ${r.status}`})` }) });
    } else if (!controlsHold) out.push({ ok: false, what: pr.what, why: 'not proven: a control above failed' });
    else out.push({ ok: !gotOk, what: pr.what, ...(!gotOk ? {} : { why: `${cfg.owner} CAN do this, and must not` }) });
  }
  return out;
}

/** What `--dry-run` prints: the commands, not run. */
export const proofCommands = (cfg) => proofList(cfg).map((pr) => `sudo -n -u ${cfg.owner} ${pr.args.join(' ')}   (${pr.expect === 'ok' ? 'must work' : 'must fail'})`);
