"""Read-only session activity projection. Never infer a delivered task from idle.
The Worker does not report harness heartbeats. No recent prompt, memory write,
or observer session status is treated as proof of a running user agent.
"""
import collections, hashlib, json, time

def enrich(snapshot,source,now=None):
    now=now or int(time.time()*1000)
    sessions=collections.defaultdict(list)
    for row in source.execute('SELECT id,platform_source,content_session_id,status,started_at_epoch,completed_at_epoch FROM sdk_sessions'):
        r=dict(row);sessions[(r['platform_source'],r['content_session_id'])].append(r)
    prompts=dict(source.execute('SELECT session_db_id,max(created_at_epoch) FROM user_prompts GROUP BY session_db_id'))
    tools=dict(source.execute('SELECT session_db_id,max(created_at_epoch) FROM tool_uses GROUP BY session_db_id'))
    counts=collections.Counter()
    for request in snapshot.get('humanRequests',[]):
        records=[]
        for key in request.get('conversationKeys',[]):
            try:
                parts=json.loads(key)
                if len(parts)==3 and parts[0]=='conversation':records.extend(sessions.get((parts[1],parts[2]),[]))
            except (ValueError,TypeError):pass
        last=max([r.get('completed_at_epoch') or 0 for r in records]+[prompts.get(r['id']) or 0 for r in records]+[tools.get(r['id']) or 0 for r in records]+[request.get('updatedAtEpoch') or 0])
        completed=all(r['status'] in ('completed','failed','cancelled','closed') for r in records) if records else False
        ended=max([r.get('completed_at_epoch') or 0 for r in records]+[0]) or None
        no_work=not request.get('items') and not request.get('activity')
        if completed:state='session-idle';label='Session idle';reason='The recorded worker session is completed; task delivery is not inferred.'
        elif no_work:state='recorded';label='Recorded only';reason='A request was saved, but no execution evidence is available.'
        elif last and now-last>15*60000:state='inactive';label='Inactive';reason='No recent activity and no live agent heartbeat.'
        else:state='unverified';label='Activity recorded';reason='Recent saved activity is not a live agent heartbeat.'
        request['bridgeRun']={'state':state,'label':label,'reason':reason,'lastActivityAt':last or None,'sessionCompletedAt':ended,'live':False}
        counts[state]+=1
    snapshot['bridgeActivity']={'version':2,'livePresenceAvailable':False,'confirmedActive':0,'counts':dict(counts)}
    # Force the mapper to observe metadata changes even when work-view content is unchanged.
    stamp=hashlib.sha256(json.dumps([(r['id'],r['bridgeRun']) for r in snapshot.get('humanRequests',[])],sort_keys=True).encode()).hexdigest()[:12]
    snapshot['revision']=str(snapshot.get('revision',''))+':activity-'+stamp
    return snapshot
