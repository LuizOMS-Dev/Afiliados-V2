'use strict';
function entries(payload){
 if(Array.isArray(payload))return payload;
 if(!payload||typeof payload!=='object')return [];
 for(const key of ['data','groups','items','results','chats']){
  const value=payload[key];
  if(Array.isArray(value))return value;
  if(value&&typeof value==='object'){
   for(const nested of ['items','data','groups','results'])if(Array.isArray(value[nested]))return value[nested];
  }
 }
 return [];
}
function groupId(raw,force=false){
 const candidates=[];
 function collect(v,depth=0){
  if(depth>8||v==null)return;
  if(typeof v==='string'){
   const str=decodeURIComponentSafe(v);
   const matches=str.match(/\d+(?:-\d+)*@g\.us/gi)||[];
   candidates.push(...matches);
   if(force&&/^\d+(?:-\d+)*$/.test(str.trim()))candidates.push(str.trim()+'@g.us');
   return;
  }
  if(Array.isArray(v)){for(const item of v.slice(0,100))collect(item,depth+1);return}
  if(typeof v==='object'){
   if(typeof v.user==='string'&&v.server==='g.us')collect(v.user+'@g.us',depth+1);
   for(const key of ['_serialized','id','chatId','jid','JID','groupId','remoteJid','RemoteJid','wid','key','groupMetadata','_chat','data','value']){
    if(v[key]!==undefined)collect(v[key],depth+1);
   }
  }
 }
 collect(raw);
 candidates.sort((x,y)=>y.length-x.length);
 return candidates[0]?.toLowerCase()||'';
}
function decodeURIComponentSafe(v){try{return decodeURIComponent(v)}catch{return v}}
function normalizeGroups(payload,{forceGroup=false}={}){
 const found=new Map();
 for(const item of entries(payload)){
  let id=groupId(item,false);
  if(!id&&forceGroup)id=groupId(item,true);
  if(!id)continue;
  const name=String(item?.subject||item?.Subject||item?.name||item?.Name||item?.title||item?.formattedTitle||item?.groupMetadata?.subject||item?._chat?.name||id).trim().slice(0,180)||id;
  const key=id.toLowerCase();
  if(!found.has(key)||found.get(key).name===id)found.set(key,{id,name});
 }
 return [...found.values()].sort((x,y)=>x.name.localeCompare(y.name,'pt-BR'));
}
async function listGroups({baseUrl,apiKey,session='default',fetchImpl=fetch}){
 const base=new URL(baseUrl);
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw Error('Invalid WAHA address');
 const endpoint=base.origin+(base.pathname.replace(/\/$/,'').replace(/\/api$/,''));
 const sess=encodeURIComponent(session);
 const paths=[
  '/api/'+sess+'/groups?limit=50&offset=%d&sortBy=id&sortOrder=asc&exclude=participants',
  '/api/'+sess+'/groups?limit=50&offset=%d&sortBy=id&sortOrder=asc',
  '/api/'+sess+'/groups',
  '/api/'+sess+'/chats/overview?limit=50&offset=%d',
  '/api/'+sess+'/chats?limit=50&offset=%d'
 ];
 const found=new Map(),diagnostics=[];
 const authoritative=new Map();let authoritativeComplete=false,authoritativeCount=null,authoritativeError=false;
 const deadline=Date.now()+90000;
 // An explicit synchronization requests a WAHA server-side refresh for this
 // session only. If unsupported or rate-limited, keep the read-only fallback.
 try{
  const refresh=await fetchImpl(endpoint+'/api/'+sess+'/groups/refresh',{
   method:'POST',headers:{Accept:'application/json','X-Api-Key':apiKey},
   signal:AbortSignal.timeout(12000),redirect:'error'
  });
  diagnostics.push('refresh: HTTP '+refresh.status);
 }catch(e){diagnostics.push('refresh: '+(e.cause?.code||e.name||'network error'))}

 try{
  const countResponse=await fetchImpl(endpoint+'/api/'+sess+'/groups/count',{headers:{Accept:'application/json','X-Api-Key':apiKey},signal:AbortSignal.timeout(8000),redirect:'error'});
  if(countResponse.ok){const c=await countResponse.json();if(Number.isSafeInteger(Number(c.count))&&Number(c.count)>=0)authoritativeCount=Number(c.count)}
 }catch{}
 for(const pattern of paths){
  if(Date.now()>deadline)break;
  const official=pattern===paths[0];let completed=false;
  const paginated=pattern.includes('%d');
  const seenPages=new Set();
  for(let page=0;page<(paginated?100:1);page++){
   if(Date.now()>deadline){if(official)authoritativeError=true;break}
   const route=pattern.replace('%d',String(page*50));
   let response;
   try{
    response=await fetchImpl(endpoint+route,{headers:{Accept:'application/json','X-Api-Key':apiKey,'Cache-Control':'no-cache'},signal:AbortSignal.timeout(Math.min(8000,Math.max(1000,deadline-Date.now()))),redirect:'error'});
   }catch(e){diagnostics.push(route.split('?')[0]+': '+(e.cause?.code||e.name||'network error'));if(official)authoritativeError=true;break}
   if(!response.ok){diagnostics.push(route.split('?')[0]+': HTTP '+response.status);if(official)authoritativeError=true;break}
   let payload;
   try{payload=await response.json()}catch{diagnostics.push(route.split('?')[0]+': invalid JSON');if(official)authoritativeError=true;break}
   const batch=entries(payload);
   // Some WAHA engines ignore offset. Stop on repeated pages instead of
   // treating a repeated first page as the complete group inventory.
   const signature=JSON.stringify(batch.map(item=>groupId(item,true)||item?.id||item?.chatId||item?.name));
   if(seenPages.has(signature)){diagnostics.push(route.split('?')[0]+': repeated page at offset '+page*50);if(official)authoritativeError=true;break}
   seenPages.add(signature);
   for(const group of normalizeGroups(batch,{forceGroup:official})){
    if(official)authoritative.set(group.id.toLowerCase(),group);
    const old=found.get(group.id.toLowerCase());
    if(!old||old.name===old.id)found.set(group.id.toLowerCase(),group);
   }
   diagnostics.push(route.split('?')[0]+': '+batch.length+' items, '+found.size+' groups');
   if(!paginated||batch.length<50){if(official)completed=true;break;}
  }
  if(official&&completed&&!authoritativeError)authoritativeComplete=true;
  // Do not stop after the first successful endpoint: a session's cached
  // group inventory and chat overview may contain different/new groups.
 }
 const result=[...found.values()].sort((a,b)=>a.name.localeCompare(b.name,'pt-BR'));
 if(!result.length&&!(authoritativeComplete&&!authoritativeError&&authoritativeCount===0)){const err=new Error('Nenhum grupo reconhecido. Diagnóstico: '+diagnostics.join(' | ').slice(0,450));err.code='NO_GROUPS';throw err}
 // Reconciliation is allowed only when an official, fully paginated groups
 // response agrees with the WAHA count endpoint. Chat caches aren't authoritative.
 Object.defineProperty(result,'reconciliation',{value:{complete:authoritativeComplete&&!authoritativeError&&authoritativeCount!==null&&authoritative.size===authoritativeCount,ids:[...authoritative.keys()],count:authoritativeCount},enumerable:false});
 return result;
}
module.exports={listGroups,normalizeGroups};
