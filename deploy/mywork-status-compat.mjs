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
// The rich badge: the function whose body renders the state label.
function richBadgeMatches(source, badgeMatches, labelMatches) {
  badgeMatches ??= [...source.matchAll(/function ([A-Za-z_$][\w$]*)\(\{state:e\}\)\{/g)];
  labelMatches ??= [...source.matchAll(/var ([A-Za-z_$][\w$]*)=\{working:`(?:Working|Active)`,/g)];
  return badgeMatches.filter(b=>{
    const next=source.indexOf('function ',b.index+12);
    const body=source.slice(b.index,next<0?undefined:next);
    return body.length>200
      && /return\(0,[A-Za-z_$][\w$]*\.jsx\)\(/.test(body)
      && labelMatches.some(l=>body.includes(l[1]+'[e]'));
  });
}
export function patchMyWorkStatus(source) {
  if(source.includes(STATUS_MARKER))return source;
  source=source.replace(V1,'').replace('idle:`\u672a\u786e\u8ba4 / \u5386\u53f2`','idle:`Idle`')
    .replace('working:`\u8fdb\u884c\u4e2d\uff08\u8bb0\u5f55\uff09`,"needs-check"','working:`Working`,"needs-check"')
    .replace('children:`\u7ecf\u8fc7\u65f6\u95f4`','children:`Running`');
  // 15.16.0 code-split the My Work UI across lazy chunks: the status mapper
  // (unknown-state) and the rich badge/labels now live in different files,
  // so each part below runs only where its targets are. A part with no
  // targets in this file is a no-op; a part whose targets are present but
  // inconsistent still throws.
  const hasUnknown=source.includes('case`unknown`');
  // Rich-badge detection, for the early return only. The full match is
  // recomputed inside the badge block, after the mapper and renames have
  // shifted the source, so its indices stay fresh.
  const richBadgesEarly=richBadgeMatches(source);
  const hasBadge=richBadgesEarly.length>0;
  const hasIdleLabel=source.includes('idle:`Idle`');
  if(!hasUnknown && !hasBadge && !hasIdleLabel)return source;
  // Real release mapper. All native review/shipped decisions remain untouched.
  if(hasUnknown){
    const old='case`unknown`:return{state:t?`working`:`idle`,stage:`Building`,who:`bot`}';
    const safe='case`unknown`:return{state:`idle`,stage:`Building`,who:`bot`}';
    if(source.includes(old))source=source.replace(old,safe);
    else if(!source.includes(safe))throw Error('My Work status contract changed; refusing to guess');
    // Minification renamed the raw request variable (e -> t) when the mapper
    // moved into a chunk, so capture it instead of pinning it, and require
    // the mapper and its end-marker to agree on it.
    const mapperMatches=[...source.matchAll(/return ([A-Za-z_$][\w$]*)\(\{id:([A-Za-z_$][\w$]*)\.id,contentFingerprint:\2\.contentFingerprint,/g)];
    const endMatches=[...source.matchAll(/checkedAt:([A-Za-z_$][\w$]*)\.review\?\.checked&&\1\.review\.checkedAtEpoch\?([A-Za-z_$][\w$]*)\(\1\.review\.checkedAtEpoch\):void 0/g)];
    if(mapperMatches.length!==endMatches.length||mapperMatches.length>1)throw Error('My Work request mapper contract changed');
    if(mapperMatches.length===1) {
      if(mapperMatches[0][2]!==endMatches[0][1])throw Error('My Work request mapper contract changed');
      const mapper=mapperMatches[0][1],raw=mapperMatches[0][2],start=mapperMatches[0][0];
      // Wrap the callee so new upstream object fields keep their original boundary.
      source=source.replace(start,'return (request=>applyRequestActivity('+raw+','+mapper+'(request)))({id:'+raw+'.id,contentFingerprint:'+raw+'.contentFingerprint,');
      source+='\n'+applyRequestActivity.toString()+'\n';
    }
  }
  // A badge's native state still drives filtering and colors; the extra label
  // communicates session activity without inventing task completion. The two
  // halves are independent: the label renames run where the labels live, and
  // the badge injection only where a rich badge actually exists (the old
  // fixture has labels but no badge, and the mapper-only chunk has neither).
  if(hasIdleLabel){
    if(source.split('idle:`Idle`').length!==2)throw Error('My Work idle label contract changed');
    source=source.replace('idle:`Idle`','idle:`Inactive`').replace('working:`Working`,"needs-check"','working:`Active`,"needs-check"')
      .replace('children:`Running`','children:`Last activity`').replace('` working`','` confirmed active`');
  }
  if(hasBadge){
    // Upstream 15.12.0 moved the rich badge's JSX return behind an i18n hook
    // (function hI({state:e}){let{t}=G();return(0,B.jsx)(...)}), so match the
    // signature and let the body filters (JSX return, length, label lookup)
    // pick the rich badge over the compact one.
    const badgeMatches=[...source.matchAll(/function ([A-Za-z_$][\w$]*)\(\{state:e\}\)\{/g)];
    const labelMatches=[...source.matchAll(/var ([A-Za-z_$][\w$]*)=\{working:`(?:Working|Active)`,/g)];
    const richBadges=richBadgeMatches(source,badgeMatches,labelMatches);
    if(richBadges.length!==1)throw Error('My Work badge contract changed');
    const selected=richBadges[0],badgeName=selected[1];
    const originalBody=source.slice(selected.index,source.indexOf('function ',selected.index+12));
    const matchingLabels=labelMatches.filter(l=>originalBody.includes(l[1]+'[e]'));
    if(matchingLabels.length!==1)throw Error('My Work badge label contract changed');
    const labelVar=matchingLabels[0][1];
    source=source.replace(selected[0],selected[0].replace('{state:e}','{state:e,label:bridgeLabel}'));
    const badgeStart=source.indexOf('function '+badgeName+'('),badgeEnd=source.indexOf('function ',badgeStart+12);
    if(badgeEnd<0)throw Error('My Work badge boundary changed');
    let badge=source.slice(badgeStart,badgeEnd);
    if(!badge.includes(labelVar+'[e]'))throw Error('My Work badge label changed');
    badge=badge.replace(labelVar+'[e]','bridgeLabel||'+labelVar+'[e]');source=source.slice(0,badgeStart)+badge+source.slice(badgeEnd);
    const badgeCall=badgeName+',{state:e.state}';
    // 15.16.0+ the badge is exported and invoked from another chunk under an
    // import alias, so its call may not be in this file. The label param is
    // optional (it falls back to the renamed label), so inject it and rewrite
    // the call only when the call is here.
    if(source.includes(badgeCall))source=source.replaceAll(badgeCall,badgeName+',{state:e.state,label:e.bridgeStatus}');
    else console.warn('My Work badge is invoked from another chunk; skipping badge label injection');
    source=source.replace('(0,H.jsx)(dk,{word:o,settled:s||c})','e.state===`working`&&(0,H.jsx)(dk,{word:o,settled:s||c})');
  }
  return source+'\n'+STATUS_MARKER+'\n';
}
