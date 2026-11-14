"""Behavioral checks for source-fidelity evidence and exit-code precedence."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


AUDITOR = Path(__file__).with_name("spec-audit.py")


class SourceFidelityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="bob-spec-audit-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.spec = self.root / "spec.md"
        self.spec.write_text("# Spec\n## Scope\nSaved orders remain searchable.\n", encoding="utf-8")
        self.source = self.root / "source.md"

    def run_audit(self, source=None, specs=None):
        command = [sys.executable, str(AUDITOR), *map(str, specs if specs is not None else [self.spec])]
        if source is not None:
            command.extend(["--source", str(source)])
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertNotIn("Traceback", result.stderr)
        return result

    def assert_unassessed(self, result):
        self.assertEqual(result.returncode, 2, result.stdout + result.stderr)
        self.assertIn("CANNOT JUDGE", result.stdout)
        self.assertNotIn("PASS —", result.stdout)
        self.assertNotIn("all 0 concepts", result.stdout)

    def test_missing_spec_member_is_not_silently_skipped(self):
        self.source.write_text("**Saved orders**\n", encoding="utf-8")
        result = self.run_audit(self.source, [self.spec, self.root / "missing.md"])
        self.assert_unassessed(result)
        self.assertIn("spec input: cannot read", result.stdout)
        self.assertIn("FileNotFoundError", result.stdout)

    def test_all_missing_specs_cannot_judge(self):
        result = self.run_audit(specs=[self.root / "missing.md", self.root / "also-missing.md"])
        self.assert_unassessed(result)
        self.assertIn("no usable spec files", result.stdout)
        self.assertIn("also-missing.md", result.stdout)

    def test_invalid_spec_inputs_cannot_judge_alone_or_with_good_spec(self):
        bad_encoding = self.root / "invalid.md"
        bad_encoding.write_bytes(b"\xff\xfe\xfd")
        empty = self.root / "empty.md"
        empty.write_text(" \n\t", encoding="utf-8")
        for invalid in (self.root, bad_encoding, empty):
            for specs in ([invalid], [self.spec, invalid]):
                with self.subTest(specs=specs):
                    self.assert_unassessed(self.run_audit(specs=specs))

    def test_incomplete_specs_do_not_invent_source_omissions(self):
        self.source.write_text("**Recovery previews**\n", encoding="utf-8")
        result = self.run_audit(self.source, [self.spec, self.root / "missing.md"])
        self.assert_unassessed(result)
        self.assertIn("omissions cannot be judged", result.stdout)
        self.assertNotIn("possible source omission", result.stdout)

    def test_missing_spec_does_not_hide_known_structural_failure(self):
        self.spec.write_text("# Spec\n## Scope\n- TODO: choose storage\n", encoding="utf-8")
        result = self.run_audit(specs=[self.root / "missing.md", self.spec])
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("leftover placeholder", result.stdout)
        self.assertIn("UNASSESSED: spec input", result.stdout)

    def test_source_omitted_is_intentional_skip(self):
        result = self.run_audit()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("no --source given; skipped", result.stdout)
        self.assertNotIn("CANNOT JUDGE", result.stdout)

    def test_missing_explicit_source_is_not_silently_skipped(self):
        result = self.run_audit(self.source)
        self.assert_unassessed(result)
        self.assertIn("FileNotFoundError", result.stdout)
        self.assertNotIn("no --source given", result.stdout)

    def test_unreadable_source_directory_cannot_judge(self):
        result = self.run_audit(self.root)
        self.assert_unassessed(result)
        self.assertIn("IsADirectoryError", result.stdout)

    def test_non_utf8_source_cannot_judge(self):
        self.source.write_bytes(b"\xff\xfe\xfd")
        self.assert_unassessed(self.run_audit(self.source))

    def test_empty_source_cannot_judge(self):
        self.source.write_text("", encoding="utf-8")
        result = self.run_audit(self.source)
        self.assert_unassessed(result)
        self.assertIn("examined 0 candidate", result.stdout)

    def test_plain_prose_without_extractable_snippets_cannot_judge(self):
        self.source.write_text("The design must support local drafts and a preview of recovery.\n", encoding="utf-8")
        result = self.run_audit(self.source)
        self.assert_unassessed(result)
        self.assertIn("no extractable candidate snippets", result.stdout)

    def test_markup_with_no_usable_lexical_anchors_cannot_judge(self):
        self.source.write_text("**the and some**\n`-----`\n", encoding="utf-8")
        self.assert_unassessed(self.run_audit(self.source))

    def test_known_dropped_candidate_still_fails(self):
        self.source.write_text("**Saved orders**\n- Recovery previews\n", encoding="utf-8")
        result = self.run_audit(self.source)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("examined 2 candidate", result.stdout)
        self.assertIn("possible source omission (review meaning): recovery previews", result.stdout)
        self.assertIn("1 source snippet(s) lack lexical coverage", result.stdout)

    def test_preserved_candidates_pass_without_semantic_completeness_claim(self):
        self.source.write_text("**Saved orders**\n`searchable`\n- Recovery previews\n", encoding="utf-8")
        self.spec.write_text("# Spec\n## Scope\nSaved orders remain searchable; recovery previews are available.\n", encoding="utf-8")
        result = self.run_audit(self.source)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("examined 3 candidate", result.stdout)
        self.assertIn("semantic review still required", result.stdout)
        self.assertIn("selected bold/code/bullet text only", result.stdout)
        self.assertNotIn("every concept", result.stdout)
        self.assertNotIn("concepts from", result.stdout)

    def test_missing_source_does_not_hide_structural_failure(self):
        self.spec.write_text("# Spec\n## Scope\n- TODO: choose draft recovery behavior\n", encoding="utf-8")
        result = self.run_audit(self.source)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("leftover placeholder", result.stdout)
        self.assertIn("UNASSESSED: source check", result.stdout)

    def test_zero_candidates_do_not_hide_structural_failure(self):
        self.source.write_text("Plain prose only.\n", encoding="utf-8")
        self.spec.write_text("# Spec\n## Scope\n- TBD: choose storage\n", encoding="utf-8")
        result = self.run_audit(self.source)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("leftover placeholder", result.stdout)
        self.assertIn("source coverage is unassessed", result.stdout)

    def test_existing_placeholder_exclusions_are_preserved(self):
        self.spec.write_text(
            "# Spec\n## Scope\n- The retry budget is TBD pending benchmarks.\n"
            "- Use `TODO` comments sparingly in code.\n```\nTODO in quoted code\n```\n",
            encoding="utf-8",
        )
        result = self.run_audit()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
