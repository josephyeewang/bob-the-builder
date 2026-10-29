<!--
  The map: the main architecture diagram, the centrepiece of the
  front page (section 3.0). Drawn from text [mermaid] so GitHub can
  draw it on a phone.

  The whole diagram is GENERATED from blueprint.yaml (modules, steps,
  part lights): never draw or edit it by hand. The layouts below show
  the shape the page builder fills in; <…> are the generated values.

  Each box: mono ID · bold name · one-line role · light dot and label,
  linking to its card. Lights are generated. Proposed modules are
  shown as "Proposed, not adopted" and never scored.
-->

<a id="map"></a>
# The map

## The one-cut rule

- **Process product** (its work moves through steps): the map draws
  the loop as a numbered path through the modules, each step with
  exactly one owning module, plus a "serves every step" column for
  shared modules.
- **Pipeline product** (its work flows through stages, e.g. "get the
  facts right" → the central "waist" → "get the conclusions right"):
  the stages *are* the path, unchanged.

<a id="map-wide"></a>
## Wide layout (desktop)

Left to right; the "serves every step" column sits below the path.

<!-- generated -->
<!-- from: blueprint.yaml (modules, steps, part lights) -->
```mermaid
flowchart LR
  subgraph Z1["<zone or stage 1>"]
    M1["<code>M1</code> · <b><Module name></b><br/><one-line role><br/>● Green"]
  end
  subgraph Z2["<zone or stage 2>"]
    M2["<code>M2</code> · <b><Module name></b><br/><one-line role><br/>◐ Amber"]
  end
  subgraph Z3["<zone or stage 3>"]
    M3["<code>M3</code> · <b><Module name></b><br/><one-line role><br/>○ Red"]
  end
  M1 -->|"1 · <step>"| M2 -->|"2 · <step>"| M3
  M3 -.->|"loops back up the chain"| M1
  subgraph ALL["Applies to every module / serves every step"]
    S1["<code>M9</code> · <b><shared module></b><br/>shared: no step of its own<br/>● Green"]
  end
  P1["<code>M10</code> · <b><Module name></b><br/>Proposed, not adopted"]:::proposed
  click M1 "#card-M1"
  click M2 "#card-M2"
  click M3 "#card-M3"
  click S1 "#card-M9"
  classDef proposed stroke-dasharray: 4 4
```
<!-- /generated -->

<a id="map-tall"></a>
## Tall layout (phone)

Top to bottom, one box per line, so nothing scrolls sideways.

<!-- generated -->
<!-- from: blueprint.yaml (modules, steps, part lights) -->
```mermaid
flowchart TB
  M1["<code>M1</code> · <b><Module name></b><br/><one-line role><br/>● Green"]
  M2["<code>M2</code> · <b><Module name></b><br/><one-line role><br/>◐ Amber"]
  M3["<code>M3</code> · <b><Module name></b><br/><one-line role><br/>○ Red"]
  M1 -->|"1 · <step>"| M2 -->|"2 · <step>"| M3
  M3 -.->|"loops back up the chain"| M1
  S1["<code>M9</code> · <b><shared module></b><br/>serves every step<br/>● Green"]
  click M1 "#card-M1"
  click M2 "#card-M2"
  click M3 "#card-M3"
  click S1 "#card-M9"
```
<!-- /generated -->

## Under the map

<!-- generated -->
- **"Applies to every module" band** [G, once there are shared rules
  or services]: shared rules · shared services · loops back up the
  chain
- **Card legend line:** ● Green · ◐ Amber · ○ Red · `ID` coloured by
  plane or zone · ◆n checkpoint
<!-- /generated -->

## The phone layout

- The **tall** map above.
- The pinned contents bar becomes a sticky menu.
- Tables keep the same columns and scroll sideways.
- Folds stay folded; the answer is always shown above each fold.
