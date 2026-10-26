'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {syncCatalogQueues}=require('./rotation-persistence');
function mockCatalog({products=['1','2','3'],original=['1','2'],groups=1}={}){
 const existing=new Map(original===null?[]:[['1',{product_order:[...original],cycle_sent:['1'] }]]);
 const globalState={product_order:[],cycle_sent:['1']};
 const sql=[];
 const db={
  async query(query,args=[]){
   sql.push({query,args});
   if(['BEGIN','COMMIT','ROLLBACK'].includes(query)||query.startsWith('SELECT pg_advisory_xact_lock'))return {};
   if(query.startsWith('SELECT id,connection_id FROM rotation_groups'))return {rows:Array.from({length:groups},(_,i)=>({id:i+1,connection_id:1}))};
   if(query.startsWith('SELECT p.id FROM products'))return {rows:products.map(id=>({id}))};
   if(query.startsWith('SELECT product_order FROM global_product_rotation_state'))return {rows:[globalState]};
   if(query.startsWith('INSERT INTO global_product_rotation_state')){globalState.product_order=JSON.parse(args[0]);return {};}
   if(query.startsWith('SELECT product_order FROM group_rotation_state'))return {rows:existing.has(String(args[0]))?[existing.get(String(args[0]))]:[]};
   if(query.startsWith('INSERT INTO group_rotation_state')){
    const id=String(args[0]),queue=JSON.parse(args[1]);
    const previous=existing.get(id)||{cycle_sent:[]};
    existing.set(id,{...previous,product_order:queue});
    return {};
   }
   throw Error('Unexpected SQL '+query);
  },release(){}
 };
 return {pool:{connect:async()=>db},sql,existing,globalState};
}
test('new product is appended to the existing WhatsApp group cycle immediately, preserving completed attempts',async()=>{
 const db=mockCatalog({products:['1','2','3','4'],original:['1','2']});
 const result=await syncCatalogQueues(db.pool);
 assert.equal(result.added,2);
 assert.deepEqual(db.existing.get('1').product_order,['1','2','3','4']);
 assert.deepEqual(db.existing.get('1').cycle_sent,['1']);
 assert.deepEqual(db.globalState.product_order,['1','2','3','4']);
 assert.deepEqual(db.globalState.cycle_sent,['1']);
 assert.ok(db.sql.some(x=>x.query==='COMMIT'));
 assert.ok(!db.sql.some(x=>/INSERT INTO (dispatch_log|rotation_plans)|UPDATE dispatch_settings/.test(x.query)));
});
test('repeated catalog scans never duplicate or consume pending offers',async()=>{
 const db=mockCatalog({products:['1','2','3','4'],original:['1','2']});
 await syncCatalogQueues(db.pool);
 const second=await syncCatalogQueues(db.pool);
 assert.equal(second.added,0);
 assert.equal(second.globalAdded,0);
 assert.deepEqual(db.existing.get('1').product_order,['1','2','3','4']);
 assert.deepEqual(db.existing.get('1').cycle_sent,['1']);
});
test('catalog queue synchronization works before first plan and does not start automation',async()=>{
 const db=mockCatalog({products:['91','92','93'],original:null});
 const result=await syncCatalogQueues(db.pool);
 assert.equal(result.added,3);
 assert.deepEqual(db.existing.get('1').product_order,['91','92','93']);
 assert.ok(!db.sql.some(x=>/dispatch_settings|rotation_plans|dispatch_log/.test(x.query)));
});
test('multiple groups receive all eligible products independently',async()=>{
 const db=mockCatalog({products:['1','2','3'],original:null,groups:3});
 const result=await syncCatalogQueues(db.pool);
 assert.equal(result.added,9);
 assert.equal(db.existing.size,3);
 for(const row of db.existing.values())assert.equal(new Set(row.product_order).size,3);
});
