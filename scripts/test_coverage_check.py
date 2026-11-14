#!/usr/bin/env python3
"""Synthetic semantic-result regressions; no network or project data."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("coverage-check.py")
spec = importlib.util.spec_from_file_location("coverage_check", SCRIPT)
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class TaskResultTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.report = dict(schema="bob-task-result/v1", run_id="unique-run-2", subject="feed-freshness",
                           completed_at="2026-11-13T01:00:00Z", verdict="pass", exit_code=0)
        self.unit = dict(id="U1", state="covered", source="observed", files=["source.py"], checks=["freshness"],
                         run=dict(report="result.json", expected_run_id="unique-run-2",
                                  expected_subject="feed-freshness", not_before="2026-11-13T00:00:00Z"))

    def record(self):
        counts = {s: int(s == self.unit['state']) for s in checker.STATES[2:]}
        return dict(units=[self.unit], findings=[], statement=dict(planned=1, **counts))

    def write(self):
        (self.root / "result.json").write_text(json.dumps(self.report))

    def errors(self):
        self.write()
        return checker.check(self.record(), base_dir=self.root)

    def test_pass(self):
        self.assertEqual(self.errors(), [])

    def test_failed_zero_exit_report_is_not_covered(self):
        self.report['verdict'] = 'fail'
        self.assertTrue(self.errors())

    def test_incomplete_and_blocked_not_covered(self):
        for verdict in ('blocked', 'in_progress'):
            with self.subTest(verdict=verdict):
                self.report.update(verdict=verdict, completed_at=None, exit_code=None)
                self.assertTrue(self.errors())

    def test_honest_candidates_and_blocked(self):
        for state in ('candidate', 'blocked'):
            for verdict in ('fail', 'blocked', 'in_progress'):
                with self.subTest(state=state, verdict=verdict):
                    self.unit.update(state=state, missing_fact='await successful source check')
                    self.report.update(verdict=verdict, completed_at=None, exit_code=None)
                    self.assertEqual(self.errors(), [])

    def test_stale_completion(self):
        self.report['completed_at'] = '2026-11-12T23:59:59Z'
        self.assertTrue(self.errors())

    def test_future_completion(self):
        self.report['completed_at'] = '9999-01-01T00:00:00Z'
        self.assertTrue(self.errors())

    def test_deferred_cannot_hide_run_evidence(self):
        self.unit.update(state='deferred', files=[], checks=[], reason='later')
        self.assertTrue(any('partial work' in e for e in self.errors()))
        self.report.update(verdict='in_progress', completed_at=None, exit_code=None)
        self.assertTrue(any('partial work' in e for e in self.errors()))

    def test_unknown_run_fields_and_report_diagnostics(self):
        self.report['diagnostics'] = {'message': 'checked source'}
        self.assertEqual(self.errors(), [])
        self.unit['run']['expected_subjet'] = 'typo'
        self.assertTrue(self.errors())

    def test_wrong_run_or_subject(self):
        for field in ('run_id', 'subject'):
            with self.subTest(field=field):
                old = self.report[field]
                self.report[field] = 'different'
                self.assertTrue(self.errors())
                self.report[field] = old

    def test_missing_report_or_base(self):
        self.assertTrue(checker.check(self.record(), base_dir=self.root))
        self.write()
        self.assertTrue(checker.check(self.record()))

    def test_malformed_reports(self):
        original = copy.deepcopy(self.report)
        for field, values in dict(schema=[None, 'wrong'], verdict=[[], None, 'unknown'],
                                  completed_at=[None, 42, 'bad', '2026-11-13T01:00:00'],
                                  exit_code=[None, True, '0', 1]).items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.report = dict(original, **{field: value})
                    self.assertTrue(self.errors())
        for field in original:
            self.report = dict(original)
            del self.report[field]
            self.assertTrue(self.errors())
        for value in ([], None, 7):
            self.report = value
            self.assertTrue(self.errors())

    def test_malformed_run(self):
        original = copy.deepcopy(self.unit['run'])
        for field in original:
            for value in (None, [], '', 42):
                with self.subTest(field=field, value=value):
                    self.unit['run'] = dict(original, **{field: value})
                    self.assertTrue(self.errors())
        for value in ([], None, 'run'):
            self.unit['run'] = value
            self.assertTrue(self.errors())
        self.unit['run'] = dict(original, not_before='2026-11-13T00:00:00')
        self.assertTrue(self.errors())

    def test_safe_paths(self):
        for path in ('../result.json', '/tmp/result.json', './result.json', 'x/../result.json',
                     'x\\result.json', '.env.json', 'secrets/result.json', '.ssh/result.json',
                     'wallet.json', 'credentials.json', 'result.txt'):
            with self.subTest(path=path):
                self.unit['run']['report'] = path
                self.assertTrue(self.errors())

    def test_symlink_directory_file_and_nonregular(self):
        self.write()
        (self.root / 'linked.json').symlink_to(self.root / 'result.json')
        (self.root / 'linked-dir').symlink_to(self.root, target_is_directory=True)
        (self.root / 'directory.json').mkdir()
        os.mkfifo(self.root / 'pipe.json')
        for path in ('linked.json', 'linked-dir/result.json', 'directory.json', 'pipe.json'):
            self.unit['run']['report'] = path
            self.assertTrue(checker.check(self.record(), base_dir=self.root))

    def test_nested_report(self):
        self.write()
        (self.root / 'reports').mkdir()
        (self.root / 'result.json').rename(self.root / 'reports/result.json')
        self.unit['run']['report'] = 'reports/result.json'
        self.assertEqual(checker.check(self.record(), base_dir=self.root), [])

    def test_invalid_json_and_size_bound(self):
        for data in (b'bad', b'\xff', b' ' * (checker.MAX_REPORT_BYTES + 1)):
            (self.root / 'result.json').write_bytes(data)
            self.assertTrue(checker.check(self.record(), base_dir=self.root))

    def test_timezone_comparison(self):
        self.report['completed_at'] = '2026-11-12T19:00:00-06:00'
        self.assertEqual(self.errors(), [])

    def test_legacy_and_malformed_records(self):
        del self.unit['run']
        self.assertEqual(checker.check(self.record()), [])
        for record in (None, [], 1, {'units': [None]}, {'units': [{'id': [], 'state': []}]},
                       {'units': [self.unit], 'findings': [None]},
                       {'units': [dict(self.unit, source=[])], 'findings': [{'verdict': []}]}):
            with self.subTest(record=record):
                self.assertTrue(checker.check(record))

    def test_actual_cli(self):
        self.write()
        path = self.root / 'coverage.json'
        path.write_text(json.dumps(self.record()))
        def invoke():
            return subprocess.run([sys.executable, str(SCRIPT), str(path)], cwd='/', capture_output=True, text=True)
        self.assertEqual(invoke().returncode, 0)
        self.report['verdict'] = 'fail'
        self.write()
        self.assertEqual(invoke().returncode, 1)
        del self.unit['run']
        path.write_text(json.dumps(self.record()))
        self.assertIn('do not establish domain verdicts', invoke().stdout)
        path.write_text('null')
        result = invoke()
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
