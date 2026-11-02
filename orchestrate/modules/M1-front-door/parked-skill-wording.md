# Parked Front Door wording: pause, away, back, wrap up, rotate

**Not loaded by the Front Door.** This is the skill text these five requests used before lead call L151. Nothing acts
on a `state-` or `request-` file yet, so the record refuses both and the live skill
(`skill/orchestrate/SKILL.md`) says plainly that they aren't available and files nothing. The text below was
checked over several audit rounds (the trip brief quoting rule, the freeze wording, the Air count). The PR that wires
a kind's consumer moves its section back into the skill, turns the kind to `pending` in the record and changes
`intakePush` back to a confirmation in the same change. The tests in this folder keep the parked text from drifting
until then.

## Pause ("pause X")

Write `state-<id>.json`, one line:
`{"product":"X","state":"paused","until":null,"tz":null}`
Reply: "Filed: pause X. The Mini confirms in a minute." Only the owner's tap brings it back.

## Away, trip mode ("I'm away until Friday", "travelling next week")

1. For each product, write its own `state-<id>.json` (a new `<id>` for each):
   `{"product":"X","state":"away","until":"<date as YYYY-MM-DD, or null>","tz":"<time zone, or null>"}`
2. Time zone: ask once with a question box: "Which time zone will you be in? A city, such as Europe/Prague." Use the
   city-based name (Region/City, or UTC). If the answer is ambiguous (EST, "Pacific", GMT+2), ask once more. Until they
   answer, write `"tz":null`. Don't tell them what that holds; the trip brief says it per product. After they answer, write a new
   `state-<id>.json` for each product, the same as step 1 but with the time zone.
3. Reply: "Filed: away <the products>. The Mini confirms in a minute." The Mini sends the trip brief to their phone itself. You
   don't know the time, so you can't judge a brief's age yourself; the brief written after these files names them.
4. If the owner asks for the brief before it arrives ("brief"): read the trip brief file named in your context. Quote it
   only if its first line lists **every** `<id>` of the newest `state-` files you wrote for this trip, or its first
   line says "wiring fault" (that one never names your ids; quote it as it is). Otherwise say:
   "Mini check: unknown (the brief isn't ready yet). Ask again in a few minutes; if it can't be built, the brief says so." When you quote it, start with
   "Made at <the time on its first line>." then the brief as it is. Don't add to or soften it.
5. The brief's Air line comes from the Air's own check. Never ask the owner for a count and never write one; if the line
   says it hasn't passed, repeat its step.
6. Only if the owner says the Mini will be turned off, add this to your step 3 reply, word for word (the Mini can't send
   anything once it is off): "The Mini is turning off: products freeze (nothing starts, nothing merges); the digest issue and the GitHub view stay as they were at the last update; the outside check will open one "heartbeat stale" issue. MAIN is not affected."
   Otherwise don't mention it.
Never write `"state":"active"`. A date passing does not bring anything back; only the owner's tap does.

## Back ("I'm back", "resume X")

Write `request-resume-<id>.json`: `{"request":"resume","product":"X","name":null}` (product null if they mean all).
Reply: "Filed: resume X. The Mini confirms in a minute." Then: "Resume still needs your tap on the product."

## Wrap up ("wrap up", "done for today")

Write `request-wrapup-<id>.json`: `{"request":"wrapup","product":null,"name":null}`.
Reply: "Filed: wrap up. The Mini confirms in a minute." Then the status line from your context file. If it says no
Lead is running, say so.

## Rotate a key ("rotate X")

Write `request-rotate-<id>.json`: `{"request":"rotate","product":null,"name":"<NAME>"}`, where `<NAME>` is the key's **name** exactly as the owner
said it (capitals and digits with at least one `_`, such as `STRIPE_KEY`; add nothing to it). Never the value. Reply:
"Filed: rotate <NAME>. The Mini confirms in a minute." The steps come after that.

## Parked owner test: OWNER-TEST.md step 7, the trip dry run


- **Type:** `I'm away until Friday` and answer the time zone with a city, such as `Europe/Prague`.
- **You should see:** the reply "Filed: away <the test product>. The Mini confirms in a minute.", a "Confirmed: away …"
  notification, then within a few minutes a
  phone notification holding the brief (lead call L22): the test product set to away, what waits on your go and the
  open risky asks (each with a link), the Mini check (online, logged in, battery backup), and the Air line. Then say
  `brief`: the Front Door quotes the same brief. If the notification doesn't come, stop here: the cutover waits until
  the push is proven (L29).
- If the Air line hasn't passed, on the Air: open Claude Code, type `/configaudit` and press Return. It sends the result
  to the Mini itself; you never type a count. Say `I'm away until Friday` again: the new brief's Air line passes.
- Claude checks the test product's record really says away. Then **tap** it back to active. Typing "I'm back" files a
  request only; that is expected.
