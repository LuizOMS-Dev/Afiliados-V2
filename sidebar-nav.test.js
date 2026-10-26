const test=require('node:test');const assert=require('node:assert');
const fs=require('node:fs');
const {renderSidebarNav,activeHref,navItems}=require('./sidebar-nav');
const PAGES=['/admin/overview','/admin','/admin/automation','/admin/plan','/admin/clicks','/admin/waha','/admin/groups','/admin/settings'];
test('nav renders every admin page link',()=>{const h=renderSidebarNav('/admin');for(const p of PAGES)assert.ok(h.includes('href="'+p+'"'),p);assert.equal(navItems().length,PAGES.length);});
test('nav has three concise sections and inline svg icons',()=>{const h=renderSidebarNav('/');for(const l of['Principal','Publicações','Gerenciar'])assert.ok(h.includes(l));assert.equal((h.match(/<a /g)||[]).length,(h.match(/<a [^>]*><svg/g)||[]).length);assert.ok(!/https?:\/\/(?!www\.w3)/.test(h));});
test('active state marks exactly one link',()=>{for(const p of PAGES){const h=renderSidebarNav(p);assert.equal((h.match(/aria-current="page"/g)||[]).length,1,p);assert.ok(h.includes('href="'+p+'" data-nav="'+p+'"'));assert.match(h,new RegExp('href="'+p.replace(/\//g,'\\/')+'"[^>]*class="active"'));}});
test('active state resolution includes contextual pages under their parent',()=>{assert.equal(activeHref('/admin/edit'),'/admin');assert.equal(activeHref('/admin/publish'),'/admin');assert.equal(activeHref('/admin/new'),'/admin');assert.equal(activeHref('/admin/waha/edit'),'/admin/waha');assert.equal(activeHref('/admin/plan/'),'/admin/plan');assert.equal(activeHref('/admin/simulate'),'/admin/plan');assert.equal(activeHref('/admin/diagnostics'),'/admin/settings');assert.equal(activeHref('/admin/catalog-health'),'/admin/settings');assert.equal(activeHref('/'),null);assert.equal(activeHref('/xyz'),null);assert.equal(activeHref('/admin/'),'/admin');});
test('no active when path unknown',()=>assert.ok(!renderSidebarNav(null).includes('aria-current')));
test('logout in footer only when authenticated',()=>{assert.ok(renderSidebarNav('/admin',true).includes('action="/logout"'));assert.ok(!renderSidebarNav('/admin',false).includes('action="/logout"'));});
test('server uses sidebar module and bumped cache',()=>{const s=fs.readFileSync(__dirname+'/server.js','utf8');assert.ok(s.includes('renderSidebarNav('));assert.ok(s.includes('/shell.css?v='));assert.ok(s.includes('/themes.css?v='));assert.ok(fs.readFileSync(__dirname+'/upload-ui.js','utf8').includes("'Escape'"));});


