import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import hashlib


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / 'scripts' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


checker = load('check-evaluation')


def record():
    return dict(schema_version=2, tool='small-widget', complete=True, source_revision='a' * 40,
        context_evidence=['Project status and output examined'],
        coverage={'inspected': ['src/widget.py', 'tests/widget.py'], 'omitted': ['unrelated exporter']},
        alternative_search={'queries': ['bounded widget parser'], 'results': []},
        whole_tool_decision='skip', runtime={'status': 'not-tested'},
        usefulness={'conclusion': 'One reusable part inside an unsuitable tool.', 'components': [
            dict(id='widget', decision='TAKE AND ADAPT', reason='Handles boundary inputs.',
                 source_evidence=['src/widget.py:4'], benefit='Improve local parsing', destination='Project/parser',
                 supporting_files=['tests/widget.py', 'LICENSE'], capture={'state': 'blocked', 'reason': 'source clone unavailable'},
                 integration={'state': 'not-integrated'})]},
        security={'conclusion': 'Runtime untested.', 'checks': ['Static selected-path review'], 'findings': [], 'unknowns': ['Runtime']},
        qualitative={'conclusion': 'Insufficient public experience.', 'sources': [], 'limitations': 'No independent reports located.'})


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.r = record()

    def errors(self):
        return checker.validate(self.r, self.base)

    def test_skip_with_useful_part_and_blocked_capture_is_honest(self):
        self.assertEqual(self.errors(), [])

    def test_missing_reviews_need_limit_not_penalty(self):
        self.r['qualitative']['limitations'] = ''
        self.assertTrue(any('public feedback' in e for e in self.errors()))

    def test_missing_bundle_cannot_be_captured(self):
        self.r['usefulness']['components'][0]['capture'] = {'state': 'captured', 'path': 'missing'}
        self.assertTrue(any('invalid capture' in e for e in self.errors()))

    def test_existing_destination_does_not_prove_integration(self):
        (self.base / 'destination').mkdir()
        self.r['usefulness']['components'][0]['integration'] = {'state': 'verified'}
        self.assertTrue(any('behavior_receipt' in e for e in self.errors()))

    def test_unresolved_material_blocks_affected_integration(self):
        (self.base / 'mapping').write_text('source to destination mapping')
        (self.base / 'review').write_text('fresh review')
        self.r['independent_review_receipt'] = 'review'
        self.r['usefulness']['components'][0]['integration'] = {'state': 'integrated', 'mapping_receipt': 'mapping'}
        self.r['security']['findings'] = [dict(severity='material', evidence='parser:4', trigger='untrusted path',
            consequence='overwrite', components=['widget'], repair='confine path', verification='escape case refused',
            resolved=False, remaining_risk='not patched')]
        self.assertTrue(any('blocks integration' in e for e in self.errors()))

    def test_ours_better_requires_our_evidence(self):
        self.r['usefulness']['components'][0]['decision'] = 'OURS IS BETTER'
        self.assertTrue(any('our implementation' in e for e in self.errors()))

    def test_adoption_without_runtime_is_blocked(self):
        self.r['whole_tool_decision'] = 'adopt'
        self.assertTrue(any('safe runtime' in e for e in self.errors()))

    def test_partial_source_failure_is_recordable(self):
        self.r.update(complete=False, source_revision='', source_access_limits='download unavailable')
        self.r['context_evidence'] = []
        self.r['coverage']['inspected'] = []
        self.assertEqual(self.errors(), [])

    def test_idea_only_requires_specific_tradeoff(self):
        self.r['usefulness']['components'][0]['decision'] = 'TAKE THE IDEA, WRITE OUR OWN'
        self.assertTrue(any('idea-only' in e for e in self.errors()))

    def test_empty_inventory_needs_explanation(self):
        self.r['usefulness']['components'] = []
        self.assertTrue(any('no useful parts' in e for e in self.errors()))

    def test_tampered_captured_bytes_rejected(self):
        folder = self.base / 'bundle'
        (folder / 'originals').mkdir(parents=True)
        (folder / 'originals' / 'LICENSE').write_text('changed')
        (folder / 'manifest.json').write_text(json.dumps(dict(schema_version=1, license_reviewed=True,
            source_url='https://github.com/example/tool', revision='a' * 40,
            files=[dict(path='LICENSE', bytes=4, sha256='0' * 64)])))
        self.r['usefulness']['components'][0]['capture'] = {'state': 'captured', 'path': 'bundle'}
        self.assertTrue(any('original changed' in e for e in self.errors()))

    def test_capture_manifest_traversal_rejected_before_read(self):
        folder = self.base / 'bundle'
        folder.mkdir()
        (folder / 'manifest.json').write_text(json.dumps(dict(schema_version=1, license_reviewed=True,
            files=[dict(path='../outside', bytes=0, sha256='0' * 64)])))
        self.r['usefulness']['components'][0]['capture'] = {'state': 'captured', 'path': 'bundle'}
        self.assertTrue(any('invalid capture' in e for e in self.errors()))

    def make_bundle(self):
        folder = self.base / 'bundle'
        (folder / 'originals').mkdir(parents=True)
        files = []
        for name in ('LICENSE', 'method.py'):
            data = b'synthetic original'
            (folder / 'originals' / name).write_bytes(data)
            files.append(dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
        manifest = dict(schema_version=1, license_reviewed=True,
            source_url='https://github.com/example/tool', revision='a'*40, files=files)
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        self.r['usefulness']['components'][0]['capture'] = dict(state='captured', path='bundle',
            revision='a'*40, source_url=manifest['source_url'], source_files=['method.py'])
        return folder, manifest

    def test_valid_bundle_passes_with_provenance(self):
        self.make_bundle()
        self.assertEqual(self.errors(), [])

    def test_missing_manifest_provenance_is_rejected(self):
        folder, manifest = self.make_bundle()
        del manifest['revision']
        (folder / 'manifest.json').write_text(json.dumps(manifest))
        self.assertTrue(any('source revision' in e for e in self.errors()))

    def test_different_source_revision_is_rejected(self):
        self.make_bundle()
        self.r['source_revision'] = 'b'*40
        self.assertTrue(any('capture revision' in e for e in self.errors()))

    def test_missing_claimed_component_is_rejected(self):
        self.make_bundle()
        self.r['usefulness']['components'][0]['capture']['source_files'] = ['not-present.py']
        self.assertTrue(any('absent from capture' in e for e in self.errors()))

    def test_originals_symlink_is_rejected(self):
        folder, manifest = self.make_bundle()
        (folder / 'originals').rename(self.base / 'outside')
        (folder / 'originals').symlink_to(self.base / 'outside', target_is_directory=True)
        self.assertTrue(any('symlink' in e for e in self.errors()))

    def test_blocked_capture_cannot_be_verified_integration(self):
        for name in ('mapping', 'behavior', 'safety', 'attribution', 'review'):
            (self.base / name).write_text('synthetic receipt')
        self.r['independent_review_receipt'] = 'review'
        self.r['usefulness']['components'][0]['integration'] = dict(state='verified',
            mapping_receipt='mapping', behavior_receipt='behavior', safety_receipt='safety', attribution_receipt='attribution')
        self.assertTrue(any('requires validated capture' in e for e in self.errors()))

    def modern(self):
        self.r.update(opportunity_schema_version=1,request_mode='learn')
        self.r['alternative_search'] = {'queries': [], 'results': [], 'scope_reason': 'Focused source reuse; compare actual destination.'}
        self.r['visual_review'] = dict(applicability='user-facing', conclusion='Useful error message presentation, appearance not rendered.',
            evidence=[dict(kind='source',ref='src/widget.py:4')],opportunities=['widget'],limitations='Source only; no browser behavior tested.')
        self.r['usefulness']['components'][0].update(projects=['Project'],tags=['import','row errors'],
            before='Generic import failure',after='Names which row needs correction',adaptation_burden='Wire caller error handling',
            next_action='Run malformed-row cases in isolated destination tests',prerequisite='Authorized destination change and capture access')

    def test_targeted_learning_does_not_force_landscape_queries(self):
        self.modern()
        self.assertEqual(self.errors(), [])

    def test_new_opportunities_need_concrete_after_and_next_action(self):
        self.modern()
        del self.r['usefulness']['components'][0]['after']
        del self.r['usefulness']['components'][0]['next_action']
        errors=self.errors()
        self.assertTrue(any('after' in e for e in errors))
        self.assertTrue(any('next_action' in e for e in errors))

    def test_new_records_require_explicit_visual_assessment(self):
        self.modern()
        del self.r['visual_review']
        self.assertTrue(any('visual' in e.lower() for e in self.errors()))

    def test_inaccessible_ui_is_unknown_not_headless(self):
        self.modern()
        self.r['visual_review'] = dict(applicability='unknown',reason='Source screenshot unavailable',
            conclusion='Visual quality not assessed',evidence=[],opportunities=[],limitations='No accessible UI evidence')
        self.assertEqual(self.errors(), [])

    def test_visual_claims_need_evidence_kind_and_reference(self):
        self.modern()
        self.r['visual_review']['evidence'] = [{'kind':'screenshot','ref':''}]
        self.assertTrue(any('kind and reference' in e for e in self.errors()))

    def test_adoption_scope_requires_real_search_or_partial_status(self):
        self.modern()
        self.r['request_mode']='adopt'
        self.assertTrue(any('alternative search' in e for e in self.errors()))

    def test_malformed_nested_record_reports_error_without_crash(self):
        self.r['coverage']=[]
        self.assertIn('coverage must be an object',self.errors())

    def test_malformed_capture_reports_error_without_crash(self):
        self.r['usefulness']['components'][0]['capture']='captured'
        self.assertTrue(any('must be objects' in e for e in self.errors()))

    def test_malformed_integration_reports_error_without_crash(self):
        self.r['usefulness']['components'][0]['integration']=[]
        self.assertTrue(any('must be objects' in e for e in self.errors()))

    def contextual(self):
        self.modern()
        self.r.update(context_schema_version=1,checked_on='2026-11-01')
        self.r['project_context']=dict(pains=[dict(id='import-errors',project='Project',problem='Cannot identify failed import row',
            basis='joe-stated',source='project-status.md#reported-pain',observed_on='unknown',status='open')],limitations='')
        self.r['product_angle']=dict(claimed_angle='Help reviewers correct imports without debugging',
            delivered_behavior='Source names the failing row; runtime not tested',conclusion='Useful correction-first framing',
            evidence=['README.md#use-case','src/widget.py:4'],opportunities=['widget'],limitations='Demand not measured')

    def test_product_angle_and_sourced_pain_context_pass(self):
        self.contextual()
        self.assertEqual(self.errors(),[])

    def test_new_context_requires_product_angle_not_just_positive_reviews(self):
        self.contextual()
        del self.r['product_angle']
        self.assertTrue(any('product_angle' in e for e in self.errors()))

    def test_pain_requires_basis_status_source_and_honest_date(self):
        self.contextual()
        pain=self.r['project_context']['pains'][0]
        pain.update(basis='probably the user',source='',observed_on='yesterday')
        errors=self.errors()
        self.assertTrue(any('basis' in e for e in errors))
        self.assertTrue(any('source' in e for e in errors))
        self.assertTrue(any('observed_on' in e for e in errors))

    def test_missing_pain_context_is_explicit_not_invented(self):
        self.contextual()
        self.r['project_context']={'pains':[],'limitations':'No source for experienced pains available'}
        self.assertEqual(self.errors(),[])

    def test_conflicting_same_source_pain_observations_are_preserved(self):
        self.contextual()
        pain=copy.deepcopy(self.r['project_context']['pains'][0])
        pain.update(status='resolved',observed_on='2026-10-31')
        self.r['project_context']['pains'].append(pain)
        self.assertEqual(self.errors(),[])

    def test_recheck_must_compare_previous_and_current_evidence(self):
        self.contextual()
        self.r['request_mode']='recheck'
        self.assertTrue(any('prior/current' in e for e in self.errors()))
        self.r['recheck']=dict(previous_checked_on='2026-10-01',previous_revision='b'*40,
            changes='Error messages now name rows',decision_effect='Old blocker removed; inspect source for capture',
            evidence=['old.json','src/widget.py:4'])
        self.assertEqual(self.errors(),[])

    def test_product_angle_component_references_must_exist(self):
        self.contextual()
        self.r['product_angle']['opportunities']=['made-up-part']
        self.assertTrue(any('product-angle opportunity' in e for e in self.errors()))



if __name__ == '__main__':
    unittest.main()
