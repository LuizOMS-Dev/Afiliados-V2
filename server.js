const http=require('node:http');
const loginAuth=require('./login-auth');
const {renderLogin}=require('./login-page');
const {initBrand,loadBrand,validateWhatsAppGroupUrl,validateSiteName,renderSidebarBrand,readBrandForm,normalizeImage,updateBrand,getBrandAsset}=require('./brand-settings');
const crypto=require('node:crypto');
const {AsyncLocalStorage}=require('node:async_hooks');
const {renderSidebarNav,ICONS,pageLabel,decorateActions}=require('./sidebar-nav');
const {THEMES,effectiveTheme,validateTheme}=require('./ui-themes');
const {renderProducts,renderCatalog,renderOverview,renderGroups,head}=require('./interface');
const requestContext=new AsyncLocalStorage();
const {Pool}=require('pg');
const {readMultipart,saveImage,getImage,deleteImage}=require('./image-upload');
const {listGroups}=require('./waha-groups');
const {initPhotoCache,loadGroupPhoto,invalidateConnectionPhotos}=require('./group-photos');
const {initSettings}=require('./waha-settings');
const {initialize:initializeRotation,planDay,syncCatalogQueues}=require('./rotation-persistence');
const dispatch=require('./dispatch');
const {initConnections,listConnections,getConnection,saveConnection,setPrimaryConnection,deleteConnection}=require('./waha-connections');
const clicks=require('./click-tracking');
const pool=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:5000});
const PORT=Number(process.env.PORT||3000);
const schema="CREATE TABLE IF NOT EXISTS products(id BIGSERIAL PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',image_url TEXT NOT NULL DEFAULT '',product_url TEXT NOT NULL DEFAULT '',affiliate_url TEXT NOT NULL,price NUMERIC(12,2),currency CHAR(3) DEFAULT 'BRL',status TEXT NOT NULL DEFAULT 'draft',created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT NOT NULL DEFAULT '';ALTER TABLE products ADD COLUMN IF NOT EXISTS show_disclosure BOOLEAN NOT NULL DEFAULT FALSE;";
let ready=false;
let brandingState={site_name:'Central de Afiliados',theme_id:'esmeralda',has_logo:false,has_favicon:false,version:0};
let wahaTest=null;
let groupSync=null;
let manualPublish=null;
async function init(){await pool.query(schema);await initializeRotation(pool);await dispatch.initialize(pool);await initSettings(pool);await pool.query('CREATE TABLE IF NOT EXISTS rotation_groups(id BIGSERIAL PRIMARY KEY,name TEXT NOT NULL,chat_id TEXT UNIQUE NOT NULL,enabled BOOLEAN NOT NULL DEFAULT FALSE)');await initConnections(pool);await initPhotoCache(pool);await pool.query(require('./click-tracking').SCHEMA);await initBrand(pool);brandingState=await loadBrand(pool);await pool.query('CREATE TABLE IF NOT EXISTS product_connections(product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,connection_id BIGINT NOT NULL REFERENCES waha_connections(id),PRIMARY KEY(product_id,connection_id))');/* Existing product selections are preserved; never silently reassign detached products. */ready=true;console.log('Database ready');}
async function scheduleDiagnostics(pool,now=new Date()){
 const day=dispatch.localDay(now);
 const [settings,groups,eligible,plan,logs,lastFail]=await Promise.all([
  dispatch.controls(pool),
  pool.query("SELECT count(*)::int AS n FROM rotation_groups WHERE enabled=true"),
  pool.query("SELECT count(DISTINCT g.id)::int AS n FROM rotation_groups g JOIN product_connections pc ON pc.connection_id=g.connection_id JOIN products p ON p.id=pc.product_id WHERE g.enabled=true AND p.status='active'"),
  pool.query('SELECT assignments FROM rotation_plans WHERE day=$1',[day]),
  pool.query('SELECT group_id,product_id,status FROM dispatch_log WHERE day=$1',[day]),
  pool.query("SELECT detail FROM dispatch_log WHERE day=$1 AND status='failed' AND id > (SELECT history_hidden_before_id FROM dispatch_settings WHERE id=1) ORDER BY updated_at DESC LIMIT 1",[day])
 ]);
 const attempted=new Set(logs.rows.filter(x=>['sent','reserved','failed'].includes(x.status)).map(x=>String(x.group_id)+':'+String(x.product_id)));
 const assignments=Array.isArray(plan.rows[0]?.assignments)?plan.rows[0].assignments:[];
 const pending=assignments.filter(x=>!attempted.has(String(x.groupId)+':'+String(x.productId)));
 const scheduled=pending.filter(x=>Number.isFinite(Number(x.dueAt))&&Number(x.dueAt)>now.getTime()).sort((a,b)=>a.dueAt-b.dueAt);
 const count=status=>logs.rows.filter(x=>x.status===status).length;
 const running=!settings.paused&&settings.send_enabled;
 const window=dispatch.windowStatus(settings,now);
 const startAt=String(settings.window_start);
 const statusLabel=!running?'Pausada manualmente':window.phase==='open'?'Em execução':'Em espera até '+startAt;
 let explanation='';
 if(!running)explanation='Automação pausada manualmente. Clique em Iniciar / Retomar.';
 else if(window.phase==='closed')explanation='Pausa automática às '+settings.window_end+'. A publicação retorna amanhã às '+settings.window_start+', sem clicar novamente.';
 else if(window.phase==='waiting')explanation='Pausa automática da madrugada. A publicação retorna hoje às '+settings.window_start+', sem clicar novamente.';
 else if(!groups.rows[0].n)explanation='Nenhum grupo autorizado.';
 else if(!eligible.rows[0].n)explanation='Nenhum grupo possui produtos ativos associados à sua conexão.';
 else if(!assignments.length)explanation='Nenhuma publicação agendada para hoje. Confira as contas e os produtos disponíveis.';
 else if(scheduled.length)explanation='Programação ativa. O primeiro ou próximo envio ocorrerá no horário informado.';
 else if(pending.length)explanation='Há publicações vencidas aguardando processamento; consulte o histórico.';
 else explanation='Todas as publicações agendadas de hoje já foram processadas, ou não há produtos inéditos para cada grupo.';
 return {running,windowPhase:window.phase,statusLabel,nextLabel:running&&window.phase!=='open'?'Retomada automática '+(window.phase==='closed'?'amanhã':'hoje')+' às '+startAt:'Não agendado',groupCount:groups.rows[0].n,eligibleGroupCount:eligible.rows[0].n,planned:assignments.length,pending:pending.length,sent:count('sent'),failed:count('failed'),processing:count('reserved'),skipped:count('skipped'),nextAt:window.phase==='open'?scheduled[0]?.dueAt||null:null,lastFailure:lastFail.rows[0]?.detail||'',explanation};
}
function formatDateBR(value){const iso=String(value??'').slice(0,10);const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);return m?m[3]+'/'+m[2]+'/'+m[1]:iso;}
function statusPt(value){return ({sent:'Enviado',skipped:'Ignorado',failed:'Falhou',reserved:'Em processamento',running:'Em andamento',ok:'Concluído',duplicate:'Duplicado',invalid:'Inválido'})[String(value)]||String(value||'Desconhecido');}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function validUrl(v){try{const u=new URL(v);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}}
function validOrigin(req){
 const fetchSite=String(req.headers['sec-fetch-site']||'').toLowerCase();
 // Browser-confirmed same-origin requests remain same-origin through a reverse proxy.
 if(fetchSite==='same-origin')return true;
 if(fetchSite==='cross-site')return false;
 const origin=req.headers.origin;
 if(!origin)return fetchSite!=='same-site';
 try {
  const u=new URL(origin);
  if(u.protocol!=='https:'&&u.protocol!=='http:')return false;
  const hosts=[req.headers.host,...String(req.headers['x-forwarded-host']||'').split(','),'sites-afiliados-app.dsgmtf.easypanel.host'];
  return hosts.some(v=>String(v||'').trim().toLowerCase()===u.host.toLowerCase());
 }catch{return false;}
}
function admin(req,res){
 if(!loginAuth.configured()){res.writeHead(503,{'content-type':'text/plain; charset=utf-8'});res.end('Credenciais administrativas não configuradas.');return false;}
 if(!loginAuth.validSession(loginAuth.cookieFromRequest(req))){
  res.writeHead(303,{'location':'/login?next='+encodeURIComponent(loginAuth.safeNext(req.url)),'cache-control':'no-store, max-age=0'});
  res.end();return false;
 }
 res.authenticated=true;
 return true;
}
function sendLogin(res,status,{next='/admin',error='',unavailable=false}={}){
 res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store, max-age=0','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
 res.end(renderLogin({next,error,unavailable,brand:brandingState}));
}
function page(body,authenticated=false){
 body=decorateActions(body);const path=requestContext.getStore()?.path||'/';const publicPage=path==='/'&&!authenticated;
 const favicon=brandingState.has_favicon?'<link rel="icon" type="image/png" href="/brand/favicon.png?v='+brandingState.version+'">':'';
 const assets='<link rel="stylesheet" href="/shell.css?v=70"><link rel="stylesheet" href="/themes.css?v=1&rev=40"><script defer src="/upload-ui.js?v=71"></script>';
 const start='<!doctype html><html lang="pt-BR" data-theme="'+effectiveTheme(brandingState.theme_id)+'"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+esc(brandingState.site_name)+'</title>'+favicon+assets+'</head>';
 if(publicPage)return start+'<body class="public-body"><a class="skip-link" href="#main-content">Ir para o conteúdo</a><header class="public-header"><a href="/" class="public-brand" aria-label="Página inicial">'+renderSidebarBrand(brandingState)+'</a><nav aria-label="Navegação do catálogo"><a href="#main-content">Explorar ofertas</a><a class="ui-btn btn-blue" href="/admin/overview">Área de gestão '+ICONS.arrow+'</a></nav></header><main id="main-content" class="public-content">'+body+'</main><footer class="public-footer"><span>'+esc(brandingState.site_name)+'</span><small>Uma seleção para o seu dia a dia.</small></footer></body></html>';
 const title=path==='/admin/overview'?'Visão geral':pageLabel(path);
 const date=new Date().toLocaleDateString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'short',year:'numeric'});
 return start+'<body class="refined-admin"><a class="skip-link" href="#main-content">Ir para o conteúdo</a><div class="app-shell"><input type="checkbox" id="nav-toggle" aria-hidden="true" tabindex="-1"><aside class="sidebar" id="app-sidebar"><a class="sidebar-home" href="/admin/overview" aria-label="Ir para visão geral">'+renderSidebarBrand(brandingState)+'</a>'+renderSidebarNav(path,authenticated)+'</aside><label class="sidebar-curtain" for="nav-toggle" aria-label="Fechar menu"></label><div class="app-main"><header class="app-topbar"><button type="button" class="menu-label" data-nav-open aria-controls="app-sidebar" aria-expanded="false" aria-label="Abrir menu">'+ICONS.menu+'</button><div class="topbar-context"><strong>'+esc(title)+'</strong></div><a class="topbar-catalog" aria-label="Ver catálogo" href="/" target="_blank" rel="noopener">'+ICONS.catalog+'<span>Ver catálogo</span></a></header><main id="main-content" data-page="'+esc(path)+'" class="app-content'+(body.includes('class="product-form"')?' product-page':'')+'">'+body+'</main><footer class="app-footer"><span>'+esc(brandingState.site_name)+'</span><small>Organize. Publique. Acompanhe.</small></footer></div></div></body></html>';
}
function send(res,code,body,headers={}){res.writeHead(code,{'content-type':'text/html; charset=utf-8','cache-control':'no-store, max-age=0','x-content-type-options':'nosniff','referrer-policy':'no-referrer','content-security-policy':"default-src 'self'; script-src 'self'; img-src 'self' https: http:; style-src 'self' 'unsafe-inline'; form-action 'self'; base-uri 'none'",...headers});res.end(page(body,Boolean(res.authenticated)));}
function form(p={},connections=[],selected=[]){const opts=connections.map(c=>'<label class="connection-choice"><input type="checkbox" name="connection_'+c.id+'" value="yes"'+(selected.includes(String(c.id))?' checked':'')+'><span><strong>'+esc(c.label)+(c.is_primary?' · Principal':'')+'</strong><small>Sessão: '+esc(c.session_name)+'</small></span></label>').join('');const title=p.id?'Editar produto':'Cadastrar produto';const active=!p.id||p.status==='active';const desc=String(p.description??'');return '<nav class="breadcrumb" aria-label="Navegação"><a href="/admin">Produtos</a><span aria-hidden="true">›</span><span aria-current="page">'+title+'</span></nav><header class="page-head"><div><h1>'+title+(p.id?' <small class="pf-id">#'+esc(p.id)+'</small>':'')+'</h1><p>'+(p.id?'Atualize os dados, a imagem e as conexões deste produto.':'Preencha os dados da oferta e escolha as conexões de publicação.')+'</p></div></header><form method="post" action="/admin/save" enctype="multipart/form-data" class="product-form"><input type="hidden" name="id" value="'+esc(p.id||'')+'"><div class="pf-layout"><div class="pf-main"><section class="pf-card"><h2>Informações</h2><label>Título<input name="title" required maxlength="180" value="'+esc(p.title)+'" placeholder="Nome curto e direto do produto"></label><label>Descrição<textarea name="description" rows="4" maxlength="4000" data-char-counter="150" placeholder="1 a 2 linhas com o essencial do produto">'+esc(desc)+'</textarea><small class="pf-hint"><span data-char-count>'+desc.length+'</span> caracteres · recomendado até 150 (texto usado no WhatsApp)</small></label></section><section class="pf-card"><h2>Links e preço</h2><label>Link exclusivo de afiliado <em class="pf-req">obrigatório</em><input name="affiliate_url" type="url" required maxlength="2000" value="'+esc(p.affiliate_url)+'" placeholder="https://..."></label><label>Link original do produto <em>opcional</em><input name="product_url" type="url" maxlength="2000" value="'+esc(p.product_url)+'" placeholder="https://..."></label><label>Preço de referência (R$) <em>opcional</em><input name="price" inputmode="decimal" placeholder="Ex: 129,90" value="'+esc(p.price)+'"></label><small class="pf-hint">Use apenas links oficiais gerados na sua conta de afiliado.</small></section><section class="pf-card"><h2>Onde publicar</h2><fieldset class="connection-select"><legend class="sr-only">Conexões para publicar este produto</legend><p>Os envios usam apenas os grupos autorizados das contas selecionadas.</p><div class="connection-choices">'+(opts||'<p>Cadastre uma conexão WAHA antes de publicar.</p>')+'</div></fieldset><label class="disclosure-option"><input name="show_disclosure" value="yes" type="checkbox"'+(p.show_disclosure?' checked':'')+'> Incluir aviso de publicidade e disponibilidade no WhatsApp (opcional)</label></section></div><aside class="pf-side"><section class="pf-card"><h2>Imagem</h2><div class="pf-preview" data-image-preview>'+(p.image_url?'<img src="'+esc(p.image_url)+'" alt="Imagem atual do produto">':'<span>Sem imagem</span>')+'</div><div class="dropzone" tabindex="0"><span class="dropzone-label">Arraste uma imagem aqui ou clique para selecionar</span><input name="image" type="file" accept="image/png,image/jpeg,image/webp"></div><label>URL alternativa da imagem<input name="image_url" maxlength="2000" value="'+esc(p.image_url)+'" placeholder="https://..."></label><small class="pf-hint">JPEG, PNG ou WebP. Envie um arquivo ou informe uma URL.</small></section><section class="pf-card"><h2>Disponibilidade</h2><label>Status<select name="status"><option value="draft"'+(!active?' selected':'')+'>Rascunho</option><option value="active"'+(active?' selected':'')+'>Publicado</option></select></label></section></aside></div><div class="pf-savebar"><a class="ui-btn pf-cancel" href="/admin">Cancelar</a><button class="ui-btn btn-green">Salvar produto</button></div></form>';}

function renderBrandSettings(brand,saved=false){
 const name=esc(brand.site_name);
 const logo=brand.has_logo?'<div class="brand-asset-preview"><img alt="Logomarca atual" src="/brand/logo.png?v='+brand.version+'"></div><label class="brand-removal"><input type="checkbox" name="remove_logo" value="yes"> Remover logomarca atual</label>':'<p class="brand-empty">Nenhuma logomarca cadastrada.</p>';
 const themes=THEMES.map(t=>'<label class="theme-option" data-preview-theme="'+t.id+'"><input type="radio" name="theme" value="'+t.id+'"'+(effectiveTheme(brand.theme_id)===t.id?' checked':'')+'><span class="theme-option-body"><span class="theme-sample" aria-hidden="true"><span class="theme-sample-nav"><i></i><i></i><i></i></span><span class="theme-sample-main"><i></i><i></i><b></b></span></span><span class="theme-option-label"><strong>'+esc(t.name)+'</strong><span class="theme-tag">'+(t.mode==='dark'?'Escuro':'Claro')+'</span></span><small>'+esc(t.description)+'</small></span></label>').join('');
 const favicon=brand.has_favicon?'<div class="brand-asset-preview brand-favicon-preview"><img alt="Favicon atual" src="/brand/favicon.png?v='+brand.version+'"></div><label class="brand-removal"><input type="checkbox" name="remove_favicon" value="yes"> Remover favicon atual</label>':'<p class="brand-empty">Nenhum favicon cadastrado.</p>';
 return '<header class="page-head"><div><h1>Configurações</h1><p>Identidade e aparência da sua central.</p></div></header>'+
 (saved?'<p class="brand-save-success" role="status">Configurações salvas com sucesso.</p>':'')+
 '<form class="brand-config-form" method="post" action="/admin/settings" enctype="multipart/form-data">'+
 '<div class="brand-field"><label for="site-name">Nome do site</label><input id="site-name" type="text" name="site_name" minlength="2" maxlength="80" value="'+name+'" required><small>Nome exibido no painel e na página de login.</small></div>'+
 '<div class="brand-field"><label for="whatsapp-group-url">Link do grupo de WhatsApp</label><input id="whatsapp-group-url" type="url" name="whatsapp_group_url" maxlength="1000" value="'+esc(brand.whatsapp_group_url||'')+'" placeholder="https://chat.whatsapp.com/convite"><small>Convite incluído ao final das ofertas. Deixe vazio para não incluir.</small></div>'+
 '<fieldset class="theme-settings" aria-label="Tema de cores"><legend>Temas de cores</legend><p>Selecione um tema para pré-visualizar. Salve para aplicar.</p><div class="theme-grid">'+themes+'</div><small class="theme-hint">A mudança de cores não altera produtos, conexões nem a programação automática.</small></fieldset>'+
 '<div class="brand-upload-grid">'+
 '<div class="brand-upload-box"><h2>Logomarca</h2><p>A logomarca substitui o nome no topo do menu lateral e também aparece na tela de login.</p>'+logo+'<label for="brand-logo">Enviar logomarca (PNG, JPG ou WebP)</label><input id="brand-logo" type="file" name="logo" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"><small>Recomendado: fundo transparente, formato horizontal, até 3 MB.</small></div>'+
 '<div class="brand-upload-box"><h2>Favicon do navegador</h2><p>Ícone pequeno exibido na aba e nos favoritos do navegador.</p>'+favicon+'<label for="brand-favicon">Enviar favicon (PNG, JPG ou WebP)</label><input id="brand-favicon" type="file" name="favicon" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"><small>Recomendado: imagem quadrada, até 3 MB. O sistema adapta para 64 × 64 px.</small></div>'+
 '</div><div class="settings-utilities"><a href="/admin/catalog-health">Saúde do catálogo '+ICONS.arrow+'</a><a href="/admin/diagnostics">Diagnóstico do sistema '+ICONS.arrow+'</a></div><div class="brand-settings-footer"><button class="ui-btn btn-blue" type="submit">Salvar configurações</button></div></form>';
}
async function readBody(req){let s='';for await(const chunk of req){s+=chunk;if(s.length>30000)throw Error('Limite excedido');}return Object.fromEntries(new URLSearchParams(s));}
const server=http.createServer((req,res)=>requestContext.run({path:new URL(req.url,'http://localhost').pathname},()=>handleRequest(req,res)));
async function handleRequest(req,res){
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  
  if((path==='/brand/logo.png'||path==='/brand/favicon.png')&&req.method==='GET'){
   if(!ready){res.writeHead(503);return res.end('Service unavailable');}
   const media=await getBrandAsset(pool,path==='/brand/logo.png'?'logo':'favicon');
   if(!media){res.writeHead(404,{'cache-control':'no-store'});return res.end('Imagem não cadastrada');}
   res.writeHead(200,{'content-type':'image/png','cache-control':'no-store','x-content-type-options':'nosniff'});
   return res.end(media);
  }
  if(path==='/login.css'&&req.method==='GET'){
   const css=await require('node:fs/promises').readFile(require('node:path').join(__dirname,'login.css'),'utf8');
   res.writeHead(200,{'content-type':'text/css; charset=utf-8','cache-control':'public,max-age=300','x-content-type-options':'nosniff'});return res.end(css);
  }
  if(path==='/login'&&req.method==='GET'){
   const next=loginAuth.safeNext(new URL(req.url,'http://localhost').searchParams.get('next'));
   if(loginAuth.validSession(loginAuth.cookieFromRequest(req))){
    res.writeHead(303,{'location':next,'cache-control':'no-store'});return res.end();
   }
   if(!loginAuth.configured())return sendLogin(res,503,{next,error:'O acesso ainda não foi configurado no servidor.',unavailable:true});
   return sendLogin(res,200,{next});
  }
  if(path==='/login'&&req.method==='POST'){
   if(!validOrigin(req))return sendLogin(res,403,{error:'Solicitação não autorizada. Atualize a página e tente novamente.'});
   if(!loginAuth.configured())return sendLogin(res,503,{error:'Credenciais administrativas indisponíveis.',unavailable:true});
   const source=req.socket?.remoteAddress||'unknown';
   if(!loginAuth.loginAllowed(source))return sendLogin(res,429,{error:'Muitas tentativas de acesso. Aguarde 15 minutos antes de tentar novamente.'});
   const f=await readBody(req),next=loginAuth.safeNext(f.next);
   if(!loginAuth.credentialsMatch(f.username,f.password)){
    loginAuth.noteFailedLogin(source);
    return sendLogin(res,401,{next,error:'Usuário ou senha incorretos. Verifique os dados e tente novamente.'});
   }
   loginAuth.clearFailedLogins(source);
   res.writeHead(303,{'location':next,'set-cookie':loginAuth.sessionCookie(loginAuth.createSession()),'cache-control':'no-store, max-age=0'});
   return res.end();
  }
  if(path==='/logout'&&req.method==='POST'){
   if(!validOrigin(req)){res.writeHead(403);return res.end('Origem não autorizada');}
   res.writeHead(303,{'location':'/login','set-cookie':loginAuth.clearCookie(),'cache-control':'no-store, max-age=0'});
   return res.end();
  }
  if(path==='/themes.css'&&req.method==='GET'){
   const css=await require('node:fs/promises').readFile(require('node:path').join(__dirname,'themes.css'),'utf8');
   res.writeHead(200,{'content-type':'text/css; charset=utf-8','cache-control':'public,max-age=300','x-content-type-options':'nosniff'});
   return res.end(css);
  }
  if(path==='/shell.css'&&req.method==='GET'){
   const fs=require('node:fs/promises');
   const css=await fs.readFile(require('node:path').join(__dirname,'shell.css'),'utf8');
   res.writeHead(200,{'content-type':'text/css; charset=utf-8','cache-control':'public,max-age=300','x-content-type-options':'nosniff'});
   return res.end(css);
  }
  if(path==='/upload-ui.js'&&req.method==='GET'){
   const script=await require('node:fs/promises').readFile(require('node:path').join(__dirname,'upload-ui.js'),'utf8');
   res.writeHead(200,{'content-type':'application/javascript; charset=utf-8','cache-control':'public,max-age=300','x-content-type-options':'nosniff'});return res.end(script);
  }
  if(path.startsWith('/uploads/')&&req.method==='GET'){
    const file=await getImage(path.slice('/uploads/'.length));
    if(!file){res.writeHead(404);return res.end('Not found');}
    res.writeHead(200,{'content-type':file.type,'cache-control':'public,max-age=86400','x-content-type-options':'nosniff'});
    return res.end(file.body);
  }
  if(path==='/health'){try{await pool.query('SELECT 1');res.writeHead(200,{'content-type':'application/json'});return res.end('{"status":"ok","database":"connected"}');}catch{res.writeHead(503);return res.end('database unavailable');}}
  if(req.method==='GET'&&/^\/r\/[^/]+$/.test(path)){if(!ready){res.writeHead(302,{location:'/'});return res.end();}return clicks.handleRedirect(pool,req,res,decodeURIComponent(path.slice(3)));}
  if(path.startsWith('/admin')&&!admin(req,res))return;
  if(!ready)return send(res,503,'<h1>Inicializando banco de dados</h1>');
  if(path==='/admin/overview'&&req.method==='GET'){
   const [count,report,stats,recent,connections]=await Promise.all([
    pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status='active')::int AS active FROM products"),
    scheduleDiagnostics(pool),clicks.stats(pool,7),
    pool.query("SELECT d.status,d.product_id,d.group_id,p.title,g.name AS group_name FROM dispatch_log d LEFT JOIN products p ON p.id=d.product_id LEFT JOIN rotation_groups g ON g.id=d.group_id WHERE d.id > (SELECT history_hidden_before_id FROM dispatch_settings WHERE id=1) ORDER BY d.updated_at DESC LIMIT 5"),
    listConnections(pool)
   ]);
   return send(res,200,renderOverview({counts:count.rows[0],report,stats,recent:recent.rows,connections:connections.length}));
  }
  if(req.method==='GET'&&/^\/admin\/groups\/[1-9][0-9]*\/photo$/.test(path)){
   const photo=await loadGroupPhoto(pool,path.split('/')[3]);
   res.writeHead(photo?200:204,{'content-type':photo?'image/webp':'text/plain','cache-control':photo?'private,max-age=3600':'private,max-age=60','x-content-type-options':'nosniff'});
   return res.end(photo||undefined);
  }
  if(path==='/admin/clicks'&&req.method==='GET'){const s=await clicks.stats(pool,new URL(req.url,'http://localhost').searchParams.get('days'));return send(res,200,clicks.renderClicks(s,esc));}
  
  if(path==='/admin/settings'&&req.method==='GET'){
   const notice=new URL(req.url,'http://localhost').searchParams.get('saved')==='1';
   return send(res,200,renderBrandSettings(brandingState,notice));
  }
  if(path==='/admin/settings'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada.');
   let upload,site_name,logo,favicon,whatsapp_group_url,theme;
   try{
    upload=await readBrandForm(req);
    site_name=validateSiteName(upload.fields.site_name);
    theme=validateTheme(upload.fields.theme);
    whatsapp_group_url=validateWhatsAppGroupUrl(upload.fields.whatsapp_group_url);
    if(upload.files.logo)logo=await normalizeImage(upload.files.logo,'logo');
    else if(upload.fields.remove_logo==='yes')logo=null;
    if(upload.files.favicon)favicon=await normalizeImage(upload.files.favicon,'favicon');
    else if(upload.fields.remove_favicon==='yes')favicon=null;
   }catch(error){
    return send(res,400,'<h1>Não foi possível salvar as configurações</h1><p>'+esc(error.message)+'</p><p><a href="/admin/settings">← Voltar às configurações</a></p>');
   }
   brandingState=await updateBrand(pool,{site_name,logo,favicon,whatsapp_group_url,theme});
   res.writeHead(303,{'location':'/admin/settings?saved=1','cache-control':'no-store'});return res.end();
  }
  if(path==='/admin/automation/history/clear'&&req.method==='GET'){
   const day=dispatch.localDay(),settings=await dispatch.controls(pool);
   const [previous,today]=await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM dispatch_log WHERE day < $1',[day]),
    pool.query('SELECT count(*)::int AS n FROM dispatch_log WHERE day=$1 AND id > $2::bigint',[day,String(settings.history_hidden_before_id||0)])
   ]);
   return send(res,200,'<h1>Limpar histórico de publicações</h1><article class="history-cleanup-review"><h2>Confirmação de limpeza</h2><p>Serão removidos definitivamente <strong>'+previous.rows[0].n+' registros de dias anteriores</strong> e ocultados <strong>'+today.rows[0].n+' registros de hoje</strong> do histórico exibido.</p><p>Os registros operacionais de hoje permanecerão protegidos até o encerramento do dia, para impedir publicações duplicadas e preservar o limite de ofertas por grupo. Os contadores operacionais de hoje não serão zerados.</p><p>A programação continuará funcionando normalmente. Novas publicações aparecerão no histórico depois da limpeza.</p><form method="post" action="/admin/automation/history/clear"><label class="history-cleanup-confirm"><input type="checkbox" name="confirm" value="yes" required> Confirmo que desejo limpar o histórico exibido.</label><button class="ui-btn btn-red">Confirmar limpeza</button></form></article><div class="actions-bar"><a class="ui-btn btn-blue" href="/admin/automation">Cancelar e voltar ao histórico</a></div>');
  }
  if(path==='/admin/automation/history/clear'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const fields=await readBody(req);
   if(fields.confirm!=='yes')return send(res,400,'Confirme a limpeza do histórico antes de continuar.');
   await dispatch.clearHistory(pool);
   res.writeHead(303,{location:'/admin/automation?notice=history-cleared'});return res.end();
  }
  if(path==='/admin/automation'&&req.method==='GET'){
   const state=await dispatch.controls(pool),day=dispatch.localDay();
   const summary=await dispatch.summary(pool,day);
   const rows=await pool.query("SELECT l.*,p.title,g.name AS group_name FROM dispatch_log l LEFT JOIN products p ON p.id=l.product_id LEFT JOIN rotation_groups g ON g.id=l.group_id WHERE l.id > $1::bigint ORDER BY l.day DESC,l.id DESC LIMIT 500",[String(state.history_hidden_before_id||0)]);
   const config='<article><strong>Segurança: '+(state.paused?'Pausado':'Em execução')+'</strong> | Envio: '+(state.send_enabled?'Habilitado':'Desabilitado')+'</article>';
   const enable='<article><h3>Habilitar envio real (ação explícita)</h3><p>Ative apenas depois de confirmar consentimento dos grupos e conformidade com WhatsApp e programa de afiliados. Após ativado, o processador executa os horários programados. Uma falha ambígua não é reenviada automaticamente.</p><form method="post" action="/admin/automation/enable"><label>Confirmação<input name="confirm" placeholder="Digite HABILITAR ENVIOS" required></label><button class="ui-btn btn-violet">Habilitar envios reais</button></form></article>';
   const actions='<div class="actions-bar"><form method="post" action="/admin/automation/control"><input type="hidden" name="mode" value="pause"><button class="ui-btn btn-amber">Pausar</button></form><form method="post" action="/admin/automation/control"><input type="hidden" name="mode" value="resume"><button class="ui-btn btn-green">Retomar (sem habilitar envios)</button></form><form method="post" action="/admin/automation/control"><input type="hidden" name="mode" value="disable"><button class="ui-btn btn-red">Desativar envios</button></form></div>';
   const notice=new URL(req.url,'http://localhost').searchParams.get('notice');
   const feedback=notice==='history-cleared'?'<p class="program-notice" role="status">Histórico de visualização limpo. Registros de segurança e contadores operacionais de hoje preservados.</p>':notice==='retry-sent'?'<p class="program-notice" role="status">Reenvio confirmado pela API WAHA para o mesmo grupo.</p>':notice==='retry-failed'?'<p class="program-notice" role="status">O WhatsApp não confirmou a nova tentativa. O registro permanece como falha.</p>':notice==='retry-invalid'?'<p class="program-notice" role="status">Produto, grupo ou conexão indisponível para reenvio.</p>':notice==='retry-unavailable'?'<p class="program-notice" role="status">Este registro não está mais marcado como falha e não foi reenviado.</p>':'';
   const grouped=new Map();
   for(const record of rows.rows){
    const recordDay=String(record.day instanceof Date?record.day.toISOString().slice(0,10):record.day).slice(0,10);
    if(!grouped.has(recordDay))grouped.set(recordDay,[]);
    grouped.get(recordDay).push(record);
   }
   const historyByDay=[...grouped.entries()].map(([date,items])=>'<section class="history-day"><h2>Histórico de '+esc(date===day?'hoje ('+formatDateBR(date)+')':formatDateBR(date))+'</h2><div class="history-grid">'+items.map(x=>'<div class="history-card"><div class="history-head"><strong>'+(x.slot>=9999?'Publicação manual':String(Math.floor(x.slot/60)).padStart(2,'0')+':'+String(x.slot%60).padStart(2,'0'))+'</strong><span class="history-status status-'+esc(x.status)+'">'+esc(statusPt(x.status))+'</span></div><div class="history-attempt-info"><small>Agendamento original: '+(x.slot>=9999?'Manual':String(Math.floor(x.slot/60)).padStart(2,'0')+':'+String(x.slot%60).padStart(2,'0'))+'</small><small>Tentativas: '+Number(x.attempts||0)+'</small><small>Última atualização: '+esc(x.updated_at?new Date(x.updated_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit'}):'Não disponível')+'</small></div><div class="history-product" title="'+esc(x.title||('#'+x.product_id))+'">'+esc(x.title||('#'+x.product_id))+'</div><small class="history-group" title="'+esc(x.group_name||('#'+x.group_id))+'">'+esc(x.group_name||('#'+x.group_id))+'</small>'+(x.detail?'<small class="history-detail" title="'+esc(x.detail)+'">'+esc(x.detail)+'</small>':'')+(x.status==='failed'?'<form method="post" action="/admin/automation/retry" class="history-retry-form" data-confirm-retry><input type="hidden" name="id" value="'+esc(x.id)+'"><button type="submit" class="ui-btn btn-amber" data-confirm="Tentar enviar novamente este mesmo produto ao mesmo grupo? A falha anterior pode ter ocorrido após o WhatsApp receber a mensagem, causando duplicação.">Tentar novamente</button></form>':'')+'</div>').join('')+'</div></section>').join('');
   return send(res,200,head('','Histórico de envios','Acompanhe as publicações mais recentes.','<a class="ui-btn btn-blue" href="/admin/plan">Ver programação '+ICONS.arrow+'</a>')+feedback+'<div class="catalog-summary">'+Object.entries(summary).map(([k,v])=>'<span><strong>'+v+'</strong> '+esc(statusPt(k))+'</span>').join('')+'</div><section class="utility-disclosure always-visible-controls"><h3>Ferramentas e controles de envio</h3><div class="disclosure-content">'+config+actions+(!state.send_enabled?enable:'')+'<p>Retomar libera o planejamento. Habilitar envios é uma ação separada.</p><div class="actions-bar"><a class="ui-btn" href="/admin/simulate">Simular programação</a><a class="ui-btn btn-red" href="/admin/automation/history/clear">Limpar histórico</a></div></div></section>'+(historyByDay||'<div class="empty-state">Nenhuma operação visível no histórico.</div>'));
  }
  if(path==='/admin/automation/retry'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   if(!/^[0-9]+$/.test(f.id||''))return send(res,400,'Registro inválido');
   const outcome=await dispatch.retryFailed(pool,{logId:f.id,getConnection:id=>getConnection(pool,id)});
   res.writeHead(303,{location:'/admin/automation?notice=retry-'+encodeURIComponent(outcome.status),'cache-control':'no-store'});return res.end();
  }
  if(path==='/admin/automation/enable'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   if(f.confirm!=='HABILITAR ENVIOS')return send(res,400,'Confirmação inválida. Digite HABILITAR ENVIOS.');
   const groups=await pool.query('SELECT count(*)::int AS n FROM rotation_groups WHERE enabled=true');
   const products=await pool.query("SELECT count(*)::int AS n FROM products WHERE status='active'");
   const config=(await listConnections(pool))[0];
   if(!config||!groups.rows[0].n||!products.rows[0].n)return send(res,400,'É necessário ter WAHA configurado, produtos ativos e grupos autorizados.');
   await dispatch.setControls(pool,{paused:false,sendEnabled:true});
   res.writeHead(303,{location:'/admin/automation'});return res.end();
  }
  if(path==='/admin/automation/control'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   if(f.mode==='pause')await dispatch.setControls(pool,{paused:true});
   else if(f.mode==='resume')await dispatch.setControls(pool,{paused:false,sendEnabled:false});
   else if(f.mode==='disable')await dispatch.setControls(pool,{paused:true,sendEnabled:false});
   else return send(res,400,'Ação desconhecida');
   res.writeHead(303,{location:'/admin/automation'});return res.end();
  }
  if(path==='/admin/simulate'&&req.method==='GET'){
   const day=dispatch.localDay();
   const plans=await pool.query('SELECT assignments FROM rotation_plans WHERE day=$1',[day]);
   if(!plans.rowCount)return send(res,200,'<h1>Simulação</h1><p>Gere o planejamento do dia primeiro.</p><a href="/admin/plan">Abrir programação</a>');
   const entries=plans.rows[0].assignments;
   const settings=await dispatch.controls(pool);
   const products=await pool.query('SELECT id,title FROM products WHERE id=ANY($1::bigint[])',[entries.map(x=>x.productId)]);
   const groups=await pool.query('SELECT g.id,g.name,c.label AS connection_label FROM rotation_groups g LEFT JOIN waha_connections c ON c.id=g.connection_id WHERE g.enabled=true ORDER BY g.id');
   const logs=await pool.query("SELECT group_id,product_id,status FROM dispatch_log WHERE day=$1 AND status IN ('reserved','sent','failed')",[day]);
   const p=new Map(products.rows.map(x=>[String(x.id),x.title])),g=new Map(groups.rows.map(x=>[String(x.id),x.name])),connections=new Map(groups.rows.map(x=>[String(x.id),x.connection_label||'Conexão não identificada']));
   const attempted=new Set(logs.rows.map(x=>String(x.group_id)+':'+String(x.product_id)));
   const pending=entries.filter(x=>!attempted.has(String(x.groupId)+':'+String(x.productId)));
   const totals={sent:0,pending:pending.length,failed:0};
   const rows=groups.rows.map(group=>{
    const history=logs.rows.filter(x=>String(x.group_id)===String(group.id));
    const sent=history.filter(x=>x.status==='sent').length,reserved=history.filter(x=>x.status==='reserved').length,failed=history.filter(x=>x.status==='failed').length;
    const planned=pending.filter(x=>String(x.groupId)===String(group.id)).length;
    const missing=Math.max(0,settings.daily_limit-sent-reserved-planned);
    totals.sent+=sent;totals.failed+=failed;
    return '<tr><td>'+esc(group.name)+'</td><td>'+settings.daily_limit+'</td><td>'+sent+'</td><td>'+planned+'</td><td>'+reserved+'</td><td>'+failed+'</td><td>'+missing+'</td></tr>';
   }).join('');
   return send(res,200,'<h1>Simulação — sem envios</h1><p>Meta de '+settings.daily_limit+' produtos distintos por grupo: '+groups.rowCount*settings.daily_limit+' publicações no dia. A fila é global: produtos diferentes entre os grupos até esgotar o catálogo. A lista então recomeça no mesmo dia para completar a meta.</p><p>Confirmadas: '+totals.sent+' · Agendadas: '+totals.pending+' · Falhas: '+totals.failed+'</p><p>Falhas não contam como entrega. Para evitar duplicações, o mesmo produto com falha não é tentado novamente no grupo hoje; outra oferta pode completar a meta. Lacunas podem indicar falta de produtos aptos ou tempo insuficiente.</p><div style="overflow-x:auto"><table><thead><tr><th>Grupo</th><th>Meta</th><th>Confirmadas</th><th>Agendadas</th><th>Em andamento</th><th>Falhas</th><th>Sem agendamento</th></tr></thead><tbody>'+rows+'</tbody></table></div><h2>Próximas ofertas</h2><div class="upcoming-offers-grid">'+pending.map(x=>'<article class="upcoming-offer-card"><div class="upcoming-offer-product"><time>'+String(Math.floor(x.minuteOfDay/60)).padStart(2,'0')+':'+String(x.minuteOfDay%60).padStart(2,'0')+'</time><strong>'+esc(p.get(String(x.productId))||x.productId)+'</strong></div><div class="upcoming-offer-meta"><span><b>Conexão:</b> '+esc(connections.get(String(x.groupId))||'Conexão não identificada')+'</span><span><b>Grupo:</b> '+esc(g.get(String(x.groupId))||x.groupId)+'</span></div></article>').join('')+'</div>'+'<p><a href="/admin/plan">Voltar</a></p>');
  }
  if(path==='/admin/delete'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   if(!/^[0-9]+$/.test(f.id||''))return send(res,400,'ID inválido');
   await pool.query('DELETE FROM products WHERE id=$1',[f.id]);
   try{await replanCatalog()}catch(error){console.error('catalog_replan_after_delete_failed',error.code||error.name||'ERROR')}
   res.writeHead(303,{location:'/admin'});return res.end();
  }
  if(path==='/admin/plan/status'&&req.method==='GET'){
   const report=await scheduleDiagnostics(pool);
   res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store, max-age=0','x-content-type-options':'nosniff'});
   return res.end(JSON.stringify(report));
  }
  if(path==='/admin/plan'&&req.method==='GET'){
   const settings=await dispatch.controls(pool);
   const products=await pool.query("SELECT count(*)::int AS n FROM products WHERE status='active'");
   const groups=await pool.query("SELECT count(*)::int AS n FROM rotation_groups WHERE enabled=true");
   const badges='<div class="plan-stat-row"><span class="plan-stat"><strong>'+products.rows[0].n+'</strong> produtos ativos</span><span class="plan-stat"><strong>'+groups.rows[0].n+'</strong> grupos autorizados</span><span class="plan-stat"><strong>'+settings.daily_limit+'</strong> produtos por grupo/dia</span><span class="plan-stat">'+esc(settings.window_start)+' – '+esc(settings.window_end)+'</span></div>';
   const toolbar='<div class="program-options-grid program-shortcut-grid"><div class="program-option-card"><div class="program-option-card-heading"><strong>Simular programação</strong><span>Confira as próximas ofertas e os horários previstos.</span></div><a class="ui-btn btn-violet" href="/admin/simulate">Simular programação</a></div><div class="program-option-card"><div class="program-option-card-heading"><strong>Automação e histórico</strong><span>Acompanhe os registros e resultados dos envios.</span></div><a class="ui-btn btn-teal" href="/admin/automation">Automação e histórico</a></div><div class="program-option-card"><div class="program-option-card-heading"><strong>Gerenciar grupos</strong><span>Consulte e configure os grupos de destino.</span></div><a class="ui-btn btn-amber" href="/admin/groups">Gerenciar grupos</a></div></div>';
   const settingsForm='<section class="setting-card"><h2>Configurar programação</h2><form method="post" action="/admin/plan/settings"><div class="fields-inline"><label>Produtos por grupo por dia<input type="number" min="1" max="20" name="daily" value="'+settings.daily_limit+'" required></label><label>Início<input type="time" name="start" value="'+esc(settings.window_start)+'" required></label><label>Fim<input type="time" name="end" value="'+esc(settings.window_end)+'" required></label></div><div class="settings-actions"><button class="ui-btn btn-green">Salvar configuração</button></div></form></section>';
   const report=await scheduleDiagnostics(pool);
   const active=report.running;
   const notice=new URL(req.url,'http://localhost').searchParams.get('notice');
   const noticeHtml=notice==='start'?'<p class="program-notice" role="status">Comando recebido: programação iniciada ou retomada. Confira o próximo envio abaixo.</p>':notice==='restart'?'<p class="program-notice" role="status">Comando recebido: fila reiniciada e horários recalculados.</p>':notice==='pause'?'<p class="program-notice" role="status">Comando recebido: programação pausada.</p>':'';
   const startAction='<form class="program-inline-action" action="/admin/plan/control" method="post"><input name="mode" value="start" type="hidden"><input name="confirm" value="yes" type="hidden"><small>Ao iniciar, você autoriza os envios reais aos grupos habilitados.</small><button class="ui-btn btn-green">Iniciar / Retomar</button></form>';
   const pauseAction='<form class="program-inline-action" action="/admin/plan/control" method="post"><input name="mode" value="pause" type="hidden"><button class="ui-btn btn-amber">Pausar programação</button></form>';
   const controlPanel='<section class="program-control-panel" aria-label="Controles da programação automática"><div class="program-control-header"><div><span class="program-status '+(!active?'is-paused':report.windowPhase==='open'?'is-running':'is-waiting')+'">'+esc(report.statusLabel)+'</span><h2>Envios automáticos</h2><p>Seus horários e limites são respeitados em cada conexão.</p></div>'+(active?pauseAction:startAction)+'</div></section>';
   const moreControls='<section class="utility-disclosure program-options-visible"><div class="program-options-heading"><h3>Mais opções da programação</h3><p>Gerencie os envios e acesse as ferramentas da programação.</p></div><div class="program-options-grid"><div class="program-option-card"><div class="program-option-card-heading"><strong>Controle de envios</strong><span>Iniciar ou pausar a programação automática.</span></div>'+(active?startAction:pauseAction)+'</div><div class="program-option-card program-option-restart"><form class="restart-action" action="/admin/plan/control" method="post" data-confirm-restart><input name="mode" value="restart" type="hidden"><input type="hidden" name="confirm_phrase" value="REINICIAR"><div><strong>Reiniciar fila</strong><p>Recalcula os horários e volta ao início da fila, preservando as ofertas já enviadas hoje. Uma confirmação será solicitada.</p></div><button class="ui-btn btn-red">Reiniciar fila</button></form></div></div><div class="program-options-shortcuts"><strong>Ferramentas de controle de envio</strong>'+toolbar+'</div></section>';
   return send(res,200,head('','Programação','Gerencie os horários e acompanhe os envios automáticos.')+controlPanel+noticeHtml+'<section class="program-diagnostics" data-schedule-status><h2>Acompanhamento da automação</h2><div class="program-diagnostics-stats"><span>Grupos aptos: <strong data-status-eligible>'+report.eligibleGroupCount+'</strong> / '+report.groupCount+'</span><span>Agendadas: <strong data-status-planned>'+report.planned+'</strong></span><span>Enviadas: <strong data-status-sent>'+report.sent+'</strong></span><span>Pendentes: <strong data-status-pending>'+report.pending+'</strong></span><span>Falhas: <strong data-status-failed>'+report.failed+'</strong></span></div><p><strong>Próximo envio:</strong> <span data-status-next>'+(report.nextAt?esc(new Date(report.nextAt).toLocaleTimeString('pt-BR',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',second:'2-digit'})):esc(report.nextLabel))+'</span></p><p data-status-reason>'+esc(report.explanation)+'</p><p data-status-error>'+(report.lastFailure?'Última falha: '+esc(report.lastFailure):'')+'</p></section>'+settingsForm+moreControls);
  }
  if(path==='/admin/plan/settings'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   try{
    await dispatch.setSchedule(pool,{daily:f.daily,start:f.start,end:f.end});
    const state=await dispatch.controls(pool);
    if(!state.paused&&state.send_enabled){
     const ids=(await pool.query('SELECT id FROM rotation_groups WHERE enabled=true ORDER BY id')).rows.map(x=>String(x.id));
     await planDay(pool,dispatch.localDay(),ids,{daily:state.daily_limit,start:state.window_start,end:state.window_end,now:new Date(),refresh:true});
    }
   }
   catch(e){return send(res,400,'<h1>Configuração inválida</h1><p>'+esc(e.message)+'</p><a href="/admin/plan">Voltar</a>')}
   res.writeHead(303,{location:'/admin/plan'});return res.end();
  }
  if(path==='/admin/plan/control'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   if(f.mode==='pause'){
    await dispatch.setControls(pool,{paused:true});
   }else if(f.mode==='start'||f.mode==='restart'){
    if(f.mode==='start'&&f.confirm!=='yes')return send(res,400,'Confirme a autorização para envios reais.');
    if(f.mode==='restart'&&f.confirm_phrase!=='REINICIAR')return send(res,400,'Digite REINICIAR para confirmar.');
    const eligible=await pool.query("SELECT 1 FROM products p JOIN product_connections pc ON pc.product_id=p.id JOIN rotation_groups g ON g.connection_id=pc.connection_id WHERE p.status='active' AND g.enabled=true LIMIT 1");
    if(!eligible.rowCount)return send(res,400,'Cadastre produtos ativos e grupos autorizados nas conexões correspondentes.');
    const state=await dispatch.controls(pool);
    const ids=(await pool.query('SELECT id FROM rotation_groups WHERE enabled=true ORDER BY id')).rows.map(x=>String(x.id));
    // Reflow today's unsent offers, keeping sent/failed/reserved history intact.
    // Restart resets product order within the same transaction used to replace the plan.
    await planDay(pool,dispatch.localDay(),ids,{daily:state.daily_limit,start:state.window_start,end:state.window_end,now:new Date(),refresh:true,restart:f.mode==='restart'});
    await dispatch.setControls(pool,{paused:false,sendEnabled:true});
    void scheduler();
   }else return send(res,400,'Operação desconhecida');
   res.writeHead(303,{location:'/admin/plan?notice='+encodeURIComponent(f.mode)});return res.end();
  }
  if(path==='/admin/groups/enable'&&req.method==='POST'){
    if(!validOrigin(req))return send(res,403,'Origem não autorizada');
    const f=await readBody(req);
    if(!/^[0-9]+$/.test(f.id||'')||!['yes','no'].includes(f.enabled))return send(res,400,'Seleção inválida');
    const db=await pool.connect();
    let chosenConnectionId='';
    try{
     await db.query('BEGIN');
     await db.query('SELECT pg_advisory_xact_lock(471022)');
     const selected=await db.query('SELECT enabled,connection_id FROM rotation_groups WHERE id=$1',[f.id]);
     if(!selected.rowCount){await db.query('ROLLBACK');return send(res,404,'Grupo não encontrado')}
     chosenConnectionId=String(selected.rows[0].connection_id||'');
     await db.query('UPDATE rotation_groups SET enabled=$1 WHERE id=$2',[f.enabled==='yes',f.id]);
     await db.query('COMMIT');
    }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
    if(String(req.headers.accept||'').includes('application/json')){
     const counts=await pool.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE enabled)::int AS enabled FROM rotation_groups WHERE connection_id=$1",[chosenConnectionId]);
     res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store, max-age=0','x-content-type-options':'nosniff'});
     return res.end(JSON.stringify({ok:true,groupId:String(f.id),connectionId:chosenConnectionId,enabled:f.enabled==='yes',total:counts.rows[0].total,enabledCount:counts.rows[0].enabled}));
    }
    res.writeHead(303,{location:'/admin/groups?connection_id='+encodeURIComponent(chosenConnectionId)});return res.end();
  }
  if(path==='/admin/diagnostics'&&req.method==='GET'){
    const checks={database:false,products:false,wahaSettings:false,uploadVolume:false};
    try{await pool.query('SELECT 1');checks.database=true;}catch{}
    try{await pool.query('SELECT 1 FROM products LIMIT 1');checks.products=true;}catch{}
    try{await initSettings(pool);await pool.query('SELECT 1 FROM waha_settings LIMIT 1');checks.wahaSettings=true;}catch{}
    try{await require('node:fs/promises').access('/data/products');checks.uploadVolume=true;}catch{}
    return send(res,200,'<h1>Diagnóstico da aplicação</h1>'+Object.entries(checks).map(([name,ok])=>'<article>'+esc(name)+': '+(ok?'OK':'Falha')+'</article>').join('')+'<p>Este diagnóstico não mostra senhas, tokens ou chaves.</p>');
  }
  if(path==='/admin/waha'&&req.method==='GET'){
   const list=await listConnections(pool);
   const impact=await pool.query("SELECT c.id,(SELECT count(*)::int FROM rotation_groups g WHERE g.connection_id=c.id) AS groups_total,(SELECT count(*)::int FROM product_connections pc WHERE pc.connection_id=c.id) AS product_links FROM waha_connections c");
   const stats=new Map(impact.rows.map(x=>[String(x.id),x]));
   const cards=list.map(c=>{
    const main=Boolean(c.is_primary),counts=stats.get(String(c.id));
    const choose=main?'<span class="connection-primary-tag">Principal</span>':'<form method="post" action="/admin/waha/primary"><input type="hidden" name="connection_id" value="'+c.id+'"><button class="ui-btn btn-violet" type="submit">Definir como principal</button></form>';
    const actions='<section class="utility-disclosure always-visible-controls"><h3>Configurar conexão</h3><div class="disclosure-content"><p><strong>Sessão:</strong> '+esc(c.session_name)+'</p><p><strong>API:</strong> '+esc(c.base_url)+'</p><div class="actions-bar"><a class="ui-btn" href="/admin/waha/edit?id='+c.id+'">Editar</a><form action="/admin/waha/test" method="post"><input type="hidden" name="connection_id" value="'+c.id+'"><button class="ui-btn">Testar conexão</button></form>'+(!main?choose:'')+'<a class="ui-btn btn-red" href="/admin/waha/delete?id='+c.id+'">Excluir conexão</a></div></div></section>';
    return '<article class="connection-card'+(main?' is-primary':'')+'"><div class="connection-card-header"><span class="connection-avatar" aria-hidden="true">'+ICONS.waha+'</span><h2>'+esc(c.label)+'</h2>'+(main?choose:'')+'</div><p class="connection-impact">'+(counts?.groups_total||0)+' grupos · '+(counts?.product_links||0)+' produtos vinculados</p><a class="connection-groups-link" href="/admin/groups?connection_id='+c.id+'">Gerenciar grupos '+ICONS.arrow+'</a>'+actions+'</article>';
   }).join('');
   const notice=new URL(req.url,'http://localhost').searchParams.get('notice');
   const feedback=notice==='primary'?'<p class="program-notice" role="status">Conexão principal atualizada. Novos produtos serão selecionados automaticamente somente nela.</p>':notice==='deleted'?'<p class="program-notice" role="status">Conexão excluída. Grupos históricos foram preservados sem autorização de envio.</p>':'';
   return send(res,200,head('','Conexões','Gerencie as contas de WhatsApp usadas nas publicações.','<a class="ui-btn btn-green" href="/admin/waha/edit">'+ICONS.add+' Adicionar conexão</a>')+feedback+'<div class="connection-grid">'+(cards||'<div class="empty-state">Nenhuma conexão cadastrada.</div>')+'</div>');
  }
  if(path==='/admin/waha/primary'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   try{await setPrimaryConnection(pool,f.connection_id)}
   catch(e){return send(res,400,'<h1>Não foi possível definir a conexão principal</h1><p>'+esc(e.message)+'</p><a href="/admin/waha">Voltar</a>')}
   res.writeHead(303,{location:'/admin/waha?notice=primary'});return res.end();
  }
  if(path==='/admin/waha/delete'&&req.method==='GET'){
   const id=new URL(req.url,'http://localhost').searchParams.get('id');
   if(!/^[1-9][0-9]*$/.test(String(id||'')))return send(res,400,'Conexão inválida.');
   const list=await listConnections(pool),item=list.find(x=>String(x.id)===id);
   if(!item)return send(res,404,'Conexão não encontrada.');
   if(item.is_primary)return send(res,400,'<h1>Conexão principal protegida</h1><p>Defina outra conexão como principal antes de excluir '+esc(item.label)+'.</p><a href="/admin/waha">Voltar às conexões</a>');
   if(list.length===1)return send(res,400,'<h1>Última conexão</h1><p>Cadastre outra conexão antes de excluir a única existente.</p><a href="/admin/waha">Voltar</a>');
   const [groups,products]=await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM rotation_groups WHERE connection_id=$1',[id]),
    pool.query('SELECT count(*)::int AS n FROM product_connections WHERE connection_id=$1',[id])
   ]);
   return send(res,200,'<h1>Excluir conexão WAHA</h1><article class="connection-delete-review"><h2>'+esc(item.label)+'</h2><p><strong>Sessão:</strong> '+esc(item.session_name)+'</p><p>Serão desativados e arquivados <strong>'+groups.rows[0].n+' grupos</strong>, preservando os registros históricos. Serão removidos <strong>'+products.rows[0].n+' vínculos de produtos</strong> com esta conexão.</p><p>Os produtos não serão excluídos nem transferidos automaticamente para outro número. Produtos sem outras conexões deixarão de ser publicados até que você selecione outra conta.</p><p>Essa ação não pode ser desfeita.</p><form method="post" action="/admin/waha/delete"><input type="hidden" name="id" value="'+esc(item.id)+'"><label class="delete-confirm"><input type="checkbox" name="confirm" value="yes" required> Confirmo a exclusão desta conexão e entendo que seus envios serão interrompidos.</label><button class="ui-btn btn-red">Excluir conexão definitivamente</button></form></article><div class="actions-bar"><a class="ui-btn btn-blue" href="/admin/waha">Cancelar e voltar</a></div>');
  }
  if(path==='/admin/waha/delete'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   if(f.confirm!=='yes')return send(res,400,'Confirme a exclusão da conexão.');
   try{await deleteConnection(pool,f.id)}
   catch(e){return send(res,400,'<h1>Não foi possível excluir a conexão</h1><p>'+esc(e.message)+'</p><a href="/admin/waha">Voltar às conexões</a>')}
   res.writeHead(303,{location:'/admin/waha?notice=deleted'});return res.end();
  }
  if(path==='/admin/waha/edit'&&req.method==='GET'){
   const id=new URL(req.url,'http://localhost').searchParams.get('id');
   const list=await listConnections(pool),item=id?list.find(x=>String(x.id)===id):null;
   if(id&&!item)return send(res,404,'Conexão não encontrada');
   return send(res,200,'<h1>'+(item?'Editar conexão':'Adicionar conexão')+'</h1><form method="post" action="/admin/waha"><input type="hidden" name="id" value="'+esc(id||'')+'"><label>Identificação da conexão<input name="label" maxlength="100" required value="'+esc(item?.label||'')+'" placeholder="Ex.: WhatsApp comercial 2"></label><label>Endereço da API WAHA<input type="url" name="base_url" required value="'+esc(item?.base_url||'')+'"></label><label>Nome da sessão<input name="session" required maxlength="100" value="'+esc(item?.session_name||'')+'"></label><label>Chave da API<input type="password" name="api_key" autocomplete="new-password" '+(item?'':'required')+' placeholder="'+(item?'Deixe vazio para manter a chave atual':'Informe a chave da API')+'"></label><button class="ui-btn btn-green">Salvar conexão</button></form><div class="actions-bar"><a class="ui-btn btn-blue" href="/admin/waha">Voltar às conexões</a></div>');
  }
  if(path==='/admin/waha'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   try{await saveConnection(pool,{id:f.id,label:f.label,baseUrl:f.base_url,session:f.session,apiKey:f.api_key});}
   catch(e){return send(res,400,'<h1>Configuração inválida</h1><p>'+esc(e.message)+'</p><div class="actions-bar"><a class="ui-btn btn-blue" href="/admin/waha">Voltar</a></div>');}
   res.writeHead(303,{location:'/admin/waha'});return res.end();
  }
  if(path==='/admin/waha/test'&&req.method==='POST'){
    if(!validOrigin(req))return send(res,403,'Origem não autorizada');
    const f=await readBody(req);
    const saved=await getConnection(pool,f.connection_id);
    if(!saved)return send(res,400,'<h1>Escolha uma conexão válida.</h1>');
    const jobId=crypto.randomBytes(6).toString('hex');
    wahaTest={id:jobId,status:'running',at:Date.now(),detail:'Aguardando resposta WAHA'};
    res.writeHead(303,{location:'/admin/waha/test-status'});res.end();
    void (async()=>{
      try{
        const address=new URL(saved.baseUrl);
        const endpoint=address.origin+'/api/sessions/'+encodeURIComponent(saved.session);
        const reply=await fetch(endpoint,{method:'GET',headers:{Accept:'application/json','X-Api-Key':saved.apiKey},signal:AbortSignal.timeout(8000),redirect:'error'});
        const auth=String(reply.headers.get('www-authenticate')||'').slice(0,120);
        const type=String(reply.headers.get('content-type')||'').slice(0,100);
        const serverName=String(reply.headers.get('server')||'').slice(0,60);
        const info=reply.ok?'Sessão WAHA respondeu HTTP '+reply.status:'HTTP '+reply.status+' | Tipo: '+(type||'não informado')+' | Autenticação: '+(auth||'não informada')+' | Servidor: '+(serverName||'não informado');
        wahaTest={id:jobId,status:reply.ok?'ok':'failed',at:Date.now(),detail:info};
      }catch(e){
        wahaTest={id:jobId,status:'failed',at:Date.now(),detail:e.code||e.cause?.code||e.name||'Connection error'};
        console.error('waha_test_failure',jobId,e.code||e.cause?.code||e.name);
      }
    })();
    return;
  }
  if(path==='/admin/waha/test-status'&&req.method==='GET'){
    const result=wahaTest;
    const output=result?'<p>Estado: '+esc(statusPt(result.status))+'</p><p>Resposta: '+esc(result.detail)+'</p>':'<p>Nenhum teste iniciado nesta execução.</p>';
    return send(res,200,'<h1>Teste da conexão WAHA</h1>'+output+'<p><a href="/admin/waha/test-status">Atualizar resultado</a> | <a href="/admin/waha">Voltar</a></p><small>A consulta não envia mensagens nem sincroniza grupos.</small>');
  }
  if(path==='/admin/groups'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   const config=await getConnection(pool,f.connection_id);
   if(!config)return send(res,400,'Escolha uma conexão válida.');
   if(groupSync?.status==='running'&&Date.now()-groupSync.started<120000)return send(res,409,'Uma consulta já está em andamento.');
   const job=crypto.randomBytes(6).toString('hex');
   groupSync={id:job,connectionId:config.id,status:'running',message:'Consultando grupos de '+config.label,started:Date.now()};
   res.writeHead(303,{location:'/admin/groups?connection_id='+config.id});res.end();
   void (async()=>{
    try{
     const found=await listGroups(config);
     const db=await pool.connect();
     try{
      await db.query('BEGIN');
      for(const item of found){
       await db.query('INSERT INTO rotation_groups(name,chat_id,enabled,connection_id) VALUES($1,$2,false,$3) ON CONFLICT(connection_id,chat_id) DO UPDATE SET name=EXCLUDED.name',[item.name,item.id,config.id]);
      }
      let archived=0;
      if(found.reconciliation?.complete){
       const missing=await db.query('UPDATE rotation_groups SET enabled=FALSE,connection_id=NULL WHERE connection_id=$1 AND NOT (chat_id=ANY($2::text[])) RETURNING id',[config.id,found.reconciliation.ids]);
       archived=missing.rowCount;
      }
      await db.query('COMMIT');
      await invalidateConnectionPhotos(pool,config.id);
      groupSync={id:job,connectionId:config.id,status:'ok',message:found.length+' grupos consultados de '+config.label+(found.reconciliation?.complete?' · '+archived+' grupos removidos da lista desta conexão':' · conferência de saídas indisponível; nenhum grupo removido'),started:Date.now()};
     }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
    }catch(e){groupSync={id:job,connectionId:config.id,status:'failed',message:'Falha na consulta: '+String(e.message||'erro').slice(0,300),started:Date.now()};console.error('group_sync_error',job,e.code||e.name)}
   })();return;
  }
  if(path==='/admin/groups/status'&&req.method==='GET'){
   const requested=new URL(req.url,'http://localhost').searchParams.get('connection_id');
   if(!/^[1-9][0-9]*$/.test(String(requested||'')))return send(res,400,'Conexão inválida.');
   if(groupSync?.status==='running'&&Date.now()-groupSync.started>120000)groupSync={...groupSync,status:'failed',message:'Tempo de consulta esgotado'};
   const current=groupSync&&String(groupSync.connectionId)===requested?groupSync:null;
   res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store, max-age=0','x-content-type-options':'nosniff'});
   return res.end(JSON.stringify({status:current?.status||'idle',message:current?.message||''}));
  }
  if(path==='/admin/groups'&&req.method==='GET'){
   const connections=await listConnections(pool);
   const requested=new URL(req.url,'http://localhost').searchParams.get('connection_id');
   const selected=connections.find(c=>String(c.id)===requested)||connections[0];
   if(!selected)return send(res,200,'<h1>Grupos de WhatsApp</h1><p>Cadastre uma conexão para consultar os grupos.</p><a class="ui-btn btn-green" href="/admin/waha">Gerenciar conexões WAHA</a>');
   const chosen=String(selected.id);
   // Each WAHA number gets a completely independent group list and counters.
   const [groups,counts]=await Promise.all([
    pool.query('SELECT g.id,g.name,g.enabled,g.connection_id,c.label AS connection_label,COALESCE(EXTRACT(EPOCH FROM gp.updated_at)::bigint,0) AS photo_version FROM rotation_groups g JOIN waha_connections c ON c.id=g.connection_id LEFT JOIN group_photos gp ON gp.group_id=g.id AND gp.connection_id=g.connection_id AND gp.chat_id=g.chat_id WHERE g.connection_id=$1 ORDER BY g.name,g.id',[chosen]),
    pool.query('SELECT connection_id,count(*)::int AS total,count(*) FILTER(WHERE enabled)::int AS enabled FROM rotation_groups GROUP BY connection_id')
   ]);
   const totals=new Map(counts.rows.map(r=>[String(r.connection_id),r]));
   if(groupSync?.status==='running'&&Date.now()-groupSync.started>120000)groupSync={...groupSync,status:'failed',message:'Tempo de consulta esgotado'};
   const feedback=groupSync&&String(groupSync.connectionId||'')===chosen?'<article><strong>Sincronização: '+esc(statusPt(groupSync.status))+'</strong><p>'+esc(groupSync.message)+'</p></article>':'';
   const autoRefresh=groupSync?.status==='running'&&String(groupSync.connectionId||'')===chosen?'<div data-group-sync-poll="'+esc(chosen)+'" aria-hidden="true"></div>':'';
   return send(res,200,renderGroups({connections,selected,groups:groups.rows,counts:counts.rows,feedback,autoRefresh}));
  }
  if(path==='/admin/save'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const upload=req.headers['content-type']?.startsWith('multipart/form-data')?await readMultipart(req):{fields:await readBody(req),image:null};const f=upload.fields, title=String(f.title||'').trim(), affiliate=String(f.affiliate_url||'').trim(), original=String(f.product_url||'').trim(), image=String(f.image_url||'').trim();
   const price=String(f.price||'').trim().replace(',','.');
   if(!title||title.length>180||!validUrl(affiliate)||(original&&!validUrl(original))||(image&&!validUrl(image)&&!image.startsWith('/uploads/'))||String(f.description||'').length>4000||(price&&!/^\d{1,10}(\.\d{1,2})?$/.test(price)))return send(res,400,'<h1>Dados inválidos</h1><a href="/admin">Voltar</a>');
   const selected=Object.keys(f).filter(k=>/^connection_[0-9]+$/.test(k)&&f[k]==='yes').map(k=>k.slice(11));
   if(!selected.length)return send(res,400,'<h1>Selecione pelo menos uma conexão WAHA.</h1><a href="/admin">Voltar</a>');
   const known=await pool.query('SELECT id FROM waha_connections WHERE id=ANY($1::bigint[])',[selected]);
   if(known.rowCount!==selected.length)return send(res,400,'Uma conexão selecionada não existe.');
   const editing=/^[0-9]+$/.test(f.id||'');
   const previous=editing?await pool.query('SELECT image_url FROM products WHERE id=$1',[f.id]):null;
   if(editing&&!previous.rowCount)return send(res,404,'Produto não encontrado');
   let storedImage=image;
   if(upload.image)storedImage=await saveImage(upload.image);
   const fields=[title,String(f.description||''),storedImage,original,affiliate,price?Number(price):null,f.status==='active'?'active':'draft',f.show_disclosure==='yes'];
   const db=await pool.connect();
   try{
    await db.query('BEGIN');
    let productId=f.id;
    if(editing)await db.query('UPDATE products SET title=$1,description=$2,image_url=$3,product_url=$4,affiliate_url=$5,price=$6,status=$7,show_disclosure=$8,updated_at=NOW() WHERE id=$9',[...fields,f.id]);
    else productId=(await db.query('INSERT INTO products(title,description,image_url,product_url,affiliate_url,price,status,show_disclosure) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',fields)).rows[0].id;
    await db.query('DELETE FROM product_connections WHERE product_id=$1',[productId]);
    for(const connectionId of selected)await db.query('INSERT INTO product_connections(product_id,connection_id) VALUES($1,$2)',[productId,connectionId]);
    await db.query('COMMIT');
   }catch(e){await db.query('ROLLBACK').catch(()=>{});if(upload.image)await deleteImage(storedImage).catch(()=>{});throw e}
   finally{db.release()}
   if(editing&&previous.rows[0].image_url!==storedImage){
    const old=previous.rows[0].image_url;
    const refs=await pool.query('SELECT 1 FROM products WHERE image_url=$1 LIMIT 1',[old]);
    if(!refs.rowCount)await deleteImage(old).catch(e=>console.error('old_image_delete_failed',e.code||e.name));
   }
   try{await syncCatalogQueues(pool)}catch(error){console.error('catalog_queue_after_save_failed',error.code||error.name||'ERROR')}
   try{await replanCatalog()}catch(error){console.error('catalog_replan_after_save_failed',error.code||error.name||'ERROR')}
   res.writeHead(303,{location:'/admin'});return res.end();
  }
  if(path==='/admin/publish'&&req.method==='GET'){
   const id=new URL(req.url,'http://localhost').searchParams.get('id');
   if(!/^[0-9]+$/.test(id||''))return send(res,400,'Produto inválido');
   const data=await pool.query('SELECT id,title,image_url,status FROM products WHERE id=$1',[id]);
   if(!data.rowCount)return send(res,404,'Produto não encontrado');
   const product=data.rows[0];
   const groups=await pool.query('SELECT g.id,g.name,c.label FROM rotation_groups g JOIN product_connections pc ON pc.connection_id=g.connection_id JOIN waha_connections c ON c.id=g.connection_id WHERE g.enabled=true AND pc.product_id=$1 ORDER BY c.label,g.name',[id]);
   const options=groups.rows.map(g=>'<option value="'+g.id+'">'+esc(g.label)+' — '+esc(g.name)+'</option>').join('');
   const warning=product.status!=='active'?'<p>O produto está em rascunho. Ative-o na edição antes de publicar.</p>':!groups.rowCount?'<p>Nenhum grupo autorizado. Habilite um grupo primeiro.</p>':'<p>Confirme o grupo de destino. A publicação será enviada imediatamente pela sessão WAHA. Esta ação não ativa a programação automática.</p>';
   return send(res,200,'<h1>Publicar produto</h1><p><strong>'+esc(product.title)+'</strong></p>'+(product.image_url?'<img src="'+esc(product.image_url)+'" alt="" style="max-width:250px;max-height:220px;object-fit:contain">':'')+warning+(product.status==='active'&&groups.rowCount?'<form method="post" action="/admin/publish"><input type="hidden" name="product_id" value="'+product.id+'"><label>Grupo autorizado<select name="group_id" required>'+options+'</select></label><label><input type="checkbox" name="confirm" value="yes" required style="display:inline;width:auto"> Confirmo que posso publicar esta oferta no grupo selecionado.</label><button class="ui-btn btn-green">Confirmar publicação agora</button></form>':'')+'<p><a href="/admin">Voltar aos produtos</a></p>');
  }
  if(path==='/admin/publish'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   if(!/^[0-9]+$/.test(f.product_id||'')||!/^[0-9]+$/.test(f.group_id||'')||f.confirm!=='yes')return send(res,400,'Confirmação inválida');
   const group=(await pool.query('SELECT connection_id FROM rotation_groups WHERE id=$1',[f.group_id])).rows[0];
   const config=await getConnection(pool,group?.connection_id);
   if(!config)return send(res,503,'A conexão WAHA deste grupo não está configurada');
   const jobId=crypto.randomBytes(8).toString('hex');
   manualPublish={id:jobId,status:'running',detail:'Processando publicação manual'};
   res.writeHead(303,{location:'/admin/publish/status?id='+jobId});res.end();
   void (async()=>{
    try{
     const result=await dispatch.publishNow(pool,{productId:f.product_id,groupId:f.group_id,config});
     const messages={sent:'API WAHA confirmou a publicação.',duplicate:'Este produto já foi publicado ou tentado neste grupo hoje. Nenhum novo envio foi feito.',invalid:'Produto inativo, grupo não autorizado ou grupo inválido. Nenhum envio foi feito.',failed:'A API não confirmou o envio. Veja o histórico. Para evitar duplicações, não há repetição automática.'};
     manualPublish={id:jobId,status:result.status,detail:messages[result.status]||'Resultado desconhecido',...(result.status==='duplicate'?{productId:f.product_id,groupId:f.group_id,confirmationToken:crypto.randomBytes(16).toString('hex'),createdAt:Date.now()}: {})};
    }catch(e){console.error('manual_publish_failed',e.code||e.name);manualPublish={id:jobId,status:'failed',detail:'Não foi possível processar a publicação. Consulte o histórico.'}}
   })();
   return;
  }
  if(path==='/admin/publish/force'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   const pending=manualPublish;
   if(!pending||pending.status!=='duplicate'||!pending.confirmationToken||f.job_id!==pending.id||f.token!==pending.confirmationToken||f.confirm!=='yes'||f.confirm_phrase!=='REPUBLICAR'||Date.now()-pending.createdAt>10*60*1000)return send(res,400,'<h1>Confirmação expirada ou inválida</h1><p>Retorne ao produto e tente novamente.</p><div class="actions-bar"><a class="ui-btn btn-blue" href="/admin">Produtos</a></div>');
   const jobId=crypto.randomBytes(8).toString('hex');
   manualPublish={id:jobId,status:'running',detail:'Processando republicação autorizada'};
   res.writeHead(303,{location:'/admin/publish/status?id='+jobId});res.end();
   void (async()=>{
    try{
     const group=(await pool.query('SELECT connection_id FROM rotation_groups WHERE id=$1',[pending.groupId])).rows[0];
     const config=await getConnection(pool,group?.connection_id);
     if(!config)throw Error('Conexão do grupo indisponível');
     const result=await dispatch.publishNow(pool,{productId:pending.productId,groupId:pending.groupId,config,allowDuplicate:true});
     const messages={sent:'A API WAHA confirmou a republicação solicitada.',invalid:'Produto ou grupo não está autorizado; nada foi enviado.',failed:'A API não confirmou a republicação. Consulte o histórico.',duplicate:'Não foi possível reservar a republicação. Nenhuma nova tentativa automática.'};
     manualPublish={id:jobId,status:result.status,detail:messages[result.status]||'Resultado desconhecido'};
    }catch(e){console.error('manual_republish_failed',e.code||e.name);manualPublish={id:jobId,status:'failed',detail:'Não foi possível processar a republicação. Consulte o histórico.'}}
   })();
   return;
  }
  if(path==='/admin/publish/status'&&req.method==='GET'){
   const id=new URL(req.url,'http://localhost').searchParams.get('id');
   const job=manualPublish?.id===id?manualPublish:null;
   const repeat=job?.status==='duplicate'&&job.confirmationToken?'<form method="post" action="/admin/publish/force"><h2>Publicar mesmo assim?</h2><p>Este produto já teve publicação ou tentativa de envio ao grupo selecionado hoje. Um novo envio poderá gerar uma mensagem repetida. A republicação só ocorrerá após sua confirmação.</p><input type="hidden" name="job_id" value="'+esc(job.id)+'"><input type="hidden" name="token" value="'+esc(job.confirmationToken)+'"><label>Digite REPUBLICAR para confirmar<input name="confirm_phrase" required autocomplete="off" placeholder="REPUBLICAR"></label><label class="disclosure-option"><input type="checkbox" name="confirm" value="yes" required> Autorizo um novo envio deste produto ao mesmo grupo.</label><button class="ui-btn btn-amber">Confirmar e publicar mesmo duplicado</button></form>':'';
   return send(res,200,'<h1>Resultado da publicação</h1><article>'+(job?'<strong>'+esc(statusPt(job.status))+'</strong><p>'+esc(job.detail)+'</p>':'Operação não encontrada nesta execução.')+'</article>'+repeat+'<div class="actions-bar"><a class="ui-btn btn-blue" href="/admin/publish/status?id='+esc(id||'')+'">Atualizar resultado</a><a class="ui-btn btn-green" href="/admin">Produtos</a><a class="ui-btn btn-teal" href="/admin/automation">Histórico</a></div>');
  }
  if(path==='/admin/product/toggle'&&req.method==='POST'){
   if(!validOrigin(req))return send(res,403,'Origem não autorizada');
   const f=await readBody(req);
   if(!/^[0-9]+$/.test(f.id||'')||!['active','draft'].includes(f.status))return send(res,400,'Produto ou situação inválida');
   await pool.query('UPDATE products SET status=$1,updated_at=NOW() WHERE id=$2',[f.status,f.id]);
   if(f.status==='active')try{await syncCatalogQueues(pool)}catch(error){console.error('catalog_queue_after_toggle_failed',error.code||error.name||'ERROR')}
   try{await replanCatalog()}catch(error){console.error('catalog_replan_after_toggle_failed',error.code||error.name||'ERROR')}
   res.writeHead(303,{location:'/admin'});return res.end();
  }
  if(path==='/admin/catalog-health'&&req.method==='GET'){
   const catalog=await pool.query("SELECT p.id,p.title,p.status,EXISTS(SELECT 1 FROM product_connections pc WHERE pc.product_id=p.id) AS linked,EXISTS(SELECT 1 FROM product_connections pc JOIN rotation_groups g ON g.connection_id=pc.connection_id WHERE pc.product_id=p.id AND g.enabled=true) AS authorized_group FROM products p ORDER BY p.id");
   const items=catalog.rows;
   const active=items.filter(p=>p.status==='active'),eligible=active.filter(p=>p.authorized_group);
   const draft=items.filter(p=>p.status!=='active'),unlinked=active.filter(p=>!p.linked),withoutGroup=active.filter(p=>p.linked&&!p.authorized_group);
   const blocked=items.filter(p=>p.status!=='active'||!p.authorized_group);
   const cards=blocked.map(p=>'<div class="mini-row"><span><strong>'+esc(p.title)+'</strong><small> #'+esc(p.id)+'</small></span><span>'+esc(p.status!=='active'?'Rascunho / desativado':!p.linked?'Sem conexão vinculada':'Sem grupo autorizado na conexão selecionada')+'</span><a class="ui-btn btn-blue" href="/admin/edit?id='+p.id+'">Corrigir</a></div>').join('');
   return send(res,200,'<header class="page-head"><div><span class="page-overline">Diagnóstico</span><h1>Elegibilidade do catálogo</h1><p>Produtos ativos com conexão vinculada e pelo menos um grupo autorizado entram automaticamente no rodízio. A entrega real também depende do funcionamento da WAHA.</p></div><a class="ui-btn btn-blue" href="/admin">← Administração</a></header><div class="admin-stats"><div class="admin-stat"><strong>'+items.length+'</strong><small>Cadastrados</small></div><div class="admin-stat is-active"><strong>'+eligible.length+'</strong><small>Aptos ao rodízio</small></div><div class="admin-stat is-paused"><strong>'+blocked.length+'</strong><small>Exigem atenção</small></div></div><p>Rascunhos/desativados: '+draft.length+' · Ativos sem conexão: '+unlinked.length+' · Ativos sem grupo autorizado: '+withoutGroup.length+'.</p><h2>Produtos que não estão aptos ao rodízio</h2>'+(cards||'<p>Todos os produtos cadastrados estão ativos e possuem grupos autorizados nas conexões selecionadas.</p>')+'<p>O rodízio é individual por grupo; ofertas que não pertencem à conexão do grupo não serão publicadas nele.</p>');
  }
  if(path==='/admin/new'&&req.method==='GET'){
   const connections=await listConnections(pool);return send(res,200,form({},connections,connections.filter(c=>c.is_primary).map(c=>String(c.id)))+'<p><a href="/admin">← Voltar para a lista de produtos</a></p>');
  }
  if(path==='/admin'&&req.method==='GET'){
   const result=await pool.query('SELECT id,title,image_url,price,status FROM products ORDER BY id DESC');
   return send(res,200,renderProducts(result.rows));
  }
  if(path==='/admin/edit'&&req.method==='GET'){
   const id=new URL(req.url,'http://localhost').searchParams.get('id');
   if(!/^[0-9]+$/.test(id||''))return send(res,400,'ID inválido');
   const data=await pool.query('SELECT * FROM products WHERE id=$1',[id]);const connections=await listConnections(pool);const selected=(await pool.query('SELECT connection_id FROM product_connections WHERE product_id=$1',[id])).rows.map(x=>String(x.connection_id));return send(res,data.rowCount?200:404,data.rowCount?form(data.rows[0],connections,selected):'Produto não encontrado');
  }
  if(path==='/'&&req.method==='GET'){
   const data=await pool.query("SELECT * FROM products WHERE status='active' ORDER BY id DESC LIMIT 100");
   return send(res,200,renderCatalog(data.rows,clicks.trackedUrl,brandingState));
  }
  send(res,404,'Página não encontrada');
  }catch(e){const incident=crypto.randomBytes(4).toString('hex');const location=(e.stack||'').split('\n').find(line=>line.includes('/app/')&&line.includes(':'))||'';console.error('exception_site',incident,location.replace(/\/app\//g,''));console.error('request_failure',JSON.stringify({incident,path:req.url?.split('?')[0],code:e.code||'UNEXPECTED',kind:e.name||'Error'}));if(!res.headersSent)send(res,500,'<h1>Não foi possível concluir esta operação</h1><p>Identificador: '+incident+'</p><p>Categoria: '+esc(e.code||e.name||'UNEXPECTED')+'</p><p>Rota: '+esc(req.url?.split('?')[0]||'unknown')+'</p><p><a href="/admin/diagnostics">Consultar diagnóstico</a></p>');else res.end();}
}
// Rebuild the remaining daily plan when the catalog changes. Every active product
// is read on each run, and the persistent per-group cycle survives day boundaries.
async function replanCatalog(now=new Date()){
 const state=await dispatch.controls(pool);
 if(state.paused||!state.send_enabled||dispatch.windowStatus(state,now).phase!=='open')return false;
 const ids=(await pool.query('SELECT id FROM rotation_groups WHERE enabled=true ORDER BY id')).rows.map(x=>String(x.id));
 if(!ids.length)return false;
 await planDay(pool,dispatch.localDay(now),ids,{daily:state.daily_limit,start:state.window_start,end:state.window_end,now,refresh:true});
 return true;
}
let catalogLastCheck=0,catalogLastSignature=null;
async function checkCatalogUpdates(now){
 if(catalogLastCheck&&now.getTime()-catalogLastCheck<30*60000)return false;
 const result=await pool.query("SELECT (SELECT count(*)::int FROM products) AS total,(SELECT COALESCE(MAX(updated_at)::text,'') FROM products) AS latest,(SELECT count(*)::int FROM product_connections) AS links,(SELECT COALESCE(string_agg(id::text||':'||enabled::text,',' ORDER BY id),'') FROM rotation_groups) AS groups");
 const signature=JSON.stringify(result.rows[0]||{});
 const changed=catalogLastSignature!==null&&catalogLastSignature!==signature;
 catalogLastSignature=signature;
 catalogLastCheck=now.getTime();
 return changed;
}
let jobRunning=false;
async function scheduler(){
 if(jobRunning||!ready)return;
 jobRunning=true;
 try{
  const state=await dispatch.controls(pool);
  if(!state.paused&&state.send_enabled){
   const now=new Date(),day=dispatch.localDay(now);
   // Automatic overnight standby. Do not plan or send before 06:00 or after 23:00.
   if(dispatch.windowStatus(state,now).phase!=='open')return;
   const result=await pool.query('SELECT assignments FROM rotation_plans WHERE day=$1',[day]);
   let refresh=!result.rowCount;
   if(await checkCatalogUpdates(now))refresh=true;
   if(result.rowCount){
    const assignments=result.rows[0].assignments;
    // Replace legacy schedules once, without toggling or interrupting active dispatch.
    const obsolete=assignments.some(x=>x.rotationVersion!==7||!Number.isFinite(Number(x.dueAt)));
    if(obsolete)refresh=true;
    else{
     const stale=assignments.filter(x=>Number(x.dueAt)<now.getTime()-90000);
     if(stale.length){
      const attempted=await pool.query("SELECT group_id,product_id FROM dispatch_log WHERE day=$1 AND status IN ('reserved','sent','failed')",[day]);
      const done=new Set(attempted.rows.map(x=>String(x.group_id)+':'+String(x.product_id)));
      if(stale.some(x=>!done.has(String(x.groupId)+':'+String(x.productId))))refresh=true;
     }
    }
   }
   if(refresh)await replanCatalog(now);
   const outcome=await dispatch.tick(pool,{now,send:async (item,deadline)=>{const config=await getConnection(pool,item.connection_id);if(!config)throw Error('Conexão do grupo indisponível');return dispatch.sendViaWaha(config,item,deadline)}});
   if(outcome.failed)await replanCatalog(new Date());
  }
 }catch(e){console.error('dispatch_tick_error',e.code||e.name||'ERROR')}
 finally{jobRunning=false}
}
const worker=setInterval(()=>{void scheduler()},10000);
worker.unref();
let initRunning=false;
async function initializeWithRetry(){
 if(ready||initRunning)return;
 initRunning=true;
 try{await init();console.log('Database initialization succeeded');void scheduler()}
 catch(e){console.error('Database initialization failed',e.code||e.name||'ERROR',String(e.message||'').slice(0,300))}
 finally{initRunning=false}
}
server.listen(PORT,'0.0.0.0',()=>{
 console.log('HTTP server running; database initialization pending');
 void initializeWithRetry();
});
const initRetry=setInterval(()=>{void initializeWithRetry()},15000);
initRetry.unref();
process.on('SIGTERM',()=>server.close(()=>pool.end()));






