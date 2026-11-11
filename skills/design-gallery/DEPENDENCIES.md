# Standalone dependencies and notices

Resolve resources relative to SKILL.md. No Bob runtime, account or connector is needed for the
HTML gallery/lock/transfer lane. View templates in a local browser, replace example content and
keep output in the target project. Google Fonts links are optional network requests; use local
fonts when offline or when privacy rules require it.

## Included files and notices

Keep SKILL.md, this file, all templates/ and references/, and the complete logo-kit/ subtree.
Logo scripts use assets/library/stats.json for complexity guidance; no company-logo library is
bundled. Include Bob's MIT LICENSE with exports, retain logo-kit/LICENSE, and include the
beautiful-ui MIT notice from third_party/beautiful-ui/LICENSE in Bob's maintained repository.
The agent checklist derives header descriptions from beautiful-ui; its runtime is not bundled.

## Logo lane

Python3 standard library runs SVG inspection and vector exports. PNG/concept sheets need one
available renderer: CairoSVG, rsvg-convert, Inkscape, Chrome/Chromium or macOS Quick Look. Scripts
detect these; they do not install them. Pillow is optional for Quick Look transparency. Check
availability before promising raster output; preserve SVG output if no renderer is available.
From logo-kit/ run python3 tests/test_export_titles.py and python3 tests/smoke_test.py after
script changes. Structural checks do not replace rendering and visual inspection.

## Optional integrations

- Design Mockups: separate image generation/gallery module. Use supplied images or HTML if absent.
- Inspo: reference search with current terms and an approved data route. No connection is assumed.
- Scrollcraft: separate marketing-scroll plugin; its checked version owns Node/ffmpeg/browser
  requirements. Keep the locked direction and use existing motion tools if it is unavailable.
- Agent UI registry components: optional examples, not required for the checklist. Inspect each
  dependency before installation; some referenced icons require payment.

Installation does not authorize a connector, system package, publication or deletion. Paid work
and confidential uploads need the user's approval. Preserve the pick/lock checkpoints.

## Installation and updates

Install the complete folder in the assistant's supported skill directory, or read it directly
from a checkout. Set DESIGN_GALLERY_DIR to this resolved folder for command examples. Keep
feedback, outputs and locks in the target project. Bob's skills/design-gallery/ is the maintained
source; update from there rather than maintaining instructions in an exported copy.
