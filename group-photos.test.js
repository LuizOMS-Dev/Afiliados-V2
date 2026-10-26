'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp');
const {fetchGroupPhoto,loadGroupPhoto,mediaLocation,invalidateConnectionPhotos}=require('./group-photos');
const config={id:'2',baseUrl:'https://waha.example.com',session:'contaB',apiKey:'private-key'};
const sample=()=>sharp({create:{width:32,height:24,channels:3,background:'#426a92'}}).png().toBuffer();
test('retrieves the correct group and session and keeps API credentials off WhatsApp media requests',async()=>{
 const bytes=await sample(),calls=[];
 const photo=await fetchGroupPhoto(config,'123456@g.us',{fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?Response.json({url:'https://pps.whatsapp.net/photo.jpg'}):new Response(bytes)}});
 assert.match(calls[0].url,/\/api\/contaB\/groups\/123456%40g.us\/picture\?refresh=false$/);
 assert.equal(calls[0].options.headers['X-Api-Key'],'private-key');assert.equal(calls[1].options.headers['X-Api-Key'],undefined);
 const meta=await sharp(photo).metadata();assert.equal(meta.format,'webp');assert.equal(meta.width,112);assert.equal(meta.height,112);
});
test('no group picture is a valid cached empty result, not a download',async()=>{
 let count=0;const photo=await fetchGroupPhoto(config,'987@g.us',{fetchImpl:async()=>{count++;return Response.json({url:null})}});
 assert.equal(photo,null);assert.equal(count,1);
});
test('fallback chat picture endpoint is read-only and keeps the selected session',async()=>{
 const calls=[];const photo=await fetchGroupPhoto(config,'987@g.us',{fetchImpl:async(url,options)=>{calls.push({url,options});return calls.length===1?new Response('',{status:404}):Response.json({url:null})}});
 assert.equal(photo,null);assert.equal(calls.length,2);assert.ok(calls[1].url.includes('/api/contaB/chats/987%40g.us/picture'));assert.ok(calls.every(x=>!x.options.method||x.options.method==='GET'));
});
test('blocks arbitrary, credentialed, and insecure external image locations',()=>{
 for(const url of ['http://127.0.0.1/admin','https://attacker.example.com/p.png','https://whatsapp.net.attacker.test/p.png','https://user:pass@pps.whatsapp.net/p.png','http://pps.whatsapp.net/p.png','file:///etc/passwd'])assert.throws(()=>mediaLocation(url,config.baseUrl));
 assert.equal(mediaLocation('/api/files/group.jpg',config.baseUrl).same,true);
});
test('a redirect to external WhatsApp media does not forward the WAHA API key',async()=>{
 const bytes=await sample(),calls=[];
 await fetchGroupPhoto(config,'321@g.us',{fetchImpl:async(url,options)=>{calls.push({url,options});if(calls.length===1)return Response.json({url:config.baseUrl+'/api/files/321'});if(calls.length===2)return new Response(null,{status:302,headers:{location:'https://pps.whatsapp.net/321.jpg'}});return new Response(bytes)}});
 assert.equal(calls[1].options.headers['X-Api-Key'],'private-key');assert.equal(calls[2].options.headers['X-Api-Key'],undefined);
});
test('enforces image size limits even if a server omits content-length',async()=>{
 let n=0;await assert.rejects(()=>fetchGroupPhoto(config,'555@g.us',{fetchImpl:async()=>++n===1?Response.json({url:'https://pps.whatsapp.net/555.jpg'}):new Response(Buffer.alloc(2*1024*1024+1))}),/size limit/);
});
test('rejects SVG and invalid image content rather than serving active documents',async()=>{
 let n=0;await assert.rejects(()=>fetchGroupPhoto(config,'556@g.us',{fetchImpl:async()=>++n===1?Response.json({url:'https://pps.whatsapp.net/556.jpg'}):new Response('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')}),/Unsupported group image format/);
});
function cachePool(row){const calls=[];return {calls,query:async(sql,values)=>{calls.push({sql,values});return {rows:sql.startsWith('SELECT')?[row].filter(Boolean):[]}}};}
test('fresh cached photos and cached absence do not contact WAHA',async()=>{
 for(const photo of [Buffer.from('cached-thumbnail'),null]){const pool=cachePool({id:'11',connection_id:'2',chat_id:'11@g.us',photo,refresh_at:new Date(100000)});const result=await loadGroupPhoto(pool,'11',{now:1000,connectionReader:()=>{throw Error('must not run')}});assert.equal(result,photo);assert.equal(pool.calls.length,1);}
});
test('failed refresh preserves previous image and retries after five minutes',async()=>{
 const bytes=Buffer.from('last-good-photo'),pool=cachePool({id:'12',connection_id:'2',chat_id:'12@g.us',photo:bytes,refresh_at:new Date(0)});
 const result=await loadGroupPhoto(pool,'12',{now:1000,connectionReader:async()=>config,fetchImpl:async()=>{throw Error('offline')}});
 assert.equal(result,bytes);assert.equal(pool.calls[1].values[3],bytes);assert.equal(pool.calls[1].values[4].getTime(),301000);
 assert.match(pool.calls[0].sql,/p.connection_id=g.connection_id AND p.chat_id=g.chat_id/);
 assert.match(pool.calls[1].sql,/WHERE id=\$1 AND connection_id=\$2 AND chat_id=\$3/);
});
test('simultaneous requests for the same group coalesce without changing group authorization',async()=>{
 const pool=cachePool({id:'13',connection_id:'2',chat_id:'13@g.us',photo:null,refresh_at:null});let lookups=0;
 const args={now:1000,connectionReader:async()=>config,fetchImpl:async()=>{lookups++;await new Promise(resolve=>setTimeout(resolve,5));return Response.json({url:null})}};
 assert.deepEqual(await Promise.all([loadGroupPhoto(pool,'13',args),loadGroupPhoto(pool,'13',args)]),[null,null]);assert.equal(lookups,1);
 assert.ok(pool.calls.every(x=>!x.sql.includes('SET enabled')));
});
test('missing groups and invalid identifiers never contact WAHA',async()=>{
 const pool=cachePool(null);for(const id of ['bad','-1','9999999999999999999999','9223372036854775808','0'])assert.equal(await loadGroupPhoto(pool,id),null);
 assert.equal(pool.calls.length,0);assert.equal(await loadGroupPhoto(pool,'99'),null);assert.equal(pool.calls.length,1);
});
test('manual sync invalidates photos only for the chosen connection',async()=>{
 const pool=cachePool(null);await invalidateConnectionPhotos(pool,'3');assert.deepEqual(pool.calls[0].values,['3']);assert.match(pool.calls[0].sql,/WHERE connection_id=\$1/);assert.ok(!pool.calls[0].sql.includes('enabled'));
});
