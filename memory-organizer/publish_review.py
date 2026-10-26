#!/usr/bin/env python3
"""Publish reviewed metadata with source-fingerprint conflict checks.
Only organizer databases are opened writable; raw Claude-mem data is untouched.
"""
import argparse, pathlib, sqlite3
import organizer as core
from reviewer import prepare

def publish(stage_path):
    stage_path=pathlib.Path(stage_path).resolve();live=(core.STATE/'catalog.sqlite').resolve()
    if stage_path==live:raise ValueError('Staging index must be separate from live index')
    if not stage_path.is_file():raise ValueError('Missing staging catalogue')
    db=core.index_db();prepare(db)
    db.execute('ATTACH DATABASE ? AS staged',(stage_path.as_uri()+'?mode=ro',))
    tax=core.Taxonomy();bad=[r[0] for r in db.execute("SELECT DISTINCT project FROM staged.records WHERE method IN ('context-reviewed','context-insufficient')") if r[0] not in tax.projects]
    if bad:raise ValueError('Reviewed project is outside the configured taxonomy')
    try:
        db.execute('BEGIN IMMEDIATE')
        target=db.execute("SELECT count(*) FROM staged.records WHERE method IN ('context-reviewed','context-insufficient')").fetchone()[0]
        matched=db.execute("""SELECT count(*) FROM records r JOIN staged.records s ON r.kind=s.kind AND r.id=s.id AND r.source_hash=s.source_hash
           WHERE s.method IN ('context-reviewed','context-insufficient')""").fetchone()[0]
        db.execute("""UPDATE records SET
           project=s.project,category=s.category,confidence=s.confidence,method=s.method,proposed_project=s.proposed_project
           FROM staged.records s WHERE records.kind=s.kind AND records.id=s.id AND records.source_hash=s.source_hash
           AND s.method IN ('context-reviewed','context-insufficient')""")
        db.execute("""INSERT OR REPLACE INTO review_audit SELECT a.* FROM staged.review_audit a
          JOIN records r ON r.kind=a.kind AND r.id=a.id AND r.source_hash=a.source_hash""")
        distinct=db.execute('SELECT count(*) FROM (SELECT kind,id FROM review_audit GROUP BY kind,id)').fetchone()[0]
        result={'reviewed_records':distinct,'published':matched,'conflicts':target-matched,
                'remaining_unassigned':db.execute("SELECT count(*) FROM records WHERE project='unclassified'").fetchone()[0],
                'source_records_modified':0}
        db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',('review_progress',core.dumps({'state':'complete' if target==matched else 'partial','target':target,'reviewed':distinct,'assigned':matched,'conflicts':target-matched})))
        db.execute('INSERT INTO operations(at,kind,payload) VALUES(?,?,?)',(core.utc(),'publish-context-review',core.dumps(result)))
        db.commit();return result
    except Exception:
        db.rollback();raise
    finally:db.close()

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('stage');a=p.parse_args();print(core.dumps(publish(a.stage)))
