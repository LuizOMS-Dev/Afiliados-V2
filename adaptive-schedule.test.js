'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {distribute,parseTime,MIN_CONNECTION_GAP_MS}=require('./rotation-persistence');
const groups=(count,rounds,connectionId=i=>'1')=>Array.from({length:rounds},(_,round)=>
 Array.from({length:count},(_,i)=>({productId:String(round+1),groupId:String(i+1),connectionId:connectionId(i)}))
).flat();
const options=(now,daily=5)=>({start:360,end:1380,daily,now:new Date(now)});
const MIN_GROUP_GAP_MS=20000;
test('20 groups get one publication per round, five complete rounds spaced across 06:00–23:00',()=>{
 const planned=distribute(groups(20,5),options('2026-10-12T09:00:00Z'));
 assert.equal(planned.assignments.length,100);
 assert.equal(planned.deferred,0);
 for(let round=0;round<5;round++){
  const slice=planned.assignments.slice(round*20,(round+1)*20);
  assert.deepEqual(slice.map(x=>String(x.groupId)),Array.from({length:20},(_,i)=>String(i+1)));
  assert.equal(slice.every(x=>String(x.productId)===String(round+1)),true);
 }
 for(let group=1;group<=20;group++){
  const times=planned.assignments.filter(x=>String(x.groupId)===String(group)).map(x=>x.dueAt);
  assert.equal(times.length,5);
  for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=MIN_GROUP_GAP_MS, 'the same group must wait several hours');
 }
 assert.ok(planned.assignments.at(-1).dueAt<=Date.parse('2026-10-13T01:59:44Z'));
});
test('late starts spread remaining rounds across the available window',()=>{
 const now='2026-10-12T22:45:00Z'; // 19:45 in Sao Paulo
 const plan=distribute(groups(20,5),options(now));
 assert.equal(plan.assignments.length,100);
 assert.equal(plan.deferred,0);
 assert.deepEqual(plan.assignments.slice(0,20).map(x=>x.groupId),Array.from({length:20},(_,i)=>String(i+1)));
 assert.ok(plan.assignments.at(-1).dueAt<Date.parse('2026-10-13T02:00:00Z'));
});
test('one remaining group at 22:58 receives at most one offer, not five',()=>{
 const plan=distribute(groups(1,5),options('2026-10-13T01:58:00Z'));
 assert.equal(plan.assignments.length,1);
 assert.equal(plan.deferred,4);
 assert.equal(plan.assignments[0].rotationVersion,3);
});
test('independent connections keep 20-second pacing while preserving global rounds',()=>{
 const plan=distribute(groups(20,5,i=>i%2?'1':'2'),options('2026-10-12T09:00:00Z'));
 assert.equal(plan.assignments.length,100);
 for(const account of ['1','2']){
  const times=plan.assignments.filter(x=>x.connectionId===account).map(x=>x.dueAt);
  for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=MIN_CONNECTION_GAP_MS);
 }
 for(let round=0;round<5;round++)assert.deepEqual(plan.assignments.slice(round*20,(round+1)*20).map(x=>x.groupId),Array.from({length:20},(_,i)=>String(i+1)));
});
test('existing history prevents another round from posting immediately to the same group',()=>{
 const now='2026-10-12T18:00:00Z'; // 15h
 const latest=new Date('2026-10-12T17:45:00Z');
 const plan=distribute(groups(1,5),{...options(now),lastAttempts:new Map([['1',latest]])});
 assert.ok(plan.assignments.length>=1&&plan.assignments.length<=5);
 assert.ok(plan.assignments[0].dueAt-latest.getTime()>=MIN_GROUP_GAP_MS);
 for(let i=1;i<plan.assignments.length;i++)assert.ok(plan.assignments[i].dueAt-plan.assignments[i-1].dueAt>=MIN_GROUP_GAP_MS);
});
test('first publication becomes due promptly after startup when within the permitted window',()=>{
 const now=new Date('2026-10-12T09:00:00Z');
 const plan=distribute(groups(20,5),options(now.toISOString()));
 assert.ok(plan.assignments[0].dueAt-now.getTime()>=10000);
 assert.ok(plan.assignments[0].dueAt-now.getTime()<=15000);
});
test('too little remaining time defers everything instead of scheduling requests after cutoff',()=>{
 const plan=distribute(groups(20,5),options('2026-10-13T01:59:50Z'));
 assert.equal(plan.assignments.length,0);
 assert.equal(plan.deferred,100);
});
test('HH:mm window settings stay validated',()=>{
 assert.equal(parseTime('23:00'),1380);
 assert.throws(()=>parseTime('25:00'));
});

