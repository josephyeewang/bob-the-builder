#!/usr/bin/env python3
"""Capture selected immutable Git blobs as untrusted evidence, never execute them.

License review is an operator attestation, not automated legal clearance. This helper
does not discover dependencies or decide whether the selected set is complete.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from urllib.parse import urlsplit

MAX_FILE_BYTES = 1024 * 1024
MAX_TOTAL_BYTES = 20 * MAX_FILE_BYTES
MAX_FILES = 4096
SENSITIVE_PARTS = {'.git', '.ssh', '.aws', '.bitcoin', '.ethereum', '.metamask',
                   '.coinbase', '.plaid', '.stripe', 'credentials', 'keychain',
                   'settings.json', 'settings.local.json', '.claude.json',
                   'login data', 'secrets', 'secrets.json', 'secrets.yaml',
                   'secrets.yml', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'}


def safe_path(value):
    """Validate names before looking up any object; never inspect secret contents."""
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value or any(ord(c) < 32 for c in value):
        raise ValueError('invalid source path')
    raw = value.split('/')
    if value.startswith('/') or any(p in ('', '.', '..') for p in raw):
        raise ValueError('source paths must be explicit relative files without traversal')
    lowered = [part.lower() for part in raw]
    if any(lowered[i:i + 2] in (['.config', 'plaid'], ['.config', 'stripe'])
           for i in range(len(lowered) - 1)):
        raise ValueError('refusing sensitive source path')
    for part in raw:
        lower = part.lower()
        if (lower in SENSITIVE_PARTS or lower == '.env' or lower.startswith('.env.')
                or 'cookie' in lower or 'wallet' in lower
                or lower.endswith(('.pem', '.key', '.p12', '.pfx', '.p8', '.keystore', '.kdbx'))
                or lower.endswith(('-password', '-password.txt'))):
            raise ValueError('refusing sensitive source path')
    return PurePosixPath(value).as_posix()


# Shared with the completion checker; one policy for capture and receipt validation.
validate_path = safe_path


def public_url(value):
    parsed = urlsplit(value)
    host = parsed.hostname or ''
    if (parsed.scheme != 'https' or not host or parsed.username or parsed.password
            or parsed.query or parsed.fragment or not parsed.path.strip('/')):
        raise ValueError('source URL must be an HTTPS repository URL without credentials or query')
    if host.lower() == 'localhost' or host.lower().endswith(('.local', '.localhost')):
        raise ValueError('source URL must identify a public repository')
    try:
        addr = ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        if not addr.is_global:
            raise ValueError('source URL must identify a public repository')
    return value.rstrip('/')


def git(repo, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
               GIT_OPTIONAL_LOCKS='0', GIT_TERMINAL_PROMPT='0',
               GIT_NO_LAZY_FETCH='1', GIT_ALLOW_PROTOCOL='')
    command = ['git', '--no-pager', '--no-replace-objects', '-c', 'core.fsmonitor=false',
               '-C', str(repo), *args]
    result = subprocess.run(command, capture_output=True, env=env, timeout=30)
    if result.returncode:
        # Don't echo Git's stderr: repository-controlled messages may contain secrets.
        raise ValueError('Git object lookup failed; confirm repository, revision and file selection')
    return result.stdout


def license_path(path):
    parts = PurePosixPath(path).parts
    name = parts[-1].lower()
    return (name in ('license', 'licence', 'copying', 'notice')
            or any(name.startswith(prefix + '.') for prefix in ('license', 'licence', 'copying', 'notice'))
            or any(part.lower() == 'licenses' for part in parts[:-1]))


def capture(repo, revision, source_url, output, files, license_reviewed=False):
    if not license_reviewed:
        raise ValueError('explicit --license-reviewed attestation is required')
    if not re.fullmatch(r'(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})', revision):
        raise ValueError('revision must be a full immutable commit hash')
    source_url = public_url(source_url)
    selected = [safe_path(p) for p in files]
    if not selected or len(selected) > MAX_FILES or len(selected) != len(set(selected)):
        raise ValueError('select at least one file and do not duplicate paths')
    if not any(license_path(p) for p in selected):
        raise ValueError('explicitly include applicable license/copying/notice files')
    repo = Path(repo).resolve(strict=True)
    root = Path(os.fsdecode(git(repo, 'rev-parse', '--show-toplevel')).strip()).resolve(strict=True)
    if root != repo:
        raise ValueError('--repo must name the repository root')
    commit = git(repo, 'rev-parse', '--verify', revision + '^{commit}').decode('ascii').strip()
    if commit != revision.lower():
        raise ValueError('revision does not identify the exact commit')
    output = Path(output).absolute()
    if os.path.lexists(output):
        raise ValueError('output already exists; refusing overwrite')
    # Use an existing parent; no implicit directory creation through uncontrolled links.
    parent = output.parent.resolve(strict=True)
    output = parent / output.name
    if output == root or root in output.parents:
        raise ValueError('output must be outside the source worktree')
    blobs = []
    total = 0
    for path in selected:
        raw = git(repo, 'ls-tree', '-z', commit, '--', path)
        entries = [entry for entry in raw.split(b'\0') if entry]
        if len(entries) != 1:
            raise ValueError('selected file is missing or ambiguous')
        metadata, found = entries[0].split(b'\t', 1)
        mode, kind, oid = metadata.decode('ascii').split()
        if os.fsdecode(found) != path or mode not in ('100644', '100755') or kind != 'blob':
            raise ValueError('only ordinary tracked files are allowed, not links or submodules')
        # Reject symlinked ancestors too, even though Git tree lookup does not follow them.
        ancestors = list(PurePosixPath(path).parents)[:-1]
        for ancestor in ancestors:
            ancestor_raw = git(repo, 'ls-tree', '-z', commit, '--', str(ancestor))
            if not ancestor_raw.startswith(b'040000 tree '):
                raise ValueError('source ancestors must be ordinary Git directories')
        size = int(git(repo, 'cat-file', '-s', oid).decode('ascii').strip())
        total += size
        if size > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
            raise ValueError('capture exceeds file or total size limit')
        content = git(repo, 'cat-file', 'blob', oid)
        if len(content) != size:
            raise ValueError('source blob length changed unexpectedly')
        blobs.append((path, content, mode))
    manifest = {'schema_version': 1, 'source_url': source_url, 'revision': commit,
                'license_reviewed': True, 'files': []}
    # No mutation until every requested source is validated and in memory.
    output.mkdir()  # Atomic reservation: fails if any file/link/directory appeared meanwhile.
    originals = output / 'originals'
    originals.mkdir()
    for path, content, mode in blobs:
        target = originals / path
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as handle:
            handle.write(content)
        # Preserve original permissions as metadata, not executability on the host.
        manifest['files'].append({'path': path, 'sha256': hashlib.sha256(content).hexdigest(),
                                  'bytes': len(content), 'mode': mode})
    with (output / 'manifest.json').open('x', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2)
        handle.write('\n')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--source-url', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--license-reviewed', action='store_true')
    parser.add_argument('--file', dest='files', action='append', required=True)
    args = parser.parse_args()
    try:
        manifest = capture(args.repo, args.revision, args.source_url, args.output,
                           args.files, args.license_reviewed)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print('Capture blocked: ' + str(error), file=sys.stderr)
        return 1
    print('Captured selected originals; evidence only, not integrated or security-cleared.')
    print(str(Path(args.output) / 'manifest.json'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
