'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs/promises');
const path=require('node:path');
function keyFile(){return process.env.WAHA_KEY_FILE||'/data/secrets/waha.key';}
async function getKey(){
  await fs.mkdir(path.dirname(keyFile()),{recursive:true,mode:0o700});
  try {const key=await fs.readFile(keyFile());if(key.length!==32)throw Error('Invalid existing encryption key');return key;}
  catch(e){if(e.code!=='ENOENT')throw e;}
  const candidate=crypto.randomBytes(32);
  try{await fs.writeFile(keyFile(),candidate,{flag:'wx',mode:0o600});return candidate;}
  catch(e){if(e.code==='EEXIST'){const key=await fs.readFile(keyFile());if(key.length!==32)throw Error('Invalid existing encryption key');return key;}throw e;}
}
async function encrypt(text){
 const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',await getKey(),iv);
 const ciphertext=Buffer.concat([cipher.update(text,'utf8'),cipher.final()]);
 return Buffer.concat([iv,cipher.getAuthTag(),ciphertext]).toString('base64');
}
async function decrypt(value){
 const buf=Buffer.from(value,'base64');if(buf.length<29)throw Error('Invalid encrypted value');
 const decipher=crypto.createDecipheriv('aes-256-gcm',await getKey(),buf.subarray(0,12));
 decipher.setAuthTag(buf.subarray(12,28));
 return Buffer.concat([decipher.update(buf.subarray(28)),decipher.final()]).toString('utf8');
}
async function initSettings(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS waha_settings(id SMALLINT PRIMARY KEY CHECK(id=1),base_url TEXT NOT NULL,session_name TEXT NOT NULL,api_key_ciphertext TEXT NOT NULL,updated_at TIMESTAMPTZ DEFAULT NOW())");
}
async function readSettings(pool){
 const row=(await pool.query('SELECT base_url,session_name,api_key_ciphertext,updated_at FROM waha_settings WHERE id=1')).rows[0];
 if(!row)return null;
 return {baseUrl:row.base_url,session:row.session_name,apiKey:await decrypt(row.api_key_ciphertext),updatedAt:row.updated_at};
}
async function saveSettings(pool,{baseUrl,session,apiKey}){
 let url; try{url=new URL(baseUrl);}catch{throw Error('Endereço WAHA inválido: informe http:// ou https:// e o host.');}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname.replace(/\/$/,'')!=='')throw Error('Invalid base URL');
 if(url.hostname==='localhost'||url.hostname==='127.0.0.1'||url.hostname==='::1')throw Error('Use the container-accessible WAHA service address');
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(session))throw Error('Invalid session name');
 const key=String(apiKey||'').trim();
 if(key.length>1000)throw Error('Invalid API key length');
 const current=await readSettings(pool);
 if(!key&&!current)throw Error('API key is required');
 const cipher=key?await encrypt(key):(await pool.query('SELECT api_key_ciphertext FROM waha_settings WHERE id=1')).rows[0].api_key_ciphertext;
 await pool.query('INSERT INTO waha_settings(id,base_url,session_name,api_key_ciphertext) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET base_url=EXCLUDED.base_url,session_name=EXCLUDED.session_name,api_key_ciphertext=EXCLUDED.api_key_ciphertext,updated_at=NOW()',[url.href.replace(/\/$/,''),session,cipher]);
}
module.exports={initSettings,readSettings,saveSettings,encrypt,decrypt};
