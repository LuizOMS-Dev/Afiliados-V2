'use strict';
const crypto=require('node:crypto');
const DEFAULT_BASE='https://sites-afiliados-app.dsgmtf.easypanel.host';
const SCHEMA="CREATE TABLE IF NOT EXISTS product_clicks(id BIGSERIAL PRIMARY KEY,product_id BIGINT NOT NULL,group_id TEXT,connection_id BIGINT,is_bot BOOLEAN NOT NULL DEFAULT FALSE,user_agent TEXT NOT NULL DEFAULT '',ip_hash TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());CREATE INDEX IF NOT EXISTS product_clicks_created_idx ON product_clicks(created_at);CREATE INDEX IF NOT EXISTS product_clicks_product_idx ON product_clicks(product_id,created_at);";
const BOT_RE=/whatsapp|facebookexternalhit|facebookcatalog|meta-externalagent|telegrambot|twitterbot|slackbot|discordbot|linkedinbot|skypeuripreview|googlebot|bingbot|applebot|embedly|preview|crawler|spider|bot\b|curl\/|wget|python-requests|headless/i;
function publicBase(env=process.env){const v=String(env.PUBLIC_BASE_URL||'').trim().replace(/\/+$/,'');return /^https?:\/\//i.test(v)?v:DEFAULT_BASE;}
function cleanRef(v){const s=String(v??'').trim().slice(0,40);return /^[A-Za-z0-9_-]+$/.test(s)?s:null;}
function trackedUrl(productId,groupRef,base=publicBase()){const ref=cleanRef(groupRef);return base+'/r/'+encodeURIComponent(String(productId))+(ref?'?g='+ref:'');}
function isBot(ua){const s=String(ua||'');return !s||BOT_RE.test(s);}
// WhatsApp messages carry the real affiliate link (meli.la) by default.
// Set MESSAGE_LINK_MODE=tracked to send the Central /r/<id> click-tracking link instead.
function messageLinkMode(env=process.env){return String(env.MESSAGE_LINK_MODE||'').trim().toLowerCase()==='tracked'?'tracked':'affiliate';}
function messageLink(item,base=publicBase(),mode=messageLinkMode()){
 if(mode==='tracked'&&item.product_id!=null)return trackedUrl(item.product_id,item.group_ref,base);
 return item.affiliate_url||'';
}
function buildMessage(item,base=publicBase(),mode=messageLinkMode()){
 const price=item.price!=null?'💰 Preço: R$ '+Number(item.price).toFixed(2).replace('.',','):'';
 const link=messageLink(item,base,mode);
 return ['*'+String(item.title||'').replace(/[\r\n*]+/g,' ').trim()+'*',item.description,price,link,item.show_disclosure?'Publicidade / link de afiliado. Consulte preço e disponibilidade no anúncio.':'',item.whatsapp_group_url?'Participe do nosso grupo no WhatsApp e confira mais ofertas.\n'+item.whatsapp_group_url:''].filter(Boolean).join('\n\n');
}
function clientIp(req){return String(req.headers['x-forwarded-for']||'').split(',')[0].trim()||req.socket?.remoteAddress||'';}
function hashIp(ip,secret=process.env.SESSION_SECRET||''){return ip?crypto.createHash('sha256').update('click\0'+secret+'\0'+ip).digest('hex').slice(0,16):null;}
async function handleRedirect(pool,req,res,rawId){
 const home='/';const id=/^\d{1,18}$/.test(rawId)?rawId:null;
 let target=home;
 try{
  if(id){
   const r=await pool.query("SELECT affiliate_url FROM products WHERE id=$1 AND status='active'",[id]);
   const url=r.rows[0]?.affiliate_url;
   if(url&&/^https?:\/\//i.test(url)){
    target=url;
    const q=new URL(req.url,'http://localhost').searchParams;const ref=cleanRef(q.get('g'));const ua=String(req.headers['user-agent']||'');
    let conn=null;if(ref&&/^\d+$/.test(ref)){const g=await pool.query('SELECT connection_id FROM rotation_groups WHERE id=$1',[ref]).catch(()=>({rows:[]}));conn=g.rows[0]?.connection_id??null;}
    // Link-preview fetchers are stored flagged, never counted as clicks.
    await pool.query('INSERT INTO product_clicks(product_id,group_id,connection_id,is_bot,user_agent,ip_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,ref,conn,isBot(ua),ua.slice(0,200),hashIp(clientIp(req))]).catch(e=>console.error('click log failed',e.message));
   }
  }
 }catch(e){console.error('redirect failed',e.message);}
 res.writeHead(302,{location:target,'cache-control':'no-store','referrer-policy':'no-referrer','x-robots-tag':'noindex'});res.end();
}
async function stats(pool,days){
 const d=[7,30].includes(Number(days))?Number(days):7;const w="c.created_at>=NOW()-($1||' days')::interval AND NOT c.is_bot";
 const [products,groups,perDay,bots]=await Promise.all([
  pool.query("SELECT c.product_id,COALESCE(p.title,'(removido)') AS title,COUNT(*)::int AS clicks FROM product_clicks c LEFT JOIN products p ON p.id=c.product_id WHERE "+w+" GROUP BY 1,2 ORDER BY 3 DESC LIMIT 50",[d]),
  pool.query("SELECT COALESCE(c.group_id,'(sem grupo)') AS ref,COALESCE(g.name,CASE WHEN c.group_id='site' THEN 'Site (catálogo)' ELSE c.group_id END,'(sem grupo)') AS name,COUNT(*)::int AS clicks FROM product_clicks c LEFT JOIN rotation_groups g ON c.group_id ~ '^[0-9]+$' AND g.id=CASE WHEN c.group_id ~ '^[0-9]+$' THEN c.group_id::bigint ELSE NULL END WHERE "+w+" GROUP BY 1,2 ORDER BY 3 DESC",[d]),
  pool.query("SELECT to_char((c.created_at AT TIME ZONE 'America/Sao_Paulo')::date,'DD/MM') AS day,COUNT(*)::int AS clicks FROM product_clicks c WHERE "+w+" GROUP BY (c.created_at AT TIME ZONE 'America/Sao_Paulo')::date ORDER BY (c.created_at AT TIME ZONE 'America/Sao_Paulo')::date",[d]),
  pool.query("SELECT COUNT(*)::int AS n FROM product_clicks c WHERE c.created_at>=NOW()-($1||' days')::interval AND c.is_bot",[d])]);
 return {days:d,products:products.rows,groups:groups.rows,perDay:perDay.rows,bots:bots.rows[0]?.n||0};
}

function renderClicks(s,esc){
 const {head,metric}=require('./interface');const total=s.perDay.reduce((a,r)=>a+r.clicks,0);
 const table=(heads,rows)=>'<table class="clicks-table"><thead><tr>'+heads.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+(rows.length?rows.join(''):'<tr><td colspan="'+heads.length+'">Nenhum clique no período.</td></tr>')+'</tbody></table>';
 return head('ACOMPANHAMENTO','Resultados das suas ofertas','Acompanhe o interesse nos produtos e os grupos que mais acessam seus links.','<a class="ui-btn '+(s.days===7?'btn-green':'btn-blue')+'" href="/admin/clicks?days=7">7 dias</a><a class="ui-btn '+(s.days===30?'btn-green':'btn-blue')+'" href="/admin/clicks?days=30">30 dias</a>')+'<div class="metrics clicks-summary">'+metric('Cliques no período',total,'Últimos '+s.days+' dias','clicks')+metric('Produtos acessados',s.products.length,'Até 50 produtos com mais cliques','products')+metric('Pré-visualizações ignoradas',s.bots,'Acessos de robôs e mensageiros','health')+'</div><div class="clicks-layout"><article><h2>Produtos com mais interesse</h2>'+table(['Produto','Cliques'],s.products.map(r=>'<tr><td><a href="/admin/edit?id='+esc(r.product_id)+'">'+esc(r.title)+'</a></td><td><strong>'+r.clicks+'</strong></td></tr>'))+'</article><article><h2>Origem dos cliques</h2>'+table(['Grupo / origem','Cliques'],s.groups.map(r=>'<tr><td>'+esc(r.name)+'</td><td>'+r.clicks+'</td></tr>'))+'</article><article><h2>Cliques por dia</h2>'+table(['Dia','Cliques'],s.perDay.map(r=>'<tr><td>'+esc(r.day)+'</td><td>'+r.clicks+'</td></tr>'))+'</article></div><p style="font-size:11px;margin-top:22px">Pré-visualizações de links do WhatsApp e de outras plataformas são identificadas e não entram no total de cliques.</p>';
}

module.exports={SCHEMA,DEFAULT_BASE,publicBase,trackedUrl,isBot,buildMessage,messageLink,messageLinkMode,handleRedirect,stats,renderClicks,cleanRef,hashIp};
