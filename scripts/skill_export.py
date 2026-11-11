#!/usr/bin/env python3
"""Build deterministic standalone skills from an explicit public file registry."""
import argparse
import hashlib
import io
import json
import re
import stat
import subprocess
import zipfile
from pathlib import Path, PurePosixPath


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def safe_path(value):
    p = PurePosixPath(value)
    if not value or '\\' in value or ':' in value or p.is_absolute() or str(p) != value or any(x in ('', '.', '..') or x.startswith('.') for x in p.parts):
        raise ValueError(f'Unsafe public path: {value}')
    if any(x.lower() in ('evolutions', 'captures', 'history', 'node_modules', '__pycache__') or
           'password' in x.lower() or x.lower().endswith(('.pem', '.key', '.pyc')) for x in p.parts):
        raise ValueError(f'Private/generated path cannot be exported: {value}')
    return p


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args])


def read_source(root, source, revision, working):
    p = safe_path(source)
    if working:
        current = root
        for part in p.parts:
            current = current / part
            if current.is_symlink():
                raise ValueError(f'Symlink cannot be exported: {source}')
        if not current.is_file():
            raise ValueError(f'Missing export source: {source}')
        return current.read_bytes(), bool(current.stat().st_mode & stat.S_IXUSR)
    row = git(root, 'ls-tree', revision, '--', source).decode().strip()
    if not row or row.split()[0] not in ('100644', '100755'):
        raise ValueError(f'Source is not a tracked regular file: {source}')
    return git(root, 'show', f'{revision}:{source}'), row.split()[0] == '100755'


def build(root, output, working=False):
    root, output = Path(root).resolve(), Path(output).resolve()
    if root == output or output in root.parents or (output.is_relative_to(root) and not any(x in ('.audit', '.claude') for x in output.relative_to(root).parts)):
        raise ValueError('Output must be outside source or under .audit/.claude')
    revision = git(root, 'rev-parse', 'HEAD').decode().strip()
    registry = json.loads(read_source(root, 'skills/exports.json', revision, working)[0])
    if registry['schemaVersion'] != 1 or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', registry['repository']):
        raise ValueError('Unsupported registry/repository')
    repository = registry['repository']
    modules = registry['modules']
    ids = [m['id'] for m in modules]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate module id')
    result, archives = [], []
    for module in modules:
        name = module['id']
        if not re.fullmatch(r'[a-z][a-z0-9-]*', name):
            raise ValueError('Invalid module id')
        files = module['files']
        if not files or len(files) != len(set(files)):
            raise ValueError(f'Empty/duplicate file list: {name}')
        payload = {}
        for relative in files:
            safe_path(relative)
            data, executable = read_source(root, f'skills/{name}/{relative}', revision, working)
            if re.search(rb'(?i)(/Users/[^/\s]+/|99\.0 Claude Sync|\.claude/projects/)', data):
                raise ValueError(f'Personal installation context in {name}/{relative}')
            payload[relative] = (data, executable)
        if 'SKILL.md' not in payload:
            raise ValueError(f'No entrypoint: {name}')
        for dependency in module.get('optionalModules', []):
            if dependency not in ids or dependency == name:
                raise ValueError(f'Invalid optional module dependency: {name}: {dependency}')
        for destination, source in module.get('notices', {}).items():
            safe_path(destination)
            if destination in payload:
                raise ValueError(f'Notice collision: {destination}')
            if source != 'LICENSE' and not source.startswith('third_party/'):
                raise ValueError('External notice must come from LICENSE or third_party/')
            payload[destination] = read_source(root, source, revision, working)
        if 'LICENSE' not in payload:
            raise ValueError(f'No license in {name}')
        if 'INSTALL.md' in payload or 'module.json' in payload:
            raise ValueError('INSTALL.md/module.json are generated, not module inputs')
        install = f'''# {module['title']}

Extract this folder anywhere you keep AI skills. Read SKILL.md with your
assistant, or register this folder using your assistant's supported skill mechanism.
No Bob installation or personal machine setup is required. Respect your own
project instructions and approval rules. Refer to SKILL.md for runtime requirements
and optional tools. Paths in the skill are relative to this extracted folder.

This is a versioned snapshot. To update, download a newer package and review its
changes before replacing your installed folder. Your own notes and private context
belong outside the skill folder. Optional companion modules: {', '.join(module.get('optionalModules', [])) or 'none'}.
'''
        payload['INSTALL.md'] = (install.encode(), False)
        receipt = {'schemaVersion': 1, 'id': name, 'sourceCommit': revision,
                   'preview': working, 'repository': repository,
                   'files': {p: digest(data) for p, (data, _) in sorted(payload.items())}}
        payload['module.json'] = (encoded(receipt), False)
        tag, asset = f'skills-{revision}', f'{name}.zip'
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for p, (data, executable) in sorted(payload.items()):
                info = zipfile.ZipInfo(f'{name}/{p}', (1980, 1, 1, 0, 0, 0))
                info.create_system = 3
                info.external_attr = (0o100755 if executable else 0o100644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        content = buffer.getvalue()
        archives.append((asset, content))
        result.append({'id': name, 'title': module['title'], 'summary': module['summary'],
                       'origin': module['origin'], 'sha256': digest(content), 'bytes': len(content),
                       'sourceCommit': revision,
                       'source': f'https://github.com/{repository}/tree/{revision}/skills/{name}',
                       'download': f'https://github.com/{repository}/releases/download/{tag}/{asset}',
                       'optionalModules': module.get('optionalModules', [])})
    catalogue = {'schemaVersion': 1, 'repository': repository, 'sourceCommit': revision,
                 'preview': working, 'modules': result}
    output.mkdir(parents=True, exist_ok=True)
    for asset, content in archives:
        (output / asset).write_bytes(content)
    (output / 'catalogue.json').write_bytes(encoded(catalogue))
    return catalogue


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--working-tree', action='store_true', help='Local preview only; cannot publish')
    args = parser.parse_args()
    try:
        catalogue = build(args.root, args.output, args.working_tree)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Export refused: {error}\n')
    print(f"Built {len(catalogue['modules'])} skill packages ({'preview' if args.working_tree else catalogue['sourceCommit']})")
