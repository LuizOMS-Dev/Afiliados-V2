'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const auth=require('./login-auth');
const {renderLogin}=require('./login-page');
const user='existing-admin',password='existing-secret';
test('existing configured ADMIN_USER/ADMIN_PASSWORD are the only login credentials',()=>{
 assert.equal(auth.credentialsMatch(user,password,user,password),true);
 assert.equal(auth.credentialsMatch(user,'wrong',user,password),false);
 assert.equal(auth.credentialsMatch('wrong',password,user,password),false);
 assert.equal(auth.credentialsMatch('','',user,password),false);
 assert.equal(auth.configured('',''),false);
});
test('signed session is random and survives separate requests, but expires after 12 hours',()=>{
 const start=Date.parse('2026-10-11T12:00:00Z');
 const first=auth.createSession(user,password,start);
 const second=auth.createSession(user,password,start);
 assert.notEqual(first,second);
 assert.equal(auth.validSession(first,user,password,start),true);
 assert.equal(auth.validSession(first,user,password,start+auth.SESSION_MS-1),true);
 assert.equal(auth.validSession(first,user,password,start+auth.SESSION_MS+1),false);
 assert.equal(auth.validSession(first,user,'changed-password',start),false);
 assert.equal(auth.validSession(first,'different-user',password,start),false);
 assert.equal(auth.validSession(first.slice(0,-43)+(first.at(-43)==='A'?'B':'A')+first.slice(-42),user,password,start),false);
 assert.equal(auth.validSession('arbitrary',user,password,start),false);
});
test('cookie uses HTTPS host-only HttpOnly security settings and can be cleared',()=>{
 const token=auth.createSession(user,password);
 const header=auth.sessionCookie(token);
 assert.ok(header.startsWith('__Host-afiliados_session='+token+';'));
 for(const flag of ['Path=/','HttpOnly','Secure','SameSite=Lax','Max-Age=43200'])assert.ok(header.includes(flag));
 assert.ok(!header.includes('Domain='));
 const fromCookie=auth.cookieFromRequest({headers:{cookie:'foo=1; __Host-afiliados_session='+token+'; theme=light'}});
 assert.equal(fromCookie,token);
 assert.equal(auth.clearCookie().includes('Max-Age=0'),true);
});
test('redirects are restricted to administrative paths, never off-site',()=>{
 for(const bad of ['https://evil.example','//evil.example','/admin.evil','/login','/','/admin\\evil.example','/admin%0d%0aHeader:Injected']){
  assert.equal(auth.safeNext(bad),'/admin',bad);
 }
 assert.equal(auth.safeNext('/admin/groups?connection_id=2'),'/admin/groups?connection_id=2');
 assert.equal(auth.safeNext('/admin/new'),'/admin/new');
});
test('login page is a separate responsive form with no Basic challenge or credential disclosure',()=>{
 const html=renderLogin({next:'/admin/groups?connection_id=2',error:'Usuário incorreto'});
 assert.ok(html.includes('Acesse sua conta'));
 assert.ok(html.includes('method="post" action="/login"'));
 assert.ok(html.includes('name="username"'));
 assert.ok(html.includes('name="password" type="password"'));
 assert.ok(html.includes('autocomplete="current-password"'));
 assert.ok(html.includes('name="next" value="/admin/groups?connection_id=2"'));
 assert.ok(html.includes('role="alert"'));
 assert.ok(!html.includes('www-authenticate'));
 assert.ok(!html.includes('existing-secret'));
});
test('error texts and redirect fields are escaped in login layout',()=>{
 const html=renderLogin({error:'<script>alert(1)</script>',next:'/admin?x="><script>'});
 assert.ok(!html.includes('<script>'));
 assert.ok(html.includes('&lt;script&gt;'));
 assert.ok(html.includes('&quot;'));
});
test('repeated invalid login attempts are limited and success clears limiter',()=>{
 const id='test-client-unique-id',now=Date.now();
 for(let i=0;i<10;i++){
  assert.equal(auth.loginAllowed(id,now),true);
  auth.noteFailedLogin(id,now);
 }
 assert.equal(auth.loginAllowed(id,now),false);
 auth.clearFailedLogins(id);
 assert.equal(auth.loginAllowed(id,now),true);
});

