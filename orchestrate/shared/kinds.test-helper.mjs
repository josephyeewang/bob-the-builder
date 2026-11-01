// Test helper: reading text for an outbox kind's name (L151). One copy, used by M9's outbox-kinds.test and the
// shared no-promise test.

import { OUTBOX_KINDS } from './record.mjs';

// Does the text name this kind itself, not only a longer kind that starts with it (state-compact- is not state-), nor
// one it ends (ask-request- is not request-)?
export function namesKind(text, k) {
  const kinds = Object.keys(OUTBOX_KINDS);
  for (let i = text.indexOf(k); i >= 0; i = text.indexOf(k, i + 1)) {
    if (i > 0 && /[a-z-]/.test(text[i - 1])) continue;
    const longer = kinds.filter((o) => o.length > k.length && o.startsWith(k) && text.startsWith(o, i));
    if (!longer.length) return true;
  }
  return false;
}
