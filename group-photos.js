'use strict';
const sharp=require('sharp');
const {getConnection}=require('./waha-connections');
const DAY=24*60*60*1000,RETRY=5*60*1000,MAX_BYTES=2*1024*1024;
const inFlight=new Map(),waiting=[];let active=0;
async function initPhotoCache(pool){
 await pool.query('CREATE TABLE IF NOT EXISTS group_photos(group_id BIGINT PRIMARY KEY REFERENCES rotation_groups(id) ON DELETE CASCADE,connection_id BIGINT NOT NULL,chat_id TEXT NOT NULL,photo BYTEA,refresh_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
}
function limited(task){
 return new Promise((resolve,reject)=>{waiting.push({task,resolve,reject});drain()});
}
function drain(){
 while(active<2&&waiting.length){const job=waiting.shift();active++;Promise.resolve().then(job.task).then(job.resolve,job.reject).finally(()=>{active--;drain()});}
}
function mediaLocation(raw,base){
 const url=new URL(raw,base);
 const same=url.origin===new URL(base).origin;
 const meta=/^(?:[^.]+\.)*(?:whatsapp\.net|whatsapp\.com)$/.test(url.hostname);
 if(url.username||url.password||url.hash||(!same&&(!meta||url.protocol!=='https:'||url.port)))throw Error('Unsupported group image location');
 if(!['http:','https:'].includes(url.protocol))throw Error('Unsupported image protocol');
 return {url,same};
}
async function imageBytes(response){
 const size=Number(response.headers.get('content-length')||0);
 if(size>MAX_BYTES){await response.body?.cancel();throw Error('Group image exceeds size limit')}
 if(!response.body)throw Error('Empty group image');
 const reader=response.body.getReader(),chunks=[];let length=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>MAX_BYTES){await reader.cancel();throw Error('Group image exceeds size limit')}chunks.push(Buffer.from(value));}}finally{reader.releaseLock()}
 if(!length)throw Error('Empty group image');
 return Buffer.concat(chunks,length);
}
async function fetchGroupPhoto(config,chatId,{fetchImpl=fetch}={}){
 if(!/^\d+(?:-\d+)*@g\.us$/.test(chatId))throw Error('Invalid group address');
 const base=new URL(config.baseUrl);
 if(!['http:','https:'].includes(base.protocol)||base.username||base.password)throw Error('Invalid WAHA address');
 const endpoint=base.origin+base.pathname.replace(/\/$/,'').replace(/\/api$/,'');
 const prefix='/api/'+encodeURIComponent(config.session||'default');
 const requestOptions={headers:{Accept:'application/json','X-Api-Key':config.apiKey},signal:AbortSignal.timeout(10000),redirect:'error'};
 let response=await fetchImpl(endpoint+prefix+'/groups/'+encodeURIComponent(chatId)+'/picture?refresh=false',requestOptions);
 if([404,405,501].includes(response.status))response=await fetchImpl(endpoint+prefix+'/chats/'+encodeURIComponent(chatId)+'/picture?refresh=false',{...requestOptions,signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Group picture lookup failed: '+response.status);
 const payload=await response.json();
 if(payload?.url===null||payload?.url==='')return null;
 if(typeof payload?.url!=='string')throw Error('Invalid group picture response');
 let location=mediaLocation(payload.url,base);
 for(let redirects=0;redirects<4;redirects++){
  const media=await fetchImpl(location.url.href,{headers:{Accept:'image/jpeg,image/png,image/webp',...(location.same?{'X-Api-Key':config.apiKey}:{})},signal:AbortSignal.timeout(10000),redirect:'manual'});
  if([301,302,303,307,308].includes(media.status)){
   const target=media.headers.get('location');await media.body?.cancel();if(!target)throw Error('Invalid image redirect');location=mediaLocation(new URL(target,location.url).href,base);continue;
  }
  if(!media.ok)throw Error('Group image download failed: '+media.status);
  const bytes=await imageBytes(media);
  // Decode only raster formats, then store a small, metadata-free thumbnail.
  const image=sharp(bytes,{limitInputPixels:16000000,animated:false});
  const info=await image.metadata();
  if(!['jpeg','png','webp'].includes(info.format))throw Error('Unsupported group image format');
  return image.rotate().resize(112,112,{fit:'cover'}).webp({quality:82}).toBuffer();
 }
 throw Error('Too many group image redirects');
}
async function loadGroupPhoto(pool,id,{connectionReader=getConnection,fetchImpl=fetch,now=Date.now()}={}){
 if(!/^[1-9]\d{0,18}$/.test(String(id))||BigInt(id)>9223372036854775807n)return null;
 const row=(await pool.query('SELECT g.id,g.chat_id,g.connection_id,p.photo,p.refresh_at FROM rotation_groups g LEFT JOIN group_photos p ON p.group_id=g.id AND p.connection_id=g.connection_id AND p.chat_id=g.chat_id WHERE g.id=$1 AND g.connection_id IS NOT NULL',[String(id)])).rows[0];
 if(!row)return null;
 if(row.refresh_at&&new Date(row.refresh_at).getTime()>now)return row.photo||null;
 const key=String(row.connection_id)+':'+row.chat_id;
 if(inFlight.has(key))return inFlight.get(key);
 const work=limited(async()=>{
  let photo=row.photo||null,ttl=DAY;
  try{const config=await connectionReader(pool,row.connection_id);if(!config)throw Error('Connection unavailable');photo=await fetchGroupPhoto(config,row.chat_id,{fetchImpl});}
  catch{ttl=RETRY;/* Preserve a previous thumbnail while a connection is unavailable. */}
  // Store only if the group still belongs to the connection used for this lookup.
  await pool.query('INSERT INTO group_photos(group_id,connection_id,chat_id,photo,refresh_at) SELECT id,connection_id,chat_id,$4,$5 FROM rotation_groups WHERE id=$1 AND connection_id=$2 AND chat_id=$3 ON CONFLICT(group_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,chat_id=EXCLUDED.chat_id,photo=EXCLUDED.photo,refresh_at=EXCLUDED.refresh_at,updated_at=NOW()',[row.id,row.connection_id,row.chat_id,photo,new Date(now+ttl)]);
  return photo;
 });
 inFlight.set(key,work);try{return await work}finally{inFlight.delete(key)}
}
async function invalidateConnectionPhotos(pool,connectionId){
 await pool.query('UPDATE group_photos SET refresh_at=NOW(),updated_at=NOW() WHERE connection_id=$1',[connectionId]);
}
module.exports={initPhotoCache,loadGroupPhoto,invalidateConnectionPhotos,fetchGroupPhoto,mediaLocation};
