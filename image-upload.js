'use strict';
const Busboy=require('busboy');
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const sharp=require('sharp');
const ROOT=process.env.UPLOAD_DIR||'/data/products';
const LIMIT=5*1024*1024;
function imageFormat(buf){
 if(buf.length>=8&&buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
 if(buf.length>=3&&buf[0]===255&&buf[1]===216&&buf[2]===255)return 'jpg';
 if(buf.length>=12&&buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP')return 'webp';
 return null;
}
function readMultipart(req){
 return new Promise((resolve,reject)=>{
  const fields={},files=[];
  let parser;
  try{parser=Busboy({headers:req.headers,limits:{fileSize:LIMIT,files:1,fields:128,fieldSize:5000,parts:140}});}catch(e){return reject(e)}
  parser.on('field',(name,value)=>{if(['id','title','description','image_url','product_url','affiliate_url','price','status','show_disclosure'].includes(name)||/^connection_[0-9]+$/.test(name))fields[name]=value});
  parser.on('file',(name,stream)=>{if(name!=='image'){stream.resume();return}
   const chunks=[];let truncated=false;
   stream.on('limit',()=>{truncated=true});
   stream.on('data',chunk=>chunks.push(chunk));
   stream.on('end',()=>{if(truncated)return reject(Error('Imagem acima de 5MB'));if(chunks.length)files.push(Buffer.concat(chunks));});
  });
  parser.on('error',reject);
  parser.on('close',()=>resolve({fields,image:files[0]||null}));
  req.pipe(parser);
 });
}
async function saveImage(buf){
 const ext=imageFormat(buf);
 if(!ext)throw Error('Formato de imagem não aceito. Use JPEG, PNG ou WebP.');
 let bytes=buf;
 let outputExt=ext;
 if(ext==='webp'){
  // JPEG does not support transparency: flatten onto white rather than producing black backgrounds.
  bytes=await sharp(buf,{limitInputPixels:40000000}).rotate().flatten({background:'#ffffff'}).jpeg({quality:88,mozjpeg:true}).toBuffer();
  outputExt='jpg';
 }
 await fs.mkdir(ROOT,{recursive:true,mode:0o700});
 const name=crypto.randomUUID()+'.'+outputExt;
 await fs.writeFile(path.join(ROOT,name),bytes,{flag:'wx',mode:0o600});
 return '/uploads/'+name;
}
async function getImage(name){
 if(!/^[0-9a-f-]{36}\.(png|jpg|webp)$/.test(name))return null;
 try{
 const file=await fs.readFile(path.join(ROOT,name));
 return {body:file,type:name.endsWith('.png')?'image/png':name.endsWith('.webp')?'image/webp':'image/jpeg'};
 }catch{return null}
}
async function deleteImage(url){
 if(typeof url!=='string'||!/^\/uploads\/[0-9a-f-]{36}\.(png|jpg|webp)$/.test(url))return false;
 try{await fs.unlink(path.join(ROOT,url.slice('/uploads/'.length)));return true}
 catch(e){if(e.code==='ENOENT')return false;throw e}
}
module.exports={readMultipart,saveImage,getImage,deleteImage};
