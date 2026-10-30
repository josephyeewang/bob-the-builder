// power-source.mjs — one fact: is the Mini on battery backup (a UPS it can see)? (review-0b-8 MAT-9; line deviation:
// this sensor was not in the 0b-7 line count, logged in the M1 README.)
//
// Reads the output of macOS `pmset -g batt` through an injected runner, so the tests never touch the machine. Format
// as checked on 29 Oct 2026 (Principle 9: a format note, re-check on a macOS upgrade):
//   Now drawing from 'AC Power'                       first line: the power source now in use
//    -<UPS model> (id=1234)\t100%; AC attached; ...   one line per battery; a UPS shows as a non-internal battery
//    -InternalBattery-0 (id=...)\t...                 a laptop's own battery (not battery backup)
// A Mac mini with no UPS prints only the first line. The UPS model name is not recorded.

export const POWER_FACT = 'power-source';

export function parsePmset(text) {
  const s = String(text ?? '');
  const src = /Now drawing from '([^']+)'/.exec(s)?.[1] ?? null;
  if (!src) return null;
  const batteries = s.split('\n').filter((l) => /^\s*-/.test(l));
  const ups = batteries.filter((l) => !/InternalBattery/i.test(l));
  return {
    source: src,
    ups_present: ups.length > 0,
    on_ups_power: /UPS/i.test(src),
    internal_battery: batteries.length > ups.length,
  };
}

// run: async () => stdout of `pmset -g batt`. A failed or unreadable run writes ups_present null ("unknown"), never false
// and never green.
export async function readPowerSource({ run, writer, now = () => new Date() }) {
  let parsed = null;
  try { parsed = parsePmset(await run()); } catch { parsed = null; }
  const doc = parsed
    ? { kind: 'fact.power-source', at: now().toISOString(), ...parsed }
    : { kind: 'fact.power-source', at: now().toISOString(), source: null, ups_present: null, on_ups_power: null, internal_battery: null };
  writer.put(POWER_FACT, doc);
  return doc;
}
