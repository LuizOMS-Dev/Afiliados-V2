'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeGroups,listGroups}=require('./waha-groups');
test('deduplicates WhatsApp group IDs, retaining useful names',()=>{
 const a=normalizeGroups([{id:'123@g.us',subject:'Ofertas'},{id:'123@g.us'},{id:'987-123@g.us',subject:'Promoções'},{id:'123@c.us',subject:'Contato'}]);
 assert.deepEqual(a.map(g=>g.id).sort(),['123@g.us','987-123@g.us']);
 assert.equal(a.find(g=>g.id==='123@g.us').name,'Ofertas');
});
test('paginates only read-only WAHA groups endpoint',async()=>{
 const visited=[];
 const fetchImpl=async u=>{visited.push(u);return {ok:true,json:async()=>[{id:'123@g.us',subject:'Grupo aberto'}]}};
 const items=await listGroups({baseUrl:'https://waha.example.com/api',apiKey:'example',session:'default',fetchImpl});
 assert.equal(items.length,1);assert.ok(visited.length>=1);
 assert.ok(visited.some(url=>/\/api\/default\/groups\?/.test(url)));
});

test('understands GOWS nested JIDs and URL-encoded group IDs',()=>{
 const groups=normalizeGroups([{id:{user:'120363012345678901',server:'g.us'},subject:'Grupo GOWS'},{key:{remoteJid:'5511999-1489425125%40g.us'},name:'Grupo legado'}]);
 assert.deepEqual(groups.map(g=>g.name).sort(),['Grupo GOWS','Grupo legado']);
});
test('does not classify private contacts as groups',()=>{
 assert.deepEqual(normalizeGroups([{id:'551199999999@c.us',name:'Contato'}]),[]);
});
test('uses group-only response to normalize numeric identifiers safely',()=>{
 const groups=normalizeGroups([{id:'120363012345678901',subject:'Grupo sem sufixo'}],{forceGroup:true});
 assert.equal(groups[0].id,'120363012345678901@g.us');
});

test('discovers recently joined groups on later pages and another endpoint',async()=>{
 const visited=[];
 const fetchImpl=async url=>{
  visited.push(url);
  const u=new URL(url);
  const offset=Number(u.searchParams.get('offset')||0);
  let items=[];
  if(u.pathname.endsWith('/groups')){
   if(offset<250)items=Array.from({length:50},(_,i)=>({id:(100000+offset+i)+'@g.us',subject:'Antigo '+(offset+i)}));
   if(offset===250)items=[{id:'999999@g.us',subject:'Grupo recém-adicionado'}];
  }else if(u.pathname.endsWith('/chats/overview')){
   items=[{id:'888888@g.us',name:'Novo na visão geral'}];
  }
  return {ok:true,json:async()=>items};
 };
 const groups=await listGroups({baseUrl:'https://waha.example.com',apiKey:'key',session:'default',fetchImpl});
 assert.ok(groups.some(g=>g.id==='999999@g.us'));
 assert.ok(groups.some(g=>g.id==='888888@g.us'));
 assert.ok(visited.some(u=>u.includes('offset=250')));
});

test('manual synchronization refreshes only the selected session before reading groups',async()=>{
 const calls=[];
 const fetchImpl=async (url,options={})=>{
  calls.push({url,method:options.method||'GET'});
  if(url.endsWith('/groups/refresh'))return {ok:true,status:200};
  return {ok:true,status:200,json:async()=>[{id:'123456@g.us',subject:'Grupo atualizado'}]};
 };
 const result=await listGroups({baseUrl:'https://waha.example.com',session:'contaB',apiKey:'secret',fetchImpl});
 assert.equal(result[0].name,'Grupo atualizado');
 assert.equal(calls[0].method,'POST');
 assert.match(calls[0].url,/\/api\/contaB\/groups\/refresh$/);
 assert.ok(calls.every(c=>c.url.includes('/api/contaB/')));
});

test('allows safe reconciliation only for complete official group inventory matching count',async()=>{
 const fetchImpl=async (url)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/groups/refresh'))return {ok:true,status:200};
  if(path.endsWith('/groups/count'))return {ok:true,json:async()=>({count:1})};
  if(path.endsWith('/groups'))return {ok:true,json:async()=>[{id:'111@g.us',subject:'Atual'}]};
  return {ok:true,json:async()=>[{id:'111@g.us',subject:'Atual'},{id:'222@g.us',subject:'Histórico antigo'}]};
 };
 const groups=await listGroups({baseUrl:'https://waha.example.com',session:'conta1',apiKey:'key',fetchImpl});
 assert.deepEqual(groups.reconciliation,{complete:true,ids:['111@g.us'],count:1});
 assert.ok(groups.some(g=>g.id==='222@g.us'));
});
test('never reconciles departures when official count disagrees with fetched groups',async()=>{
 const fetchImpl=async url=>{
  const path=new URL(url).pathname;
  if(path.endsWith('/groups/refresh'))return {ok:true,status:200};
  if(path.endsWith('/groups/count'))return {ok:true,json:async()=>({count:2})};
  return {ok:true,json:async()=>[{id:'111@g.us',subject:'Atual'}]};
 };
 const groups=await listGroups({baseUrl:'https://waha.example.com',session:'conta1',apiKey:'key',fetchImpl});
 assert.equal(groups.reconciliation.complete,false);
});
