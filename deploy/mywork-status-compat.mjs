/** Display-only correction; never marks tasks as shipped or edits source memory. */
const V1='/* central-memory-bridges:truthful-mywork-status:v1 */';
export const STATUS_MARKER='/* central-memory-bridges:truthful-mywork-status:v2 */';
export function applyRequestActivity(raw,request,now=Date.now()) {
  const state=raw.bridgeRun;
  if(request.state==='working'||request.state==='idle') {
    request.state='idle';
    request.bridgeStatus=state?.label||(!raw.items?.length?'Recorded only':'No live status');
    request.bridgeStatusReason=state?.reason||'Recorded activity is not proof of a running agent.';
    if(!raw.progress && !raw.lifecycle?.explicit) request.stage='Not reviewed';
  }
  const last=state?.lastActivityAt||raw.updatedAtEpoch;
  if(last) {
    const minutes=Math.max(0,Math.floor((now-last)/60000));
    request.runningFor=minutes<1?'Just now':minutes<60?`${minutes} min ago`:minutes<1440?`${Math.floor(minutes/60)} hr ago`:`${Math.floor(minutes/1440)} days ago`;
  } else request.runningFor='Not recorded';
  return request;
}
export function patchMyWorkStatus(source) {
  if(source.includes(STATUS_MARKER))return source;
  source=source.replace(V1,'').replace('idle:`\u672a\u786e\u8ba4 / \u5386\u53f2`','idle:`Idle`')
    .replace('working:`\u8fdb\u884c\u4e2d\uff08\u8bb0\u5f55\uff09`,"needs-check"','working:`Working`,"needs-check"')
    .replace('children:`\u7ecf\u8fc7\u65f6\u95f4`','children:`Running`');
  if(!source.includes('case`unknown`'))return source;
  const old='case`unknown`:return{state:t?`working`:`idle`,stage:`Building`,who:`bot`}';
  const safe='case`unknown`:return{state:`idle`,stage:`Building`,who:`bot`}';
  if(source.includes(old))source=source.replace(old,safe);
  else if(!source.includes(safe))throw Error('My Work status contract changed; refusing to guess');
  if(source.split('idle:`Idle`').length!==2)throw Error('My Work idle label contract changed');
  source=source.replace('idle:`Idle`','idle:`Inactive`').replace('working:`Working`,"needs-check"','working:`Active`,"needs-check"')
    .replace('children:`Running`','children:`Last activity`').replace('` working`','` confirmed active`');
  // Real release mapper. All native review/shipped decisions remain untouched.
  const start='return tD({id:e.id,contentFingerprint:e.contentFingerprint,';
  const end='checkedAt:e.review?.checked&&e.review.checkedAtEpoch?oN(e.review.checkedAtEpoch):void 0})}';
  if(source.includes('function _N(')) {
    if(source.split(start).length!==2||source.split(end).length!==2)throw Error('My Work request mapper contract changed');
    source=source.replace(start,'return applyRequestActivity(e,tD({id:e.id,contentFingerprint:e.contentFingerprint,').replace(end,end.slice(0,-2)+'))}');
    // A badge's native state still drives filtering and colors; the extra label
    // communicates session activity without inventing task completion.
    if(!source.includes('function HD({state:e})'))throw Error('My Work badge contract changed');
    source=source.replace('function HD({state:e})','function HD({state:e,label:bridgeLabel})');
    const badgeStart=source.indexOf('function HD('),badgeEnd=source.indexOf('function ',badgeStart+12);
    let badge=source.slice(badgeStart,badgeEnd);
    if(!badge.includes('BD[e]'))throw Error('My Work badge label changed');
    badge=badge.replace('BD[e]','bridgeLabel||BD[e]');source=source.slice(0,badgeStart)+badge+source.slice(badgeEnd);
    source=source.replaceAll('HD,{state:e.state}','HD,{state:e.state,label:e.bridgeStatus}');
    source=source.replace('(0,H.jsx)(dk,{word:o,settled:s||c})','e.state===`working`&&(0,H.jsx)(dk,{word:o,settled:s||c})');
    source+='\n'+applyRequestActivity.toString()+'\n';
  }
  return source+'\n'+STATUS_MARKER+'\n';
}
