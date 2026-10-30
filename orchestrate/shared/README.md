# orchestrate/shared/

Small helpers more than one module uses (the record file format, masking, safe file writes). Owned by lane 1; other lanes ask the lead before adding here, so two lanes never edit the same file.

## The two interfaces other lanes code against

Import these, never the module folders behind them. Each has a fake for your own tests, so you don't wait on lane 1.

### `rules.mjs`: ask M10 Rules "may X happen?"

```js
import { makeRules, fakeRules, ACTIONS, RISKY_CLASSES } from '../../shared/rules.mjs';
const d = rules.may('push_branch', { product, card, files });  // { decision: 'allow'|'ask'|'deny', tier?, reason, rev }
rules.get('caps.editing_per_mac', { product });               // a value from the rules (Mac-wide ones: strictest across products)
rules.classify({ product, files, diff });                     // { tier: 1|2, risky: [...RISKY_CLASSES], reasons }
rules.rev;                                                    // the rules version, stamped on diary lines
```

- **It never throws and fails closed.** An unknown action, an error, or no readable rules is `deny`. A classification that fails is `unclassifiable`, Tier 1.
- `ask` means allowed only with Joe's answer: `tier: 1` is his GitHub Approve, `tier: 2` a tap.
- Actions (`ACTIONS`): `start_session`, `write_production`, `push_branch`, `merge`, `count_approval`, `delete_copy`, `flip_switch`. A new one is added here first, by lane 1.
- Tests: `fakeRules({ answers: { merge: allow('ok') }, values: { 'caps.rounds': 3 } })`. Unlisted actions are denied, as with the real rules.

### `record.mjs`: read and write M9 Record

```js
import { makeRecord, memoryRecord, STATES, ENTITIES, WAIT_FIELDS } from '../../shared/record.mjs';
rec.read('card', 'C-12');                       // { id, doc, rev } or null
rec.list('card');
rec.write({ actor: 'dispatcher', entity: 'card', id: 'C-12', expectRev: 3, doc, kind: 'claim' });  // { ok, rev, seq } | { ok: false, reason }
rec.applyOutbox({ role: 'worker', sessionId: 'S-4', card: 'C-12' }, outboxFilePath);
rec.diary({ since: 0 });
```

- **Only plain scripts call `write`**, under their own actor name (`SCRIPT_ACTORS`). AI sessions never do: the Dispatcher hands their outbox files to `applyOutbox`, tagged with the session's role.
- **Every write is "only if unchanged since read"**: pass the `rev` you read (`0` to create). A mismatch is refused. Each accepted write leaves one diary line; a refused one leaves none.
- `write` and `applyOutbox` never throw; any failure is `{ ok: false, reason }`.
- The names (`SCRIPT_ACTORS`, `AI_ROLES`, `ENTITIES`, `STATES`, `WAIT_FIELDS`) are defined once, here.
- Tests: `memoryRecord()` keeps the rev check and the diary only. The real Store Writer (M9) adds the legal state moves and who may change what, so code that passes on the fake can still be refused by the real one.
