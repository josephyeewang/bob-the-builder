// sensors-wiring.mjs — the wiring module the Sensors job's config names (R-0b-169, LEAD-CALLS L1049): the one place the
// Sensors loop's ports (M12 loop.mjs) are joined to the real things. loop.mjs imports it and calls `wire(config)`.
//
// WHAT IS REAL:
//   - the Record: M9's Store Writer at config.recordRoot, owned by config.ownerUid, opened with the rules the one way the
//     Dispatcher and the robot open it (dispatcher-wiring.mjs recordAndRules): the same products file, rules folder and
//     read-only token, so the three jobs read one Record under one set of rules;
//   - who is signed in and that account's usage: the owner's answer file (sensors-ports.mjs, L609/L614/L727), which only
//     the owner's user may have written (answerUid); the marks a forged low reading is held to are the Record's (storedUsage);
//   - the network: a plain TCP connection to each of NETWORK_HOSTS (probes/network.mjs), up if any answers;
//   - each pull request's reading: the product's repository (products.json's owner and repo) through the read-only client.
//     No App client is named (checksGh), so the check runs at a PR's head read as not known, which the loop says each pass.
// WHAT IS NOT WIRED: the Front Door and Mini Base probes. Neither exists yet (M11 phone-ports.mjs NOT_WIRED_PHONE), so
// there is nothing to ask: the loop writes both readings as unknown, with their time, every pass. Only M11 phone-link.mjs
// reads them, and an unknown reading makes it do nothing. A stand-in "yes" would be a made-up value.
//
// The config (one JSON file, loop.mjs's argument; setup writes it, sensors-setup.mjs). Every path is absolute; nothing
// here names a machine, a product or a person.
//   installRoot, wiring   loop.mjs's own: the config, the wiring and loop.mjs must be files of the installed copy (L253)
//   product, recordRoot, ownerUid, productsFile, rulesStateDir, tokenFile
//                         the Dispatcher's own values (dispatcher-wiring.mjs), so the Sensors write the Record it reads
//   answerFile            the owner's answer, <base>/owner-answer/owner-answer.json (setup layout.mjs ownerAnswerPath)
//   answerUid             the owner's Mac user id: the answer file and its folder must be that user's. It may be neither
//                         this job's own user (which could then write its own answer) nor root

import { isAbsolute } from 'node:path';
import { PRODUCT } from '../shared/product-paths.mjs';
import { PRODUCT_NAME_PROBLEM, recordAndRules } from './dispatcher-wiring.mjs';
import { sensorsPorts, storedUsage } from './sensors-ports.mjs';
import { networkProbe } from '../modules/M12-sensors/probes/network.mjs';

export const CONFIG_KEYS = Object.freeze(['installRoot', 'wiring', 'product', 'recordRoot', 'ownerUid', 'productsFile', 'rulesStateDir', 'tokenFile', 'answerFile', 'answerUid']);
const PATHS = Object.freeze(['installRoot', 'wiring', 'recordRoot', 'productsFile', 'rulesStateDir', 'tokenFile', 'answerFile']);
// Services the Mini needs anyway (GitHub and Claude's own). Any one answering is "up"; see probes/network.mjs for "down".
export const NETWORK_HOSTS = Object.freeze(['api.github.com', 'api.anthropic.com']);

/** The config, checked before anything is opened. An unknown key stops the start (a misspelt key would fall back to a default). */
export function checkConfig(c, { selfUid = process.getuid() } = {}) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('config: must be an object');
  const extra = Object.keys(c).filter((k) => !CONFIG_KEYS.includes(k));
  if (extra.length) throw new Error(`config: unknown key ${extra.join(', ')}`);
  if (typeof c.product !== 'string' || !PRODUCT.test(c.product)) throw new Error(PRODUCT_NAME_PROBLEM);
  for (const k of PATHS) if (typeof c[k] !== 'string' || !isAbsolute(c[k])) throw new Error(`config: ${k} must be an absolute path`);
  for (const k of ['ownerUid', 'answerUid']) if (!Number.isSafeInteger(c[k]) || c[k] < 0) throw new Error(`config: ${k} must be a Mac user id`);
  // The answer is a claim the owner's user makes (sensors-ports.mjs, L614). From this job's own user it would be the job
  // vouching for itself, and root never writes it.
  if (c.answerUid === selfUid) throw new Error('config: answerUid must be the owner\'s user, not this job\'s own');
  if (c.answerUid === 0) throw new Error('config: answerUid must be the owner\'s user, not root');
  return c;
}

/**
 * → { rec, ports: { whoIsSignedIn, readUsage, probes: { network }, github: { gh, owner, repo } } }, loop.mjs's shape.
 * `fetchFn` and `now` (→ ms) are for tests; `answer` replaces sensorsPorts (tests only).
 */
export async function wire(config, { fetchFn = globalThis.fetch, now = () => Date.now(), log = (s) => process.stderr.write(`${s}\n`), selfUid = process.getuid(), answer = sensorsPorts, hosts = NETWORK_HOSTS } = {}) {
  const c = checkConfig(config, { selfUid });
  const { rec, gh, entry } = await recordAndRules(c, { who: 'sensors', log, fetchFn, now });
  const owner = answer({ file: c.answerFile, ownerUid: c.answerUid, now: () => new Date(now()), stored: storedUsage(rec) });
  return {
    rec,
    ports: {
      whoIsSignedIn: owner.whoIsSignedIn,
      readUsage: owner.readUsage,
      probes: { network: networkProbe({ hosts: [...hosts] }) },
      github: { gh, owner: entry.owner, repo: entry.repo },
    },
  };
}
