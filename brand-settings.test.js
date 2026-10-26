'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const sharp=require('sharp');
const {validateSiteName,normalizeImage,renderSidebarBrand}=require('./brand-settings');
const {renderLogin}=require('./login-page');
test('site name is sanitized and control characters forbidden',()=>{
 assert.equal(validateSiteName('  Ofertas e Produtos  '),'Ofertas e Produtos');
 for(const bad of ['', 'A', 'X'.repeat(81),'Nome\nmalicioso'])assert.throws(()=>validateSiteName(bad));
});
test('login uses the configured name and images, retaining existing credential form',()=>{
 const html=renderLogin({brand:{site_name:'Ofertas & Promoções',has_logo:true,has_favicon:true,version:123}});
 assert.ok(html.includes('Entrar | Ofertas &amp; Promoções'));
 assert.ok(html.includes('href="/brand/favicon.png?v=123"'));
 assert.ok(html.includes('src="/brand/logo.png?v=123"'));
 assert.ok(html.includes('name="username"')&&html.includes('name="password"'));
 assert.ok(!renderLogin({brand:{site_name:'<script>alert(1)</script>'}}).includes('<script>'));
});
test('images are normalized to PNG including square favicon',async()=>{
 const input=await sharp({create:{width:180,height:90,channels:4,background:'#ffffff'}}).png().toBuffer();
 const logo=await normalizeImage(input,'logo'),favicon=await normalizeImage(input,'favicon');
 assert.equal((await sharp(logo).metadata()).format,'png');
 const meta=await sharp(favicon).metadata();assert.equal(meta.width,64);assert.equal(meta.height,64);
 await assert.rejects(()=>normalizeImage(Buffer.from('<svg/>'),'logo'));
 await assert.rejects(()=>normalizeImage(input,'unknown'));
});

test('sidebar with uploaded logo shows image only, without duplicated visible site name',()=>{
 const html=renderSidebarBrand({site_name:'Central de Afiliados',has_logo:true,version:123});
 assert.ok(html.includes('class="sidebar-brand has-logo"'));
 assert.ok(html.includes('src="/brand/logo.png?v=123"'));
 assert.ok(html.includes('alt="Central de Afiliados"'));
 assert.ok(!html.includes('<strong>Central de Afiliados</strong>'));
 assert.ok(!html.includes('<small>Ofertas'));
});
test('sidebar without a logo restores the site name above the navigation',()=>{
 const html=renderSidebarBrand({site_name:'Central de Afiliados',has_logo:false,version:124});
 assert.ok(html.includes('<strong>Central de Afiliados</strong>'));
 assert.ok(html.includes('<small>Ofertas · Produtos · WhatsApp</small>'));
 assert.ok(!html.includes('<img'));
 assert.ok(!html.includes('has-logo'));
});
test('custom site name is safely encoded and kept as logo accessible description',()=>{
 const name='Ofertas <Novas> & Promoções';
 const visible=renderSidebarBrand({site_name:name,has_logo:false});
 const logo=renderSidebarBrand({site_name:name,has_logo:true,version:5});
 assert.ok(visible.includes('Ofertas &lt;Novas&gt; &amp; Promoções'));
 assert.ok(logo.includes('alt="Ofertas &lt;Novas&gt; &amp; Promoções"'));
 assert.ok(!logo.includes('<strong>'));
 assert.ok(!logo.includes('<Novas>'));
});
test('browser tab title remains driven by the configured site name independently of logo state',()=>{
 const fs=require('node:fs');
 const source=fs.readFileSync(require('node:path').join(__dirname,'server.js'),'utf8');
 assert.ok(source.includes("<title>\'+esc(brandingState.site_name)+\'</title>"));
 assert.ok(source.includes("renderSidebarBrand(brandingState)"));
});
