'use strict';
// Admin sidebar navigation: grouped sections, inline SVG icons, accessible markup.
const svg=d=>'<svg class="nav-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+d+'</svg>';
const ICONS={
 search:svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>'),
 catalog:svg('<path d="M3 10h18l-2-6H5l-2 6Z"/><path d="M4 10v10h16V10M9 20v-6h6v6"/><path d="M3 10c0 3 4 3 4 0 0 3 5 3 5 0 0 3 5 3 5 0 0 3 4 3 4 0"/>'),
 products:svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
 add:svg('<path d="M12 5v14M5 12h14"/>'),
 automation:svg('<path d="m13 3-8 10h6l-1 8 9-11h-6l1-7Z"/>'),
 plan:svg('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4M17 3v4M3 11h18M8 15h2M14 15h2M8 18h2"/>'),
 clicks:svg('<path d="m5 3 5 17 3-7 7-3L5 3ZM15 15l5 5"/>'),
 health:svg('<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
 waha:svg('<rect x="5" y="2.5" width="14" height="19" rx="3"/><path d="M9 6h6M10 18h4"/><path d="M9 10h6v4H9z"/>'),
 groups:svg('<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 20v-2a6 6 0 0 0-3-5.2"/>'),
 settings:svg('<path d="M4 7h3M11 7h9M4 17h9M17 17h3"/><circle cx="9" cy="7" r="2"/><circle cx="15" cy="17" r="2"/>'),
 logout:svg('<path d="M10 4H5v16h5M9 12h12m-4-4 4 4-4 4"/>'),
 collapse:svg('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m7-12-4 4 4 4"/>'),
 menu:svg('<path d="M4 6h16M4 12h11M4 18h16"/>'),
 edit:svg('<path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15l-1 6 5-2"/>'),
 trash:svg('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'),
 play:svg('<path d="m8 5 11 7-11 7V5Z"/>'),
 pause:svg('<path d="M8 5v14M16 5v14"/>'),
 restart:svg('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>'),
 save:svg('<path d="M4 3h13l3 3v15H4V3ZM8 3v6h8V3M8 21v-8h8v8"/>'),
 back:svg('<path d="m10 5-7 7 7 7M3 12h18"/>'),
 arrow:svg('<path d="M5 12h14m-5-5 5 5-5 5"/>'),
 check:svg('<path d="m5 12 4 4L19 6"/>')
};
ICONS.overview=svg('<rect x="3" y="3" width="7" height="10" rx="1.5"/><rect x="14" y="3" width="7" height="6" rx="1.5"/><rect x="3" y="17" width="7" height="4" rx="1.5"/><rect x="14" y="13" width="7" height="8" rx="1.5"/>');
const NAV_SECTIONS=[
 {label:'Principal',items:[
  {href:'/admin/overview',label:'Visão geral',icon:'overview'},
  {href:'/admin',label:'Produtos',icon:'products',also:['/admin/new','/admin/edit','/admin/publish']},
  {href:'/admin/clicks',label:'Cliques',icon:'clicks'}]},
 {label:'Publicações',items:[
  {href:'/admin/plan',label:'Programação',icon:'plan',also:['/admin/simulate']},
  {href:'/admin/automation',label:'Histórico',icon:'automation'},
  {href:'/admin/groups',label:'Grupos',icon:'groups'}]},
 {label:'Gerenciar',items:[
  {href:'/admin/waha',label:'Conexões',icon:'waha'},
  {href:'/admin/settings',label:'Configurações',icon:'settings',also:['/admin/diagnostics','/admin/catalog-health']}]}
];
function navItems(){return NAV_SECTIONS.flatMap(s=>s.items);}
// Returns the href of the item that should be highlighted for a path (most specific wins).
function activeHref(path){
 path=String(path||'/').split('?')[0].replace(/\/+$/,'')||'/';
 let best=null,len=-1;
 for(const it of navItems()){
  const cands=[it.href,...(it.also||[])];
  for(const c of cands){
   const hit=path===c||(c!=='/'&&path.startsWith(c+'/'));
   if(hit&&c.length>len){best=it.href;len=c.length;}
  }
 }
 return best;
}
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function renderSidebarNav(path,authenticated=false){
 const act=path==null?null:activeHref(path);
 const sections=NAV_SECTIONS.map((s,i)=>'<div class="nav-section" role="group" aria-labelledby="nav-h-'+i+'"><div class="nav-heading" id="nav-h-'+i+'">'+esc(s.label)+'</div>'+s.items.map(it=>{
  const on=it.href===act;
  return '<a href="'+it.href+'" data-nav="'+it.href+'"'+(it.also?' data-nav-also="'+it.also.join(' ')+'"':'')+' title="'+esc(it.label)+'"'+(on?' class="active" aria-current="page"':'')+'>'+ICONS[it.icon]+'<span class="nav-label">'+esc(it.label)+'</span></a>';
 }).join('')+'</div>').join('');
 const foot='<div class="sidebar-foot">'+(authenticated?'<div class="sidebar-user"><span class="sidebar-avatar" aria-hidden="true">S</span><span class="nav-label"><strong>Supervisor</strong><small>Painel de gerenciamento</small></span></div><form class="sidebar-logout" method="post" action="/logout"><button type="submit" title="Sair" aria-label="Sair">'+ICONS.logout+'<span class="nav-label">Sair</span></button></form>':'<span class="nav-label">Painel de gerenciamento</span>')+'<button type="button" class="sidebar-collapse" data-sidebar-collapse aria-label="Recolher menu" aria-pressed="false" title="Recolher menu">'+ICONS.collapse+'</button></div>';
 return '<nav class="side-links" aria-label="Menu principal">'+sections+'</nav>'+foot;
}
function pageLabel(path){return navItems().find(item=>item.href===activeHref(path))?.label||'Área de trabalho';}
function decorateActions(html){
 // Add presentational icons to text-only action controls without changing forms or events.
 return html.replace(/<(a|button)([^>]*)>([^<]+)<\/\1>/g,(all,tag,attrs,text)=>{
  if(tag==='a'&&!/class="[^"]*(?:ui-btn|edit|publish)/.test(attrs))return all;
  const plain=text.trim().replace(/^(?:←|→|\+)\s*/, '');
  let key=/excluir|limpar|remover/i.test(plain)?'trash':/salvar/i.test(plain)?'save':/reiniciar/i.test(plain)?'restart':/pausar|desativar/i.test(plain)?'pause':/iniciar|retomar|publicar|ativar/i.test(plain)?'play':/cadastrar|adicionar|nova conexão/i.test(plain)?'add':/editar/i.test(plain)?'edit':/voltar|cancelar|produtos$/i.test(plain)?'back':/simular|programação/i.test(plain)?'plan':/oferta/i.test(plain)?'arrow':/confirmar|autorizar/i.test(plain)?'check':null;
  if(!key)return all;
  return '<'+tag+attrs+'>'+ICONS[key]+'<span>'+plain+'</span></'+tag+'>';
 });
}
module.exports={NAV_SECTIONS,ICONS,navItems,activeHref,renderSidebarNav,pageLabel,decorateActions};


