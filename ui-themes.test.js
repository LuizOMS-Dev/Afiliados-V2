'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {THEMES,THEME_IDS,DEFAULT_THEME,validateTheme,effectiveTheme}=require('./ui-themes');
const {renderSidebarBrand}=require('./brand-settings');
const {renderLogin}=require('./login-page');
const css=fs.readFileSync(path.join(__dirname,'themes.css'),'utf8');
const shellCss=fs.readFileSync(path.join(__dirname,'shell.css'),'utf8');
const server=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
const interfaceSource=fs.readFileSync(path.join(__dirname,'interface.js'),'utf8');
function luminance(c){
 const v=[0,2,4].map(i=>parseInt(c.slice(1+i,3+i),16)/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4);
 return v[0]*.2126+v[1]*.7152+v[2]*.0722;
}
function contrast(a,b){
 const x=luminance(a),y=luminance(b);
 return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);
}
function palette(id){
 const pattern=new RegExp(':root\\[data-theme="'+id+'"\\]\\{([^}]+)\\}');
 const match=css.match(pattern);
 assert.ok(match,'theme missing CSS '+id);
 return Object.fromEntries([...match[1].matchAll(/--([a-z-]+):\s*(#[a-fA-F0-9]{6})/g)].map(a=>[a[1],a[2]]));
}
test('six themes include three light and three dark and preserve previous default',()=>{
 assert.equal(THEMES.length,6);
 assert.equal(new Set(THEME_IDS).size,6);
 assert.equal(THEMES.filter(t=>t.mode==='light').length,3);
 assert.equal(THEMES.filter(t=>t.mode==='dark').length,3);
 assert.equal(DEFAULT_THEME,'esmeralda');
});
test('themes accept only predefined values, preventing CSS, HTML or attribute injection',()=>{
 for(const id of THEME_IDS)assert.equal(validateTheme(id),id);
 for(const bad of ['','<script>','safira" onmouseover="evil','blue','../../admin',null])assert.throws(()=>validateTheme(bad));
 assert.equal(effectiveTheme('bad'),'esmeralda');
});
test('every theme passes WCAG AA 4.5:1 for page text, card text, menu text, input and primary buttons',()=>{
 for(const {id} of THEMES){
  const p=palette(id);
  for(const [a,b] of [['ink','paper'],['ink','surface'],['nav-text','sidebar'],['input-text','input-bg'],['btn-accent-text','accent']]){
   assert.ok(contrast(p[a],p[b])>=4.5,id+' '+a+' vs '+b+' fails 4.5:1');
  }
 }
});
test('dark themes use bright foreground over dark surfaces; light themes use dark foreground',()=>{
 for(const {id,mode} of THEMES){
  const p=palette(id);
  assert.equal(luminance(p.ink)>luminance(p.paper),mode==='dark',id);
  assert.equal(luminance(p.ink)>luminance(p.surface),mode==='dark',id);
 }
});
test('theme choices are persisted and applied from settings, not exposed to uploads',()=>{
 assert.ok(server.includes('renderBrandSettings(brandingState,notice)'));
 assert.ok(server.includes('validateTheme(upload.fields.theme)'));
 assert.ok(server.includes('theme=validateTheme(upload.fields.theme)'));
 assert.ok(server.includes('brandingState=await updateBrand(pool,{site_name,logo,favicon,whatsapp_group_url,theme})'));
 assert.ok(server.includes("effectiveTheme(brandingState.theme_id)"));
 assert.match(server,/themes\.css\?v=\d+/);
});
test('login inherits selected theme without changing name or credentials',()=>{
 const html=renderLogin({brand:{site_name:'Central de Afiliados',theme_id:'safira'}});
 assert.ok(html.includes('data-theme="safira"'));
 assert.ok(html.includes('themes.css?v=1'));
 assert.ok(html.includes('<title>Entrar | Central de Afiliados</title>'));
 assert.ok(html.includes('name="username"')&&html.includes('name="password"'));
 assert.ok(!renderLogin({brand:{theme_id:'x" onload="evil'}}).includes('onload='));
});
test('uploaded logo replaces sidebar name only and browser tab still has site name',()=>{
 const img=renderSidebarBrand({site_name:'Central de Afiliados',has_logo:true,version:45});
 const words=renderSidebarBrand({site_name:'Central de Afiliados',has_logo:false});
 assert.ok(img.includes('<img'));assert.ok(!img.includes('<strong>Central de Afiliados</strong>'));
 assert.ok(words.includes('<strong>Central de Afiliados</strong>'));
 assert.ok(server.includes("<title>'+esc(brandingState.site_name)+'</title>"));
});

test('product actions use uniform two-column, equal-height tracks',()=>{
 assert.match(shellCss,/\.product-actions\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\);grid-auto-rows:minmax\(44px,1fr\)\}/);
 assert.match(shellCss,/\.app-content \.product-actions :is\(a,button\)\{[^}]*height:100%/);
});
test('product photographs keep a neutral white canvas in all themes',()=>{
 assert.match(css,/:root\[data-theme\] \.app-content \.product-photo,[\s\S]*?background:#fff;/);
 assert.match(css,/:root\[data-theme\] \.app-content \.admin-image-preview:hover/);
});
test('connection choices and their actions are centered',()=>{
 assert.match(shellCss,/\.group-connection-grid\{display:flex;[^}]*justify-content:center/);
 assert.match(shellCss,/\.group-control-actions\{justify-content:center;align-items:center\}/);
});

test('product list renders four columns on desktop while preserving narrower layouts',()=>{
 assert.match(shellCss,/\.product-grid\{grid-template-columns:repeat\(4,minmax\(0,1fr\)\)\}/);
 assert.match(shellCss,/@media\(max-width:1150px\)\{\.product-grid\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)\}\}/);
 assert.match(shellCss,/@media\(max-width:800px\)\{\.product-grid\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}\}/);
 assert.match(server,/shell\.css\?v=\d+/);
});

test('product actions reset inherited button margins',()=>{
 assert.match(shellCss,/\.app-content \.product-actions form>button\{margin:0\}/);
 assert.match(server,/shell\.css\?v=\d+/);
});


test('legacy group cards retain their original fallback styles',()=>{
 assert.match(shellCss,/\.groups-list\{\s*display:grid;\s*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
 assert.match(shellCss,/@media\(max-width:1000px\)\{\s*\.groups-list\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
 assert.match(shellCss,/@media\(max-width:700px\)\{\s*\.groups-list\{grid-template-columns:minmax\(0,1fr\)\}/);
 assert.match(shellCss,/\.groups-list \.group-row\{[\s\S]*?flex-direction:column/);
 assert.match(shellCss,/\.groups-list \.group-row form\[data-group-toggle\]\{[\s\S]*?width:100%/);
 assert.ok(interfaceSource.includes('class="groups-list"'));
});

test('group workspace keeps two compact columns without stretching over the screen',()=>{
 assert.match(shellCss,/\.groups-workspace \.groups-list\{\s*display:grid;\s*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
 assert.match(shellCss,/\.groups-workspace \.groups-list\{[^}]*max-width:1080px/s);
 assert.match(shellCss,/@media\(max-width:1120px\)\{\s*\.groups-workspace \.groups-list\{grid-template-columns:minmax\(0,1fr\)/);
 assert.match(shellCss,/\.groups-workspace \.groups-column-head\{display:none\}/);
 assert.match(shellCss,/\.groups-workspace \.groups-list \.group-row\[hidden\]\{display:none\}/);
 assert.match(shellCss,/\.groups-workspace \.groups-list \.group-row\{[^}]*grid-template-columns:minmax\(0,1fr\) 112px 44px/s);
 assert.match(server,/shell\.css\?v=\d+/);
});
