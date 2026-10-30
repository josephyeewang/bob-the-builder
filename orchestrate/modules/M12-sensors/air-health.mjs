// air-health.mjs — the Air's health result as a dated file a machine writes (lead call L23; 0b-8 audit round 3 M-4,
// round 4 M-1). Joe never types a count: /configaudit on the Air runs this with its red count, and the file reaches the
// Mini's air-health folder (a synced folder the Front Door can't write; never the Front Door's outbox). Intake checks
// it with checkAirHealthFile and the Ledger stores airFactFromFile(doc) under AIR_FACT ('air-health').
//
//   request-airhealth-<yyyymmdd>-<hhmm>-air.json   { "request": "airhealth", "red_count": <0-999>, "checked_at": "<ISO, Z>" }
//
// The date is the check's own (checked_at, which the name repeats in UTC), so a file taken in late is never fresher
// than the check behind it.
//
//   node air-health.mjs <red count> <folder>     writes the file, prints its name
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AIR_FILE = /^request-airhealth-(\d{8})-(\d{4})-air\.json$/;
const FUTURE_SLACK_MS = 5 * 60e3;
const refuse = (reason) => ({ ok: false, reason });
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');

export function airHealthFile({ red_count: n, at = new Date() }) {
  if (!(Number.isInteger(n) && n >= 0 && n <= 999)) return refuse('red_count must be a whole number 0 to 999');
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) return refuse('bad time');
  const checked_at = at.toISOString();
  return { ok: true, name: `request-airhealth-${stamp(at)}-air.json`, text: `${JSON.stringify({ request: 'airhealth', red_count: n, checked_at })}\n` };
}

export function checkAirHealthFile(name, text, now = () => new Date()) {
  const m = AIR_FILE.exec(String(name));
  if (!m) return refuse('not an air-health file name');
  if (String(text).length > 256) return refuse('too long');
  let doc; try { doc = JSON.parse(text); } catch { return refuse('not JSON'); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return refuse('not an object');
  const keys = Object.keys(doc).sort().join(',');
  if (keys !== 'checked_at,red_count,request' || doc.request !== 'airhealth') return refuse('fields must be request, red_count, checked_at');
  if (!(Number.isInteger(doc.red_count) && doc.red_count >= 0 && doc.red_count <= 999)) return refuse('red_count must be a whole number 0 to 999');
  const t = Date.parse(doc.checked_at);
  if (typeof doc.checked_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(doc.checked_at) || !Number.isFinite(t)) return refuse('checked_at is not a UTC time');
  if (t > now().getTime() + FUTURE_SLACK_MS) return refuse('checked_at is in the future');
  if (stamp(new Date(t)) !== `${m[1]}-${m[2]}`) return refuse('file name and checked_at differ');
  return { ok: true, doc: { red_count: doc.red_count, checked_at: new Date(t).toISOString() } };
}

// The fact the trip brief reads, dated by the check itself (never by when it was taken in). stored: the fact already
// in the record; a file whose check is not newer than it returns null, so an older result synced late never replaces
// a newer one (0b-8 audit round 5 M-3).
export function airFactFromFile(doc, now = () => new Date(), stored = null) {
  const t = Date.parse(doc?.checked_at);
  if (!Number.isInteger(doc?.red_count) || doc.red_count < 0 || !Number.isFinite(t) || t > now().getTime() + FUTURE_SLACK_MS) return null;
  if (Date.parse(stored?.checked_at) >= t) return null;
  return { kind: 'fact.air-health', red_count: doc.red_count, checked_at: new Date(t).toISOString() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [count, folder] = process.argv.slice(2);
  const f = airHealthFile({ red_count: /^\d+$/.test(count ?? '') ? Number(count) : NaN });
  if (!f.ok || !folder) { console.error(`air-health: ${f.ok ? 'no folder given' : f.reason}`); process.exitCode = 1; }
  else { writeFileSync(join(folder, f.name), f.text); console.log(f.name); }
}
