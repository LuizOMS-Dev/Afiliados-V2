'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {renderProducts,renderCatalog,renderOverview}=require('./interface');
const {renderGroups}=require('./interface');
test('groups workspace preserves authorization, selected connection and safe text',()=>{
 const connections=[{id:2,label:'Conta <A>',is_primary:true},{id:3,label:'Outra conta'}];
 const groups=[{id:5,name:'Grupo <script>alert(1)</script>',enabled:true},{id:6,name:'Grupo sem autorização',enabled:false}];
 const html=renderGroups({connections,selected:connections[0],groups,counts:[{connection_id:2,total:2,enabled:1},{connection_id:3,total:9,enabled:4}]});
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('Conta &lt;A&gt;'));
 assert.equal((html.match(/aria-current="page"/g)||[]).length,1);assert.ok(html.includes('9 grupos · 4 autorizados'));
 assert.ok(html.includes('role="switch" aria-checked="true"'));assert.ok(html.includes('role="switch" aria-checked="false"'));
 assert.ok(html.includes('name="enabled" value="no"'));assert.ok(html.includes('name="enabled" value="yes"'));
 assert.ok(html.includes('data-group-search'));assert.ok(html.includes('data-group-filter'));assert.ok(!html.includes('data-groups-next'));assert.ok(html.includes('data-groups-count'));
 assert.deepEqual(groups.map(g=>g.enabled),[true,false]);
});
test('groups workspace handles an empty connection with a sync action and empty state',()=>{
 const selected={id:3,label:'Conta sem grupos'};const html=renderGroups({connections:[selected],selected,groups:[]});
 assert.ok(html.includes('Nenhum grupo sincronizado'));assert.ok(html.includes('name="connection_id" type="hidden" value="3"'));
 assert.ok(!html.includes('data-groups-pagination'));assert.ok(html.includes('data-groups-count'));assert.equal((html.match(/role="switch"/g)||[]).length,0);
});
test('product library escapes imported titles, URLs and displays prices in Brazilian currency',()=>{
 const html=renderProducts([{id:'1',title:'Oferta <script>alert(1)</script>',image_url:'https://example.com/a" onerror="alert(1)',price:'1234.50',status:'active'},{id:'2',title:'Rascunho',image_url:'',price:null,status:'draft'}]);
 assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('" onerror="'));assert.ok(html.includes('1.234,50'));assert.ok(html.includes('data-status="paused"'));assert.ok(html.includes('data-product-view="list"'));assert.ok(html.includes('action="/admin/delete"'));assert.ok(html.includes('data-confirm="Excluir definitivamente'));
});
test('empty product library gives a useful first action',()=>{const html=renderProducts([]);assert.ok(html.includes('Seu catálogo começa aqui'));assert.ok(html.includes('href="/admin/new"'));});
test('public catalog retains tracked affiliate destinations and disclosure',()=>{
 let args;const html=renderCatalog([{id:9,title:'Produto',price:'10',description:'<img src=x onerror=alert(1)>',image_url:''}],(...v)=>{args=v;return '/r/9?g=site'},{whatsapp_group_url:'https://chat.whatsapp.com/abc'});
 assert.deepEqual(args,[9,'site','']);assert.ok(html.includes('href="/r/9?g=site"'));assert.ok(html.includes('rel="noopener noreferrer sponsored"'));assert.ok(html.includes('&lt;img'));assert.ok(html.includes('Publicidade:'));assert.ok(html.includes('data-catalog-search'));
});
test('overview handles no activity and never offers a dispatch action',()=>{
 const html=renderOverview({counts:{total:0,active:0},report:{sent:0,pending:0,planned:0,groupCount:0,eligibleGroupCount:0,running:false,statusLabel:'Pausada',nextAt:null,explanation:'Sem grupos'},stats:{perDay:[]},recent:[],connections:0});
 assert.ok(html.includes('Nenhuma publicação registrada'));assert.ok(html.includes('is-paused'));assert.ok(!html.includes('NaN'));assert.ok(!html.includes('method="post"'));assert.ok(html.includes('href="/admin/plan"'));
});


test('all groups for one connection appear in one list without paging',()=>{
 const selected={id:5,label:'WhatsApp A'};
 const groups=Array.from({length:35},(_,i)=>({id:i+1,name:'Grupo '+(i+1),enabled:i%2===0}));
 const html=renderGroups({connections:[selected],selected,groups});
 assert.equal((html.match(/data-group-id=/g)||[]).length,35);
 assert.ok(!html.includes('data-groups-prev'));
 assert.ok(!html.includes('data-groups-next'));
 assert.ok(!html.includes('data-groups-page'));
});
