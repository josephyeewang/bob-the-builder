"""Standalone profile behavior, with explicit synthetic inputs only."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).parents[1]
SCRIPT = ROOT / 'scripts/fit-profile.py'


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


profile = load('fit-profile')
indexer = load('component-index')
checker = load('check-evaluation')


class PortableProfileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.project = self.root / 'sensor-workbench'
        self.project.mkdir()
        self.memory = self.root / 'private-recall'

    def command(self, *args):
        return subprocess.run([sys.executable, '-B', '-I', str(SCRIPT), *map(str, args)],
                              text=True, capture_output=True)

    def test_explicit_project_does_not_discover_neighbor_or_write(self):
        (self.project / 'README.md').write_text('# Workbench\n\nCompare sensor quality.\n')
        neighbor = self.root / 'unselected-project'
        neighbor.mkdir()
        (neighbor / 'README.md').write_text('UNSELECTED CONTENT')
        text = profile.render([self.project], [], self.memory)
        self.assertIn('Compare sensor quality.', text)
        self.assertNotIn('UNSELECTED CONTENT', text)
        self.assertNotIn(str(neighbor), text)
        self.assertFalse(self.memory.exists())

    def test_missing_context_and_capabilities_remain_unknown(self):
        run = self.command('--memory-root', self.memory, '--no-project-context')
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn('Current-project fit remains unknown', run.stdout)
        self.assertIn('unverified, not absent', run.stdout)
        self.assertFalse(self.memory.exists())

    def test_symlink_and_oversized_documents_not_read(self):
        outside = self.root / 'outside.md'
        outside.write_text('OUTSIDE CONTENT')
        (self.project / 'README.md').symlink_to(outside)
        (self.project / 'AGENTS.md').write_text('X' * (profile.MAX_BYTES + 1))
        docs = self.root / 'outside-docs'
        docs.mkdir()
        (docs / 'PROJECT-STATE.md').write_text('OUTSIDE STATUS')
        (self.project / 'docs').symlink_to(docs, target_is_directory=True)
        text = profile.render([self.project], [], self.memory)
        self.assertNotIn('OUTSIDE CONTENT', text)
        self.assertNotIn('OUTSIDE STATUS', text)
        self.assertIn('symlink rejected', text)
        self.assertIn('exceeds bounded document size', text)

    def test_skill_presence_is_not_activation(self):
        skill = self.root / 'explicit-skill'
        skill.mkdir()
        (skill / 'SKILL.md').write_text('---\nname: example\n---\n# Example\n\nInspect synthetic packets.\n')
        text = profile.render([self.project], [skill], self.memory)
        self.assertIn('Inspect synthetic packets.', text)
        self.assertIn('does not establish activation or actual use', text)

    def test_cli_requires_explicit_memory_and_project_context_choice(self):
        self.assertNotEqual(self.command('--no-project-context').returncode, 0)
        self.assertNotEqual(self.command('--memory-root', self.memory).returncode, 0)
        self.assertNotEqual(self.command('--memory-root', self.memory, '--project-root', self.project,
                                        '--no-project-context').returncode, 0)
        index_run = subprocess.run([sys.executable, '-B', '-I', str(ROOT / 'scripts/component-index.py'), '--stdout'],
                                   capture_output=True, text=True)
        self.assertNotEqual(index_run.returncode, 0)

    def test_only_named_generated_output_is_written_history_unchanged(self):
        tools = self.memory / 'tools'
        tools.mkdir(parents=True)
        historical = tools / 'old.md'
        historical.write_bytes(b'---\nrating: 3\n---\nimmutable old history\r\n')
        before = historical.read_bytes()
        output = self.memory / 'fit-profile.md'
        run = self.command('--project-root', self.project, '--memory-root', self.memory, '--output', output)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn('Historical Markdown records available: 1', output.read_text())
        self.assertEqual(historical.read_bytes(), before)
        unsafe = self.command('--project-root', self.project, '--memory-root', self.memory, '--output', historical)
        self.assertNotEqual(unsafe.returncode, 0)
        self.assertEqual(historical.read_bytes(), before)

    def test_output_symlink_cannot_overwrite_target(self):
        self.memory.mkdir()
        target = self.root / 'target.md'
        target.write_text('UNCHANGED')
        output = self.memory / 'fit-profile.md'
        output.symlink_to(target)
        run = self.command('--memory-root', self.memory, '--no-project-context', '--output', output)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual(target.read_text(), 'UNCHANGED')

    def test_current_and_legacy_statement_bases_preserved_not_rewritten(self):
        (self.memory / 'tools').mkdir(parents=True)
        pains = [dict(id=basis, project='SensorDesk', problem='Missing sample dates', basis=basis,
                      source='AGENTS.md:4', observed_on='unknown', status='open')
                 for basis in ['user-stated', 'joe-stated']]
        record = dict(schema_version=2, context_schema_version=1, tool='fixture', checked_on='2026-01-01',
                      complete=False, source_access_limits='Synthetic fixture only',
                      project_context={'pains': pains}, usefulness={'conclusion': 'No parts selected', 'components': []},
                      security={'conclusion': 'No runtime', 'checks': [], 'unknowns': ['Runtime'], 'findings': []},
                      qualitative={'conclusion': 'Unknown', 'sources': [], 'limitations': 'Fixture'},
                      coverage={'inspected': [], 'omitted': []}, alternative_search={'results': []},
                      runtime={'status': 'not-tested'})
        path = self.memory / 'tools/fixture.json'
        path.write_text(json.dumps(record))
        before = path.read_bytes()
        index = indexer.build_index(self.memory)
        self.assertEqual({p['basis'] for p in index['pains']}, {'user-stated', 'joe-stated'})
        self.assertFalse(any('valid basis' in w['problem'] for w in index['warnings']))
        # This fixture intentionally omits unrelated completion fields; compare only basis validation.
        errors = checker.validate(record, self.memory)
        self.assertFalse(any('pain basis' in e for e in errors), errors)
        self.assertEqual(path.read_bytes(), before)
        for pain in pains:
            pain['source'] = ''
        path.write_text(json.dumps(record))
        self.assertEqual({p['basis'] for p in indexer.build_index(self.memory)['pains']}, {'unknown'})
        self.assertTrue(any('pain observation requires source' in e for e in checker.validate(record, self.memory)))


if __name__ == '__main__':
    unittest.main()
