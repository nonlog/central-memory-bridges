import fs from 'node:fs';
import path from 'node:path';

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
  if (source.includes(REGISTRY_START) || source.includes(AVATAR_START)) {
    if (!source.includes(REGISTRY_START) || !source.includes(REGISTRY_END) ||
        !source.includes(AVATAR_START) || !source.includes(AVATAR_END))
      throw new Error('Incomplete React My Work overlay markers');
    return source;
  }
  // Fail closed on upstream changes: never blindly rewrite unrelated React code.
  const originalRegistry = /([A-Za-z_$][\w$]*)=\[`claude`,`codex`,`gemini`\],([A-Za-z_$][\w$]*)=\{claude:`Claude Code`,codex:`Codex`,gemini:`Gemini`\}/g;
  const matches=[...source.matchAll(originalRegistry)];
  if (matches.length !== 1) throw new Error('React My Work platform registry changed');
  const [original, allowed, labels] = matches[0];
  const identities = Object.keys(LABELS);
  const ext = identities.map(x => JSON.stringify(x)).join(',');
  const extLabels = Object.entries(LABELS).map(([key,value]) => JSON.stringify(key)+':'+JSON.stringify(value)).join(',');
  const registry = REGISTRY_START + allowed + '=[`claude`,`codex`,`gemini`,' + ext +
    '],' + labels + '={claude:`Claude Code`,codex:`Codex`,gemini:`Gemini`,' + extLabels + '}' + REGISTRY_END;
  let patched = source.replace(original,registry);
  const avatarStart = 'function ID({tool:e,mono:t=!1,className:n})';
  const start=patched.indexOf(avatarStart);
  if (start < 0 || patched.indexOf(avatarStart,start+1)>=0) throw new Error('React My Work avatar function changed');
  const ret = ';return e===`claude`?';
  const pos = patched.indexOf(ret,start);
  if (pos < 0 || pos > start+230) throw new Error('React My Work native avatar contract changed');
  const icons = Object.entries(ICONS).map(([key,value])=>JSON.stringify(key)+':'+JSON.stringify(value)).join(',');
  const injected = ';' + AVATAR_START + 'let bridgeIcon={' + icons + '}[e];' +
    'if(bridgeIcon)return(0,H.jsx)(`img`,{src:`/work-view/assets/agents/bridge-${bridgeIcon}.svg`,alt:``,"aria-hidden":`true`,className:r});' +
    'if(e===`claude-web`)e=`claude`;if(e===`gemini-web`)e=`gemini`;' +
    AVATAR_END + 'return e===`claude`?';
  patched = patched.slice(0,pos)+injected+patched.slice(pos+ret.length);
  return patched;
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
    const scripts=[...source.matchAll(/src="\/work-view\/assets\/(index-[A-Za-z0-9_-]+\.js)"/g)];
    if(scripts.length!==1)throw new Error('React My Work entry script changed');
    const js=path.join(dir,'assets',scripts[0][1]);
    if(!fs.existsSync(js))throw new Error('Missing React My Work bundle '+js);
    found.push(js);
  }
  return found;
}

export function updateReactBundle(bundlePath, assetSourceDir, check) {
  const current=fs.readFileSync(bundlePath,'utf8');
  const next=patchReactBundle(current);
  const icons=REQUIRED_ICONS.map(icon=>({
    from:path.join(assetSourceDir,icon+'.svg'),
    to:path.join(path.dirname(bundlePath),'agents','bridge-'+icon+'.svg'),
  }));
  const present=icons.every(({from,to})=>fs.existsSync(from)&&fs.existsSync(to)&&fs.readFileSync(from).equals(fs.readFileSync(to)));
  if(check) return next===current && present;
  for(const {from,to} of icons) {
    const content=fs.readFileSync(from);
    fs.mkdirSync(path.dirname(to),{recursive:true});
    if(!fs.existsSync(to)||!fs.readFileSync(to).equals(content)) fs.writeFileSync(to,content);
  }
  if(next!==current)fs.writeFileSync(bundlePath,next);
  return true;
}
