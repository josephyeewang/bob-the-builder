# Cowork Session Template

> Use when a build phase requires human-in-the-loop data collection, research, or manual enrichment that Claude assists with.
> Common uses: vendor account setup, manual data enrichment, competitor research, content review, visual asset evaluation.

Some phases require the human and Claude to work together in real-time — looking up data, extracting information from websites, reviewing visual assets, etc. These sessions benefit from the same structure as build phases.

---

## SESSION [N]: [Clear Scope Name]

### Context
[Why we're doing this. What project phase it supports.]

### Your Job
[One-sentence role statement for Claude]

### What to Capture
[Field-by-field list with "where to find it" notes]
| Field | Source | Notes |
|-------|--------|-------|
|       |        |       |

### Output Format
[Exact structure — CSV columns, markdown table, JSON shape]

### Workflow
[Step-by-step sequence]
1. Human does X
2. Claude does Y
3. Repeat for each item

### Items to Process
[Prioritized list with status column]
| # | Item | Status |
|---|------|--------|
| 1 |      | Pending |

### Error Handling
- If item not found: [behavior]
- If data is ambiguous: [behavior]
- If source is down: [behavior]

Let's start with item #1.

**When to use:** Vendor account setup, manual data enrichment (Zillow/Redfin lookups, competitor research), content review, visual asset evaluation, any task where Claude reads/processes but the human navigates.
