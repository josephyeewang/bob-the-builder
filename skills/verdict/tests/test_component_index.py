import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'scripts/component-index.py'
spec = importlib.util.spec_from_file_location('component_index', SCRIPT)
indexer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(indexer)


def part(cid='labels', **values):
    item = dict(id=cid, kind='UI', decision='TAKE AND ADAPT', benefit='Keep labels visible while scrolling',
                before='Labels disappear', after='Labels remain visible', destination='OldViewer/styles.css',
                projects=['OldViewer'], tags=['sticky labels', 'wide tables'], next_action='Check overlap at corner',
                prerequisite='Authorized viewer work and browser test', capture={'state': 'captured', 'path': 'bundle'},
                integration={'state': 'not-integrated'}, source_evidence=['src/detail.css:3'])
    item.update(values)
    return item


def record(*parts, **values):
    item = dict(schema_version=2, tool='database-server', complete=True, whole_tool_decision='skip',
                source_revision='a'*40, usefulness={'components': list(parts)}, security={'findings': []})
    item.update(values)
    return item


def pain(pid='scrolling', **values):
    item = dict(id=pid, project='ReviewDesk', problem='Long tables lose row labels', basis='joe-stated',
                source='project/PROJECT-STATE.md:8', observed_on='2026-10-01', status='open',
                next_check='Reopen current viewer and status before proposing a fix')
    item.update(values)
    return item


class IndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root/'tools').mkdir()

    def save(self, name, data):
        (self.root/'tools'/name).write_text(json.dumps(data))

    def build(self, *queries, project=None):
        return indexer.filtered(indexer.build_index(self.root), queries, project)

    def test_recall_skipped_tool_visual_part_by_new_project_need(self):
        self.save('database-server.json', record(part()))
        result = self.build('wide tables', 'labels')
        self.assertEqual([r['identity'] for r in result['components']], ['database-server#labels'])
        self.assertTrue(result['components'][0]['pending'])
        self.assertEqual(result['components'][0]['projects'], ['OldViewer'])
        # A new dashboard can retrieve by need without pretending it was an old destination.
        self.assertEqual(self.build('wide tables', project='NewDashboard')['components'], [])

    def test_duplicate_ids_across_tools_remain_distinct(self):
        self.save('a.json', record(part(), tool='A'))
        self.save('b.json', record(part(), tool='B'))
        self.assertEqual([r['identity'] for r in self.build()['components']], ['a#labels', 'b#labels'])

    def test_duplicate_ids_within_record_preserved_with_warning(self):
        self.save('a.json', record(part(), part()))
        result = self.build()
        self.assertEqual(len(result['components']), 2)
        self.assertNotEqual(*[r['identity'] for r in result['components']])
        self.assertTrue(any('duplicate' in w['problem'] for w in result['warnings']))

    def test_literal_ordinal_like_ids_cannot_collide_with_duplicate_suffix(self):
        self.save('old.json',record(part('x'),part('x'),part('x@1')))
        identities=[p['identity'] for p in self.build()['components']]
        self.assertEqual(len(identities),len(set(identities)))
        pending=[i for group in self.build()['pending_by_project'].values() for i in group]
        self.assertEqual(len(pending),3)

    def test_partial_empty_sidecar_does_not_hide_old_visual_discovery(self):
        (self.root/'tools/old.md').write_text('Whole tool skipped; useful sticky table labels remain worth copying.')
        self.save('old.json',record(complete=False))
        result=self.build('sticky labels')
        self.assertEqual(result['legacy_matches'][0]['record'],'tools/old.md')
        self.assertEqual(result['components'],[])

    def test_partial_component_inventory_keeps_unmodeled_prose_searchable(self):
        (self.root/'tools/old.md').write_text('Hidden recovery interaction with inline explanation.')
        self.save('old.json',record(part('unrelated'),complete=False))
        result=self.build('recovery')
        self.assertEqual(result['legacy_matches'][0]['record'],'tools/old.md')

    def test_verified_part_is_searchable_not_pending(self):
        self.save('a.json', record(part(integration={'state':'verified'})))
        result = self.build('labels')
        self.assertEqual(len(result['components']), 1)
        self.assertEqual(result['pending_by_project'], {})

    def test_blocked_parts_and_applicable_material_repairs_remain_visible(self):
        self.save('a.json', record(part(capture={'state':'blocked','reason':'Permission unknown'}), security={'findings':[
            dict(severity='material', components=['labels'], resolved=False, evidence='src/write.py:2',
                 trigger='outside path', consequence='overwrite', repair='confine writes', verification='escape refused', remaining_risk='unpatched'),
            dict(severity='material', components=['other'], resolved=False, repair='unrelated')]}))
        item = self.build()['components'][0]
        self.assertEqual(item['capture']['reason'], 'Permission unknown')
        self.assertEqual(len(item['material_blockers']), 1)
        self.assertEqual(item['material_blockers'][0]['repair'], 'confine writes')
        self.assertTrue(item['pending'])

    def test_partial_unknown_and_legacy_records_warn(self):
        (self.root/'tools/old.md').write_text('Historical verdict not parsed or altered')
        (self.root/'tools/bad.json').write_text('{malformed')
        self.save('partial.json', record(part(next_action=''), complete=False))
        self.save('unknown.json', {'schema_version': 100, 'complete': False})
        result = self.build()
        self.assertEqual(result['coverage']['sidecars_found'], 3)
        self.assertEqual(result['coverage']['sidecars_loaded'], 2)
        self.assertEqual(result['coverage']['legacy_records_without_sidecar'], ['tools/old.md'])
        self.assertGreaterEqual(len(result['warnings']), 5)
        self.assertIn('next_action',result['components'][0]['missing_followthrough'])
        self.assertFalse(result['components'][0]['evaluation_complete'])

    def test_project_exact_match_and_inference_labeled(self):
        self.save('a.json', record(part(projects=['Toolkit']), part('other', projects=['Toolkitcat']),
                      part('inferred', projects=[], destination='/Users/fixture/Desktop/Toolkit/ui.css')))
        result = self.build(project='toolkit')
        self.assertEqual([p['component'] for p in result['components']], ['inferred', 'labels'])
        self.assertEqual(result['components'][0]['project_association'], 'destination-heuristic')
        self.assertIn('explicit projects', result['components'][0]['missing_followthrough'])

    def test_query_is_case_insensitive_and_terms_and(self):
        self.save('a.json', record(part()))
        self.assertEqual(len(self.build('WIDE LABELS')['components']),1)
        self.assertEqual(self.build('labels chart')['components'],[])

    def test_unknown_decision_is_investigation_pending_not_silent_drop(self):
        self.save('a.json', record(part(decision='new format')))
        result = self.build()
        self.assertTrue(result['components'][0]['pending'])
        self.assertTrue(any('Unknown component decision' in w['problem'] for w in result['warnings']))

    def test_symlink_sidecar_and_tool_dir_not_followed(self):
        (self.root/'outside.json').write_text(json.dumps(record(part())))
        (self.root/'tools/a.json').symlink_to(self.root/'outside.json')
        self.assertEqual(self.build()['components'],[])
        self.assertTrue(any('Symlinked sidecar' in w['problem'] for w in self.build()['warnings']))
        other=self.root/'other'
        other.mkdir()
        (other/'tools').symlink_to(self.root/'tools', target_is_directory=True)
        self.assertEqual(indexer.build_index(other)['components'],[])
        self.assertIn('Symlinked tool-record', indexer.build_index(other)['warnings'][0]['problem'])

    def test_stdout_search_does_not_write_and_generation_deterministic(self):
        self.save('a.json', record(part()))
        args=[sys.executable,str(SCRIPT),'--memory-root',str(self.root)]
        run=subprocess.run(args+['--stdout','--query','labels'],capture_output=True,text=True,check=True)
        self.assertEqual(len(json.loads(run.stdout)['components']),1)
        self.assertFalse((self.root/'component-index.json').exists())
        subprocess.run(args,capture_output=True,text=True,check=True)
        first=(self.root/'component-index.json').read_bytes()
        subprocess.run(args,capture_output=True,text=True,check=True)
        self.assertEqual(first,(self.root/'component-index.json').read_bytes())
        markdown=(self.root/'component-index.md').read_text()
        self.assertIn('OldViewer',markdown)
        self.assertIn('no authorization',markdown)

    def test_filtered_generation_cannot_replace_full_index(self):
        self.save('a.json', record(part()))
        run=subprocess.run([sys.executable,str(SCRIPT),'--memory-root',str(self.root),'--query','labels'],capture_output=True,text=True)
        self.assertNotEqual(run.returncode,0)
        self.assertFalse((self.root/'component-index.json').exists())

    def test_legacy_skipped_tool_ui_is_recalled_without_fake_states(self):
        path = self.root/'tools/database-server.md'
        original = '# Database server\nOverall call: skip.\nUseful UI: sticky labels keep row names visible in wide tables.\nHarvest was planned; no copy verified.\n'
        path.write_text(original)
        result = self.build('sticky labels', 'tables')
        self.assertEqual(result['components'], [])
        self.assertEqual(result['pending_by_project'], {})
        self.assertEqual(len(result['legacy_matches']), 1)
        match = result['legacy_matches'][0]
        self.assertEqual(match['record'], 'tools/database-server.md')
        self.assertIn('sticky labels', match['snippet'])
        self.assertIn('historical', match['basis'])
        for key in ('capture', 'integration', 'pending', 'verified', 'decision'):
            self.assertNotIn(key, match)
        self.assertEqual(path.read_text(), original)

    def test_legacy_projects_are_not_inferred_from_raw_mentions(self):
        (self.root/'tools/old.md').write_text('Toolkitcat had useful keyboard focus indicators; Toolkit never used it.')
        result = self.build('keyboard focus', project='Toolkit')
        self.assertEqual(result['components'], [])
        self.assertEqual(result['legacy_matches'][0]['project_association'], 'unverified')
        self.assertIn('not applied', result['legacy_search']['project_filter'])
        self.assertEqual(self.build(project='Toolkit')['legacy_matches'], [])

    def test_legacy_symlink_and_oversize_not_read_or_silently_absent(self):
        (self.root/'outside.md').write_text('sticky labels')
        (self.root/'tools/link.md').symlink_to(self.root/'outside.md')
        (self.root/'tools/large.md').write_bytes(b'x' * (indexer.MAX_RECORD_BYTES + 1))
        result = self.build('sticky labels')
        self.assertEqual(result['legacy_matches'], [])
        self.assertEqual(result['legacy_search']['searched_records'], 0)
        self.assertEqual(len(result['legacy_search']['skipped_records']), 2)

    def test_default_index_lists_legacy_references_without_copying_prose(self):
        (self.root/'tools/old.md').write_text('sticky labels historical prose')
        result = self.build()
        self.assertEqual(result['legacy_records'][0]['record'], 'tools/old.md')
        self.assertEqual(result['legacy_matches'], [])
        self.assertEqual(result['legacy_search']['searched_records'], 0)
        self.assertNotIn('historical prose', json.dumps(result))
        self.assertIn('Legacy Markdown is searchable on demand', indexer.markdown(result))

    def test_broken_sidecar_does_not_hide_historical_prose(self):
        (self.root/'tools/old.md').write_text('Useful keyboard focus rings in a skipped repository.')
        (self.root/'tools/old.json').write_text('{malformed')
        result = self.build('focus rings')
        self.assertEqual(result['components'], [])
        self.assertEqual(result['legacy_matches'][0]['record'], 'tools/old.md')
        self.assertTrue(any('unusable' in warning['problem'] for warning in result['warnings']))

    def test_pain_query_preserves_evidence_basis_and_not_component_status(self):
        self.save('old.json', record(project_context={'pains':[pain(),pain('guess', basis='inferred')], 'limitations':''}))
        result=self.build('row labels')
        self.assertEqual([p['basis'] for p in result['pains']],['inferred','joe-stated'])
        self.assertEqual(result['components'],[])
        self.assertEqual(result['pending_by_project'],{})
        self.assertEqual(len(result['pains_by_project']['ReviewDesk']),2)
        self.assertNotIn('capture',result['pains'][0])

    def test_pain_exact_project_filter_does_not_match_neighbor(self):
        self.save('old.json',record(project_context={'pains':[pain(project='Toolkit'),pain('other',project='Toolkitcat')]}))
        self.assertEqual([p['project'] for p in self.build(project='toolkit')['pains']],['Toolkit'])

    def test_resolved_pains_remain_visible_without_becoming_open_or_pending(self):
        self.save('old.json',record(project_context={'pains':[pain(status='resolved')]}))
        result=self.build()
        self.assertEqual(result['pains'][0]['status'],'resolved')
        self.assertFalse(result['pains'][0]['reported_open'])
        self.assertEqual(result['pending_by_project'],{})

    def test_pain_ids_and_projects_preserve_all_varying_entities(self):
        self.save('a.json',record(project_context={'pains':[pain('same'),pain('second'),pain('same',project='Other')]}))
        self.save('b.json',record(project_context={'pains':[pain('same')]}))
        items=self.build()['pains']
        self.assertEqual(len(items),4)
        self.assertEqual(len({p['identity'] for p in items}),4)

    def test_conflicting_pain_snapshots_are_retained_not_newest_date_winner(self):
        self.save('a.json',record(project_context={'pains':[pain()]}))
        self.save('b.json',record(project_context={'pains':[pain(status='resolved',observed_on='2026-11-01')]}))
        result=self.build()
        self.assertEqual(len(result['pains']),2)
        self.assertEqual({p['status'] for p in result['pains']},{'open','resolved'})
        self.assertTrue(any('observations differ' in w['problem'] for w in result['warnings']))

    def test_legacy_context_missing_is_a_coverage_gap_not_no_pains(self):
        self.save('old.json',record(part()))
        result=self.build()
        self.assertEqual(result['coverage']['records_without_project_context'],['tools/old.json'])
        self.assertTrue(any('Pain recall coverage incomplete' in w['problem'] for w in result['warnings']))

    def test_pain_survives_missing_component_inventory(self):
        self.save('old.json',dict(schema_version=2,project_context={'pains':[pain()]},checked_on='2026-11-01',source_revision='a'*40))
        result=self.build('row labels')
        self.assertEqual(len(result['pains']),1)
        self.assertEqual(result['pains'][0]['checked_on'],'2026-11-01')
        self.assertEqual(result['pains'][0]['source_revision'],'a'*40)

    def test_markdown_pain_rows_keep_origin_and_checked_date(self):
        self.save('a.json',record(project_context={'pains':[pain()],'limitations':'Source may have changed'},checked_on='2026-11-01'))
        rendered=indexer.markdown(self.build())
        self.assertIn('tools/a.json · checked 2026-11-01',rendered)
        self.assertIn('Source may have changed',rendered)

    def test_malformed_pain_fields_are_preserved_as_unknown_with_warning(self):
        self.save('old.json',record(project_context={'pains':[pain(basis='my-guess',status='done',observed_on='yesterday')]}))
        result=self.build()
        self.assertEqual(result['pains'][0]['basis'],'unknown')
        self.assertEqual(result['pains'][0]['status'],'unknown')
        self.assertIn('valid observed_on date',result['pains'][0]['missing_evidence'])

    def test_undated_observation_keeps_unknown_instead_of_inventing_today(self):
        self.save('old.json',record(project_context={'pains':[pain(observed_on='unknown')]}))
        item=self.build()['pains'][0]
        self.assertEqual(item['observed_on'],'unknown')
        self.assertNotIn('valid observed_on date',item['missing_evidence'])

    def test_unsupported_joe_stated_claim_lacks_basis_until_source_checked(self):
        self.save('old.json',record(project_context={'pains':[pain(source='')]}))
        item=self.build()['pains'][0]
        self.assertEqual(item['basis'],'unknown')
        self.assertEqual(item['reported_basis'],'joe-stated')

    def test_duplicate_and_delimiter_pain_ids_have_distinct_identities(self):
        self.save('old.json',record(project_context={'pains':[pain('x'),pain('x'),pain('x@1'),pain('x#p')]}))
        items=self.build()['pains']
        self.assertEqual(len({p['identity'] for p in items}),4)

    def test_malformed_context_does_not_crash_or_silently_claim_complete(self):
        self.save('old.json',record(project_context={'pains':'unknown'}))
        result=self.build()
        self.assertEqual(result['pains'],[])
        self.assertEqual(result['coverage']['records_with_malformed_project_context'],['tools/old.json'])


if __name__=='__main__':
    unittest.main()
