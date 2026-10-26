'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {validateWhatsAppGroupUrl,updateBrand}=require('./brand-settings');
const {sendViaWaha}=require('./dispatch');
test('accepts WhatsApp group invitations and rejects other destinations',()=>{
 assert.equal(validateWhatsAppGroupUrl('  https://chat.whatsapp.com/Abc123?s=sh  '),'https://chat.whatsapp.com/Abc123?s=sh');
 assert.equal(validateWhatsAppGroupUrl(''),'');
 for(const url of ['http://chat.whatsapp.com/Abc','https://example.com/Abc','https://chat.whatsapp.com.evil.test/Abc','https://chat.whatsapp.com/','https://user:pass@chat.whatsapp.com/Abc'])assert.throws(()=>validateWhatsAppGroupUrl(url));
});
test('saves and reloads the invite, and permits clearing it',async()=>{
 let saved='';
 const pool={query:async(sql,values)=>{
  if(sql.startsWith('UPDATE'))saved=values[1];
  return {rows:[{site_name:'Ofertas',whatsapp_group_url:saved}]};
 }};
 assert.equal((await updateBrand(pool,{site_name:'Ofertas',whatsapp_group_url:'https://chat.whatsapp.com/Abc'})).whatsapp_group_url,'https://chat.whatsapp.com/Abc');
 assert.equal((await updateBrand(pool,{site_name:'Ofertas',whatsapp_group_url:''})).whatsapp_group_url,'');
});
test('text and image offers append invite after disclosure; blank setting omits it',async()=>{
 const oldFetch=global.fetch;const sent=[];
 global.fetch=async(url,options)=>{sent.push({url,body:JSON.parse(options.body)});return {ok:true,json:async()=>({id:'mock'})}};
 try{
  const item={title:'Produto',description:'Descrição',price:19.9,affiliate_url:'https://example.com/produto',show_disclosure:true,chat_id:'123@g.us',whatsapp_group_url:'https://chat.whatsapp.com/Abc'};
  const config={baseUrl:'https://waha.example.com',session:'default',apiKey:'test'};
  await sendViaWaha(config,item);
  await sendViaWaha(config,{...item,image_url:'https://example.com/imagem.jpg'});
  const ending='Participe do nosso grupo no WhatsApp e confira mais ofertas.\nhttps://chat.whatsapp.com/Abc';
  for(const message of [sent[0].body.text,sent[1].body.caption]){
   assert.ok(message.endsWith(ending));
   assert.ok(message.indexOf('Publicidade / link de afiliado.')<message.indexOf(ending));
   assert.equal(message.split(ending).length,2);
  }
  await sendViaWaha(config,{...item,whatsapp_group_url:''});
  assert.ok(!sent[2].body.text.includes('Participe'));
 }finally{global.fetch=oldFetch}
});
