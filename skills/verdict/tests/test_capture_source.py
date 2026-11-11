"""Behavior checks using synthetic Git objects; never execute source code."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'capture-source.py'
spec = importlib.util.spec_from_file_location('capture_source', SCRIPT)
capture_source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture_source)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='verdict-capture-test-')
        self.base = Path(self.temp.name)
        self.repo = self.base / 'repo'
        self.repo.mkdir()
        self.run_git('init', '-q')
        (self.repo / 'src').mkdir()
        (self.repo / 'src' / 'method.py').write_bytes(b'original\r\n\x00\xff')
        (self.repo / 'empty.txt').write_bytes(b'')
        (self.repo / 'LICENSE').write_text('Synthetic license fixture for testing only.\n')
        self.run_git('add', '--', 'src/method.py', 'empty.txt', 'LICENSE')
        self.run_git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                     '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'fixture')
        self.commit = self.run_git('rev-parse', 'HEAD').decode().strip()
        self.output = self.base / 'bundle'

    def tearDown(self):
        self.temp.cleanup()

    def run_git(self, *args):
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull)
        return subprocess.check_output(['git', '--no-pager', '-c', 'core.fsmonitor=false',
                                        '-C', str(self.repo), *args], env=env, stderr=subprocess.PIPE)

    def capture(self, **overrides):
        options = dict(repo=self.repo, revision=self.commit,
                       source_url='https://github.com/example/fixture', output=self.output,
                       files=['LICENSE', 'src/method.py', 'empty.txt'], license_reviewed=True)
        options.update(overrides)
        return capture_source.capture(**options)

    def test_preserves_original_bytes_and_empty_assets(self):
        manifest = self.capture()
        for row in manifest['files']:
            data = (self.output / 'originals' / row['path']).read_bytes()
            self.assertEqual(data, (self.repo / row['path']).read_bytes())
            self.assertEqual(hashlib.sha256(data).hexdigest(), row['sha256'])
            self.assertEqual(len(data), row['bytes'])
        self.assertEqual(json.loads((self.output / 'manifest.json').read_text()), manifest)

    def test_immutable_revision_ignores_worktree_changes(self):
        (self.repo / 'src/method.py').write_text('changed execution')
        self.capture()
        self.assertEqual((self.output / 'originals/src/method.py').read_bytes(), b'original\r\n\x00\xff')

    def test_refuses_mutable_revision(self):
        with self.assertRaises(ValueError):
            self.capture(revision='HEAD')
        self.assertFalse(self.output.exists())

    def test_refuses_escape_and_absolute_paths_before_writes(self):
        for value in ('../out', '/absolute', 'src/../../out', './LICENSE', 'src\\out'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.capture(files=['LICENSE', value])
        self.assertFalse(self.output.exists())

    def test_refuses_sensitive_names_before_git_lookup(self):
        # Names only: no prohibited files are created or read.
        for value in ('.env', 'config/.env.local', '.ssh/id_rsa', 'Cookies', 'wallet.dat',
                      'settings.json', '.claude.json', 'server.key', 'user-password.txt'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.capture(files=['LICENSE', value])
        self.assertFalse(self.output.exists())

    def test_refuses_symlink_without_following_it(self):
        (self.repo / 'alias').symlink_to('src/method.py')
        self.run_git('add', '--', 'alias')
        self.run_git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                     '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'link fixture')
        revision = self.run_git('rev-parse', 'HEAD').decode().strip()
        with self.assertRaises(ValueError):
            self.capture(revision=revision, files=['LICENSE', 'alias'])
        self.assertFalse(self.output.exists())

    def test_refuses_submodule_without_reading_it(self):
        self.run_git('update-index', '--add', '--cacheinfo', '160000,' + self.commit + ',vendor')
        self.run_git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                     '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'submodule fixture')
        revision = self.run_git('rev-parse', 'HEAD').decode().strip()
        with self.assertRaises(ValueError):
            self.capture(revision=revision, files=['LICENSE', 'vendor'])
        self.assertFalse(self.output.exists())

    def test_duplicate_paths_block_before_output(self):
        with self.assertRaises(ValueError):
            self.capture(files=['LICENSE', 'LICENSE'])
        self.assertFalse(self.output.exists())

    def test_existing_symlink_output_is_not_followed(self):
        self.output.symlink_to(self.repo / 'missing-target')
        with self.assertRaises(ValueError):
            self.capture()
        self.assertTrue(self.output.is_symlink())
        self.assertFalse((self.repo / 'missing-target').exists())

    def test_missing_file_leaves_no_partial_output(self):
        with self.assertRaises(ValueError):
            self.capture(files=['LICENSE', 'not-there.py'])
        self.assertFalse(self.output.exists())

    def test_missing_license_or_attestation_blocks(self):
        for options in ({'files': ['src/method.py']}, {'license_reviewed': False}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.capture(**options)
        self.assertFalse(self.output.exists())

    def test_existing_output_is_not_modified(self):
        self.output.mkdir()
        marker = self.output / 'keep.txt'
        marker.write_text('keep')
        with self.assertRaises(ValueError):
            self.capture()
        self.assertEqual(marker.read_text(), 'keep')

    def test_output_cannot_be_in_source_worktree(self):
        with self.assertRaises(ValueError):
            self.capture(output=self.repo / 'bundle')
        self.assertFalse((self.repo / 'bundle').exists())

    def test_oversize_source_blocks_before_writes(self):
        (self.repo / 'big.txt').write_bytes(b'x' * (capture_source.MAX_FILE_BYTES + 1))
        self.run_git('add', '--', 'big.txt')
        self.run_git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                     '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'size fixture')
        revision = self.run_git('rev-parse', 'HEAD').decode().strip()
        with self.assertRaises(ValueError):
            self.capture(revision=revision, files=['LICENSE', 'big.txt'])
        self.assertFalse(self.output.exists())

    def test_rejects_credentials_in_provenance_url(self):
        with self.assertRaises(ValueError):
            self.capture(source_url='https://user:placeholder@github.com/example/fixture')
        self.assertFalse(self.output.exists())

    def test_missing_promisor_blob_cannot_execute_remote_command(self):
        oid = self.run_git('rev-parse', self.commit + ':src/method.py').decode().strip()
        (self.repo / '.git' / 'objects' / oid[:2] / oid[2:]).unlink()
        marker = self.base / 'remote-executed'
        self.run_git('config', 'remote.origin.url', str(self.repo))
        self.run_git('config', 'remote.origin.promisor', 'true')
        self.run_git('config', 'remote.origin.partialclonefilter', 'blob:none')
        self.run_git('config', 'remote.origin.uploadpack', 'touch ' + str(marker) + '; false')
        with self.assertRaises(ValueError):
            self.capture()
        self.assertFalse(marker.exists(), 'capture must never invoke remote-configured commands')
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
