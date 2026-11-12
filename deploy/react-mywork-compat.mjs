import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {patchMyWorkStatus} from './mywork-status-compat.mjs';

const REGISTRY_START = '/* central-memory-bridges:react-registry:start */';
const REGISTRY_END = '/* central-memory-bridges:react-registry:end */';
const AVATAR_START = '/* central-memory-bridges:react-icons:start */';
const AVATAR_END = '/* central-memory-bridges:react-icons:end */';

// Only identities without native React logos get bridge assets.
const LABELS = {
  chatgpt:'ChatGPT', 'chatgpt-web':'ChatGPT Web', 'claude-web':'Claude Web',
  'gemini-web':'Gemini Web', pi:'Pi', 'pi-agent':'Pi', hermes:'Hermes',
  'hermes-agent':'Hermes', 'grok-web':'Grok Web', 'muse-web':'Muse',
  executor:'Executor', openclaw:'OpenClaw', omp:'Oh My Pi', 'oh-my-pi':'Oh My Pi',
};
const ICONS = {
  chatgpt:'chatgpt', 'chatgpt-web':'chatgpt',
  pi:'pi', 'pi-agent':'pi',
  hermes:'hermes', 'hermes-agent':'hermes',
  'grok-web':'grok-web', 'muse-web':'muse-web',
  executor:'executor', openclaw:'openclaw', omp:'omp', 'oh-my-pi':'omp',
};
export const REQUIRED_ICONS = [...new Set(Object.values(ICONS))];

export function patchReactBundle(source) {
  if (source.includes(REGISTRY_START) !== source.includes(REGISTRY_END) ||
      source.includes(AVATAR_START) !== source.includes(AVATAR_END))
    throw new Error('Incomplete React My Work overlay markers');
  // Fail closed on upstream changes: never blindly rewrite unrelated React code.
  const originalRegistry = /([A-Za-z_$][\w$]*)=\[`claude`,`codex`,`gemini`\],([A-Za-z_$][\w$]*)=\{claude:`Claude Code`,codex:`Codex`,gemini:`Gemini`\}/g;
  const matches=[...source.matchAll(originalRegistry)];
  if (matches.length > 1 || (source.includes('[`claude`,`codex`,`gemini`]') && matches.length !== 1))
    throw new Error('React My Work platform registry changed');
  let patched = source;
  if (matches.length === 1) {
    const [original, allowed, labels] = matches[0];
    const ext = Object.keys(LABELS).map(x => JSON.stringify(x)).join(',');
    const extLabels = Object.entries(LABELS).map(([key,value]) => JSON.stringify(key)+':'+JSON.stringify(value)).join(',');
    const registry = REGISTRY_START + allowed + '=[`claude`,`codex`,`gemini`,' + ext +
      '],' + labels + '={claude:`Claude Code`,codex:`Codex`,gemini:`Gemini`,' + extLabels + '}' + REGISTRY_END;
    patched = patched.replace(original,registry);
  }
  // Minification renames the component (ID -> PF) and React JSX helper
  // (H -> W) between official releases. Validate the function's signature and
  // native SVG renderer rather than assuming those private variable names.
  const avatarPattern = /function [A-Za-z_$][\w$]*\(\{tool:e,mono:t=!1,className:n\}\)\{/g;
  const avatars = [...patched.matchAll(avatarPattern)];
  if (avatars.length > 1) throw new Error('React My Work avatar function changed');
  if (!avatars.length || patched.includes(AVATAR_START)) return patchMyWorkStatus(patched);
  const start=avatars[0].index;
  const ret = ';return e===`claude`?';
  const pos = patched.indexOf(ret,start);
  if (pos < 0 || pos > start+330) throw new Error('React My Work native avatar contract changed');
  const renderer = /^;return e===`claude`\?\(0,([A-Za-z_$][\w$]*)\.jsx\)\(`svg`,/.exec(patched.slice(pos, pos+110));
  if(!renderer) throw new Error('React My Work SVG renderer changed');
  const jsx = renderer[1];
  const icons = Object.entries(ICONS).map(([key,value])=>JSON.stringify(key)+':'+JSON.stringify(value)).join(',');
  const injected = ';' + AVATAR_START + 'let bridgeIcon={' + icons + '}[e];' +
    'if(bridgeIcon)return(0,' + jsx + '.jsx)(`img`,{src:`/work-view/assets/agents/bridge-${bridgeIcon}.svg`,alt:``,"aria-hidden":`true`,className:r});' +
    'if(e===`claude-web`)e=`claude`;if(e===`gemini-web`)e=`gemini`;' +
    AVATAR_END + 'return e===`claude`?';
  patched = patched.slice(0,pos)+injected+patched.slice(pos+ret.length);
  return patchMyWorkStatus(patched);
}

export function findReactBundles(root) {
  const roots=['plugin/ui/work-view','ui/work-view'].map(p=>path.join(root,p));
  const found=[];
  for(const dir of roots) {
    const html=path.join(dir,'index.html');
    if(!fs.existsSync(html))continue;
    const source=fs.readFileSync(html,'utf8');
    // v15.0.x uses a plain JS view-model and is handled by the legacy overlay.
    if (fs.existsSync(path.join(dir,'view-model.js')) && !source.includes('/work-view/assets/index-')) continue;
    const scripts=[...source.matchAll(/src="\/work-view\/assets\/(index-[A-Za-z0-9_.-]+\.js)"/g)];
    if(scripts.length!==1)throw new Error('React My Work entry script changed');
    const js=path.join(dir,'assets',scripts[0][1]);
    if(!fs.existsSync(js))throw new Error('Missing React My Work bundle '+js);
    found.push(js);
  }
  return found;
}

export function updateReactBundle(bundlePath, assetSourceDir, check) {
  const assets=path.dirname(bundlePath),htmlPath=path.join(assets,'..','index.html');
  // Upstream 15.16.0 code-split the My Work UI across lazy chunks: the
  // registry/avatar/mapper live in ui-message-*.js and the rich badge/labels
  // in collapsible-*.js, while the entry keeps only a compact badge. Patch
  // every chunk that holds overlay targets. Chunks are patched in place:
  // the import graph between them is dense and cyclic, so renaming a chunk
  // would mean rewriting references in many files. The entry keeps the
  // content-hashed rename (index-cmb-*.js) so a stale cached entry can never
  // serve new code.
  const isGenerated=f=>/^index-cmb-[0-9a-f]+\.js$/.test(path.basename(f));
  // A patched registry keeps the original identities as a prefix and gains
  // the marker, so match either form (fresh or already patched).
  const hasRegistry=src=>src.includes(REGISTRY_START)||src.includes(REGISTRY_END)||/\[`claude`,`codex`,`gemini`\]/.test(src);
  const hasAvatar=src=>src.includes(AVATAR_START)||src.includes(AVATAR_END)||/function [A-Za-z_$][\w$]*\(\{tool:e,mono:t=!1,className:n\}\)\{/.test(src);
  const allFiles=fs.readdirSync(assets).filter(f=>f.endsWith('.js')).map(f=>path.join(assets,f));
  const sourceFiles=allFiles.filter(f=>!isGenerated(f));
  const entrySource=sourceFiles.find(f=>/^index-[A-Za-z0-9_.-]+\.js$/.test(path.basename(f)));
  if(!entrySource)throw new Error('Missing React My Work bundle '+bundlePath);
  let registryCount=0,avatarCount=0,mapperCount=0;
  const patched=new Map();
  for(const file of sourceFiles){
    const current=fs.readFileSync(file,'utf8');
    let next=current;
    if(hasRegistry(current))registryCount++;
    if(hasAvatar(current))avatarCount++;
    if(hasRegistry(current)||hasAvatar(current))next=patchReactBundle(current);
    else next=patchMyWorkStatus(current);
    if(current.includes('case`unknown`'))mapperCount++;
    patched.set(file,{current,next});
  }
  if(registryCount!==1)throw new Error('React My Work platform registry changed');
  if(avatarCount!==1)throw new Error('React My Work avatar function changed');
  if(mapperCount!==1)throw new Error('My Work status mapper changed');
  // In check mode the bundle is the generated entry, so re-derive its
  // content the same way instead of reading it from the source map.
  let entryNext;
  if(isGenerated(bundlePath)){
    const current=fs.readFileSync(bundlePath,'utf8');
    entryNext=hasRegistry(current)||hasAvatar(current)?patchReactBundle(current):patchMyWorkStatus(current);
  } else entryNext=patched.get(bundlePath).next;
  const digest=createHash('sha256').update(entryNext).digest('hex').slice(0,16);
  const filename='index-cmb-'+digest+'.js',target=path.join(assets,filename);
  const html=fs.readFileSync(htmlPath,'utf8');
  const oldRef='/work-view/assets/'+path.basename(bundlePath),newRef='/work-view/assets/'+filename;
  const newHtml=html.replace(oldRef,newRef);
  const icons=REQUIRED_ICONS.map(icon=>({from:path.join(assetSourceDir,icon+'.svg'),to:path.join(assets,'agents','bridge-'+icon+'.svg')}));
  const present=icons.every(({from,to})=>fs.existsSync(from)&&fs.existsSync(to)&&fs.readFileSync(from).equals(fs.readFileSync(to)));
  if(check){
    // Chunks patched in place must already be in their patched state; the
    // entry is verified through the generated file, not in place.
    const chunksOk=[...patched.entries()].every(([file,{current,next}])=>file===entrySource||next===current);
    return chunksOk && present && html.includes(newRef) && fs.existsSync(target) && fs.readFileSync(target,'utf8')===entryNext;
  }
  for(const [file,{current,next}] of patched){
    if(file!==entrySource&&next!==current)fs.writeFileSync(file,next);
  }
  for(const {from,to} of icons){const content=fs.readFileSync(from);fs.mkdirSync(path.dirname(to),{recursive:true});if(!fs.existsSync(to)||!fs.readFileSync(to).equals(content))fs.writeFileSync(to,content);}
  // Never reuse a hashed URL for different bytes. An ordinary reload must pick
  // up the new release even behind a browser or CDN cache.
  if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==entryNext)fs.writeFileSync(target,entryNext);
  if(newHtml!==html){fs.writeFileSync(htmlPath+'.tmp',newHtml);fs.renameSync(htmlPath+'.tmp',htmlPath);}
  return true;
}
