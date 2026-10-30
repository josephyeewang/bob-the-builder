// timezone.mjs — accept a time zone only as a real IANA name the system knows (review-0b-8 minor 10).
// "EST", "Pacific" or "GMT+2" are ambiguous: the skill asks once more, and until Joe answers, tz stays null
// (number work holds; [Undo] still runs).

export function checkTimeZone(name) {
  const s = String(name ?? '').trim();
  if (!s) return { ok: false, reason: 'empty' };
  if (s !== 'UTC' && !/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(s)) return { ok: false, reason: 'ambiguous: give a city-based name such as Europe/Prague' };
  if (/^Etc\//.test(s)) return { ok: false, reason: 'ambiguous: give a city-based name such as Europe/Prague' };
  try {
    const tz = new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone;
    return { ok: true, tz };
  } catch {
    return { ok: false, reason: 'unknown time zone' };
  }
}
