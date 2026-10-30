# Front Door: owner test script (R-0b-81 to R-0b-84)

Joe runs these with Claude watching on the Mini. Each step says where to do it, what to type, and what you should see.
Claude records each result as the second ledger line for its row (README). Use the test product, never a live one.

**Stop conditions. If either happens, stop, and Claude logs a design finding for Joe. No workarounds.**
- The phone can reach the Front Door only through server mode (`claude remote-control` run as a server). The design
  forbids depending on it. A connected session started by the Mini must work, either with Remote Control on at start
  in its settings or with `/remote-control` typed in by the Dispatcher after start.
- Question boxes from the Front Door don't appear on the phone.

## 1. Reach it from the phone (R-0b-81)

- **Where:** the Claude app on your phone → Code → the session named for the Front Door.
- **Type:** `hello, what can you do?`
- **You should see:** a short reply listing new idea, pause, away, wrap up, rotate.
- Claude records which way Remote Control was on: in the role's settings at start, or typed in after start.

## 2. Read-back from the phone (R-0b-81)

- **Where:** the same phone session.
- **Type:** `Read back your set-up as one JSON object with tools, skills, mcp_servers, plugins, connectors and setting_sources.`
- **You should see:** a JSON block. Claude checks it with `readback.mjs` against the role profile. Expect the role's
  tools only (EndConversation is allowed), `orchestrate` the only skill, no tool servers, plugins or connectors, and
  settings from machine-wide + `--settings` only.

## 3. A question box, and a write outside the outbox (R-0b-81)

- **Type:** `I'm away until Friday`
- **You should see:** a question box asking your time zone. Tap an answer. (Stop condition above if it doesn't appear.)
- **Then type:** `write a note called test.md in the main folder`
- **You should see:** a refusal and no "allow?" card.

## 4. The trigger phrase (R-0b-81)

- **Type:** `new: try a darker header on the test product`
- **You should see:** "Filed as idea <id>, unsorted; the Lead will place it." Claude checks the `idea-` file in the outbox.

## 5. Reach it after a Mini restart (R-0b-81)

- **Where:** the Mini → Apple menu → Restart. If it asks, unlock it at the Mini.
- Then repeat step 1 from the phone. It must answer under the same name.

## 6. Restart after a quiet spell (R-0b-82; needs lane 2's stop/start)

- Claude grows the Front Door past 150k with a test conversation. Then don't touch it for 15 minutes.
- **You should see:** on the phone, the session is still there under the same name and remembers your last messages.
- Then Claude repeats with a question box left open: it must **not** restart.

## 7. Trip dry run (R-0b-83)

- **Type:** `I'm away until Friday` and answer the time zone with a city, such as `Europe/Prague`.
- **You should see:** one reply: the test product set to away, what waits on your go and the open risky asks (each
  with a link), the Mini check (online, logged in, battery backup), and the Air line.
- If the Air line says "not known", on the Air: open Claude Code, type `/configaudit`, press Return, and reply to the
  Front Door with how many red items it shows.
- Claude checks the test product's record really says away. Then **tap** it back to active. Typing "I'm back" files a
  request only; that is expected.

## 8. Three question boxes (R-0b-84)

- In the Front Door, then in the thinking session (started for this test by the launcher), Claude asks three question
  boxes. Tap each one from the phone.
- Claude runs `checkTapTest` on each session's log: three answers, each matched to its question's call ID, with the
  time. A line the Dispatcher types can't count as an answer.
- **For each box, the phone shows a notification.** Say so to Claude for each one.

## 8a. The thinking session passes the same phone test (R-0b-84)

- Repeat steps 1, 2 and 5 against the thinking session instead of the Front Door: reach it from the phone, ask it for
  its read-back (Claude checks it with `readback.mjs` against the **thinking** role profile), and reach it again
  after a Mini restart.

## 8b. Typed keys can't answer a question box (R-0b-84, MAT-11; needs lane 2's Dispatcher)

- With a question box open in the Front Door and not tapped, Claude has the Dispatcher send one line to it.
- **You should see:** the box still open on the phone. Claude checks the log: no answer for that box's call ID, or an
  answer `checkTapTest` reports as "typed automated text, not a tap". Then tap the box from the phone; it now passes.
- Lane 2's Dispatcher must not type into a session while `openQuestions(log)` lists a box (join item).
