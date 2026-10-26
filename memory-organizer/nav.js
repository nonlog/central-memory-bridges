/* Native navigation integration: no extra header row or floating button. */
(()=>{
  const ID='central-memory-organizer-nav';
  function install(){
    const previous=document.getElementById(ID);
    if(previous?.tagName==='A'&&previous.dataset.release==='2'&&previous.isConnected)return true;
    previous?.remove();
    const items=[...document.querySelectorAll('nav button,nav a')];
    const work=items.find(n=>n.textContent.trim()==='My Work');
    const neutral=items.find(n=>n.textContent.trim()==='My Goals');
    const header=document.querySelector('header');
    if((location.pathname==='/'||location.pathname.startsWith('/work-view'))&&!work)return false;
    const host=work?.parentElement||(header?.querySelector('nav')||header?.querySelector('.flex.items-center.justify-between > div:last-child')||header?.firstElementChild);
    if(!host)return false;
    const a=document.createElement('a');a.id=ID;a.dataset.release='2';a.href='/organizer/';a.title='Browse memories by topic and project';a.setAttribute('aria-label','Memories');
    a.className=(neutral?.className||work?.className||'')+' cmb-memory-link';
    const iconFrame=document.createElement('span');iconFrame.className=neutral?.firstElementChild?.className||'cmb-icon-frame';
    iconFrame.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>';
    const label=document.createElement('span');label.className=work?(neutral?.lastElementChild?.className||''):'';label.textContent='Memories';a.append(iconFrame,label);
    if(work)work.insertAdjacentElement('afterend',a);else host.append(a);
    if(!document.getElementById('cmb-nav-style')){const css=document.createElement('link');css.id='cmb-nav-style';css.rel='stylesheet';css.href='/organizer/integration.css?v=2';document.head.append(css)}
    return true;
  }
  let queued=false;const observer=new MutationObserver(()=>{if(!document.getElementById(ID)&&!queued){queued=true;requestAnimationFrame(()=>{queued=false;install()})}});observer.observe(document.documentElement,{childList:true,subtree:true});install();
})();
