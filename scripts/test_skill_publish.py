"""Offline publication contract tests; every GitHub mutation is a fake."""
import base64
import copy
import hashlib
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from skill_publish import ApiError, load_assets, publish

REPOSITORY = 'example/skills'
REVISION = 'a' * 40
OLDER = 'b' * 40
NEWER = 'c' * 40
BASE = f'repos/{REPOSITORY}'


def encoded(value):
    return (json.dumps(value, sort_keys=True) + '\n').encode()


def export_fixture(directory):
    files = {'SKILL.md': b'---\nname: sample\ndescription: Sample\n---\n',
             'LICENSE': b'Example license', 'INSTALL.md': b'Example install'}
    receipt = {'schemaVersion': 1, 'id': 'sample', 'sourceCommit': REVISION,
               'preview': False, 'repository': REPOSITORY,
               'files': {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        for name, data in files.items():
            archive.writestr(f'sample/{name}', data)
        archive.writestr('sample/module.json', encoded(receipt))
    data = buffer.getvalue()
    (directory / 'sample.zip').write_bytes(data)
    catalogue = {'schemaVersion': 1, 'repository': REPOSITORY, 'sourceCommit': REVISION,
                 'preview': False, 'modules': [
                     {'id': 'sample', 'sourceCommit': REVISION, 'bytes': len(data),
                      'sha256': hashlib.sha256(data).hexdigest(),
                      'download': f'https://github.com/{REPOSITORY}/releases/download/skills-{REVISION}/sample.zip'}]}
    (directory / 'catalogue.json').write_bytes(encoded(catalogue))
    return catalogue


class FakeApi:
    def __init__(self):
        self.main = REVISION
        self.tag = None
        self.release = None
        self.assets = {}
        self.pointer = None
        self.branch = False
        self.events = []
        self.comparison = 'ahead'
        self.fail_upload = None
        self.advance_during_download = False
        self.fail_pointer = False
        self.race_pointer = False

    def upload(self, repository, release_id, name, data):
        self.events.append(('UPLOAD', name))
        if name == self.fail_upload:
            raise ApiError(503)
        if name in self.assets:
            raise AssertionError('Cannot overwrite an existing asset')
        self.assets[name] = data
        return {'name': name, 'id': name}

    def api(self, method, path, payload=None, binary=False):
        self.events.append((method, path))
        if method == 'GET':
            if path == f'{BASE}/git/ref/heads/main':
                return {'object': {'type': 'commit', 'sha': self.main}}
            if path == f'{BASE}/git/ref/tags/skills-{REVISION}':
                if self.tag is None:
                    raise ApiError(404)
                return {'object': {'type': 'commit', 'sha': self.tag}}
            if path == f'{BASE}/releases/tags/skills-{REVISION}':
                if self.release is None:
                    raise ApiError(404)
                return self.release
            if path == f'{BASE}/releases/1/assets?per_page=100&page=1':
                return [{'name': name, 'id': name} for name in self.assets]
            if path.startswith(f'{BASE}/releases/assets/'):
                if self.advance_during_download:
                    self.main = NEWER
                assert binary
                return self.assets[path.rsplit('/', 1)[1]]
            if path == f'{BASE}/contents/catalogue.json?ref=skill-downloads':
                if self.pointer is None:
                    raise ApiError(404)
                return {'sha': 'pointer-file-sha', 'content': base64.b64encode(self.pointer).decode()}
            if path == f'{BASE}/git/ref/heads/skill-downloads':
                if not self.branch:
                    raise ApiError(404)
                return {'object': {'type': 'commit', 'sha': 'branch-head'}}
            if path == f'{BASE}/compare/{OLDER}...{REVISION}':
                return {'status': self.comparison}
        if method == 'POST':
            if path == f'{BASE}/git/refs':
                if payload['ref'].startswith('refs/tags/'):
                    self.tag = payload['sha']
                else:
                    self.branch = True
                    self.pointer = self.pending_pointer
                return {'ref': payload['ref']}
            if path == f'{BASE}/releases':
                self.release = dict(payload, id=1)
                return self.release
            if path == f'{BASE}/git/blobs':
                self.pending_pointer = base64.b64decode(payload['content'])
                return {'sha': 'blob'}
            if path == f'{BASE}/git/trees':
                assert len(payload['tree']) == 1 and payload['tree'][0]['path'] == 'catalogue.json'
                return {'sha': 'tree'}
            if path == f'{BASE}/git/commits':
                assert payload['parents'] == []
                return {'sha': 'new-root-commit'}
        if method == 'PUT' and path == f'{BASE}/contents/catalogue.json':
            assert payload['sha'] == 'pointer-file-sha'
            if self.fail_pointer:
                raise ApiError(503)
            if self.race_pointer:
                raise ApiError(409)
            self.pointer = base64.b64decode(payload['content'])
            return {'commit': {'sha': 'updated'}}
        raise AssertionError((method, path, payload))


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.catalogue = export_fixture(self.directory)
        self.api = FakeApi()

    def run_publish(self):
        return publish(self.api, self.directory, REPOSITORY, REVISION)

    def old_pointer(self):
        value = copy.deepcopy(self.catalogue)
        value['sourceCommit'] = OLDER
        self.api.pointer = encoded(value)
        self.api.branch = True

    def test_first_publication_uploads_all_before_atomic_pointer_creation(self):
        self.assertEqual(self.run_publish(), 'published')
        self.assertEqual(self.api.pointer, (self.directory / 'catalogue.json').read_bytes())
        self.assertEqual(set(self.api.assets), {'catalogue.json', 'sample.zip', 'SHA256SUMS'})
        pointer_position = self.api.events.index(('POST', f'{BASE}/git/blobs'))
        downloads = [i for i, (_, path) in enumerate(self.api.events) if '/releases/assets/' in path]
        self.assertEqual(len(downloads), 3)
        self.assertLess(max(downloads), pointer_position)
        self.assertTrue(self.api.branch)

    def test_retry_after_partial_upload_finishes_without_replacing(self):
        self.api.fail_upload = 'sample.zip'
        with self.assertRaises(ApiError):
            self.run_publish()
        self.assertIsNone(self.api.pointer)
        self.assertEqual(set(self.api.assets), {'catalogue.json'})
        self.api.fail_upload = None
        self.assertEqual(self.run_publish(), 'published')
        self.assertEqual(self.api.events.count(('UPLOAD', 'catalogue.json')), 1)

    def test_retry_identical_does_not_upload_or_write_pointer(self):
        self.run_publish()
        self.api.events.clear()
        self.assertEqual(self.run_publish(), 'already published')
        self.assertFalse(any(method in ('UPLOAD', 'PUT', 'POST') for method, _ in self.api.events))

    def test_remote_mismatched_bytes_are_never_clobbered(self):
        self.run_publish()
        self.api.assets['sample.zip'] = b'changed'
        self.api.pointer = None
        self.api.branch = False
        self.api.events.clear()
        with self.assertRaisesRegex(ValueError, 'differs'):
            self.run_publish()
        self.assertIsNone(self.api.pointer)
        self.assertEqual(self.api.assets['sample.zip'], b'changed')
        self.assertFalse(any(method in ('UPLOAD', 'PUT', 'POST') for method, _ in self.api.events))

    def test_preview_and_local_tampering_fail_before_any_api(self):
        self.catalogue['preview'] = True
        (self.directory / 'catalogue.json').write_bytes(encoded(self.catalogue))
        with self.assertRaises(ValueError):
            self.run_publish()
        self.assertEqual(self.api.events, [])
        self.catalogue['preview'] = False
        (self.directory / 'catalogue.json').write_bytes(encoded(self.catalogue))
        (self.directory / 'sample.zip').write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            self.run_publish()
        self.assertEqual(self.api.events, [])

    def test_inner_file_digest_is_checked_even_if_zip_hash_matches(self):
        path = self.directory / 'sample.zip'
        with zipfile.ZipFile(io.BytesIO(path.read_bytes())) as archive:
            entries = {name: archive.read(name) for name in archive.namelist()}
        entries['sample/LICENSE'] = b'tampered'
        with zipfile.ZipFile(path, 'w') as archive:
            for name, data in entries.items():
                archive.writestr(name, data)
        self.catalogue['modules'][0]['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.catalogue['modules'][0]['bytes'] = path.stat().st_size
        (self.directory / 'catalogue.json').write_bytes(encoded(self.catalogue))
        with self.assertRaisesRegex(ValueError, 'file digest'):
            self.run_publish()
        self.assertEqual(self.api.events, [])

    def test_stale_main_run_has_no_mutations(self):
        self.api.main = NEWER
        self.assertIn('stale', self.run_publish())
        self.assertTrue(all(method == 'GET' for method, _ in self.api.events))

    def test_main_advances_during_upload_pointer_stays(self):
        self.old_pointer()
        before = self.api.pointer
        self.api.advance_during_download = True
        self.assertIn('stale', self.run_publish())
        self.assertEqual(self.api.pointer, before)
        self.assertEqual(len(self.api.assets), 3)

    def test_existing_pointer_advances_with_file_sha_only_after_assets(self):
        self.old_pointer()
        self.assertEqual(self.run_publish(), 'published')
        write = self.api.events.index(('PUT', f'{BASE}/contents/catalogue.json'))
        self.assertEqual(len([1 for _, p in self.api.events[:write] if '/releases/assets/' in p]), 3)

    def test_newer_pointer_never_rolls_back_and_divergence_blocks(self):
        self.old_pointer()
        before = self.api.pointer
        self.api.comparison = 'behind'
        self.assertIn('stale', self.run_publish())
        self.assertEqual(self.api.pointer, before)
        self.api.comparison = 'diverged'
        with self.assertRaisesRegex(ValueError, 'unrelated'):
            self.run_publish()
        self.assertEqual(self.api.pointer, before)

    def test_pointer_failure_retry_reuses_assets(self):
        self.old_pointer()
        before = self.api.pointer
        self.api.fail_pointer = True
        with self.assertRaises(ApiError):
            self.run_publish()
        self.assertEqual(self.api.pointer, before)
        uploads = [event for event in self.api.events if event[0] == 'UPLOAD']
        self.api.fail_pointer = False
        self.assertEqual(self.run_publish(), 'published')
        self.assertEqual([event for event in self.api.events if event[0] == 'UPLOAD'], uploads)

    def test_concurrent_pointer_change_fails_without_overwrite(self):
        self.old_pointer()
        before = self.api.pointer
        self.api.race_pointer = True
        with self.assertRaises(ApiError) as caught:
            self.run_publish()
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.api.pointer, before)

    def test_wrong_tag_and_malformed_existing_branch_fail_closed(self):
        self.api.tag = NEWER
        with self.assertRaisesRegex(ValueError, 'tag points'):
            self.run_publish()
        self.assertEqual(self.api.assets, {})
        self.api.tag = None
        self.api.branch = True
        with self.assertRaisesRegex(ValueError, 'lacks catalogue'):
            self.run_publish()
        self.assertIsNone(self.api.pointer)

    def test_existing_same_revision_different_catalogue_is_refused(self):
        self.run_publish()
        self.api.pointer = encoded(dict(self.catalogue, extra='altered'))
        with self.assertRaisesRegex(ValueError, 'different catalogue'):
            self.run_publish()

    def test_sums_cover_the_catalogue_and_archive_exactly(self):
        _, assets = load_assets(self.directory, REPOSITORY, REVISION)
        lines = assets['SHA256SUMS'].decode().splitlines()
        self.assertEqual(len(lines), 2)
        for line in lines:
            digest, name = line.split('  ')
            self.assertEqual(hashlib.sha256(assets[name]).hexdigest(), digest)

    def test_workflow_keeps_all_main_pushes_and_read_only_pull_requests(self):
        workflow = Path(__file__).resolve().parents[1] / '.github/workflows/skill-downloads.yml'
        text = workflow.read_text()
        push = text.split('  push:\n', 1)[1].split('\n\n', 1)[0]
        self.assertIn('branches: [main]', push)
        self.assertNotIn('paths:', push)
        self.assertIn('  pull_request:\n    paths:', text)
        self.assertIn('cancel-in-progress: false', text)
        self.assertIn("if: github.event_name == 'push' && github.ref == 'refs/heads/main'", text)
        self.assertIn('permissions:\n  contents: read', text)
        self.assertIn('GH_TOKEN: ${{ github.token }}', text)


if __name__ == '__main__':
    unittest.main()
