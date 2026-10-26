'use strict';
document.querySelectorAll('[data-preview-image]').forEach(button=>{
 button.addEventListener('click',()=>{
  const dialog=document.getElementById('image-preview');
  if(!dialog)return;
  document.getElementById('preview-img').src=button.dataset.previewImage;
  document.getElementById('preview-title').textContent=button.dataset.previewTitle||'Imagem do produto';
  dialog.showModal();
 });
});
document.getElementById('preview-close')?.addEventListener('click',()=>document.getElementById('image-preview')?.close());
document.getElementById('image-preview')?.addEventListener('click',event=>{if(event.target.tagName==='DIALOG')event.target.close()});
// Sidebar: active state fallback, mobile drawer (hamburger/overlay/Esc), desktop collapse remembered.
(()=>{
 const links=[...document.querySelectorAll('[data-nav]')];
 if(links.length&&!document.querySelector('.side-links a.active')){
  const path=location.pathname.replace(/\/+$/,'')||'/';let best=null,len=-1;
  links.forEach(a=>[a.getAttribute('data-nav'),...(a.getAttribute('data-nav-also')||'').split(' ').filter(Boolean)].forEach(c=>{if((path===c||(c!=='/'&&path.startsWith(c+'/')))&&c.length>len){best=a;len=c.length}}));
  if(best){best.classList.add('active');best.setAttribute('aria-current','page')}
 }
 const toggle=document.getElementById('nav-toggle'),opener=document.querySelector('[data-nav-open]'),shell=document.querySelector('.app-shell');
 const drawer=document.querySelector('.sidebar'),mobile=window.matchMedia('(max-width:760px)');
 const syncDrawer=()=>{if(drawer)drawer.inert=mobile.matches&&!toggle?.checked};
 syncDrawer();mobile.addEventListener('change',syncDrawer);
 const setOpen=open=>{if(!toggle)return;toggle.checked=open;syncDrawer();opener?.setAttribute('aria-expanded',String(open));if(open)document.querySelector('.side-links a')?.focus();else if(document.activeElement?.closest?.('.sidebar'))opener?.focus()};
 opener?.addEventListener('click',()=>setOpen(!toggle.checked));
 toggle?.addEventListener('change',()=>{syncDrawer();opener?.setAttribute('aria-expanded',String(toggle.checked))});
 links.forEach(a=>a.addEventListener('click',()=>{if(toggle?.checked)setOpen(false)}));
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&toggle?.checked)setOpen(false);if(e.key==='Tab'&&mobile.matches&&toggle?.checked){const focusable=[...drawer.querySelectorAll('a,button')].filter(x=>x.getClientRects().length);const first=focusable[0],last=focusable.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}});
 const btn=document.querySelector('[data-sidebar-collapse]'),KEY='sidebar-collapsed';
 const apply=c=>{shell?.classList.toggle('sidebar-collapsed',c);btn?.setAttribute('aria-pressed',String(c));btn?.setAttribute('aria-label',c?'Expandir menu':'Recolher menu');btn?.setAttribute('title',c?'Expandir menu':'Recolher menu')};
 try{apply(localStorage.getItem(KEY)==='1')}catch{}
 btn?.addEventListener('click',()=>{const c=!shell.classList.contains('sidebar-collapsed');apply(c);try{localStorage.setItem(KEY,c?'1':'0')}catch{}});
})();
document.querySelectorAll('.dropzone').forEach(zone=>{
 const input=zone.querySelector('input[type=file]');
 const label=zone.querySelector('.dropzone-label');
 if(!input)return;
 const describe=file=>{if(label)label.textContent=file?'Arquivo selecionado: '+file.name:'Arraste uma imagem aqui ou clique para selecionar';};
 zone.addEventListener('click',event=>{if(event.target!==input)input.click()});
 zone.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();input.click()}});
 input.addEventListener('change',()=>describe(input.files?.[0]));
 zone.addEventListener('dragenter',event=>{event.preventDefault();zone.classList.add('dragging')});
 zone.addEventListener('dragover',event=>{event.preventDefault();event.dataTransfer.dropEffect='copy';zone.classList.add('dragging')});
 zone.addEventListener('dragleave',event=>{if(!zone.contains(event.relatedTarget))zone.classList.remove('dragging')});
 zone.addEventListener('drop',event=>{
  event.preventDefault();event.stopPropagation();zone.classList.remove('dragging');
  const file=Array.from(event.dataTransfer?.files||[]).find(f=>f.type.startsWith('image/')||/\.(jpe?g|png|webp)$/i.test(f.name));
  if(!file){describe(null);if(label)label.textContent='Selecione uma imagem JPG, PNG ou WebP';return}
  const transfer=new DataTransfer();transfer.items.add(file);input.files=transfer.files;
  input.dispatchEvent(new Event('change',{bubbles:true}));
 });
});

// Switching WhatsApp account filters saved groups; it does not call the WAHA API.
document.querySelectorAll('select[data-switch-connection]').forEach(select=>{
 select.addEventListener('change',()=>{
  const chosen=select.value;
  if(!/^[0-9]+$/.test(chosen))return;
  location.assign('/admin/groups?connection_id='+encodeURIComponent(chosen));
 });
});


// Authorize or disable a group in place. Do not navigate, reload or reset scroll.
document.querySelectorAll('form[data-group-toggle]').forEach(form=>{
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  if(form.dataset.pending==='yes')return;
  const button=form.querySelector('button');
  const field=form.querySelector('input[name=enabled]');
  const row=form.closest('.group-row');
  const label=row?.querySelector('[data-authorization-label]');
  const feedback=form.querySelector('.group-toggle-feedback');
  if(!button||!field||!row)return;
  form.dataset.pending='yes';
  button.disabled=true;
  const original=button.textContent,isSwitch=button.getAttribute('role')==='switch';
  button.setAttribute('aria-busy','true');
  if(!isSwitch)button.textContent='Salvando...';
  if(feedback)feedback.textContent='';
  try{
   const response=await fetch(form.action,{
    method:'POST',
    body:new URLSearchParams(new FormData(form)),
    headers:{Accept:'application/json'},
    credentials:'same-origin',
    redirect:'follow'
   });
   if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))throw Error('Falha ao salvar a autorização');
   const result=await response.json();
   if(!result.ok||String(result.groupId)!==String(row.dataset.groupId))throw Error('Resposta inválida da aplicação');
   const enabled=Boolean(result.enabled);
   field.value=enabled?'no':'yes';
   if(label)label.textContent=enabled?'Autorizado':'Não autorizado';
   if(isSwitch)button.setAttribute('aria-checked',String(enabled));
   else button.textContent=enabled?'Desabilitar':'Confirmar e habilitar';
   button.setAttribute('aria-label',(enabled?'Desativar envios para ':'Autorizar envios para ')+(row.querySelector('.group-name')?.textContent||''));
   button.classList.toggle('off',enabled);
   row.classList.toggle('is-authorized',enabled);
   row.dataset.groupAuthorized=enabled?'yes':'no';
   const total=Number(result.total),authorized=Number(result.enabledCount);
   if(Number.isFinite(total)&&Number.isFinite(authorized)){
    const totalNode=document.querySelector('[data-total-groups]');
    const enabledNode=document.querySelector('[data-enabled-groups]');
    const disabledNode=document.querySelector('[data-disabled-groups]');
    if(totalNode)totalNode.textContent=String(total);
    if(enabledNode)enabledNode.textContent=String(authorized);
    if(disabledNode)disabledNode.textContent=String(total-authorized);
    const tab=document.querySelector('[data-connection-stats="'+String(result.connectionId)+'"]');
    if(tab)tab.textContent=total+' grupos · '+authorized+' autorizados';
   }
   document.dispatchEvent(new Event('groups:updated'));
  }catch(error){
   if(!isSwitch)button.textContent=original;
   if(feedback)feedback.textContent='Não foi possível atualizar. Tente novamente.';
  }finally{
   button.removeAttribute('aria-busy');
   button.disabled=false;
   delete form.dataset.pending;
  }
 });
});


document.querySelectorAll('form[data-confirm-retry]').forEach(form=>{
 form.addEventListener('submit',event=>{
  if(!window.confirm('Tentar reenviar o produto ao mesmo grupo? Se o WhatsApp tiver recebido a mensagem anterior, ela poderá ficar duplicada.'))event.preventDefault();
 });
});

// One explicit confirmation, instead of a blocking required text field.
document.querySelectorAll('form[data-confirm-restart]').forEach(form=>{
 form.addEventListener('submit',event=>{
  if(!window.confirm('Reiniciar a fila de produtos agora? Os envios já realizados hoje serão preservados.'))event.preventDefault();
 });
});
// Keep the scheduling status current without scrolling or reloading the page.
const scheduleInfo=document.querySelector('[data-schedule-status]');
if(scheduleInfo){
 const updateStatus=async()=>{
  if(document.visibilityState==='hidden')return;
  try{
   const response=await fetch('/admin/plan/status',{headers:{Accept:'application/json'},cache:'no-store',credentials:'same-origin'});
   if(!response.ok)throw Error('Status indisponível');
   const data=await response.json();
   const set=(selector,value)=>{
    const node=scheduleInfo.querySelector(selector);
    if(node)node.textContent=String(value);
   };
   set('[data-status-eligible]',data.eligibleGroupCount);
   set('[data-status-planned]',data.planned);
   set('[data-status-sent]',data.sent);
   set('[data-status-pending]',data.pending);
   set('[data-status-failed]',data.failed);
   const clock=data.nextAt?new Date(Number(data.nextAt)).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',second:'2-digit'}):(data.nextLabel||'Não agendado');
   set('[data-status-next]',clock);
   set('[data-status-reason]',data.explanation||'');
   set('[data-status-error]',data.lastFailure?'Última falha: '+data.lastFailure:'');
   const statusBadge=document.querySelector('.program-status');
   if(statusBadge){
    statusBadge.textContent=data.statusLabel||(data.running?'Em execução':'Pausada');
    statusBadge.classList.toggle('is-running',!!data.running&&data.windowPhase==='open');
    statusBadge.classList.toggle('is-waiting',!!data.running&&data.windowPhase!=='open');
    statusBadge.classList.toggle('is-paused',!data.running);
   }
  }catch(error){
   // Do not alter the last verified status when the connection is temporarily unavailable.
  }
 };
 setInterval(updateStatus,15000);
}

// Carregar automaticamente os grupos ao escolher outra conexão (CSP-safe).
const groupConnectionSelect=document.querySelector('[data-auto-load-groups]');
if(groupConnectionSelect){
 groupConnectionSelect.addEventListener('change',()=>{
  const selectedId=groupConnectionSelect.value;
  if(!selectedId)return;
  const target=new URL('/admin/groups',window.location.origin);
  target.searchParams.set('connection_id',selectedId);
  window.location.assign(target.pathname+target.search);
 });
}

// Confirmation before destructive or publishing actions (Excluir / Publicar).
document.querySelectorAll('[data-confirm]').forEach(el=>{
 const ask=event=>{if(!window.confirm(el.dataset.confirm)){event.preventDefault();event.stopImmediatePropagation();}};
 if(el.tagName==='A')el.addEventListener('click',ask);
 else{const form=el.closest('form');if(form)form.addEventListener('submit',event=>{if(event.submitter===el||!event.submitter)ask(event)});}
});

// Client-side product search and status filter on /admin (no server requests).
(()=>{
 const search=document.getElementById('product-search'),status=document.getElementById('product-status-filter');
 if(!search||!status)return;
 const cards=[...document.querySelectorAll('[data-product-card]')],count=document.getElementById('product-filter-count'),empty=document.getElementById('product-filter-empty');
 const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 const apply=()=>{const q=norm(search.value.trim()),st=status.value;let shown=0;
  cards.forEach(c=>{const ok=(!q||norm(c.dataset.title).includes(q))&&(!st||c.dataset.status===st);c.hidden=!ok;if(ok)shown++;});
  if(count)count.textContent=shown+' de '+cards.length+' produtos';if(empty)empty.hidden=shown>0||!cards.length;};
 search.addEventListener('input',apply);status.addEventListener('change',apply);
})();

// Contador de caracteres da descrição (texto usado no WhatsApp).
document.querySelectorAll('textarea[data-char-counter]').forEach(area=>{
 const limit=Number(area.dataset.charCounter)||150,hint=area.parentElement?.querySelector('.pf-hint'),out=hint?.querySelector('[data-char-count]');
 const update=()=>{const n=area.value.length;if(out)out.textContent=String(n);hint?.classList.toggle('is-over',n>limit);};
 area.addEventListener('input',update);update();
});


// Monitor manual group synchronization. External script is allowed by the
// application's Content Security Policy; inline scripts are not.
(()=>{
 const marker=document.querySelector('[data-group-sync-poll]');
 if(!marker)return;
 const connectionId=marker.dataset.groupSyncPoll;
 let finished=false, failures=0;
 async function poll(){
  if(finished)return;
  try{
   const response=await fetch('/admin/groups/status?connection_id='+encodeURIComponent(connectionId),{cache:'no-store',credentials:'same-origin'});
   if(!response.ok)throw new Error('HTTP '+response.status);
   const status=await response.json();
   failures=0;
   if(status.status==='ok'||status.status==='failed'){
    finished=true;
    window.location.reload();
    return;
   }
  }catch(error){
   failures++;
   if(failures>=5){
    finished=true;
    window.location.reload();
    return;
   }
  }
  window.setTimeout(poll,1500);
 }
 window.setTimeout(poll,500);
})();

// Preview the selected palette without persisting it until "Salvar configurações".
// A page reload discards unsaved changes; the server always sets the saved theme.
(()=>{
 const choices=[...document.querySelectorAll('.theme-option input[name="theme"]')];
 if(!choices.length)return;
 const allowed=new Set(['esmeralda','oceano','areia','safira','grafite','ameixa']);
 choices.forEach(choice=>choice.addEventListener('change',()=>{
  if(choice.checked&&allowed.has(choice.value))document.documentElement.dataset.theme=choice.value;
 }));
})();


// Product presentation preferences never change product or dispatch data.
(()=>{const grid=document.querySelector('[data-product-grid]'),buttons=[...document.querySelectorAll('[data-product-view]')];if(!grid)return;const apply=v=>{grid.classList.toggle('is-list',v==='list');buttons.forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.productView===v)))};try{apply(localStorage.getItem('products-view')||'grid')}catch{}buttons.forEach(b=>b.addEventListener('click',()=>{apply(b.dataset.productView);try{localStorage.setItem('products-view',b.dataset.productView)}catch{}}));})();
(()=>{const search=document.querySelector('[data-catalog-search]');if(!search)return;const cards=[...document.querySelectorAll('[data-offer-card]')],empty=document.querySelector('[data-catalog-empty]');const norm=v=>v.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');search.addEventListener('input',()=>{let count=0;cards.forEach(c=>{c.hidden=!norm(c.dataset.title).includes(norm(search.value.trim()));if(!c.hidden)count++});if(empty)empty.hidden=count>0});})();
// Native details keep secondary actions available by keyboard and without JavaScript.
document.querySelectorAll('.action-menu').forEach(menu=>menu.addEventListener('toggle',()=>{
 if(menu.open)document.querySelectorAll('.action-menu[open]').forEach(other=>{if(other!==menu)other.open=false});
}));
document.addEventListener('pointerdown',e=>document.querySelectorAll('.action-menu[open]').forEach(menu=>{if(!menu.contains(e.target))menu.open=false}));
document.addEventListener('keydown',e=>{if(e.key==='Escape')document.querySelectorAll('.action-menu[open]').forEach(menu=>{menu.open=false;menu.querySelector('summary')?.focus()})});
document.querySelectorAll('#product-search,#product-status-filter').forEach(field=>field.addEventListener('input',()=>document.querySelectorAll('.action-menu[open]').forEach(menu=>{menu.open=false})));

// Search and authorization filter operate on every group in the selected connection.
(()=>{
 const root=document.querySelector('.groups-workspace');if(!root)return;
 const search=root.querySelector('[data-group-search]'),filter=root.querySelector('[data-group-filter]'),rows=[...root.querySelectorAll('[data-group-id]')];
 const count=root.querySelector('[data-groups-count]'),empty=root.querySelector('[data-groups-empty]');
 const norm=v=>String(v||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'');
 function apply(){
  const q=norm(search?.value.trim()),status=filter?.value||'';
  const matched=rows.filter(r=>(!q||norm(r.dataset.groupName).includes(q))&&(!status||r.dataset.groupAuthorized===status));
  const visible=new Set(matched);
  rows.forEach(r=>r.hidden=!visible.has(r));
  if(empty)empty.hidden=matched.length>0;
  if(count)count.textContent=matched.length+' de '+rows.length+(rows.length===1?' grupo':' grupos');
 }
 search?.addEventListener('input',apply);filter?.addEventListener('change',apply);
 document.addEventListener('groups:updated',()=>{const active=document.activeElement;apply();if(active?.closest('[data-group-id]')?.hidden)(root.querySelector('[data-filter-trigger]')||filter)?.focus()});apply();
})();

// Enhance the native authorization filter while keeping its change contract.
(()=>{
 const root=document.querySelector('[data-custom-group-filter]');if(!root)return;
 const native=root.parentElement.querySelector('[data-group-filter]'),trigger=root.querySelector('[data-filter-trigger]'),panel=root.querySelector('[data-filter-panel]'),label=root.querySelector('[data-filter-label]'),options=[...root.querySelectorAll('[data-filter-value]')];
 if(!native||!trigger||!panel||!options.length)return;
 const sync=()=>{options.forEach(o=>o.setAttribute('aria-selected',String(o.dataset.filterValue===native.value)));label.textContent=options.find(o=>o.dataset.filterValue===native.value)?.querySelector('span:nth-child(2)')?.textContent||'Todos os grupos'};
 const close=(restore=false)=>{panel.hidden=true;trigger.setAttribute('aria-expanded','false');if(restore)trigger.focus()};
 const open=(last=false)=>{panel.hidden=false;trigger.setAttribute('aria-expanded','true');(last?options.at(-1):options.find(o=>o.dataset.filterValue===native.value)||options[0]).focus()};
 trigger.addEventListener('click',()=>panel.hidden?open():close(true));
 trigger.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();open(e.key==='ArrowUp'||e.key==='End')}else if(e.key==='Escape')close(true)});
 options.forEach((option,i)=>{
  option.addEventListener('click',()=>{native.value=option.dataset.filterValue;native.dispatchEvent(new Event('change',{bubbles:true}));sync();close(true)});
  option.addEventListener('keydown',e=>{
   let next=null;if(e.key==='ArrowDown')next=(i+1)%options.length;if(e.key==='ArrowUp')next=(i+options.length-1)%options.length;if(e.key==='Home')next=0;if(e.key==='End')next=options.length-1;
   if(next!==null){e.preventDefault();options[next].focus()}else if(e.key==='Escape'){e.preventDefault();close(true)}else if(e.key==='Tab')close(true);
  });
 });
 document.addEventListener('pointerdown',e=>{if(!root.contains(e.target))close()});
 document.addEventListener('focusin',e=>{if(!root.contains(e.target))close()});
 native.addEventListener('change',sync);sync();native.hidden=true;root.hidden=false;
})();

// Graceful initials when a group has no photo or the connection is unavailable.
document.querySelectorAll('img[data-group-photo]').forEach(img=>{
 const show=()=>img.closest('.group-avatar')?.classList.add('has-photo');
 const fallback=()=>{img.hidden=true;img.closest('.group-avatar')?.classList.remove('has-photo')};
 img.addEventListener('load',show);img.addEventListener('error',fallback);
 if(img.complete&&img.naturalWidth>0)show();
});
