// The gate every captured screen passes before it may be saved as a fixture (R-0b-150). Bob is public, so a screen
// that shows the Mac user's home folder, the user name, an email address or anything key-shaped is refused, never
// saved. Pure: the caller hands in the text and what to look for.

import { findCredentials, makeMasker } from '../../mask.mjs';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replace the throwaway repo's path with <repo> and the home folder with ~, then mask key-shaped text.
 * Returns { text, masked }; masked lists what the masker changed (a capture with any is refused by fixtureProblems
 * anyway, so the masker is a second net, not the gate).
 */
export function scrubScreen(text, { repo, home, host } = {}) {
  let out = String(text ?? '');
  // macOS shows a temp folder with or without /private in front; the longer form goes first.
  const swaps = typeof repo === 'string' && repo.length > 1 ? [[`/private${repo}`, '<repo>'], [repo, '<repo>']] : [];
  if (typeof home === 'string' && home.length > 1) swaps.push([home, '~']);
  // The Mac's network name shows in the pane title; its short form (before the first dot) too.
  if (typeof host === 'string' && host.length > 1) swaps.push([host, '<host>'], [host.split('.')[0], '<host>']);
  for (const [value, stand] of swaps) out = out.split(value).join(stand);
  // Colour codes are long runs of digits and semicolons that the high-entropy rule reads as a key, so coloured
  // text is masked-checked with them stripped; any hit refuses the whole capture (the raw text is never half-masked).
  if (ANSI.test(out)) {
    const { hits } = makeMasker({ env: {} }).maskSecrets(stripAnsi(out));
    return { text: out, masked: hits };
  }
  const { text: masked, hits } = makeMasker({ env: {} }).maskSecrets(out);
  return { text: masked, masked: hits };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/;
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s) => String(s ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

/**
 * Every reason this screen may not be published; [] when it may. Never echoes the text it found.
 * values: other private words to refuse anywhere (the Mac's network name, each part of the owner's full name).
 */
export function fixtureProblems(text, { home, user, values = [] } = {}) {
  // Raw and colour-stripped both: a name split by colour codes is whole again once they're stripped.
  const raw = String(text ?? '');
  const s = `${raw}\n${stripAnsi(raw)}`;
  const out = [];
  if (typeof home === 'string' && home.length > 1 && s.includes(home)) out.push('the home folder');
  if (/\/Users\/[^/\s]+/.test(s)) out.push('a /Users/ path');
  if (typeof user === 'string' && user && new RegExp(`(?:^|[^A-Za-z0-9])${escape(user)}(?:$|[^A-Za-z0-9])`, 'i').test(s)) out.push('the Mac user name');
  if (EMAIL.test(s)) out.push('an email address');
  for (const v of values) if (typeof v === 'string' && v.length >= 3 && s.toLowerCase().includes(v.toLowerCase())) out.push('a named private value');
  const keys = findCredentials(stripAnsi(raw));
  if (keys.length) out.push(`key-shaped text (${[...new Set(keys.map((k) => k.kind))].join(', ')})`);
  if (/\[REDACTED/.test(s)) out.push('a masked value');
  return out;
}
