'use strict';
const {chooseGlobal,VERSION}=require('./global-cycle');
async function initialize(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS rotation_state (id SMALLINT PRIMARY KEY, product_order JSONB NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, day_index INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ DEFAULT now())");
 await pool.query("CREATE TABLE IF NOT EXISTS rotation_plans (day DATE PRIMARY KEY, assignments JSONB NOT NULL, created_at TIMESTAMPTZ DEFAULT now())");
 await pool.query('CREATE TABLE IF NOT EXISTS group_rotation_state(group_id BIGINT PRIMARY KEY,product_order JSONB NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ DEFAULT NOW())');
 await pool.query("ALTER TABLE group_rotation_state ADD COLUMN IF NOT EXISTS cycle_sent JSONB NOT NULL DEFAULT '[]'::jsonb");
 await pool.query("CREATE TABLE IF NOT EXISTS global_product_rotation_state(id SMALLINT PRIMARY KEY CHECK(id=1),product_order JSONB NOT NULL DEFAULT '[]'::jsonb,cycle_sent JSONB NOT NULL DEFAULT '[]'::jsonb,last_group_id BIGINT,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await pool.query("ALTER TABLE global_product_rotation_state ADD COLUMN IF NOT EXISTS history_seeded BOOLEAN NOT NULL DEFAULT FALSE");
 await pool.query("INSERT INTO global_product_rotation_state(id) VALUES(1) ON CONFLICT DO NOTHING");
}

const MIN_CONNECTION_GAP_MS=20000;
function localMinute(date){
 const v=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'America/Sao_Paulo',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,Number(x.value)]));
 return v.hour*60+v.minute;
}
function parseTime(x){
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(x))throw Error('Horário inválido');
 return Number(x.slice(0,2))*60+Number(x.slice(3));
}
// Reserve 90 seconds for the scheduler's 10-second polling and WAHA's HTTP latency.
// The last planned send is due by 22:58:30, not dangerously close to 23:00.
const MIN_SEND_BUFFER_MS=90000;
// Round-robin work is ordered across ALL eligible groups, not separated by WAHA account.
function distribute(assignments,{start,end,now=new Date(),daily=3,lastAttempts=new Map(),minimumGapMs=MIN_CONNECTION_GAP_MS,minimumGroupGapMs=null}){
 const current=localMinute(now);
 const startEpoch=now.getTime()+(start-current)*60000-now.getSeconds()*1000-now.getMilliseconds();
 const endEpoch=now.getTime()+(end-current)*60000-now.getSeconds()*1000-now.getMilliseconds();
 const from=Math.max(now.getTime()+12000,startEpoch+12000);
 const latest=endEpoch-MIN_SEND_BUFFER_MS;
 const total=assignments.length;
 const groupGap=minimumGroupGapMs??Math.max(MIN_CONNECTION_GAP_MS,Math.min(20*60000,Math.floor((latest-from)/Math.max(total,1))));
 if(!total||latest<from)return {assignments:[],deferred:total,windowRemainingMs:Math.max(0,endEpoch-now.getTime())};
 const idealStep=total>1?Math.floor((latest-from)/(total-1)):0;
 const nextConnection=new Map(),nextGroup=new Map();
 const scheduled=[];
 // Every item is already sorted by absolute round and group order by planDay.
 // Do not allow a later round to overtake an unfinished earlier one.
 let nextGlobal=from;
 for(let i=0;i<total;i++){
  const item=assignments[i],group=String(item.groupId),connection=String(item.connectionId);
  const last=lastAttempts instanceof Map?lastAttempts.get(group):lastAttempts?.[group];
  const lastEpoch=last==null?0:new Date(last).getTime();
  const at=Math.ceil(Math.max(
   from+i*idealStep,
   nextGlobal,
   nextConnection.get(connection)||0,
   nextGroup.get(group)||0,
   Number.isFinite(lastEpoch)?lastEpoch+groupGap:0
  ));
  if(at>latest)break; // Remaining publications wait for a future day, never an end-of-day burst.
  scheduled.push({productId:item.productId,groupId:item.groupId,connectionId:item.connectionId,minuteOfDay:localMinute(new Date(at)),dueAt:at,groupGapMs:groupGap,rotationVersion:3});
  nextGlobal=at+1000;
  nextConnection.set(connection,at+minimumGapMs);
  nextGroup.set(group,at+groupGap);
 }
 return {assignments:scheduled,deferred:total-scheduled.length,windowRemainingMs:Math.max(0,endEpoch-now.getTime())};
}
// A group never receives the same product twice in one day, even if the queue wraps.
function selectDistinctProducts({queue,cursor=0,offset=0,already=[],prior=[],needed=0,restart=false}){
 const ids=queue.map(String), allowed=new Set(ids), seen=new Set(already.map(String)),selected=[];
 if(!restart){
  for(const value of prior){
   const id=String(value);
   if(selected.length>=needed)break;
   if(allowed.has(id)&&!seen.has(id)){selected.push(id);seen.add(id)}
  }
 }
 let visits=0,position=Math.max(0,Number(cursor)||0);
 while(selected.length<needed&&visits<ids.length){
  const id=ids[(position+offset)%ids.length];
  position++;visits++;
  if(!seen.has(id)){selected.push(id);seen.add(id)}
 }
 return {selected,cursor:position};
}
// The persisted cycle contains ONLY actual reservations, never planned offers.
// Newly eligible products are appended to product_order and must be consumed
// before anything in cycle_sent can be selected again.
function selectCycleProducts({queue,cycleSent=[],attemptedToday=[],prior=[],needed=0}){
 const available=new Set(queue.map(String)),today=new Set(attemptedToday.map(String));
 let completed=new Set(cycleSent.map(String).filter(id=>available.has(id)));
 if(queue.length&&queue.every(id=>completed.has(String(id))))completed.clear();
 const unsent=queue.map(String).filter(id=>!completed.has(id)&&!today.has(id));
 const next=[],used=new Set();
 for(const id of [...prior.map(String),...unsent]){
  if(next.length>=needed)break;
  if(!unsent.includes(id)||used.has(id))continue;
  next.push(id);used.add(id);
 }
 return {selected:next,cycleSent:[...completed]};
}
function pickGroupProducts({queue,cycleSent=[],blockedToday=[],needed=0,prior=[]}){
 const ids=[...new Set(queue.map(String))],blocked=new Set(blockedToday.map(String)),used=new Set(cycleSent.map(String));
 const fresh=ids.filter(id=>!used.has(id));
 // Prior plans never consume the cycle, and cannot overtake unseen products.
 const result=[];
 for(const tier of [fresh,ids.filter(id=>used.has(id))]){
  for(const id of [...prior.filter(id=>tier.includes(id)),...tier]){
   if(result.length>=needed)return result;
   if(!blocked.has(id)&&!result.includes(id))result.push(id);
  }
 }
 return result;
}
function sqlRecordCycleAttempt(){
 return "INSERT INTO group_rotation_state(group_id,product_order,cursor,cycle_sent) VALUES($1,'[]'::jsonb,0,jsonb_build_array($2::text)) ON CONFLICT(group_id) DO UPDATE SET cycle_sent=CASE WHEN group_rotation_state.product_order <@ group_rotation_state.cycle_sent THEN jsonb_build_array($2::text) WHEN group_rotation_state.cycle_sent @> jsonb_build_array($2::text) THEN group_rotation_state.cycle_sent ELSE group_rotation_state.cycle_sent || jsonb_build_array($2::text) END,updated_at=NOW()";
}
// Persist freshly registered catalog entries immediately, even when it is night
// or automatic dispatch is manually paused. This does not schedule or send anything.
async function syncCatalogQueues(pool){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(471021)');
  const groups=await db.query('SELECT id,connection_id FROM rotation_groups WHERE enabled=true AND connection_id IS NOT NULL ORDER BY id');
  let added=0;
  const eligible=new Set();
  for(const [index,group] of groups.rows.entries()){
   const id=String(group.id);
   const products=(await db.query("SELECT p.id FROM products p JOIN product_connections pc ON pc.product_id=p.id AND pc.connection_id=$1 WHERE p.status='active' ORDER BY p.id",[group.connection_id])).rows.map(p=>String(p.id));
   for(const productId of products)eligible.add(productId);
   if(!products.length)continue;
   const existing=(await db.query('SELECT product_order FROM group_rotation_state WHERE group_id=$1 FOR UPDATE',[id])).rows[0];
   const order=Array.isArray(existing?.product_order)?existing.product_order.map(String):[];
   if(!order.length){
    const shift=index%products.length;
    order.push(...products.slice(shift),...products.slice(0,shift));added+=products.length;
   }else{
    for(const productId of products)if(!order.includes(productId)){order.push(productId);added++;}
   }
   await db.query('INSERT INTO group_rotation_state(group_id,product_order,cursor) VALUES($1,$2,0) ON CONFLICT(group_id) DO UPDATE SET product_order=EXCLUDED.product_order,updated_at=NOW()',[id,JSON.stringify(order)]);
  }
  const previous=(await db.query('SELECT product_order FROM global_product_rotation_state WHERE id=1 FOR UPDATE')).rows[0];
  const globalOrder=Array.isArray(previous?.product_order)?previous.product_order.map(String):[];
  let globalAdded=0;
  for(const id of [...eligible].sort((a,b)=>Number(a)-Number(b))){
   if(!globalOrder.includes(id)){globalOrder.push(id);globalAdded++;}
  }
  await db.query('INSERT INTO global_product_rotation_state(id,product_order) VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET product_order=EXCLUDED.product_order,updated_at=NOW()',[JSON.stringify(globalOrder)]);
  await db.query('COMMIT');
  return {added,globalAdded,groups:groups.rows.length};
 }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}
 finally{db.release()}
}
async function planDay(pool,day,groupIds,options={}){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(471021)');
  const earlier=await db.query('SELECT assignments FROM rotation_plans WHERE day=$1 FOR UPDATE',[day]);
  if(earlier.rowCount&&!options.refresh){await db.query('COMMIT');return earlier.rows[0].assignments}
  const now=options.now instanceof Date?options.now:new Date();
  const daily=Number(options.daily??3);
  if(!Number.isInteger(daily)||daily<1||daily>20)throw Error('Informe entre 1 e 20 produtos por grupo');
  const start=parseTime(options.start||'06:00'),end=parseTime(options.end||'23:00');
  if(end<=start)throw Error('O fim deve ser posterior ao início');
  if(localMinute(now)>=end){await db.query('COMMIT');return earlier.rows[0]?.assignments||[]}
  const groupRows=(await db.query("SELECT id,connection_id FROM rotation_groups WHERE enabled=true AND connection_id IS NOT NULL AND id=ANY($1::bigint[]) ORDER BY id",[groupIds])).rows;
  const groups=[],eligible=new Set();
  for(const group of groupRows){
   const ids=(await db.query("SELECT p.id FROM products p JOIN product_connections pc ON pc.product_id=p.id AND pc.connection_id=$1 WHERE p.status='active' ORDER BY p.id",[group.connection_id])).rows.map(row=>String(row.id));
   groups.push({id:String(group.id),connectionId:String(group.connection_id),products:ids});
   for(const id of ids)eligible.add(id);
  }
  const log=await db.query("SELECT group_id,product_id,status,created_at FROM dispatch_log WHERE day=$1 AND status IN ('reserved','sent','failed')",[day]);
  const blocked=new Map(),counts=new Map(),lastAttempts=new Map();
  for(const entry of log.rows){
   const group=String(entry.group_id);
   if(!blocked.has(group))blocked.set(group,[]);
   blocked.get(group).push(String(entry.product_id));
   if(entry.status!=='failed')counts.set(group,(counts.get(group)||0)+1);
   const when=entry.created_at?new Date(entry.created_at).getTime():0;
   if(when>Number(lastAttempts.get(group)||0))lastAttempts.set(group,when);
  }
  const global=(await db.query('SELECT product_order,cycle_sent,last_group_id,history_seeded FROM global_product_rotation_state WHERE id=1 FOR UPDATE')).rows[0]||{};
  const order=(global.product_order||[]).map(String).filter(id=>eligible.has(id));
  for(const id of [...eligible].sort((a,b)=>Number(a)-Number(b)))if(!order.includes(id))order.push(id);
  const picked=chooseGlobal({groups,productOrder:order,cycleSent:global.cycle_sent||[],attemptsByGroup:counts,blockedByGroup:blocked,lastGroupId:global.last_group_id,daily});
  const scheduled=distribute(picked.assignments,{start,end,now,daily,lastAttempts}).assignments.map((a,i)=>({...a,rotationVersion:VERSION,cyclePhase:picked.assignments[i].cyclePhase}));
  await db.query('INSERT INTO global_product_rotation_state(id,product_order,cycle_sent,history_seeded) VALUES(1,$1,$2,TRUE) ON CONFLICT(id) DO UPDATE SET product_order=EXCLUDED.product_order,cycle_sent=EXCLUDED.cycle_sent,history_seeded=TRUE,updated_at=NOW()',[JSON.stringify(order),JSON.stringify(picked.cycleSent)]);
  await db.query('INSERT INTO rotation_plans(day,assignments) VALUES($1,$2) ON CONFLICT(day) DO UPDATE SET assignments=EXCLUDED.assignments,created_at=NOW()',[day,JSON.stringify(scheduled)]);
  await db.query('COMMIT');
  return scheduled;
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}finally{db.release()}
}
module.exports={pickGroupProducts,initialize,planDay,distribute,parseTime,selectDistinctProducts,selectCycleProducts,sqlRecordCycleAttempt,syncCatalogQueues,MIN_CONNECTION_GAP_MS};

