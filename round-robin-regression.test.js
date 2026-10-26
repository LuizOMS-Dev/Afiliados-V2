'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {planDay}=require('./rotation-persistence');
const {tick}=require('./dispatch');

function rotationDatabase(groupCount=20,productCount=30){
 const state={product_order:[],cycle_sent:[],last_group_id:null},database={assignments:null,done:[],productCount};
 const db={
  async query(sql,args=[]){
   if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.includes('pg_advisory_xact_lock'))return {rowCount:0,rows:[]};
   if(sql.startsWith('SELECT assignments FROM rotation_plans'))return {rowCount:database.assignments===null?0:1,rows:database.assignments===null?[]:[{assignments:database.assignments}]};
   if(sql.startsWith('SELECT id,connection_id FROM rotation_groups'))return {rows:Array.from({length:groupCount},(_,i)=>({id:i+1,connection_id:1}))};
   if(sql.startsWith('SELECT group_id,product_id,status,created_at FROM dispatch_log'))return {rows:database.done};
   if(sql.startsWith('SELECT DISTINCT product_id FROM dispatch_log'))return {rows:[]};
   if(sql.startsWith('SELECT p.id FROM products'))return {rows:Array.from({length:database.productCount},(_,i)=>({id:i+1}))};
   if(sql.startsWith('SELECT product_order,cycle_sent FROM group_rotation_state'))return {rows:[state]};
   if(sql.startsWith('INSERT INTO group_rotation_state(group_id,product_order,cursor)')){state.product_order=JSON.parse(args[1]);return {rowCount:1};}
   if(sql.startsWith('SELECT product_order,cycle_sent,last_group_id,history_seeded FROM global_product_rotation_state'))return {rows:[{...state}]};
   if(sql.startsWith('INSERT INTO global_product_rotation_state')){
    state.product_order=JSON.parse(args[0]);state.cycle_sent=JSON.parse(args[1]);state.history_seeded=true;return {rowCount:1};
   }
   if(sql.startsWith('INSERT INTO rotation_plans')){
    database.assignments=JSON.parse(args[1]);return {rowCount:1};
   }
   throw Error('unexpected planner SQL: '+sql);
  },release(){}
 };
 return {pool:{connect:async()=>db},database,state};
}
test('initial day plan: every group including last is served once in each of five rounds',async()=>{
 const {pool,database}=rotationDatabase(20,100);
 const day='2026-10-12',ids=Array.from({length:20},(_,i)=>String(i+1));
 const jobs=await planDay(pool,day,ids,{daily:5,start:'06:00',end:'23:00',now:new Date('2026-10-12T09:00:00Z')});
 assert.equal(jobs.length,100);
 assert.deepEqual(jobs.slice(0,20).map(x=>String(x.groupId)),ids);
 assert.equal(jobs.filter(x=>String(x.groupId)==='20').length,5);
 for(const id of ids)assert.equal(new Set(jobs.filter(x=>String(x.groupId)===id).map(x=>x.productId)).size,5);
 assert.equal(jobs.every(x=>x.rotationVersion===7),true);
 for(let r=0;r<5;r++)assert.deepEqual(jobs.slice(r*20,(r+1)*20).map(x=>String(x.groupId)),ids);
 assert.deepEqual(database.assignments,jobs);
});
test('catch-up plan serves an unvisited last group BEFORE returning to earlier groups for round two',async()=>{
 const {pool,database}=rotationDatabase(20,100);
 const day='2026-10-12',ids=Array.from({length:20},(_,i)=>String(i+1));
 const initial=await planDay(pool,day,ids,{daily:5,start:'06:00',end:'23:00',now:new Date('2026-10-12T09:00:00Z')});
 database.done=initial.slice(0,19).map(a=>({group_id:a.groupId,product_id:a.productId,status:'sent',created_at:new Date(a.dueAt)}));
 const next=await planDay(pool,day,ids,{daily:5,start:'06:00',end:'23:00',now:new Date('2026-10-12T12:45:00Z'),refresh:true});
 assert.ok(next.length>0);
 assert.equal(String(next[0].groupId),'20','group 20 must receive its first publication before group 1 receives a second');
 const first20=next.find(x=>String(x.groupId)==='20');
 const second1=next.find(x=>String(x.groupId)==='1');
 assert.ok(first20.dueAt<second1.dueAt);
 for(const a of next){
  const past=database.done.find(x=>String(x.group_id)===String(a.groupId));
  if(past)assert.ok(a.dueAt-new Date(past.created_at).getTime()>=20000,'no same-group compressed sends');
 }
});
test('actual daily planner exhausts 300 catalog products over 60 days before any repeat',async()=>{
 const {pool,database,state}=rotationDatabase(1,300),all=[];
 for(let day=0;day<61;day++){
  const now=new Date(Date.UTC(2026,9,12+day,9,0,0));
  database.assignments=null;database.done=[];
  const planned=await planDay(pool,now.toISOString().slice(0,10),['1'],{daily:5,start:'06:00',end:'23:00',now});
  assert.equal(planned.length,5);
  for(const offer of planned){
   if(state.product_order.every(id=>state.cycle_sent.includes(id)))state.cycle_sent=[];
   if(!state.cycle_sent.includes(String(offer.productId)))state.cycle_sent.push(String(offer.productId));
   state.last_group_id=String(offer.groupId);
   all.push(String(offer.productId));
  }
 }
 assert.equal(all.length,305);
 assert.equal(new Set(all.slice(0,300)).size,300);
 assert.deepEqual(all.slice(300),['1','2','3','4','5']);
});
test('actual daily planner retains 200-product cycle when 100 items arrive mid-rotation',async()=>{
 const {pool,database,state}=rotationDatabase(1,200),all=[];
 for(let day=0;day<61;day++){
  if(day===8)database.productCount=300;
  const now=new Date(Date.UTC(2026,9,12+day,9,0,0));
  database.assignments=null;database.done=[];
  const jobs=await planDay(pool,now.toISOString().slice(0,10),['1'],{daily:5,start:'06:00',end:'23:00',now});
  for(const job of jobs){
   if(state.product_order.every(id=>state.cycle_sent.includes(id)))state.cycle_sent=[];
   if(!state.cycle_sent.includes(String(job.productId)))state.cycle_sent.push(String(job.productId));
   state.last_group_id=String(job.groupId);
   all.push(String(job.productId));
  }
 }
 assert.equal(new Set(all.slice(0,300)).size,300);
 assert.deepEqual(all.slice(295,300),['296','297','298','299','300']);
 assert.deepEqual(all.slice(300),['1','2','3','4','5']);
 assert.equal(state.product_order.length,300);
});
test('replanning ten times without real sends preserves the first queued five offers',async()=>{
 const {pool,state}=rotationDatabase(1,300);
 const now=new Date('2026-10-12T09:00:00Z'),day='2026-10-12';
 const initial=await planDay(pool,day,['1'],{daily:5,start:'06:00',end:'23:00',now});
 for(let i=0;i<10;i++){
  const repeated=await planDay(pool,day,['1'],{daily:5,start:'06:00',end:'23:00',now,refresh:true});
  assert.deepEqual(repeated.map(x=>x.productId),initial.map(x=>x.productId));
  assert.deepEqual(state.cycle_sent,[]);
 }
});
function dispatchDb({jobs,done=[],recent=[]}){
 const statuses={paused:false,send_enabled:true,window_start:'06:00',window_end:'23:00',daily_limit:5};
 let id=900,sent=[];
 const db={
  async query(sql,args=[]){
   if(['BEGIN','COMMIT','ROLLBACK'].includes(sql)||sql.startsWith('SELECT pg_advisory_xact_lock'))return {};
   if(sql.startsWith('SELECT assignments FROM rotation_plans'))return {rows:[{assignments:jobs}]};
   if(sql.startsWith('SELECT 1 FROM dispatch_log'))return {rowCount:0};
   if(sql.startsWith('SELECT count(*)::int AS n FROM dispatch_log'))return {rows:[{n:0}]};
   if(sql.startsWith('SELECT cycle_sent FROM global_product_rotation_state'))return {rows:[{cycle_sent:[]}]}
   if(sql.startsWith('SELECT (SELECT MAX(created_at) FROM dispatch_log'))return {rows:[recent.shift()||{group_last:null,connection_last:null}]};
   if(sql.startsWith('SELECT paused,send_enabled FROM dispatch_settings'))return {rows:[statuses]};
   if(sql.startsWith('INSERT INTO dispatch_log'))return {rowCount:1,rows:[{id:++id}]};
   if(sql.startsWith('INSERT INTO group_rotation_state'))return {rowCount:1};
   if(sql.startsWith('INSERT INTO global_product_rotation_state'))return {rowCount:1};
   throw Error('unexpected transaction SQL: '+sql);
  },release(){}
 };
 const pool={
  async query(sql,args=[]){
   if(sql.startsWith('SELECT * FROM dispatch_settings'))return {rows:[statuses]};
   if(sql.startsWith('SELECT assignments FROM rotation_plans'))return {rowCount:1,rows:[{assignments:jobs}]};
   if(sql.startsWith('SELECT group_id,product_id FROM dispatch_log'))return {rows:done};
   if(sql.startsWith('SELECT p.title'))return {rows:[{title:'Oferta',status:'active',enabled:true,chat_id:'123@g.us',connection_id:'1',affiliate_url:'https://example.org'}]};
   if(sql.startsWith('UPDATE dispatch_log'))return {rowCount:1,rows:[]};
   throw Error('unexpected pool SQL: '+sql);
  },
  async connect(){return db}
 };
 return {pool,sent};
}
test('completed first five never block dispatching the sixth pending group',async()=>{
 const now=new Date('2026-10-12T18:00:00Z'),ids=Array.from({length:6},(_,i)=>String(i+1));
 const jobs=ids.map((groupId,i)=>({productId:String(i+1),groupId,connectionId:'1',minuteOfDay:800,dueAt:now.getTime()-30000+i*2000}));
 const done=jobs.slice(0,5).map(j=>({group_id:j.groupId,product_id:j.productId}));
 const {pool}=dispatchDb({jobs,done});
 const calls=[];
 const result=await tick(pool,{now,clock:()=>now,send:async item=>{calls.push(item.chat_id);return {id:'ok'}}});
 assert.equal(result.sent,1);
 assert.equal(calls.length,1,'the sixth unprocessed group must not starve behind old sent messages');
});
test('processing backlog cannot send two images to same group consecutively',async()=>{
 const now=new Date('2026-10-12T18:00:00Z');
 const jobs=[1,2].map((i)=>({productId:String(i),groupId:'20',connectionId:'1',minuteOfDay:800,dueAt:now.getTime()-30000+i*2000}));
 const {pool}=dispatchDb({jobs,recent:[{group_last:null,connection_last:null},{group_last:now,connection_last:now}]});
 let sendCount=0;
 const result=await tick(pool,{now,clock:()=>now,send:async()=>{sendCount++;return {id:'ok'}}});
 assert.equal(result.sent,1);
 assert.equal(sendCount,1);
});


test('22 groups receive four distinct offers even with only four catalog products',async()=>{
 const {pool}=rotationDatabase(22,4);
 const now=new Date('2026-10-14T14:30:00Z');
 const jobs=await planDay(pool,'2026-10-14',Array.from({length:22},(_,i)=>String(i+1)),{daily:4,start:'06:00',end:'23:00',now});
 assert.equal(jobs.length,88);
 for(let i=1;i<=22;i++){
  const offers=jobs.filter(x=>String(x.groupId)===String(i));
  assert.equal(offers.length,4);assert.equal(new Set(offers.map(x=>x.productId)).size,4);
  assert.ok(offers.every(x=>x.dueAt>=now.getTime()&&x.dueAt<Date.parse('2026-10-15T02:00:00Z')));
 }
});
test('a failed offer does not consume quota and is replaced without retrying its product',async()=>{
 const {pool,database}=rotationDatabase(1,10);
 database.done=[{group_id:'1',product_id:'1',status:'failed',created_at:new Date('2026-10-14T12:00:00Z')},{group_id:'1',product_id:'2',status:'sent',created_at:new Date('2026-10-14T12:01:00Z')}];
 const jobs=await planDay(pool,'2026-10-14',['1'],{daily:4,start:'06:00',end:'23:00',now:new Date('2026-10-14T14:30:00Z')});
 assert.equal(jobs.length,3);
 assert.ok(jobs.every(x=>!['1','2'].includes(x.productId)));
});
test('cycle rollover fills the daily quota without repeating a product within the group today',()=>{
 const {pickGroupProducts}=require('./rotation-persistence');
 assert.deepEqual(pickGroupProducts({queue:['1','2','3','4','5'],cycleSent:['1','2','3','4'],needed:4}),['5','1','2','3']);
 assert.deepEqual(pickGroupProducts({queue:['1','2','3','4','5'],cycleSent:['1','2','3','4','5'],blockedToday:['5','1'],needed:4}),['2','3','4']);
});
test('delivery in one group does not prevent the same product reaching another group',async()=>{
 const now=new Date('2026-10-14T14:30:00Z');
 const jobs=[{productId:'1',groupId:'2',connectionId:'1',minuteOfDay:690,dueAt:now.getTime()-1000}];
 const {pool}=dispatchDb({jobs,done:[{group_id:'1',product_id:'1'}]});
 const result=await tick(pool,{now,clock:()=>now,send:async()=>({id:'confirmed'})});
 assert.equal(result.sent,1);
});
