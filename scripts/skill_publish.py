#!/usr/bin/env python3
"""Publish verified immutable skill assets, then advance the public catalogue.

Transport uses gh's existing GITHUB_TOKEN/GH_TOKEN authentication. This program
never creates credentials, replaces assets, deletes releases, or force-pushes.
"""
import argparse
import base64
import hashlib
import io
import json
import re
import subprocess
import zipfile
from http import HTTPStatus
from pathlib import Path


class ApiError(RuntimeError):
    def __init__(self, status, message='GitHub request failed', cli_exit=None):
        details = f'HTTP {status}' if status is not None else 'no HTTP status'
        if status is not None:
            try:
                details += f': {HTTPStatus(status).phrase}'
            except ValueError:
                pass
        if cli_exit is not None:
            details += f'; CLI exit {cli_exit}'
        super().__init__(f'{message} ({details})')
        self.status = status


def gh_error(result, operation):
    """Retain status without reflecting raw CLI/server messages or auth data."""
    match = re.search(rb'\bHTTP[ /](\d{3})\b', result.stderr)
    return ApiError(int(match[1]) if match else None, operation, result.returncode)


class Gh:
    def api(self, method, path, payload=None, binary=False):
        command = ['gh', 'api', '--method', method, path]
        if binary:
            command += ['-H', 'Accept: application/octet-stream']
        if payload is not None:
            command += ['--input', '-']
        result = subprocess.run(command, input=json.dumps(payload).encode() if payload is not None else None,
                                capture_output=True)
        if result.returncode:
            raise gh_error(result, 'GitHub API request failed')
        return result.stdout if binary else json.loads(result.stdout or b'null')

    def upload(self, repository, release_id, name, data):
        # gh cannot infer a pipe's byte count. Release uploads require an exact
        # Content-Length; otherwise gh 2.97.0 sends chunked stdin without it.
        path = f'https://uploads.github.com/repos/{repository}/releases/{release_id}/assets?name={name}'
        result = subprocess.run(['gh', 'api', '--method', 'POST', path,
                                 '-H', 'Content-Type: application/octet-stream',
                                 '-H', f'Content-Length: {len(data)}', '--input', '-'],
                                input=data, capture_output=True)
        if result.returncode:
            raise gh_error(result, 'Release asset upload failed; retry is safe')
        return json.loads(result.stdout)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def load_assets(directory, repository, revision):
    directory = Path(directory)
    catalogue_bytes = (directory / 'catalogue.json').read_bytes()
    catalogue = json.loads(catalogue_bytes)
    if (catalogue.get('schemaVersion') != 1 or catalogue.get('preview') is not False or
            catalogue.get('repository') != repository or catalogue.get('sourceCommit') != revision):
        raise ValueError('Only a matching committed non-preview export can be published')
    assets = {'catalogue.json': catalogue_bytes}
    modules = catalogue['modules']
    if not modules:
        raise ValueError('Empty catalogue')
    for module in modules:
        name = module['id']
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name) or f'{name}.zip' in assets:
            raise ValueError('Invalid/duplicate module id')
        expected = f'https://github.com/{repository}/releases/download/skills-{revision}/{name}.zip'
        if module['sourceCommit'] != revision or module['download'] != expected:
            raise ValueError('Module source/download mismatch')
        data = (directory / f'{name}.zip').read_bytes()
        if sha(data) != module['sha256'] or len(data) != module['bytes']:
            raise ValueError(f'Archive digest/size mismatch: {name}')
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            names = archive.namelist()
            receipt_name = f'{name}/module.json'
            if len(names) != len(set(names)):
                raise ValueError('Duplicate archive paths')
            receipt = json.loads(archive.read(receipt_name))
            if (receipt.get('schemaVersion') != 1 or receipt.get('preview') is not False or
                    receipt.get('sourceCommit') != revision or receipt.get('repository') != repository or
                    receipt.get('id') != name):
                raise ValueError('Archive source receipt mismatch')
            files = receipt['files']
            if not {'SKILL.md', 'LICENSE', 'INSTALL.md'} <= files.keys():
                raise ValueError('Archive missing entrypoint/license/install guide')
            if set(names) != {receipt_name} | {f'{name}/{p}' for p in files}:
                raise ValueError('Archive receipt coverage mismatch')
            for path, digest in files.items():
                if (not path or path.startswith('/') or '\\' in path or
                        any(p in ('', '.', '..') for p in path.split('/'))):
                    raise ValueError('Unsafe archive path')
                if sha(archive.read(f'{name}/{path}')) != digest:
                    raise ValueError('Archive file digest mismatch')
        assets[f'{name}.zip'] = data
    # A human/tool-readable receipt covers the exact catalogue and archive bytes.
    assets['SHA256SUMS'] = ''.join(f'{sha(data)}  {name}\n' for name, data in sorted(assets.items())).encode()
    return catalogue, assets


def optional(api, path):
    try:
        return api.api('GET', path)
    except ApiError as error:
        if error.status == 404:
            return None
        raise


def ref_commit(api, base, ref):
    value = api.api('GET', f'{base}/git/ref/{ref}')['object']
    for _ in range(8):
        if value['type'] == 'commit':
            return value['sha']
        if value['type'] != 'tag':
            break
        value = api.api('GET', f'{base}/git/tags/{value["sha"]}')['object']
    raise ValueError('Unsupported Git ref target')


def publish(api, directory, repository, revision):
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Invalid repository')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('A full source commit is required')
    catalogue, assets = load_assets(directory, repository, revision)
    base = f'repos/{repository}'
    # A queued old main run is not allowed to publish or move the pointer back.
    if ref_commit(api, base, 'heads/main') != revision:
        return 'stale: main has advanced; no publication'
    tag = f'skills-{revision}'
    tag_path = f'{base}/git/ref/tags/{tag}'
    if optional(api, tag_path) is None:
        try:
            api.api('POST', f'{base}/git/refs', {'ref': f'refs/tags/{tag}', 'sha': revision})
        except ApiError as error:
            if error.status != 422:
                raise
    if ref_commit(api, base, f'tags/{tag}') != revision:
        raise ValueError('Immutable tag points at different source')
    release = optional(api, f'{base}/releases/tags/{tag}')
    if release is None:
        try:
            release = api.api('POST', f'{base}/releases', {
                'tag_name': tag, 'target_commitish': revision, 'name': tag,
                'draft': False, 'prerelease': False, 'make_latest': 'false'})
        except ApiError as error:
            if error.status != 422:
                raise
            release = api.api('GET', f'{base}/releases/tags/{tag}')
    if release.get('draft') or release.get('prerelease'):
        raise ValueError('Existing release is not a normal published release')
    release_id = release['id']
    existing = []
    page = 1
    while True:
        rows = api.api('GET', f'{base}/releases/{release_id}/assets?per_page=100&page={page}')
        existing.extend(rows)
        if len(rows) < 100:
            break
        page += 1
    if len({row['name'] for row in existing}) != len(existing) or any(row['name'] not in assets for row in existing):
        raise ValueError('Unexpected/duplicate assets on immutable release')
    by_name = {row['name']: row for row in existing}
    for name, data in assets.items():
        asset = by_name.get(name)
        if asset is None:
            asset = api.upload(repository, release_id, name, data)
        if asset.get('name') != name:
            raise ValueError('Upload returned wrong asset')
        actual = api.api('GET', f'{base}/releases/assets/{asset["id"]}', binary=True)
        if actual != data:
            raise ValueError(f'Immutable release asset differs: {name}; never overwritten')
    # Only after ALL remote asset bytes pass can a public pointer change.
    if ref_commit(api, base, 'heads/main') != revision:
        return 'stale: assets preserved; catalogue pointer unchanged'
    branch = 'skill-downloads'
    current = optional(api, f'{base}/contents/catalogue.json?ref={branch}')
    content = assets['catalogue.json']
    if current is not None:
        previous_bytes = base64.b64decode(current['content'])
        previous = json.loads(previous_bytes)
        if previous.get('repository') != repository or previous.get('preview') is not False:
            raise ValueError('Existing catalogue pointer is not trusted')
        previous_revision = previous['sourceCommit']
        if not re.fullmatch(r'[0-9a-f]{40}', previous_revision):
            raise ValueError('Invalid previous source commit')
        if previous_revision == revision:
            if previous_bytes != content:
                raise ValueError('Same revision has different catalogue bytes')
            return 'already published'
        comparison = api.api('GET', f'{base}/compare/{previous_revision}...{revision}')
        if comparison['status'] == 'behind':
            return 'stale: pointer already newer'
        if comparison['status'] != 'ahead':
            raise ValueError('Cannot advance catalogue across unrelated source history')
        api.api('PUT', f'{base}/contents/catalogue.json', {
            'branch': branch, 'sha': current['sha'], 'message': f'Skill downloads from {revision}',
            'content': base64.b64encode(content).decode()})
    else:
        # Only a genuinely absent branch may be bootstrapped; never overwrite a
        # malformed existing branch. Root commit contains catalogue.json only.
        if optional(api, f'{base}/git/ref/heads/{branch}') is not None:
            raise ValueError('Existing catalogue branch lacks catalogue.json')
        blob = api.api('POST', f'{base}/git/blobs', {
            'content': base64.b64encode(content).decode(), 'encoding': 'base64'})
        tree = api.api('POST', f'{base}/git/trees', {'tree': [
            {'path': 'catalogue.json', 'mode': '100644', 'type': 'blob', 'sha': blob['sha']}]})
        commit = api.api('POST', f'{base}/git/commits', {
            'message': f'Skill downloads from {revision}', 'tree': tree['sha'], 'parents': []})
        api.api('POST', f'{base}/git/refs', {'ref': f'refs/heads/{branch}', 'sha': commit['sha']})
    return 'published'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True, type=Path)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--source-sha', required=True)
    args = parser.parse_args()
    try:
        print(publish(Gh(), args.directory, args.repository, args.source_sha))
    except (ValueError, KeyError, OSError, ApiError, zipfile.BadZipFile) as error:
        parser.exit(1, f'Publication refused: {error}\n')
