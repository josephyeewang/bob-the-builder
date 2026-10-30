// timezone.mjs — accept a time zone only as a real IANA name the system knows (review-0b-8 minor 10).
// "EST", "Pacific" or "GMT+2" are ambiguous: the skill asks once more, and until Joe answers, tz stays null
// (on the Merge Gate, number work holds; [Undo] still runs).

export function checkTimeZone(name) {
  const s = String(name ?? '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (s !== 'UTC' && !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(s)) return { ok: false, reason: 'ambiguous: give a city-based name such as Europe/Prague' };
  // Fixed-offset zones are refused in any spelling: the system accepts "etc/gmt+2" and returns "Etc/GMT+2", which means
  // UTC-2 (0b-8 audit round 1, M-2). The check runs on the name typed AND on the system's own name for it.
  const fixed = (n) => /^(etc|systemv)\//i.test(n) || /^(gmt|utc|ut|uct|zulu|universal|greenwich)$/i.test(n) && n !== 'UTC';
  if (fixed(s)) return { ok: false, reason: 'ambiguous: give a city-based name such as Europe/Prague' };
  try {
    const tz = new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone;
    if (fixed(tz) || (tz !== 'UTC' && !tz.includes('/'))) return { ok: false, reason: 'ambiguous: give a city-based name such as Europe/Prague' };
    return { ok: true, tz };
  } catch {
    return { ok: false, reason: 'unknown time zone' };
  }
}
