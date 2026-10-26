'use strict';
const crypto=require('node:crypto');
const COOKIE_NAME='__Host-afiliados_session';
const SESSION_MS=12*60*60*1000;
const ATTEMPT_WINDOW_MS=15*60*1000;
const MAX_ATTEMPTS=10;
const failedLogins=new Map();
function configured(user=process.env.ADMIN_USER,password=process.env.ADMIN_PASSWORD){
 return typeof user==='string'&&user.length>0&&typeof password==='string'&&password.length>0;
}
function credentialsMatch(username,password,user=process.env.ADMIN_USER,secret=process.env.ADMIN_PASSWORD){
 if(!configured(user,secret)||typeof username!=='string'||typeof password!=='string'||username.length>1000||password.length>1000)return false;
 // Digests keep the comparison constant-length regardless of user input.
 const digest=x=>crypto.createHash('sha256').update(x,'utf8').digest();
 return crypto.timingSafeEqual(digest(username+'\0'+password),digest(user+'\0'+secret));
}
function key(user,secret){
 return crypto.createHash('sha256').update('central-afiliados-session-v1\0').update(user).update('\0').update(secret).update('\0').update(process.env.SESSION_SECRET||'').digest();
}
function createSession(user=process.env.ADMIN_USER,secret=process.env.ADMIN_PASSWORD,now=Date.now()){
 if(!configured(user,secret))throw Error('Credenciais administrativas não configuradas');
 const payload='v1.'+Number(now).toString(36)+'.'+crypto.randomBytes(18).toString('base64url');
 const signature=crypto.createHmac('sha256',key(user,secret)).update(payload).digest('base64url');
 return payload+'.'+signature;
}
function validSession(token,user=process.env.ADMIN_USER,secret=process.env.ADMIN_PASSWORD,now=Date.now()){
 if(!configured(user,secret)||typeof token!=='string'||token.length>256)return false;
 const m=/^(v1)\.([0-9a-z]{8,12})\.([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/.exec(token);
 if(!m)return false;
 const issued=parseInt(m[2],36);
 if(!Number.isSafeInteger(issued)||issued>now+60000||issued+SESSION_MS<now)return false;
 const payload=m[1]+'.'+m[2]+'.'+m[3];
 const actual=crypto.createHmac('sha256',key(user,secret)).update(payload).digest();
 const provided=Buffer.from(m[4],'base64url');
 return provided.length===actual.length&&crypto.timingSafeEqual(actual,provided);
}
function cookieFromRequest(req){
 const all=String(req.headers?.cookie||'');
 if(all.length>8192)return '';
 const cookie=all.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE_NAME+'='));
 return cookie?cookie.slice(COOKIE_NAME.length+1):'';
}
function sessionCookie(token){
 return COOKIE_NAME+'='+token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age='+Math.floor(SESSION_MS/1000);
}
function clearCookie(){
 return COOKIE_NAME+'=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}
function safeNext(raw){
 const next=String(raw||'/admin');
 if(next.length>1000||!next.startsWith('/')||next.startsWith('//')||next.includes('\\')||/[\u0000-\u001f\u007f]/.test(next))return '/admin';
 const url=new URL(next,'https://local.invalid');
 if(url.origin!=='https://local.invalid'||!(url.pathname==='/admin'||url.pathname.startsWith('/admin/')))return '/admin';
 return url.pathname+url.search;
}
function loginAllowed(key,now=Date.now()){
 const item=failedLogins.get(String(key));
 if(!item)return true;
 if(now-item.started>ATTEMPT_WINDOW_MS){failedLogins.delete(String(key));return true;}
 return item.count<MAX_ATTEMPTS;
}
function noteFailedLogin(key,now=Date.now()){
 const id=String(key||'unknown');
 const old=failedLogins.get(id);
 if(!old||now-old.started>ATTEMPT_WINDOW_MS){
  if(failedLogins.size>2000)failedLogins.clear();
  failedLogins.set(id,{started:now,count:1});
 }else old.count++;
}
function clearFailedLogins(key){failedLogins.delete(String(key||'unknown'));}
module.exports={COOKIE_NAME,SESSION_MS,credentialsMatch,configured,createSession,validSession,cookieFromRequest,sessionCookie,clearCookie,safeNext,loginAllowed,noteFailedLogin,clearFailedLogins};