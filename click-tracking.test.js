const test=require('node:test');const assert=require('node:assert');
const c=require('./click-tracking');
function fakePool(products={5:{affiliate_url:'https://meli.la/abc',status:'active'},6:{affiliate_url:'https://meli.la/x',status:'draft'}}){
 const inserts=[];return {inserts,async query(sql,args){
  if(sql.startsWith('SELECT affiliate_url')){const p=products[args[0]];return {rows:p&&p.status==='active'?[{affiliate_url:p.affiliate_url}]:[]};}
  if(sql.startsWith('SELECT connection_id'))return {rows:[{connection_id:2}]};
  if(sql.startsWith('INSERT INTO product_clicks')){inserts.push(args);return {rows:[]};}
  throw Error('unexpected '+sql);}};}
function fakeRes(){return {code:0,headers:{},writeHead(c,h){this.code=c;this.headers=h;},end(){}};}
const req=(url,ua)=>({url,headers:{'user-agent':ua,'x-forwarded-for':'1.2.3.4'},socket:{}});
const HUMAN='Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128 Mobile Safari/537.36';
test('redirects to affiliate url and logs human click with group',async()=>{const p=fakePool(),r=fakeRes();await c.handleRedirect(p,req('/r/5?g=12',HUMAN),r,'5');assert.equal(r.code,302);assert.equal(r.headers.location,'https://meli.la/abc');assert.equal(p.inserts.length,1);const [pid,g,conn,bot,ua,ip]=p.inserts[0];assert.equal(pid,'5');assert.equal(g,'12');assert.equal(conn,2);assert.equal(bot,false);assert.ok(ua.length<=200);assert.match(ip,/^[0-9a-f]{16}$/);});
test('link preview fetchers are flagged as bots',async()=>{for(const ua of ['WhatsApp/2.23.20.0 A','facebookexternalhit/1.1','TelegramBot (like TwitterBot)','']){const p=fakePool();await c.handleRedirect(p,req('/r/5?g=site',ua),fakeRes(),'5');assert.equal(p.inserts[0][3],true,ua);}assert.equal(c.isBot(HUMAN),false);});
test('unknown or inactive product goes home without logging',async()=>{for(const id of ['99','6','abc']){const p=fakePool(),r=fakeRes();await c.handleRedirect(p,req('/r/'+id,HUMAN),r,id);assert.equal(r.headers.location,'/');assert.equal(p.inserts.length,0);}});
test('invalid group ref is dropped',async()=>{const p=fakePool();await c.handleRedirect(p,req('/r/5?g=%3Cscript%3E',HUMAN),fakeRes(),'5');assert.equal(p.inserts[0][1],null);});
const ITEM={product_id:5,group_ref:'12',title:'Fone *X*',description:'Bom',price:26.49,affiliate_url:'https://meli.la/abc',show_disclosure:false,whatsapp_group_url:''};
test('message uses real affiliate link by default and keeps format',()=>{const msg=c.buildMessage(ITEM,'https://central.example','affiliate');assert.equal(msg,'*Fone  X*\n\nBom\n\n💰 Preço: R$ 26,49\n\nhttps://meli.la/abc');assert.ok(!msg.includes('/r/'));assert.ok(!msg.includes('central.example'));});
test('default mode (no MESSAGE_LINK_MODE) sends meli.la, never the Central link',()=>{const prev=process.env.MESSAGE_LINK_MODE;delete process.env.MESSAGE_LINK_MODE;try{assert.equal(c.messageLinkMode(),'affiliate');const msg=c.buildMessage(ITEM);assert.ok(msg.includes('https://meli.la/abc'));assert.ok(!msg.includes('/r/5'));}finally{if(prev!==undefined)process.env.MESSAGE_LINK_MODE=prev;}});
test('message link mode parsing',()=>{assert.equal(c.messageLinkMode({}),'affiliate');assert.equal(c.messageLinkMode({MESSAGE_LINK_MODE:'affiliate'}),'affiliate');assert.equal(c.messageLinkMode({MESSAGE_LINK_MODE:' Tracked '}),'tracked');assert.equal(c.messageLinkMode({MESSAGE_LINK_MODE:'qualquer'}),'affiliate');});
test('tracked mode uses Central /r/ link only when explicitly enabled',()=>{const msg=c.buildMessage(ITEM,'https://central.example','tracked');assert.equal(msg,'*Fone  X*\n\nBom\n\n💰 Preço: R$ 26,49\n\nhttps://central.example/r/5?g=12');assert.ok(!msg.includes('meli.la'));});
test('tracked mode falls back to affiliate link without product id',()=>{assert.equal(c.messageLink({...ITEM,product_id:null},'https://central.example','tracked'),'https://meli.la/abc');});
test('site catalog buttons still use tracked link',()=>{assert.equal(c.trackedUrl(5,'site','https://central.example'),'https://central.example/r/5?g=site');});
test('public base defaults to production host and honours PUBLIC_BASE_URL',()=>{assert.equal(c.publicBase({}),c.DEFAULT_BASE);assert.equal(c.publicBase({PUBLIC_BASE_URL:'https://x.com/'}),'https://x.com');assert.equal(c.trackedUrl(3,'site',''),'/r/3?g=site');});
