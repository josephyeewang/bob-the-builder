#!/usr/bin/env python3
"""spec-audit.py — Structure audit for a product spec (Bob Rule 28, v2.36).

The DOCUMENT twin of Rule 25 (data silent-failures) and Rule 26 (engineering
silent-failures). A spec can pass every mechanical check — headings resolve,
cross-refs valid, counts match, nothing dangling — and still be incoherent.
Those checks are SYNTACTIC. This one is SEMANTIC.

It catches what a human otherwise has to catch by reading:

  1  BUCKET OVERLAP        two groups saying the same thing in different words
  2  MISFILED MEMBERSHIP   an item under a group it doesn't belong to
  3  UNDELIVERED PROMISE   a group whose NAME claims what its CONTENTS lack
  4  ONE-WAY COVERAGE      capabilities described in prose, never in the inventory
  5  STRUCTURAL DUPLICATION  two SECTIONS doing the same job
  6  PHRASE DUPLICATION    the same clause in two places
  7  SOURCE FIDELITY       a concept from the origin notes silently dropped

Usage:
  scripts/spec-audit.py SPEC [SPEC ...] [--source ORIGIN] [--inventory "Features"]

  SPEC        one or more .md (or .html) spec files
  --source    the earlier notes/intake doc the spec derives from (fidelity diff)
  --inventory heading text of the capability inventory, for one-way coverage

Exit: 0 = no hard failures; 1 = at least one. Review prompts never fail the run.

Two disciplines this script exists to serve, and cannot enforce for you:
  * REGRESSION-TEST every check against the defect it was written for. This
    script's own duplication check first reported clean against the very document
    containing the duplicate — it counted table rows and the duplicate used lists.
  * CALIBRATE before trusting. A check that cries wolf gets ignored exactly like
    an over-eager linter. Tune to a handful of reviewable hits, not forty.
"""
import argparse, itertools, re, sys, os

STOP = set("""a an the and or of to in for on with by is are be it its this that you
your they their we our from as at not no than so what which who whom whose can cant
cannot into over under out up down one two three each every all any some more most
other others same different way ways thing things work works project projects team
teams it's don't doesn't isn't will would should could may might must have has had
do does did been being about after before between through during""".split())

def strip(s):
    import html as _html
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", s, flags=re.S)
    return _html.unescape(re.sub(r"<[^>]+>", " ", s))

def words(s):
    return {w for w in re.findall(r"[a-z][a-z'-]{2,}", strip(s).lower()) if w not in STOP}

def jac(a, b):
    return len(a & b) / len(a | b) if (a | b) else 0.0

def sections(text):
    """[(level, title, body)] from markdown ## / ### or HTML <h2>/<h3>."""
    out = []
    if "<h" in text.lower():
        parts = re.split(r'(<h([23])[^>]*>.*?</h\2>)', text, flags=re.S)
        i = 1
        while i < len(parts) - 1:
            out.append((int(parts[i + 1]), strip(parts[i]).strip(), parts[i + 2]))
            i += 3
    else:
        parts = re.split(r"^(#{2,3}) +(.+)$", text, flags=re.M)
        for i in range(1, len(parts) - 2, 3):
            out.append((len(parts[i]), parts[i + 1].strip(), parts[i + 2]))
    return out

def groups_in(body):
    """A group = an h4/#### heading, or a bolded list-item lead."""
    g = [(strip(m).strip(), None) for m in re.findall(r"<h4[^>]*>(.*?)</h4>", body, re.S)]
    g += [(m.strip(), None) for m in re.findall(r"^#### +(.+)$", body, flags=re.M)]
    return g

def items_under(body, heading):
    """Rows/bullets that follow a heading, until the next heading."""
    idx = body.find(heading)
    if idx < 0: return []
    rest = body[idx + len(heading):]
    nxt = re.search(r"<h4|^#### ", rest, flags=re.M)
    if nxt: rest = rest[:nxt.start()]
    out = [strip(m).strip() for m in re.findall(r"<tr>(.*?)</tr>", rest, re.S)]
    out += [m.strip() for m in re.findall(r"^\s*[-*] +(.+)$", rest, flags=re.M)]
    out += [strip(m).strip() for m in re.findall(r"<li>(.*?)</li>", rest, re.S)]
    return [o for o in out if len(o.split()) > 2]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("spec", nargs="+")
    ap.add_argument("--source", help="earlier notes the spec derives from")
    ap.add_argument("--inventory", default="", help="heading of the capability inventory")
    a = ap.parse_args()

    raw = "\n".join(open(f, encoding="utf-8").read() for f in a.spec if os.path.exists(f))
    if not raw:
        print("no readable spec files"); return 2
    flat = re.sub(r"\s+", " ", strip(raw)).lower()
    secs = sections(raw)
    fails, notes = [], []
    P = print
    P("=" * 72); P("SPEC STRUCTURE AUDIT  (Bob Rule 28)"); P("=" * 72)

    # ---- 1 & 2 & 3: groups within each section -------------------------------
    P("\n1-3  BUCKET OVERLAP · MISFILED MEMBERSHIP · UNDELIVERED PROMISE")
    checked = False
    for lvl, title, body in secs:
        gs = groups_in(body)
        if len(gs) < 2: continue
        checked = True
        names = [g[0] for g in gs]
        pop = {n: [words(i) for i in items_under(body, n)] for n in names}
        if not any(pop.values()): continue
        P(f"\n  § {title[:56]}")
        for x, y in itertools.combinations(names, 2):
            s = jac(words(x), words(y))
            if s > 0.34:
                fails.append(f"[{title[:24]}] groups {x!r} / {y!r} overlap {s:.2f}")
                P(f"    !!  overlap {s:.2f}  {x[:26]!r} ~ {y[:26]!r}")
        for n in names:                                   # membership
            for k, iw in enumerate(pop[n]):
                own = max((jac(iw, o) for j, o in enumerate(pop[n]) if j != k), default=0)
                best, bn = own, n
                for m in names:
                    if m == n: continue
                    v = max((jac(iw, o) for o in pop[m]), default=0)
                    if v > best: best, bn = v, m
                if bn != n and best - own > 0.06 and best > 0.10:
                    fails.append(f"[{title[:24]}] an item in {n!r} fits {bn!r} better")
                    P(f"    !!  item {k+1} of {n[:22]!r} sits closer to {bn[:22]!r} ({own:.2f} vs {best:.2f})")
        for n in names:                                   # delivery
            # Only a heading that makes a CLAIM can fail to deliver one. "X -> Y"
            # or "X (vs Y)" is a claim; "Install path" is an organisational label.
            if not re.search(r"→|->|\bvs\b", n): continue
            have = set().union(*pop[n]) if pop[n] else set()
            claim = words(n.split("→")[-1].split("->")[-1])
            miss = [w for w in claim if w not in have]
            if miss and pop[n]:
                fails.append(f"[{title[:24]}] {n!r} promises {miss} its items don't deliver")
                P(f"    !!  {n[:30]!r} promises {miss} — nothing under it delivers that")
    if not checked: P("  --  no multi-group sections found; skipped")

    # ---- 4: one-way coverage -------------------------------------------------
    P("\n4    ONE-WAY COVERAGE — capabilities named in prose but not in the inventory")
    inv = ""
    for lvl, title, body in secs:
        if a.inventory and a.inventory.lower() in title.lower(): inv = body
    if not inv:
        P("  --  no --inventory heading given; skipped")
    else:
        iflat = strip(inv).lower()
        orphan, seen = [], set()
        for lvl, title, body in secs:
            if a.inventory and a.inventory.lower() in title.lower(): continue
            prose = " ".join(re.findall(r"<p>.*?</p>|<li>.*?</li>", body, re.S)) or body
            for m in re.findall(r"\*\*([^*]{6,52})\*\*|<strong>([^<]{6,52})</strong>", prose):
                x = (m[0] or m[1]).strip().rstrip(".:")
                if re.match(r"^\d+\.|^(why|note|the trap|origin|test)", x, re.I): continue
                if not (2 <= len(x.split()) <= 5) or x.lower() in seen: continue
                if x.endswith((",", ";")) or x[0].islower(): continue
                if any(x.lower() in h_.lower() for _, h_, _ in [(0, s[1], 0) for s in secs]): continue
                seen.add(x.lower())
                ws = [w for w in re.findall(r"[a-z][a-z'-]{3,}", x.lower()) if w not in STOP]
                if ws and sum(1 for w in ws if w in iflat) / len(ws) < 0.5:
                    orphan.append((title, x))
        if orphan:
            notes.append(f"{len(orphan)} capability-shaped phrases not in the inventory")
            P(f"  ??  {len(orphan)} named in prose, not clearly in the inventory — judge each:")
            for t, x in orphan[:12]: P(f"      {t[:24]:26s} {x}")
        else:
            P("  ok  nothing describes a capability the inventory omits")

    # ---- 5: structural duplication ------------------------------------------
    P("\n5    STRUCTURAL DUPLICATION — two sections doing the same job")
    sig = []
    for lvl, title, body in secs:
        heads = tuple(sorted(strip(x).strip().lower() for x in re.findall(r"<thead>(.*?)</thead>", body, re.S)))
        n = len(re.findall(r"<tr>", body)) + len(re.findall(r"<li>", body)) + len(re.findall(r"^\s*[-*] ", body, flags=re.M))
        sig.append((title, heads, n))
    hit = False
    for (t1, h1, n1), (t2, h2, n2) in itertools.combinations(sig, 2):
        if n1 < 5 or n2 < 5: continue
        if jac(words(t1), words(t2)) > 0.4 or (h1 and h2 and set(h1) & set(h2)):
            fails.append(f"sections {t1!r} and {t2!r} look like the same job"); hit = True
            P(f"  !!  {t1[:30]!r} and {t2[:30]!r}")
    if not hit: P("  ok  no two sections doing the same job")

    # ---- 6: phrase duplication ----------------------------------------------
    P("\n6    PHRASE DUPLICATION — the same clause in two places")
    from collections import Counter
    c = Counter()
    for _, _, body in secs:
        for ph in re.findall(r"[a-z][a-z ,'-]{40,80}", re.sub(r"\s+", " ", strip(body)).lower()):
            c[ph.strip()] += 1
    dups = [(p_, n) for p_, n in c.most_common(40) if n > 1]
    for p_, n in dups[:6]: P(f"  ??  {n}x  {p_[:74]}")
    if dups: notes.append(f"{len(dups)} repeated phrases")
    else: P("  ok  none")

    # ---- 7: source fidelity --------------------------------------------------
    P("\n7    SOURCE FIDELITY — every concept in the origin notes still present")
    if not a.source or not os.path.exists(a.source or ""):
        P("  --  no --source given; skipped")
    else:
        o = open(a.source, encoding="utf-8").read()
        cand = set(re.findall(r"\*\*(.+?)\*\*", o)) | set(re.findall(r"`([^`]+)`", o)) \
             | set(re.findall(r"^[-*] (.+)$", o, re.M))
        cl = lambda s: re.sub(r"[*`\[\]]", "", re.sub(r"\(.*?\)", "", s)).strip().lower()
        cand = {cl(i) for i in cand}
        cand = {i for i in cand if 3 < len(i) < 90 and not re.match(r"^\d+\.|^(status|takeaway)", i)}
        gone = []
        for t in cand:
            t = t.rstrip(".")
            if t in flat: continue
            ws = [w for w in re.findall(r"[a-z][a-z'_/-]{3,}", t) if w not in STOP]
            if ws and sum(1 for w in ws if w in flat) / len(ws) < 0.6: gone.append(t)
        if gone:
            fails.append(f"{len(gone)} concept(s) dropped from {os.path.basename(a.source)}")
            for g in sorted(gone): P(f"  !!  dropped from the source: {g}")
        else:
            P(f"  ok  all {len(cand)} concepts from {os.path.basename(a.source)} still present")

    P("\n" + "=" * 72)
    if fails:
        P("FAIL (fix before advancing):"); [P("  · " + f) for f in fails]
    else:
        P("PASS — no hard structural failures")
    if notes: P("REVIEW (judge each, does not fail the run): " + " · ".join(notes))
    P("\nNow read for what no script can see: altitude drift (mechanisms where the")
    P("concept belongs), jargon in reader-facing sections, and whether the bold leads")
    P("of any list reword each other with the detail covered up.")
    P("=" * 72)
    return 1 if fails else 0

if __name__ == "__main__":
    sys.exit(main())
