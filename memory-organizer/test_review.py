import importlib.util,pathlib,sqlite3,sys,tempfile,unittest
ROOT=pathlib.Path(__file__).parent;sys.path.insert(0,str(ROOT))
import reviewer,lifecycle
class ReviewTests(unittest.TestCase):
 def test_validate_model_cannot_invent_or_duplicate_ids(self):
  rows=[{'key':'observation:1'}];data={'a':[['observation:1','p',.96,'direct evidence'],['observation:2','p',1,'fake'],['observation:1','q',.99,'duplicate']]}
  self.assertEqual(reviewer.validate_answer(data,rows,{'p'}),{'observation:1':('p',.96,'direct evidence')})
 def test_bad_confidence_and_unsupported_project_rejected(self):
  for val in [float('nan'),float('inf'),True,-1,2]:self.assertEqual(reviewer.validate_answer({'a':[['x','p',val,'reason']]},[{'key':'x'}],{'p'}),{})
  self.assertEqual(reviewer.validate_answer({'a':[['x','other',.95,'reason']]},[{'key':'x'}],{'p'}),{})
 def test_real_context_uses_local_turn_not_global_session_majority(self):
  ctx=({1:{'project':'General'}},{1:[(100,'Work on Conduit'),(500,'Switch to fonts')]},{1:[(150,'conduit','file transfer'),(550,'pingfang-one','font fix')]})
  c=reviewer.context_for({'session_db_id':1,'created_at_epoch':600},ctx)
  self.assertEqual(c['user_context'][-1],'Switch to fonts')
 def test_lifecycle_never_guesses_running_from_recent_prompt(self):
  db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
  db.executescript('CREATE TABLE sdk_sessions(id,platform_source,content_session_id,status,started_at_epoch,completed_at_epoch);CREATE TABLE user_prompts(session_db_id,created_at_epoch);CREATE TABLE tool_uses(session_db_id,created_at_epoch);INSERT INTO sdk_sessions VALUES(1,"pi","s","completed",100,900);INSERT INTO user_prompts VALUES(1,800);')
  snap={'revision':'x','humanRequests':[{'id':'q','conversationKeys':['["conversation","pi","s"]'],'items':[],'activity':[],'updatedAtEpoch':900}]}
  result=lifecycle.enrich(snap,db,1000);self.assertEqual(result['humanRequests'][0]['bridgeRun']['state'],'session-idle');self.assertFalse(result['humanRequests'][0]['bridgeRun']['live']);self.assertEqual(result['bridgeActivity']['confirmedActive'],0)
 def test_publication_refuses_changed_source_fingerprints(self):
  import organizer as core,publish_review
  before=core.STATE
  with tempfile.TemporaryDirectory() as directory:
   root=pathlib.Path(directory);core.STATE=root/'live';live=core.index_db();reviewer.prepare(live)
   rows=[('observation',i,'General','unclassified','review','pi','',1,'Example','Excerpt',100,.0,'needs-review','[]','h'+str(i),None) for i in (1,2)]
   live.executemany('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',rows);live.commit()
   stage_path=root/'stage.sqlite'
   with sqlite3.connect(stage_path) as target:live.backup(target)
   live.execute("UPDATE records SET source_hash='changed' WHERE id=2");live.commit();live.close()
   stage=sqlite3.connect(stage_path);stage.execute("UPDATE records SET project='general-reference',category='reference',method='context-reviewed'")
   for i in (1,2):stage.execute('INSERT INTO review_audit VALUES(?,?,?,?,?,?,?,?,?,?,?)',('observation',i,'h'+str(i),'test','unclassified','needs-review','general-reference',.95,'evidence','assigned','test'))
   stage.commit();stage.close()
   try:
    result=publish_review.publish(stage_path);self.assertEqual(result['published'],1);self.assertEqual(result['conflicts'],1)
    db=core.index_db();self.assertEqual(db.execute('SELECT project FROM records WHERE id=1').fetchone()[0],'general-reference');self.assertEqual(db.execute('SELECT project FROM records WHERE id=2').fetchone()[0],'unclassified');db.close()
   finally:core.STATE=before
 def test_audit_schema_is_separate_from_source(self):
  db=sqlite3.connect(':memory:');reviewer.prepare(db);self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='review_audit'").fetchone())
if __name__=='__main__':unittest.main()
