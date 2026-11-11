import importlib.util
import json
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location('skill_export', Path(__file__).with_name('skill_export.py'))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        self.module = self.root / 'skills/example'
        self.module.mkdir(parents=True)
        self.entry = self.module / 'SKILL.md'
        self.entry.write_text('---\nname: example\ndescription: Example\n---\n# Example\n')
        (self.root / 'LICENSE').write_text('Example license fixture\n')
        self.registry = {'schemaVersion': 1, 'repository': 'example/modules', 'modules': [
            {'id': 'example', 'title': 'Example', 'summary': 'Test fixture', 'origin': 'Example',
             'files': ['SKILL.md'], 'notices': {'LICENSE': 'LICENSE'}}]}
        self.write_registry()
        self.run_git('init', '-q')
        self.run_git('add', 'skills', 'LICENSE')
        self.run_git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Fixture')

    def run_git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], stderr=subprocess.STDOUT)

    def write_registry(self):
        (self.root / 'skills/exports.json').write_text(json.dumps(self.registry))

    def build(self, name='out', working=True):
        return exporter.build(self.root, Path(self.temp.name) / name, working)

    def test_reproducible_archive_and_receipt(self):
        a, b = self.build('one'), self.build('two')
        self.assertEqual(a, b)
        path = Path(self.temp.name) / 'one/example.zip'
        self.assertEqual(path.read_bytes(), (Path(self.temp.name) / 'two/example.zip').read_bytes())
        self.assertEqual(exporter.digest(path.read_bytes()), a['modules'][0]['sha256'])
        with zipfile.ZipFile(path) as archive:
            receipt = json.loads(archive.read('example/module.json'))
            self.assertEqual(set(archive.namelist()), {'example/' + name for name in receipt['files']} | {'example/module.json'})
            for name, expected in receipt['files'].items():
                self.assertEqual(expected, exporter.digest(archive.read('example/' + name)))

    def test_committed_source_ignores_uncommitted_and_unlisted_files(self):
        self.entry.write_text('Changed locally')
        (self.module / 'private-notes.txt').write_text('Never export this fixture')
        self.build(working=False)
        with zipfile.ZipFile(Path(self.temp.name) / 'out/example.zip') as archive:
            self.assertIn(b'name: example', archive.read('example/SKILL.md'))
            self.assertFalse(any('private-notes' in name for name in archive.namelist()))

    def test_preview_and_committed_are_distinguished(self):
        self.assertTrue(self.build('preview')['preview'])
        self.assertFalse(self.build('committed', False)['preview'])

    def test_dangerous_paths(self):
        for value in ('../outside', '/absolute', 'a/../b', 'a//b', '.private/x', 'evolutions/x', 'config.key', 'a\\..\\b', 'C:/drive'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                exporter.safe_path(value)

    def test_symlink_refused(self):
        link = self.module / 'link.md'
        link.symlink_to(self.entry)
        self.registry['modules'][0]['files'].append('link.md')
        self.write_registry()
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            self.build()

    def test_missing_and_duplicate_and_notice_collision(self):
        for files, notices in [(['SKILL.md', 'missing.md'], {'LICENSE': 'LICENSE'}),
                               (['SKILL.md', 'SKILL.md'], {'LICENSE': 'LICENSE'}),
                               (['SKILL.md'], {'SKILL.md': 'LICENSE'})]:
            with self.subTest(files=files, notices=notices):
                self.registry['modules'][0].update(files=files, notices=notices)
                self.write_registry()
                with self.assertRaises(ValueError):
                    self.build()

    def test_unknown_optional_dependency(self):
        self.registry['modules'][0]['optionalModules'] = ['missing']
        self.write_registry()
        with self.assertRaisesRegex(ValueError, 'dependency'):
            self.build()

    def test_private_installation_context(self):
        self.entry.write_text('Read /Users/example/private/project first')
        with self.assertRaisesRegex(ValueError, 'Personal installation'):
            self.build()

    def test_output_cannot_overwrite_source(self):
        with self.assertRaisesRegex(ValueError, 'Output'):
            exporter.build(self.root, self.module, True)

    def test_no_partial_archive_on_invalid_second_module(self):
        self.registry['modules'].append({'id': 'broken', 'files': ['SKILL.md'], 'title': 'Broken'})
        self.write_registry()
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse((Path(self.temp.name) / 'out').exists())


if __name__ == '__main__':
    unittest.main()
