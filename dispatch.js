'use strict';
const {planDay,sqlRecordCycleAttempt}=require('./rotation-persistence');
const {globalAttemptSQL}=require('./global-cycle');
const TZ='America/Sao_Paulo';
function localDay(date=new Date()){return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(date)}
function localMinute(date=new Date()){const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:TZ,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));return parts.hour*60+parts.minute}
// Daily automatic sending window, evaluated in Sao Paulo time on every dispatch.
function windowStatus(settings,now=new Date()){
 const time=x=>Number(String(x).slice(0,2))*60+Number(String(x).slice(3,5));
 const start=time(settings.window_start),end=time(settings.window_end),minute=localMinute(now);
 if(!Number.isFinite(start)||!Number.isFinite(end)||start>=end)throw Error('Janela de publicação inválida');
 const phase=minute<start?'waiting':minute>=end?'closed':'open';
 const closeAt=now.getTime()+(end-minute)*60000-now.getSeconds()*1000-now.getMilliseconds();
 return {phase,start,end,minute,closeAt};
}
const MIN_SEND_REMAINING_MS=15000;
async function initialize(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS dispatch_settings(id SMALLINT PRIMARY KEY CHECK(id=1),paused BOOLEAN NOT NULL DEFAULT TRUE,send_enabled BOOLEAN NOT NULL DEFAULT FALSE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await pool.query("INSERT INTO dispatch_settings(id) VALUES(1) ON CONFLICT DO NOTHING");
 await pool.query("ALTER TABLE dispatch_settings ADD COLUMN IF NOT EXISTS daily_limit INTEGER NOT NULL DEFAULT 3");
 await pool.query("ALTER TABLE dispatch_settings ADD COLUMN IF NOT EXISTS window_start TEXT NOT NULL DEFAULT '06:00'");
 await pool.query("ALTER TABLE dispatch_settings ADD COLUMN IF NOT EXISTS window_end TEXT NOT NULL DEFAULT '23:00'");
 // One-time migration: an old global limit of 10 must never become 10 sends per group.
 await pool.query("ALTER TABLE dispatch_settings ADD COLUMN IF NOT EXISTS per_group_mode BOOLEAN NOT NULL DEFAULT FALSE");
 await pool.query("ALTER TABLE dispatch_settings ADD COLUMN IF NOT EXISTS history_hidden_before_id BIGINT NOT NULL DEFAULT 0");
 await pool.query("UPDATE dispatch_settings SET daily_limit=3,per_group_mode=TRUE,updated_at=NOW() WHERE id=1 AND per_group_mode=FALSE");

 await pool.query("ALTER TABLE dispatch_settings ADD COLUMN IF NOT EXISTS individual_rotation_v5 BOOLEAN NOT NULL DEFAULT FALSE");
 await pool.query("UPDATE dispatch_settings SET daily_limit=4,individual_rotation_v5=TRUE,updated_at=NOW() WHERE id=1 AND individual_rotation_v5=FALSE");

 await pool.query("CREATE TABLE IF NOT EXISTS dispatch_log(id BIGSERIAL PRIMARY KEY,day DATE NOT NULL,product_id BIGINT NOT NULL,group_id BIGINT NOT NULL,slot INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('reserved','sent','failed','skipped')),attempts INTEGER NOT NULL DEFAULT 0,detail TEXT NOT NULL DEFAULT '',message_id TEXT,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),UNIQUE(day,product_id,group_id,slot))");
}
async function controls(pool){return (await pool.query('SELECT * FROM dispatch_settings WHERE id=1')).rows[0]}
async function setControls(pool,{paused,sendEnabled}){
 const current=await controls(pool);
 await pool.query('UPDATE dispatch_settings SET paused=$1,send_enabled=$2,updated_at=NOW() WHERE id=1',[paused??current.paused,sendEnabled??current.send_enabled]);
}
async function setSchedule(pool,{daily,start,end}){
 const n=Number(daily);
 const validTime=x=>/^([01]\d|2[0-3]):[0-5]\d$/.test(x);
 if(!Number.isInteger(n)||n<1||n>20)throw Error('Produtos por grupo devem ficar entre 1 e 20.');
 if(!validTime(start)||!validTime(end))throw Error('Horário inválido.');
 const minute=x=>Number(x.slice(0,2))*60+Number(x.slice(3));
 if(minute(start)<360||minute(end)>1380||minute(end)<=minute(start))throw Error('Horários devem respeitar a janela entre 06:00 e 23:00.');
 await pool.query('UPDATE dispatch_settings SET daily_limit=$1,window_start=$2,window_end=$3,updated_at=NOW() WHERE id=1',[n,start,end]);
}
function assignmentKey(a){return {productId:String(a.productId),groupId:String(a.groupId),slot:Number(a.minuteOfDay)}}
// Purge old display logs, but retain today's operational records for duplicate protection.
// A monotonic ID cutoff hides today's pre-clear cards without changing daily quotas.
async function clearHistory(pool,now=new Date()){
 const day=localDay(now);
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(471021)');
  const latest=await db.query('SELECT COALESCE(MAX(id),0)::bigint AS id FROM dispatch_log');
  const cutoff=String(latest.rows[0].id);
  const purged=await db.query('DELETE FROM dispatch_log WHERE day < $1',[day]);
  await db.query('UPDATE dispatch_settings SET history_hidden_before_id=GREATEST(history_hidden_before_id,$1::bigint),updated_at=NOW() WHERE id=1',[cutoff]);
  await db.query('COMMIT');
  return {olderDeleted:purged.rowCount,hiddenUpToId:cutoff};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}
 finally{db.release()}
}
async function summary(pool,day=localDay()){
 const q=await pool.query("SELECT status,count(*)::int AS n FROM dispatch_log WHERE day=$1 GROUP BY status",[day]);
 return Object.fromEntries(q.rows.map(x=>[x.status,x.n]));
}
async function tick(pool,{send=null,now=new Date(),clock=()=>new Date()}={}){
 const state=await controls(pool);
 if(state.paused||!state.send_enabled||typeof send!=='function')return {reason:'disabled'};
 if(windowStatus(state,now).phase!=='open')return {reason:'outside-window'};
 const day=localDay(now),epoch=now.getTime();
 const result=await pool.query('SELECT assignments FROM rotation_plans WHERE day=$1',[day]);
 if(!result.rowCount)return {reason:'no-plan'};
 // Filter already processed work BEFORE limiting the batch: otherwise the first five
 // completed entries can permanently starve every later group.
 const processed=await pool.query("SELECT group_id,product_id FROM dispatch_log WHERE day=$1 AND status IN ('reserved','sent','failed')",[day]);
 const done=new Set(processed.rows.map(x=>String(x.group_id)+':'+String(x.product_id)));
 const due=result.rows[0].assignments.filter(x=>Number.isFinite(Number(x.dueAt))&&Number(x.dueAt)<=epoch&&!done.has(String(x.groupId)+':'+String(x.productId))).sort((a,b)=>a.dueAt-b.dueAt).slice(0,5);
 let sent=0,skipped=0,failed=0;
 for(const a of due){
  // Do not start another reservation if the window closed while prior WAHA calls ran.
  const check=clock(),gate=windowStatus(state,check);
  if(gate.phase!=='open'||gate.closeAt-check.getTime()<MIN_SEND_REMAINING_MS)break;
  const db=await pool.connect();
  let record=null,waitForSpacing=false;
  try{
   await db.query('BEGIN');
   // Serialization with planning prevents an old due job from surviving a restart.
   await db.query('SELECT pg_advisory_xact_lock(471021)');
   const current=await db.query('SELECT assignments FROM rotation_plans WHERE day=$1',[day]);
   const exists=current.rows[0]?.assignments?.some(x=>String(x.groupId)===String(a.groupId)&&String(x.productId)===String(a.productId)&&Number(x.dueAt)===Number(a.dueAt));
   if(exists){
    const prev=await db.query("SELECT 1 FROM dispatch_log WHERE day=$1 AND product_id=$2 AND group_id=$3 AND status IN ('reserved','sent','failed') LIMIT 1",[day,a.productId,a.groupId]);
    if(!prev.rowCount){
     const quota=await db.query("SELECT count(*)::int AS n FROM dispatch_log WHERE day=$1 AND group_id=$2 AND status IN ('reserved','sent')",[day,a.groupId]);
     if(Number(quota.rows[0]?.n||0)<Number(state.daily_limit||4)){
     // Real-time minimum gaps are checked inside the same advisory lock as the
     // reservation; a restart or delayed WAHA response cannot bypass them.
     const recent=await db.query("SELECT (SELECT MAX(created_at) FROM dispatch_log WHERE day=$1 AND group_id=$2 AND status IN ('reserved','sent','failed')) AS group_last,(SELECT MAX(l.created_at) FROM dispatch_log l JOIN rotation_groups g ON g.id=l.group_id WHERE l.day=$1 AND g.connection_id=$3 AND l.status IN ('reserved','sent','failed')) AS connection_last",[day,a.groupId,a.connectionId]);
     const last=recent.rows[0]||{},at=check.getTime();
     const groupGap=Math.max(20000,Math.min(20*60000,Number(a.groupGapMs)||20*60000));
     const groupAt=last.group_last?new Date(last.group_last).getTime():0;
     const connectionAt=last.connection_last?new Date(last.connection_last).getTime():0;
     if(groupAt&&at-groupAt<groupGap||connectionAt&&at-connectionAt<20000){
      waitForSpacing=true;
     }else{
      const controlsNow=await db.query('SELECT paused,send_enabled FROM dispatch_settings WHERE id=1');
      if(!controlsNow.rows[0].paused&&controlsNow.rows[0].send_enabled){
       const added=await db.query("INSERT INTO dispatch_log(day,product_id,group_id,slot,status,attempts) VALUES($1,$2,$3,$4,'reserved',1) ON CONFLICT DO NOTHING RETURNING id",[day,a.productId,a.groupId,Number(a.minuteOfDay)]);
       if(added.rowCount){
        record=added.rows[0].id;
        await db.query(sqlRecordCycleAttempt(),[a.groupId,a.productId]);
        await db.query(globalAttemptSQL(),[a.productId,a.groupId]);
       }
      }
     }
     }
    }
   }
   await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}
  if(!record){if(waitForSpacing)break;continue;}
  try{
   const data=await pool.query("SELECT p.title,p.id AS product_id,g.id::text AS group_ref,p.description,p.image_url,p.affiliate_url,p.price,p.show_disclosure,g.chat_id,g.connection_id,g.enabled,p.status,(SELECT whatsapp_group_url FROM site_branding WHERE id=1) AS whatsapp_group_url FROM products p JOIN rotation_groups g ON g.id=$2 JOIN product_connections pc ON pc.product_id=p.id AND pc.connection_id=g.connection_id WHERE p.id=$1",[a.productId,a.groupId]);
   const item=data.rows[0];
   if(!item||item.status!=='active'||!item.enabled||!String(item.chat_id).endsWith('@g.us')){await pool.query("UPDATE dispatch_log SET status='skipped',detail='Produto ou grupo indisponível',updated_at=NOW() WHERE id=$1",[record]);skipped++;continue}
   const current=await controls(pool),sendTime=clock(),sendGate=windowStatus(current,sendTime);
   if(current.paused||!current.send_enabled){await pool.query("UPDATE dispatch_log SET status='skipped',detail='Pausado antes do envio',updated_at=NOW() WHERE id=$1",[record]);skipped++;continue}
   if(sendGate.phase!=='open'||sendGate.closeAt-sendTime.getTime()<MIN_SEND_REMAINING_MS){
    await pool.query("UPDATE dispatch_log SET status='skipped',detail='Janela de publicação encerrada antes do envio',updated_at=NOW() WHERE id=$1",[record]);
    skipped++;break;
   }
   const outcome=await send(item,{deadlineMs:sendGate.closeAt});
   await pool.query("UPDATE dispatch_log SET status='sent',message_id=$2,detail='WAHA confirmou a requisição',updated_at=NOW() WHERE id=$1",[record,String(outcome?.id||'').slice(0,300)]);
   sent++;
  }catch(e){
   // Never automatically retry an ambiguous WAHA response.
   await pool.query("UPDATE dispatch_log SET status='failed',detail=$2,updated_at=NOW() WHERE id=$1",[record,String(e.message||e.code||'Falha').slice(0,250)]);
   failed++;
  }
 }
 return {day,sent,skipped,failed};
}
async function sendViaWaha(config,item,{deadlineMs=null}={}){
 const {getImage}=require('./image-upload');
 const base=new URL(config.baseUrl);
 const message=require('./click-tracking').buildMessage(item);
 let endpoint='/api/sendText',body={session:config.session,chatId:item.chat_id,text:message};
 if(item.image_url){
  let file=null;
  if(/^\/uploads\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(item.image_url)){
   const source=await getImage(item.image_url.slice('/uploads/'.length));
   if(source)file={mimetype:source.type,filename:'oferta.'+item.image_url.split('.').pop(),data:source.body.toString('base64')};
  }else if(/^https:\/\//i.test(item.image_url)){
   file={url:item.image_url};
  }
  if(file){endpoint='/api/sendImage';body={session:config.session,chatId:item.chat_id,file,caption:message};}
 }
 // Stop pending HTTP calls by the closing deadline; WAHA can still deliver accepted jobs later.
 const remaining=deadlineMs==null?30000:Math.min(30000,Number(deadlineMs)-Date.now()-500);
 if(remaining<1000)throw Error('Janela de publicação encerrada antes de chamar WAHA');
 const response=await fetch(base.origin+endpoint,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json','X-Api-Key':config.apiKey},body:JSON.stringify(body),signal:AbortSignal.timeout(Math.floor(remaining)),redirect:'error'});
 if(!response.ok)throw Error('WAHA '+endpoint+' HTTP '+response.status);
 const result=await response.json().catch(()=>({}));
 return {id:result.id||result.key?.id||''};
}
async function publishNow(pool,{productId,groupId,config,allowDuplicate=false}){
 const day=localDay();
 const db=await pool.connect();
 let id;
 try{
  await db.query('BEGIN');
  // Serialize manual reservations with scheduled reservations and plan refreshes.
  await db.query('SELECT pg_advisory_xact_lock(471021)');
  const data=await db.query("SELECT p.title,p.id AS product_id,g.id::text AS group_ref,p.description,p.image_url,p.affiliate_url,p.price,p.show_disclosure,p.status,g.chat_id,g.connection_id,g.enabled,(SELECT whatsapp_group_url FROM site_branding WHERE id=1) AS whatsapp_group_url FROM products p JOIN rotation_groups g ON g.id=$2 JOIN product_connections pc ON pc.product_id=p.id AND pc.connection_id=g.connection_id WHERE p.id=$1",[productId,groupId]);
  const item=data.rows[0];
  if(!item||item.status!=='active'||!item.enabled||!String(item.chat_id).endsWith('@g.us')){await db.query('ROLLBACK');return {status:'invalid'}}
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['manual:'+day+':'+productId+':'+groupId]);
  const conflict=await db.query("SELECT 1 FROM dispatch_log WHERE day=$1 AND product_id=$2 AND group_id=$3 AND status IN ('reserved','sent','failed') LIMIT 1",[day,productId,groupId]);
  if(conflict.rowCount&&!allowDuplicate){await db.query('ROLLBACK');return {status:'duplicate'}}
  const slots=await db.query("SELECT COALESCE(MAX(slot),9998)::int AS slot FROM dispatch_log WHERE day=$1 AND product_id=$2 AND group_id=$3 AND slot>=9999",[day,productId,groupId]);
  const slot=slots.rows[0].slot+1;
  const record=await db.query("INSERT INTO dispatch_log(day,product_id,group_id,slot,status,attempts,detail) VALUES($1,$2,$3,$4,'reserved',1,$5) ON CONFLICT DO NOTHING RETURNING id",[day,productId,groupId,slot,allowDuplicate?'Republicação manual autorizada':'Publicação manual']);
  if(!record.rowCount){await db.query('ROLLBACK');return {status:'duplicate'}}
  id=record.rows[0].id;
  await db.query(sqlRecordCycleAttempt(),[groupId,productId]);
  await db.query(globalAttemptSQL(),[productId,groupId]);
  await db.query('COMMIT');
  try{
   const response=await sendViaWaha(config,item);
   await pool.query("UPDATE dispatch_log SET status='sent',message_id=$2,detail='Publicação manual confirmada pela API WAHA',updated_at=NOW() WHERE id=$1",[id,String(response.id||'').slice(0,300)]);
   return {status:'sent'};
  }catch(e){
   await pool.query("UPDATE dispatch_log SET status='failed',detail=$2,updated_at=NOW() WHERE id=$1",[id,'Publicação manual: '+String(e.message||'Falha WAHA').slice(0,200)]);
   return {status:'failed'};
  }
 }catch(e){try{await db.query('ROLLBACK')}catch{}throw e}finally{db.release()}
}
// Explicit operator retry of a failed dispatch; never auto-retry uncertain WAHA outcomes.
async function retryFailed(pool,{logId,getConnection}){
 const db=await pool.connect();let record,item,config;
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(471021)');
  const q=await db.query("SELECT l.id,l.product_id,l.group_id,l.status,g.connection_id,g.chat_id,g.enabled,p.status AS product_status,p.title,p.id AS product_id,p.description,p.image_url,p.affiliate_url,p.price,p.show_disclosure,(SELECT whatsapp_group_url FROM site_branding WHERE id=1) AS whatsapp_group_url FROM dispatch_log l JOIN rotation_groups g ON g.id=l.group_id JOIN products p ON p.id=l.product_id JOIN product_connections pc ON pc.product_id=p.id AND pc.connection_id=g.connection_id WHERE l.id=$1 FOR UPDATE OF l",[logId]);
  item=q.rows[0];
  if(!item||item.status!=='failed'){await db.query('ROLLBACK');return {status:'unavailable'}}
  if(!item.enabled||item.product_status!=='active'||!String(item.chat_id).endsWith('@g.us')){await db.query('ROLLBACK');return {status:'invalid'}}
  config=await getConnection(item.connection_id);
  if(!config){await db.query('ROLLBACK');return {status:'invalid'}}
  // The original row becomes reserved before the network call, ensuring that
  // another click cannot reserve the same failed publication concurrently.
  record=item.id;
  await db.query("UPDATE dispatch_log SET status='reserved',attempts=attempts+1,detail='Reenvio manual solicitado; aguardando WAHA',updated_at=NOW() WHERE id=$1",[record]);
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}finally{db.release()}
 try{
  const sent=await sendViaWaha(config,{...item,group_ref:String(item.group_id)});
  await pool.query("UPDATE dispatch_log SET status='sent',message_id=$2,detail='Reenvio manual confirmado pela API WAHA',updated_at=NOW() WHERE id=$1 AND status='reserved'",[record,String(sent.id||'').slice(0,300)]);
  return {status:'sent'};
 }catch(e){
  await pool.query("UPDATE dispatch_log SET status='failed',detail=$2,updated_at=NOW() WHERE id=$1 AND status='reserved'",[record,'Reenvio manual: '+String(e.message||'Falha WAHA').slice(0,200)]);
  return {status:'failed'};
 }
}
module.exports={initialize,controls,setControls,setSchedule,summary,clearHistory,tick,publishNow,retryFailed,sendViaWaha,localDay,localMinute,windowStatus};

