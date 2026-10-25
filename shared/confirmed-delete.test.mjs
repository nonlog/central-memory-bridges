import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createDeleteCoordinator,PREVIEW_TTL_MS} from './confirmed-delete.mjs';

function setup() {
  const reads=[],writes=[];
  let clock=1000;
  const coordinator=createDeleteCoordinator({
    now:()=>clock,
    readRecord:async (url,type,id) => {reads.push([url,type,id]); if(id===404)throw Error('not found');return {id,title:'Known observation',project:'demo',prompt_text:'PRIVATE PROMPT'};},
    deleteRecord:async (url,type,id)=>{writes.push([url,type,id]);if(id===500)throw Error('simulated failure');},
  });
  return {coordinator,reads,writes,expire:()=>{clock+=PREVIEW_TTL_MS+1;}};
}
const items=[{type:'observation',id:25},{type:'prompt',id:35}];
const url='http://worker';

test('preview reads verified IDs, suppresses prompt contents, does not delete',async()=>{
  const {coordinator,reads,writes}=setup();
  const p=await coordinator.preview({items:[...items,items[0]],workerUrl:url});
  assert.equal(reads.length,2);
  assert.equal(writes.length,0);
  assert.equal(p.operation,'preview-only');
  assert.equal(p.count,2);
  assert.equal(p.confirmationText,'DELETE 2 RECORDS');
  assert.equal(p.items[1].title,'prompt #35');
  assert.ok(!JSON.stringify(p).includes('PRIVATE PROMPT'));
});

test('missing confirmation, mismatch, replay and worker switching cannot delete',async()=>{
  const {coordinator,writes}=setup();
  const p=await coordinator.preview({items,workerUrl:url});
  const args={items,workerUrl:url,previewToken:p.previewToken,confirmationText:p.confirmationText};
  await assert.rejects(coordinator.forget({...args,confirm:false}),/confirm=true/);
  await assert.rejects(coordinator.forget({...args,confirm:true,workerUrl:'http://other'}),/previewToken/);
  await assert.rejects(coordinator.forget({...args,confirm:true,items:[items[0]]}),/confirmationText/);
  assert.equal(writes.length,0);
  assert.deepEqual((await coordinator.forget({...args,confirm:true})).deleted,items);
  await assert.rejects(coordinator.forget({...args,confirm:true}),/previewToken/);
  assert.equal(writes.length,2);
});

test('expired or unavailable preview blocks deletion',async()=>{
  const {coordinator,writes,expire}=setup();
  await assert.rejects(coordinator.preview({items:[{type:'prompt',id:404}],workerUrl:url}),/not found/);
  await assert.rejects(coordinator.preview({items:[{type:'summary',id:0}],workerUrl:url}));
  const p=await coordinator.preview({items,workerUrl:url});expire();
  await assert.rejects(coordinator.forget({items,workerUrl:url,previewToken:p.previewToken,confirmationText:p.confirmationText,confirm:true}),/previewToken/);
  assert.equal(writes.length,0);
});

test('partial errors are returned, and token is consumed before mutations',async()=>{
  const {coordinator,writes}=setup();
  const targets=[{type:'observation',id:500},{type:'summary',id:501}];
  const p=await coordinator.preview({items:targets,workerUrl:url});
  const args={items:targets,workerUrl:url,previewToken:p.previewToken,confirmationText:p.confirmationText,confirm:true};
  const result=await coordinator.forget(args);
  assert.equal(result.ok,false);
  assert.equal(result.deleted.length,1);
  assert.equal(result.failed[0].id,500);
  await assert.rejects(coordinator.forget(args),/previewToken/);
  assert.equal(writes.length,2);
});

test('OpenClaw runtime carries the same reviewed coordinator implementation',()=>{
  const a=fs.readFileSync(new URL('./confirmed-delete.mjs',import.meta.url));
  const b=fs.readFileSync(new URL('../openclaw-memory-admin/dist/confirmed-delete.mjs',import.meta.url));
  assert.deepEqual(a,b);
});
