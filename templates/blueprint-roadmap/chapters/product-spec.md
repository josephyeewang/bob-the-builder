> **Chapter of the Blueprint:** short facts live there; this page holds depth.

<!--
  Copy to docs/product-spec.md (the path blueprint.yaml names for
  "Product"). This chapter holds DEPTH only. Short facts have one home
  in docs/blueprint/ and are linked, never re-typed:
    • the goal, objectives and targets → front page section 2
      (decided.yaml); this chapter has no mission section of its own
    • "not doing" → section 2a (decided.yaml)
    • the one-line customer and the pain → section 2b (decided.yaml)
    • the capability list → section 3.c (blueprint.yaml); this
      chapter holds each capability's detail under its ID, never the
      list itself
    • dates and the plan → section 5c (blueprint.yaml, rows/*.yaml);
      no chapter has a roadmap section
  scripts/blueprint/fact-twice-check.mjs fails a change that re-types
  one of those facts here.

  Small product: the Product and Market chapters may be one file with
  two headings ("# Product" and "# Market"), so a personal tool isn't
  handed a 20-section page. List that one file under both chapter
  names in blueprint.yaml.
-->

<a id="product"></a>
# Product

The goal and objectives:
[front page, section 2](blueprint/front-page.md#s-2).
What we are not doing: [section 2a](blueprint/front-page.md#s-2a).

<a id="who"></a>
## Who it's for and what they need

<!-- In full here. The one-line customer and the pain sit in
     decided.yaml and show in section 2b; link, don't repeat. -->
Who it's for, in one line: [section 2b](blueprint/front-page.md#s-2b).

<a id="who-pain"></a>
### The pain

<the pain, in depth: when it happens, what it costs them>

<a id="who-today"></a>
### Today's alternatives

<what they use today, and where each falls short>

<a id="who-scenarios"></a>
### The scenarios

<scenario: who, the moment, what they do, what "worked" looks like>

<a id="who-interviews"></a>
### The interview answers

<what people said, each linked to its research-library entry>

<a id="who-day"></a>
### A day in their life

<a day, start to finish, showing where the pain lands>

<a id="capabilities"></a>
## Capabilities, in depth

<!-- One heading per capability ID. The list itself (name, module,
     maturity, row) is generated in section 3.c; never re-type it. -->
The list: [section 3.c](blueprint/front-page.md#s-3-c).

<a id="C1"></a>
### C1

- **Scenarios:** <the situations it serves>
- **What "accepted" means:** <how we know it works for the user>
- **Notes:** <edge cases, open questions>

<a id="later"></a>
## Later

Ideas for after the first version are **later** rows on the roadmap,
each with its trigger: [section 5c](blueprint/front-page.md#s-5c).
