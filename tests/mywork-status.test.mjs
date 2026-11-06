import test from 'node:test';import assert from 'node:assert/strict';
import {patchMyWorkStatus,applyRequestActivity} from '../deploy/mywork-status-compat.mjs';
const fixture='function a(e,t){switch(e){case`unknown`:return{state:t?`working`:`idle`,stage:`Building`,who:`bot`}}}var labels={working:`Working`,"needs-check":`Done`,idle:`Idle`};var x={children:`Running`};';
test('unknown activity is not represented as live execution; all controls are English',()=>{const s=patchMyWorkStatus(fixture);assert.ok(!s.includes('state:t?`working`'));assert.ok(s.includes('idle:`Inactive`'));assert.ok(s.includes('Last activity'));assert.equal(patchMyWorkStatus(s),s);assert.doesNotMatch(s,/[\u4e00-\u9fff]/)});
test('upgrades the prior status overlay instead of retaining obsolete labels',()=>{const old=fixture.replace('state:t?`working`:`idle`','state:`idle`').replace('idle:`Idle`','idle:`\u672a\u786e\u8ba4 / \u5386\u53f2`')+'\n/* central-memory-bridges:truthful-mywork-status:v1 */';assert.match(patchMyWorkStatus(old),/truthful-mywork-status:v2/);assert.doesNotMatch(patchMyWorkStatus(old),/[\u4e00-\u9fff]/)});
test('completed observer sessions display idle and do not become shipped',()=>{const raw={bridgeRun:{label:'Session idle',lastActivityAt:60000},items:[]};const out=applyRequestActivity(raw,{state:'working',stage:'Building'},180000);assert.equal(out.state,'idle');assert.equal(out.bridgeStatus,'Session idle');assert.equal(out.runningFor,'2 min ago');assert.equal(out.stage,'Not reviewed')});
test('real delivery/review states are preserved',()=>{for(const state of ['shipped','needs-check','your-move'])assert.equal(applyRequestActivity({items:[]},{state}).state,state)});
test('changed upstream mapping fails closed',()=>assert.throws(()=>patchMyWorkStatus('case`unknown`:return{state:"different"};idle:`Idle`'),/contract changed/));

// The release mapper gained review/suggestion spreads after checkedAt in 15.10.
const mapperFixture=tail=>fixture+'function normalize(r){return{...r,normalized:true}}function date(r){return r}function mapRequest(e){return normalize({id:e.id,contentFingerprint:e.contentFingerprint,state:`working`,stage:`Building`,checkedAt:e.review?.checked&&e.review.checkedAtEpoch?date(e.review.checkedAtEpoch):void 0'+tail+'})}function Badge({state:e}){return(0,J.jsx)(`span`,{className:`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2`,children:labels[e]})}function render(e){return(0,J.jsx)(Badge,{state:e.state})}';
test('release mappers preserve normalized data and new review/suggestion fields',()=>{
  for(const tail of ['',',...e.review?.mode?{review:{mode:e.review.mode,hash:e.review.hash??null}}:{},...e.suggestion?{suggestion:{requestId:e.suggestion.requestId,sharedConflict:e.suggestion.sharedConflict}}:{}']){
    const patched=patchMyWorkStatus(mapperFixture(tail));
    const raw={id:'request',contentFingerprint:'fingerprint',review:{checked:true,checkedAtEpoch:123,mode:'verified',hash:'review-hash'},suggestion:{requestId:'suggestion',sharedConflict:true},items:[]};
    const out=new Function('raw',patched+';return mapRequest(raw);')(raw);
    assert.equal(out.normalized,true);assert.equal(out.state,'idle');assert.equal(out.checkedAt,123);
    assert.equal(out.id,raw.id);assert.equal(out.contentFingerprint,raw.contentFingerprint);
    if(tail){assert.deepEqual(out.review,{mode:'verified',hash:'review-hash'});assert.deepEqual(out.suggestion,raw.suggestion)}
    assert.equal(patchMyWorkStatus(patched),patched);
  }
});
test('ambiguous release mappers fail closed',()=>assert.throws(()=>patchMyWorkStatus(mapperFixture('')+'function other(e){return normalize({id:e.id,contentFingerprint:e.contentFingerprint,state:`working`})}'),/request mapper contract changed/));
test('changed release mapper entry fails closed',()=>assert.throws(()=>patchMyWorkStatus(mapperFixture('').replace('contentFingerprint:e.contentFingerprint,','contentFingerprint:changed,')),/request mapper contract changed/));
