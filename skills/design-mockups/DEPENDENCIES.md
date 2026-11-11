# Standalone dependencies and notices

Keep SKILL.md, this file, mockup.py, config.example.json, all lib/, references/ and tests/ files.
Include Bob's MIT LICENSE with exports. No Bob runtime or private setup file is required.

## Local gallery

Python3 plus Pillow is required: mockup.py imports the gallery/contact-sheet renderer. Use a
project environment or virtual environment with Pillow installed. Scripts do not install packages.
The browser opener uses Python's standard webbrowser module and prints a local path if opening
is unavailable.

For existing images without provider configuration, pass the output directory to grouped/curated
or set MOCKUP_OUT_DIR for gallery/reject. These commands do not resolve a provider key. Reject
moves images into _deleted and changes numbering: rebuild the board before reusing numbers.
Keep project configuration and generated output outside the installed module.

## Optional generation

lib/gen.py uses Python's standard HTTP/JSON libraries for the configured Google image model.
Generation needs approved credentials, model availability, budget and permission to send prompts
and reference images. The runtime reads the configured environment variable, or a user-chosen
api_key_file; installers and assistants must not inspect secret values. No actual credentials or
project configuration belong in an exported module. Check current model IDs, limits and pricing
before generation. Local galleries need no paid account.

lib/vid.py is a Python helper, not a mockup.py CLI subcommand. Import it with this module's lib/
on Python's import path after setting project configuration; import initializes its output
folder. Calling make_video uses the approved provider configuration and uploads the input image.
It is optional; source inspection does not establish a successful generation or runtime test.

## Optional companions and installation

Design Gallery provides reference discovery and exact transfer discipline. Resolve it through
the current assistant's skill list or a user-specified path; a sibling folder is not required.
If absent, use supplied/approved public references and retain a concrete lock/transfer record.
Motion libraries in references/build-bridge.md are project choices, not bundled dependencies.

Install this complete folder in the assistant's supported skill directory, or read it from a
checkout. Set DESIGN_MOCKUPS_DIR to the resolved folder for examples; set DESIGN_MOCKUP_CONFIG
when configuration is outside the working directory. Bob's skills/design-mockups/ is maintained
source; update from there rather than maintaining instructions in an exported copy.

Local verification: python3 tests/test_portability.py checks browser handoff and gallery building
with fictional images, no provider access and no actual browser launch.
