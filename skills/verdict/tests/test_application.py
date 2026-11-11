"""Application horizons and real-trial follow-through; isolated synthetic records only."""
import json
from pathlib import Path
import runpy
import tempfile
import unittest

HERE = Path(__file__).parent
legacy = runpy.run_path(str(HERE / 'test_evaluation.py'), run_name='application_fixtures')
index_fixtures = runpy.run_path(str(HERE / 'test_component_index.py'), run_name='index_fixtures')
checker = legacy['checker']
indexer = index_fixtures['indexer']


def application_record():
    record = legacy['record']()
    record.update(application_schema_version=1, checked_on='2026-11-10')
    record['usefulness']['components'][0].update(application_type='current', recommendation_timing='act-now', revisit_trigger='none')
    return record


def trial(state='proposed'):
    return dict(state=state, task='Parse three synthetic malformed imports',
                keep_criteria='Every failure identifies the row and retains all valid rows',
                drop_criteria='Any valid row is silently lost', review_on='2026-11-17')


class ApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.r = application_record()

    def errors(self):
        return checker.validate(self.r, self.root)

    def test_legacy_record_does_not_require_extension_or_trial(self):
        old = legacy['record']()
        old['whole_tool_decision'] = 'try'
        self.assertEqual(checker.validate(old, self.root), [])

    def test_current_application_and_nontry_no_trial(self):
        self.assertEqual(self.errors(), [])

    def test_reusable_without_fake_project(self):
        self.r['usefulness']['components'][0].update(application_type='reusable', projects=[],
            destination='', destination_unknown_reason='Reusable import diagnostics; no product selected',
            recommendation_timing='preserve', revisit_trigger='Next product with tabular imports')
        self.assertEqual(self.errors(), [])

    def test_future_needs_user_task_and_enabling_value(self):
        part = self.r['usefulness']['components'][0]
        part.update(application_type='future', future_scenario={'user':'Operations reviewer','task':'Correct rejected rows','enabling_value':'Fix data without calling a developer'})
        self.assertEqual(self.errors(), [])
        for field in ('user', 'task', 'enabling_value'):
            with self.subTest(field=field):
                old = part['future_scenario'].pop(field)
                self.assertTrue(any('future_scenario requires ' + field in e for e in self.errors()))
                part['future_scenario'][field] = old

    def test_preserve_and_defer_need_trigger(self):
        part = self.r['usefulness']['components'][0]
        for timing in ('preserve', 'defer'):
            part.update(recommendation_timing=timing, revisit_trigger='none')
            self.assertTrue(any('revisit_trigger' in e for e in self.errors()))
        part['revisit_trigger'] = 'When the next import project starts'
        self.assertEqual(self.errors(), [])

    def test_malformed_extension_fields_return_errors(self):
        part = self.r['usefulness']['components'][0]
        for field in ('application_type', 'recommendation_timing', 'revisit_trigger'):
            with self.subTest(field=field):
                original = part[field]
                part[field] = []
                self.assertTrue(self.errors())
                part[field] = original
        part.update(application_type='future', future_scenario=[])
        self.assertTrue(any('future_scenario must be an object' in e for e in self.errors()))
        self.r['application_schema_version'] = True
        self.assertTrue(any('application_schema_version' in e for e in self.errors()))

    def test_checked_date_required(self):
        self.r['checked_on'] = 'unknown'
        self.assertTrue(any('checked_on' in e for e in self.errors()))

    def test_try_requires_trial_and_proposed_passes(self):
        self.r['whole_tool_decision'] = 'try'
        self.assertTrue(any('trial object' in e for e in self.errors()))
        self.r['trial'] = trial()
        self.assertEqual(self.errors(), [])
        self.r['trial'] = []
        self.assertTrue(any('trial' in e for e in self.errors()))

    def test_nontry_cannot_claim_live_trial(self):
        self.r['trial'] = trial()
        self.assertTrue(any('proposed/active' in e for e in self.errors()))

    def test_malformed_trial_fields_report_errors(self):
        self.r.update(whole_tool_decision='try', trial=trial('active'))
        self.r['trial']['started_on'] = '2026-11-10'
        for field in ('state', 'task', 'review_on', 'started_on'):
            with self.subTest(field=field):
                original = self.r['trial'][field]
                self.r['trial'][field] = []
                self.assertTrue(self.errors())
                self.r['trial'][field] = original

    def test_trial_fields_and_active_start_are_required(self):
        self.r.update(whole_tool_decision='try', trial=trial('active'))
        self.assertTrue(any('started_on' in e for e in self.errors()))
        self.r['trial']['started_on'] = '2026-11-10'
        self.assertEqual(self.errors(), [])
        for field in ('task', 'keep_criteria', 'drop_criteria', 'review_on', 'state'):
            with self.subTest(field=field):
                old = self.r['trial'].pop(field)
                self.assertTrue(self.errors())
                self.r['trial'][field] = old

    def test_completed_trial_needs_result_dates_and_new_decision(self):
        self.r.update(whole_tool_decision='try', trial=trial('completed'))
        self.r['trial'].update(started_on='2026-11-10', ended_on='2026-11-12', result='One valid row lost; dropped whole tool')
        self.assertTrue(any('beyond try' in e for e in self.errors()))
        self.r['whole_tool_decision'] = 'skip'
        self.assertEqual(self.errors(), [])
        for field in ('result', 'started_on', 'ended_on'):
            old = self.r['trial'].pop(field)
            self.assertTrue(self.errors())
            self.r['trial'][field] = old
        self.r['trial']['ended_on'] = '2026-11-09'
        self.assertTrue(any('cannot precede' in e for e in self.errors()))

    def test_application_extension_does_not_weaken_adoption_or_integration(self):
        self.r['whole_tool_decision'] = 'adopt'
        errors = self.errors()
        self.assertTrue(any('safe runtime' in e for e in errors))
        self.assertTrue(any('independent review' in e for e in errors))

    def test_index_preserves_unassigned_horizons_dates_and_search(self):
        (self.root/'tools').mkdir()
        for horizon in ('reusable', 'future'):
            record = application_record()
            part = record['usefulness']['components'][0]
            part.update(application_type=horizon, recommendation_timing='preserve',
                        revisit_trigger='new supplier review product', projects=[], tags=['row diagnostics'],
                        destination='capabilities/imports', destination_unknown_reason='No current project selected',
                        future_scenario={'user':'Purchasing reviewer','task':'Review supplier files','enabling_value':'Explain failed rows'})
            (self.root/'tools'/f'{horizon}.json').write_text(json.dumps(record))
        result = indexer.filtered(indexer.build_index(self.root), ['2026-11-10'])
        self.assertEqual(len(result['components']), 2)
        self.assertEqual(set(result['pending_by_project']), {'Reusable — no project assigned', 'Future scenario — no project assigned'})
        for part in result['components']:
            self.assertEqual(part['projects'], [])
            self.assertEqual(part['checked_on'], '2026-11-10')
            self.assertNotIn('explicit projects', part['missing_followthrough'])
            self.assertEqual(part['recommendation_timing'], 'preserve')
            self.assertEqual(part['destination_unknown_reason'], 'No current project selected')
        rendered = indexer.markdown(result)
        self.assertIn('Purchasing reviewer', rendered)
        self.assertIn('new supplier review product', rendered)
        self.assertIn('checked 2026-11-10', rendered)
        self.assertEqual(len(indexer.filtered(indexer.build_index(self.root), ['Purchasing'])['components']), 2)
        self.assertEqual(indexer.filtered(indexer.build_index(self.root), project='capabilities')['components'], [])

    def test_trial_visible_without_components_and_malformed_warns(self):
        (self.root/'tools').mkdir()
        record = application_record()
        record.update(whole_tool_decision='try', trial=trial('active'))
        record['trial']['started_on'] = '2026-11-10'
        record['usefulness']['components'] = []
        (self.root/'tools/a.json').write_text(json.dumps(record))
        result = indexer.filtered(indexer.build_index(self.root), ['synthetic'])
        self.assertEqual(len(result['trials']), 1)
        self.assertEqual(result['trials'][0]['state'], 'active')
        self.assertIn('retains all valid rows', indexer.markdown(result))
        record['trial'] = []
        (self.root/'tools/a.json').write_text(json.dumps(record))
        result = indexer.filtered(indexer.build_index(self.root))
        self.assertEqual(result['trials'], [])
        self.assertTrue(any('Trial has unknown format' in w['problem'] for w in result['warnings']))


if __name__ == '__main__':
    unittest.main()
