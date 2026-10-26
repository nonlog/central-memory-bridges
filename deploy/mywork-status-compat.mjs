/** Display-only correction. It never marks a task completed or rewrites memory. */
const MARKER='/* central-memory-bridges:truthful-mywork-status:v1 */';
export function patchMyWorkStatus(source) {
  if(source.includes(MARKER))return source;
  const from='case`unknown`:return{state:t?`working`:`idle`,stage:`Building`,who:`bot`}';
  const to='case`unknown`:return{state:`idle`,stage:`Building`,who:`bot`}';
  if(!source.includes('case`unknown`'))return source; // legacy fixture/view: no React status mapping
  if(source.split(from).length!==2)throw Error('My Work status contract changed; refusing to guess');
  if(source.split('idle:`Idle`').length!==2)throw Error('My Work idle label contract changed');
  source=source.replace(from,to).replace('idle:`Idle`','idle:`未确认 / 历史`');
  source=source.replace('working:`Working`,"needs-check"','working:`进行中（记录）`,"needs-check"');
  source=source.replace('children:`Running`','children:`经过时间`');
  return source+'\n'+MARKER+'\n';
}
