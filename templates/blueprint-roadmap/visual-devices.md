<!--
  Visual devices, kept: the look every Blueprint page shares (front
  page, history page, cards, map). The page builder reads the colour
  tokens from here; define each one ONCE, here, and nowhere else.
-->

<a id="visual-devices"></a>
# Visual devices

<a id="vd-tokens"></a>
## Colour tokens

Defined once, with light and dark modes: zone colours, and status
colours each with a soft background. Pages use the token names,
never a raw colour.

```css
:root {
  /* status colours, each with a soft background */
  --green: #1a7f37;      --green-soft: #dafbe1;
  --amber: #9a6700;      --amber-soft: #fff8c5;
  --red: #cf222e;        --red-soft: #ffebe9;
  /* zone (plane) colours: one per zone or stage on the map */
  --zone-1: #0969da;     --zone-1-soft: #ddf4ff;
  --zone-2: #8250df;     --zone-2-soft: #fbefff;
  --zone-3: #bc4c00;     --zone-3-soft: #fff1e5;
  --zone-shared: #57606a; --zone-shared-soft: #f6f8fa;
  /* text and receipts */
  --ink: #1f2328;  --muted: #656d76;  --bg: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --green: #3fb950;    --green-soft: #12261e;
    --amber: #d29922;    --amber-soft: #272115;
    --red: #f85149;      --red-soft: #2d1214;
    --zone-1: #4493f8;   --zone-1-soft: #121d2f;
    --zone-2: #ab7df8;   --zone-2-soft: #1f1630;
    --zone-3: #f0883e;   --zone-3-soft: #2a1a0e;
    --zone-shared: #8d96a0; --zone-shared-soft: #161b22;
    --ink: #e6edf3;  --muted: #8d96a0;  --bg: #0d1117;
  }
}
:root[data-theme="dark"] {
  --green: #3fb950;    --green-soft: #12261e;
  --amber: #d29922;    --amber-soft: #272115;
  --red: #f85149;      --red-soft: #2d1214;
  --zone-1: #4493f8;   --zone-1-soft: #121d2f;
  --zone-2: #ab7df8;   --zone-2-soft: #1f1630;
  --zone-3: #f0883e;   --zone-3-soft: #2a1a0e;
  --zone-shared: #8d96a0; --zone-shared-soft: #161b22;
  --ink: #e6edf3;  --muted: #8d96a0;  --bg: #0d1117;
}
```

<a id="vd-chips"></a>
## Light chips: a symbol *and* the word

`● Green / ◐ Amber / ○ Red`, never colour alone, so a reader who
can't tell the colours apart, or prints in black and white, still
reads the light.

| Chip | Symbol | Word | Colour token |
|---|---|---|---|
| ● Green | ● | Green | `--green` on `--green-soft` |
| ◐ Amber | ◐ | Amber | `--amber` on `--amber-soft` |
| ○ Red | ○ | Red | `--red` on `--red-soft` |

<a id="vd-tags"></a>
## Tags

- **Source type:** Measured · Audit · History · Best practice ·
  Live defect
- **Exists / partial / missing** on design sheets
- **Status in headers:** the light chip

<a id="vd-receipts"></a>
## Grey mono reference tags (receipts)

A grey mono tag after each claim, in `--muted`. There are four
receipt kinds:

| Kind | Looks like |
|---|---|
| Roadmap row | `R-M1-1` |
| Intake item | `IN-12` |
| Decision | `D-7` |
| Code change | `#42` or `a1b2c3d` |

<a id="vd-folds"></a>
## Folds where the answer is always shown

The answer sits above the fold; the evidence and history fold away
[`<details>`].

<a id="vd-skip"></a>
## "The owner can skip" labels

On builder material, e.g. **"Builders' notes; the owner can skip."**

<a id="vd-boxes"></a>
## "Approved" and "Proposed" boxes

> **Approved by [owner], [date] (D-n)**

> **Proposed**: not yet approved.

<a id="vd-tables"></a>
## Tables

Tables keep the same columns every time and scroll sideways on
phones.

<a id="vd-links"></a>
## Cross-links

Cross-links keep every old anchor: a renamed heading keeps its old
anchor and says "(was X)".

<a id="vd-type"></a>
## Typography

- A condensed display font for headings.
- Mono for IDs and receipts.
- **Prose at most 72 characters a line** (`max-width: 72ch` on the
  rich page; hand-written Markdown wraps at 72). Tables, code and
  diagrams are exempt.
