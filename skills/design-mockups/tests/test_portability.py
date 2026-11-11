"""Local portability checks; no provider calls, installs or real browser launch."""
import contextlib
import io
import os
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]


class PortabilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = runpy.run_path(str(ROOT / "mockup.py"), run_name="portability_fixture")

    def test_browser_receives_a_file_uri_without_shell_parsing(self):
        with tempfile.TemporaryDirectory() as folder:
            board = Path(folder) / 'a space and "quote" board.html'
            with patch("webbrowser.open", return_value=True) as browser:
                self.module["_open"](board)
            browser.assert_called_once_with(board.resolve().as_uri())

    def test_missing_browser_preserves_an_openable_path(self):
        with patch("webbrowser.open", side_effect=OSError("no browser")):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.module["_open"]("board.html")
            self.assertIn(str(Path("board.html").resolve()), output.getvalue())

    def test_existing_images_build_without_config_or_provider_access(self):
        from PIL import Image
        import gen
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / "images"
            out.mkdir()
            Image.new("RGB", (32, 24), "white").save(out / "fixture.png")
            missing = str(Path(folder) / "not-present.json")
            with patch.dict(os.environ, {"DESIGN_MOCKUP_CONFIG": missing}, clear=True):
                with patch.object(gen, "key", side_effect=AssertionError("provider access")):
                    with patch("webbrowser.open", return_value=True):
                        self.module["cmd_grouped"](str(out))
            self.assertTrue((out / "gallery-grouped.html").exists())


if __name__ == "__main__":
    unittest.main()
