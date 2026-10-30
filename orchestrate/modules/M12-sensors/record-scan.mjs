// record-scan.mjs — "a week's record finds 0 credential-like strings" (R-0b-125 done_when; review-0b-7 M6).
//
// WHY A SEPARATE DETECTOR. A scan that reused the masker's own patterns would miss exactly what the masker misses, so
// "0 found" would prove nothing (Green ≠ Correct). This file shares NO pattern with mask.mjs on purpose. It is looser:
// any run of 20+ word characters with at least 2 letters and 2 digits and entropy ≥ 3.0, after the identifier
// allowlist (hex SHAs and hashes, UUIDs, dpl_/prj_/team_ IDs, our own [REDACTED:…] markers, the fence tags). It will
// flag some harmless strings; every hit is listed with where it is, for a person to judge.
//
// A scan is valid only if (a) it finds the planted control INSIDE the record it scanned: the caller writes a fake key
// (built at runtime) into one document first, and a scan that never reaches it (wrong record, wrong entities, a walk
// that skips fields) reports itself failed; and (b) no entity holding documents was left out of the scan (0b-7 audit
// round 2, M-4: checking the control on a made-up string let an empty entity list pass as "0 found"). When gitleaks is installed (a check tool, not a dependency) the
// caller can also run it over the record folder through runGitleaks(); it is skipped, and says so, when absent.

import { execFileSync } from 'node:child_process';
import { ENTITIES } from '../../shared/record.mjs';

const RUN = /[A-Za-z0-9+/_=.-]{20,}/g;

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

function allowlisted(t) {
  return /^[0-9a-f]{7,64}$/i.test(t)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)
    || /^(?:dpl|prj|team)_[A-Za-z0-9]+$/.test(t)
    || /^\d{4}-\d\d-\d\dT[\d:.]+Z?$/.test(t);
}

// Candidate credential-like substrings of one string.
export function looseFind(text) {
  const out = [];
  const s = String(text ?? '').replace(/\[REDACTED(?::[a-z-]+)?\]/g, ' ');
  for (const m of s.matchAll(RUN)) {
    // Split paths and dotted names into parts, so "src/modules/file-2024-v3.mjs" isn't one long run.
    for (const part of m[0].split(/[/.]/)) {
      const t = part.replace(/^[=_-]+|[=_-]+$/g, '');
      if (t.length < 20 || allowlisted(t)) continue;
      const letters = (t.match(/[A-Za-z]/g) || []).length;
      const digits = (t.match(/[0-9]/g) || []).length;
      if (letters >= 2 && digits >= 2 && entropy(t) >= 3.0) out.push(t);
    }
  }
  return out;
}

// Scan every string in the record (docs of the named entities, keys included, and the diary). Hits that are the
// control itself are not counted. Returns { valid, control_found, unscanned, count, hits: [{ where, length }] } —
// never the matched text itself.
export function scanRecordLoose(rec, entities = ENTITIES, { control } = {}) {
  const ok = typeof control === 'string' && looseFind(control).includes(control);
  let control_found = false;
  const hits = [];
  const walk = (v, where, inDoc) => {
    if (typeof v === 'string') {
      for (const t of looseFind(v)) {
        if (ok && t === control) { if (inDoc) control_found = true; continue; }
        hits.push({ where, length: t.length });
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${where}[${i}]`, inDoc)); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k, `${where}.<key>`, inDoc); walk(x, `${where}.${k}`, inDoc); }
  };
  const list = Array.isArray(entities) ? entities : [];
  for (const e of list) for (const d of rec.list(e)) walk(d.doc, `${e}/${d.id}`, true);
  for (const l of rec.diary({ since: 0 })) walk(l, `diary#${l.seq}`, false);
  const unscanned = ENTITIES.filter((e) => !list.includes(e) && rec.list(e).length > 0);
  return { valid: control_found && unscanned.length === 0, control_found, unscanned, count: hits.length, hits };
}

// gitleaks over a folder, if installed. { ran:false, why } when it isn't; { ran:true, leaks:n } when it is.
export function runGitleaks(dir, runner = (args) => execFileSync('gitleaks', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })) {
  let out;
  try {
    out = runner(['detect', '--no-git', '--source', dir, '--report-format', 'json', '--report-path', '/dev/stdout', '--exit-code', '0', '--no-banner']);
  } catch (e) {
    return { ran: false, why: e && e.code === 'ENOENT' ? 'gitleaks not installed' : 'gitleaks failed to run' };
  }
  try {
    const at = out.indexOf('[');
    const json = at < 0 ? [] : JSON.parse(out.slice(at, out.lastIndexOf(']') + 1));
    return { ran: true, leaks: json.length };
  } catch {
    return { ran: false, why: 'gitleaks output unreadable' };
  }
}
