'use strict';
const Busboy=require('busboy');
const sharp=require('sharp');
const {effectiveTheme,validateTheme}=require('./ui-themes');
const DEFAULT_SITE_NAME='Central de Afiliados';
const MAX_IMAGE_BYTES=3*1024*1024;
async function initBrand(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS site_branding(id INTEGER PRIMARY KEY CHECK(id=1),site_name VARCHAR(80) NOT NULL DEFAULT 'Central de Afiliados',logo BYTEA, favicon BYTEA,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 await pool.query("ALTER TABLE site_branding ADD COLUMN IF NOT EXISTS whatsapp_group_url TEXT NOT NULL DEFAULT ''");
 await pool.query("ALTER TABLE site_branding ADD COLUMN IF NOT EXISTS theme_id TEXT NOT NULL DEFAULT 'esmeralda'");
 await pool.query('INSERT INTO site_branding(id) VALUES(1) ON CONFLICT(id) DO NOTHING');
}
async function loadBrand(pool){
 const result=await pool.query('SELECT site_name,whatsapp_group_url,theme_id,logo IS NOT NULL AS has_logo,favicon IS NOT NULL AS has_favicon,updated_at FROM site_branding WHERE id=1');
 const row=result.rows[0]||{};
 return {whatsapp_group_url:row.whatsapp_group_url||'',theme_id:effectiveTheme(row.theme_id),site_name:row.site_name||DEFAULT_SITE_NAME,has_logo:!!row.has_logo,has_favicon:!!row.has_favicon,version:row.updated_at?new Date(row.updated_at).getTime():0};
}
function validateSiteName(raw){
 const name=String(raw??'').trim();
 if(name.length<2||name.length>80||/[\u0000-\u001f\u007f]/.test(name))throw Error('Informe um nome para o site entre 2 e 80 caracteres.');
 return name;
}
function validateWhatsAppGroupUrl(raw){
 const value=String(raw??'').trim();
 if(!value)return '';
 let url;
 try{url=new URL(value)}catch{throw Error('Informe um link válido de convite de grupo do WhatsApp.');}
 if(value.length>1000||url.protocol!=='https:'||url.hostname!=='chat.whatsapp.com'||url.port||url.username||url.password||!/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))throw Error('Use um link de grupo no formato https://chat.whatsapp.com/convite.');
 return url.href;
}
// The sidebar shows either the uploaded logo or the written site name, never both.
// The browser-tab title and topbar name are managed separately by server.js.
function renderSidebarBrand(brand){
 const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const name=escapeHtml(brand.site_name||DEFAULT_SITE_NAME);
 const content=brand.has_logo
  ? '<img class="sidebar-logo" src="/brand/logo.png?v='+Number(brand.version||0)+'" alt="'+name+'">'
  : '<strong>'+name+'</strong><small>Ofertas · Produtos · WhatsApp</small>';
 return '<div class="sidebar-brand'+(brand.has_logo?' has-logo':'')+'">'+content+'</div>';
}
function readBrandForm(req){
 return new Promise((resolve,reject)=>{
  let parser,problem=null;
  const fields={},files={};
  try{parser=Busboy({headers:req.headers,limits:{files:2,fileSize:MAX_IMAGE_BYTES,fields:6,fieldSize:1000,parts:9}});}catch(e){return reject(e);}
  parser.on('field',(name,value)=>{if(['site_name','remove_logo','remove_favicon','whatsapp_group_url','theme'].includes(name))fields[name]=value});
  parser.on('file',(name,stream)=>{
   if(!['logo','favicon'].includes(name)){problem=Error('Arquivo não permitido.');stream.resume();return;}
   if(files[name]){problem=Error('Envie apenas um arquivo por campo.');stream.resume();return;}
   const chunks=[];let limited=false;
   stream.on('limit',()=>{limited=true;problem=Error('Cada imagem deve ter no máximo 3 MB.');});
   stream.on('data',chunk=>{if(!limited)chunks.push(chunk)});
   stream.on('end',()=>{if(!limited&&chunks.length)files[name]=Buffer.concat(chunks)});
   stream.on('error',reject);
  });
  parser.on('filesLimit',()=>{problem=Error('Envie no máximo duas imagens.');});
  parser.on('fieldsLimit',()=>{problem=Error('Formulário excedeu o limite permitido.');});
  parser.on('partsLimit',()=>{problem=Error('Formulário excedeu o limite permitido.');});
  parser.on('error',reject);
  parser.on('close',()=>problem?reject(problem):resolve({fields,files}));
  req.pipe(parser);
 });
}
async function normalizeImage(buffer,kind){
 if(!Buffer.isBuffer(buffer)||!buffer.length)throw Error('Imagem vazia.');
 const isPng=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 const isJpeg=buffer[0]===255&&buffer[1]===216&&buffer[2]===255;
 const isWebp=buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';
 if(!isPng&&!isJpeg&&!isWebp)throw Error('Formato inválido. Use PNG, JPEG ou WebP.');
 if(!['logo','favicon'].includes(kind))throw Error('Tipo de imagem não permitido.');
 try{
  const source=sharp(buffer,{limitInputPixels:16000000,animated:false}).rotate();
  if(kind==='favicon')return await source.resize(64,64,{fit:'contain',background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();
  return await source.resize(1000,400,{fit:'inside',withoutEnlargement:true}).png().toBuffer();
 }catch{throw Error('Não foi possível processar a imagem. Verifique se o arquivo está íntegro.');}
}
async function updateBrand(pool,{site_name,logo,favicon,whatsapp_group_url,theme}){
 const fields=['site_name=$1','updated_at=NOW()'],values=[validateSiteName(site_name)];
 if(whatsapp_group_url!==undefined){values.push(validateWhatsAppGroupUrl(whatsapp_group_url));fields.push('whatsapp_group_url=$'+values.length);}
 if(theme!==undefined){values.push(validateTheme(theme));fields.push('theme_id=$'+values.length);}
 if(logo!==undefined){values.push(logo);fields.push('logo=$'+values.length);}
 if(favicon!==undefined){values.push(favicon);fields.push('favicon=$'+values.length);}
 await pool.query('UPDATE site_branding SET '+fields.join(',')+' WHERE id=1',values);
 return loadBrand(pool);
}
async function getBrandAsset(pool,kind){
 if(!['logo','favicon'].includes(kind))return null;
 const result=await pool.query('SELECT '+kind+' FROM site_branding WHERE id=1');
 return result.rows[0]?.[kind]||null;
}
module.exports={validateWhatsAppGroupUrl,DEFAULT_SITE_NAME,initBrand,loadBrand,validateSiteName,renderSidebarBrand,readBrandForm,normalizeImage,updateBrand,getBrandAsset};

