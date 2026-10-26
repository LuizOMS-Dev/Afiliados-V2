'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {chooseGlobal,VERSION,globalAttemptSQL}=require('./global-cycle');
const ids=n=>Array.from({length:n},(_,i)=>String(i+1));
const groups=(n,size)=>ids(n).map(id=>({id,connectionId:'1',products:ids(size)}));
test('22 groups receive distinct four-product catalog blocks when inventory covers 88',()=>{
 const p=chooseGlobal({groups:groups(22,100),productOrder:ids(100),daily:4});
 assert.equal(p.assignments.length,88);assert.equal(new Set(p.assignments.map(x=>x.productId)).size,88);
 for(let g=1;g<=22;g++)assert.deepEqual(p.assignments.filter(x=>x.groupId===String(g)).map(x=>x.productId),ids(4).map(x=>String((g-1)*4+Number(x))));
 assert.equal(VERSION,7);
});
test('catalog remainder is used before same-day rollover completes all group quotas',()=>{
 const p=chooseGlobal({groups:groups(22,100),productOrder:ids(100),cycleSent:ids(78),daily:4});
 assert.equal(p.assignments.length,88);
 const firstRepeat=p.assignments.findIndex(x=>Number(x.productId)<=78);
 assert.equal(firstRepeat,22);assert.equal(new Set(p.assignments.slice(0,22).map(x=>x.productId)).size,22);
 for(let i=1;i<=22;i++)assert.equal(new Set(p.assignments.filter(x=>x.groupId===String(i)).map(x=>x.productId)).size,4);
});
test('short catalog cycles repeat only after each complete pass, filling 88 slots',()=>{
 const p=chooseGlobal({groups:groups(22,4),productOrder:ids(4),daily:4});
 assert.equal(p.assignments.length,88);
 for(let i=0;i<88;i+=4)assert.deepEqual(p.assignments.slice(i,i+4).map(x=>x.productId),ids(4));
});
test('previous same-group attempts remain blocked and reservations consume quota',()=>{
 const p=chooseGlobal({groups:groups(2,10),productOrder:ids(10),cycleSent:['1','2'],attemptsByGroup:new Map([['1',1]]),blockedByGroup:new Map([['1',['1','2']]]),daily:4});
 assert.equal(p.assignments.filter(x=>x.groupId==='1').length,3);
 assert.ok(p.assignments.filter(x=>x.groupId==='1').every(x=>!['1','2'].includes(x.productId)));
});
test('new items enter the global queue before a repeat and respect connection eligibility',()=>{
 const p=chooseGlobal({groups:[{id:'1',connectionId:'1',products:['1','2']},{id:'2',connectionId:'2',products:['3','4']}],productOrder:ids(4),cycleSent:['1','2','3'],daily:1});
 assert.ok(p.assignments.some(x=>x.productId==='4'&&x.groupId==='2'));
 assert.ok(p.assignments.every(x=>x.groupId==='1'?['1','2'].includes(x.productId):['3','4'].includes(x.productId)));
});
test('planning never consumes the global cycle; reservations reset only after exhaustion',()=>{
 const before=['1','2'];const p=chooseGlobal({groups:groups(2,8),productOrder:ids(8),cycleSent:before,daily:4});
 assert.deepEqual(p.cycleSent,before);assert.deepEqual(before,['1','2']);
 assert.ok(globalAttemptSQL().includes('product_order <@ global_product_rotation_state.cycle_sent'));
});

test('alternates WAHA connections instead of scheduling account blocks',()=>{
 const roster=[
  {id:'1',connectionId:'1',products:ids(50)},
  {id:'2',connectionId:'1',products:ids(50)},
  {id:'3',connectionId:'2',products:ids(50)},
  {id:'4',connectionId:'2',products:ids(50)}
 ];
 const plan=chooseGlobal({groups:roster,productOrder:ids(50),daily:3}).assignments;
 assert.equal(plan.length,12);
 assert.deepEqual(plan.map(x=>x.connectionId),['1','2','1','2','1','2','1','2','1','2','1','2']);
 for(const group of roster)assert.equal(plan.filter(x=>x.groupId===group.id).length,3);
});
test('cycles through three connections in turn',()=>{
 const roster=[1,2,3].map(id=>({id:String(id),connectionId:String(id),products:ids(30)}));
 const plan=chooseGlobal({groups:roster,productOrder:ids(30),daily:3}).assignments;
 assert.deepEqual(plan.map(x=>x.connectionId),['1','2','3','1','2','3','1','2','3']);
});
test('uses remaining eligible connection when another has no more offers',()=>{
 const roster=[{id:'1',connectionId:'1',products:ids(30)},{id:'2',connectionId:'2',products:ids(30)},{id:'3',connectionId:'2',products:ids(30)}];
 const plan=chooseGlobal({groups:roster,productOrder:ids(30),daily:2}).assignments;
 assert.equal(plan.length,6);
 assert.equal(plan.filter(x=>x.connectionId==='1').length,2);
 assert.equal(plan.filter(x=>x.connectionId==='2').length,4);
 assert.ok(plan.every((x,i)=>i===0||x.connectionId!==plan[i-1].connectionId||plan.slice(i).every(y=>y.connectionId===x.connectionId)));
});
