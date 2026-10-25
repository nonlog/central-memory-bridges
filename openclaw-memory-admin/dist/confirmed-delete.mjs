import { randomBytes } from 'node:crypto';

// A single process keeps an expiring, one-use review receipt. It is not proof
// of human approval: callers must ask the user before submitting confirm=true.
export const PREVIEW_TTL_MS = 300_000;
const TYPES = new Set(['observation', 'summary', 'prompt']);
export function exactItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) throw Error('items must contain 1-50 exact records');
  const unique = new Map();
  for (const item of items) {
    if (!item || !TYPES.has(item.type) || !Number.isSafeInteger(item.id) || item.id < 1)
      throw Error('Invalid record type or positive numeric ID');
    unique.set(item.type + ':' + item.id, {type:item.type,id:item.id});
  }
  return [...unique.values()];
}
const keyFor = items => items.map(item => item.type + ':' + item.id).sort().join('|');

export function createDeleteCoordinator({readRecord, deleteRecord, now = Date.now}) {
  const tickets = new Map();
  const prune = () => {
    for (const [key, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(key);
    while (tickets.size >= 128) tickets.delete(tickets.keys().next().value);
  };
  async function preview({items, workerUrl, signal}) {
    const requested = exactItems(items);
    if (typeof workerUrl !== 'string' || !workerUrl) throw Error('Worker URL required');
    const records = [];
    for (const item of requested) {
      signal?.throwIfAborted?.();
      const data = await readRecord(workerUrl,item.type,item.id,signal);
      if (!data || !Number.isSafeInteger(data.id) || data.id !== item.id)
        throw Error('Preview could not validate the exact record ' + item.type + ':' + item.id);
      records.push({...item,
        project:typeof data.project === 'string' ? data.project.slice(0,96) : '',
        title:item.type === 'observation' && typeof data.title === 'string'
          ? data.title.slice(0,120) : item.type + ' #' + item.id});
    }
    prune();
    const previewToken = randomBytes(32).toString('base64url');
    tickets.set(previewToken,{key:keyFor(requested),workerUrl,expiresAt:now()+PREVIEW_TTL_MS});
    return {ok:true, operation:'preview-only', items:records, deleted:[], count:records.length,
      previewToken,expiresInSeconds:PREVIEW_TTL_MS/1000,
      confirmationText:'DELETE '+records.length+' RECORD'+(records.length === 1 ? '' : 'S'),
      next:'Show these exact records to the user and request confirmation. Only then pass previewToken, confirmationText, same items and confirm=true to claude_mem_forget.'};
  }
  async function forget({items,workerUrl,previewToken,confirmationText,confirm,signal}) {
    if (confirm !== true) throw Error('confirm=true is required after preview and user approval');
    const requested = exactItems(items);
    if (confirmationText !== 'DELETE '+requested.length+' RECORD'+(requested.length === 1 ? '' : 'S'))
      throw Error('confirmationText does not match the preview');
    prune();
    const ticket = tickets.get(previewToken);
    if (!ticket || ticket.expiresAt <= now() || ticket.workerUrl !== workerUrl || ticket.key !== keyFor(requested))
      throw Error('Missing, expired or mismatched previewToken; preview again');
    tickets.delete(previewToken); // Consume before first mutation; failed batches require new preview.
    const deleted = [], failed = [];
    for (const item of requested) {
      signal?.throwIfAborted?.();
      try { await deleteRecord(workerUrl,item.type,item.id,signal); deleted.push(item); }
      catch(error) {failed.push({...item,error:String(error?.message||error).slice(0,500)}); }
    }
    return {ok:failed.length===0,deleted,failed,count:requested.length};
  }
  return {preview,forget};
}
