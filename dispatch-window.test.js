'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {windowStatus,localDay,tick,sendViaWaha}=require('./dispatch');
const settings={paused:false,send_enabled:true,window_start:'06:00',window_end:'23:00'};
const date=x=>new Date(x);
test('Sao Paulo window closes exactly at 23:00 and reopens at 06:00 the next day',()=>{
 const cases=[
  ['2026-10-10T08:59:59Z','waiting'],
  ['2026-10-10T09:00:00Z','open'],
  ['2026-10-11T01:59:59Z','open'],
  ['2026-10-11T02:00:00Z','closed'],
  ['2026-10-11T02:59:59Z','closed'],
  ['2026-10-11T03:00:00Z','waiting'],
  ['2026-10-11T08:59:59Z','waiting'],
  ['2026-10-11T09:00:00Z','open']
 ];
 for(const [time,expected] of cases)assert.equal(windowStatus(settings,date(time)).phase,expected,time);
 assert.equal(localDay(date('2026-10-11T02:59:59Z')),'2026-10-10');
 assert.equal(localDay(date('2026-10-11T03:00:00Z')),'2026-10-11');
});
test('configured 23:00 close calculates precise deadline, not server UTC time',()=>{
 const now=date('2026-10-11T01:59:40Z');
 assert.equal(windowStatus(settings,now).closeAt, date('2026-10-11T02:00:00Z').getTime());
});
test('automatic tick refuses outside window, but is eligible again at 06:00 without resetting settings',async()=>{
 let queriedPlans=0;
 const pool={query:async sql=>{
  if(sql.startsWith('SELECT * FROM dispatch_settings'))return {rows:[settings]};
  if(sql.startsWith('SELECT assignments FROM rotation_plans')){queriedPlans++;return {rowCount:0,rows:[]}};
  throw new Error('unexpected query: '+sql);
 }};
 for(const time of ['2026-10-11T02:00:00Z','2026-10-11T06:00:00Z','2026-10-11T08:59:59Z']){
  const result=await tick(pool,{now:date(time),send:async()=>{throw Error('Send outside window')}});
  assert.equal(result.reason,'outside-window');
 }
 assert.equal(queriedPlans,0);
 assert.equal((await tick(pool,{now:date('2026-10-11T09:00:00Z'),send:async()=>{}})).reason,'no-plan');
 assert.equal(queriedPlans,1);
});
test('manual pause remains effective even after 06:00',async()=>{
 const pool={query:async sql=>{
  if(sql.startsWith('SELECT * FROM dispatch_settings'))return {rows:[{...settings,paused:true}]};
  throw new Error('unexpected DB access');
 }};
 const result=await tick(pool,{now:date('2026-10-11T09:00:00Z'),send:async()=>{throw Error('should not send')}});
 assert.equal(result.reason,'disabled');
});
test('no extra WAHA request starts after the boundary during a long dispatch batch',async()=>{
 const now=date('2026-10-11T01:59:25Z');
 const afterClose=date('2026-10-11T02:00:00Z');
 const jobs=[
  {productId:'1',groupId:'101',minuteOfDay:1379,dueAt:now.getTime()-4000},
  {productId:'2',groupId:'102',minuteOfDay:1379,dueAt:now.getTime()-3000}
 ];
 let reserved=0,sendCalls=0,clockCalls=0;
 const pool={
  query:async sql=>{
   if(sql.startsWith('SELECT * FROM dispatch_settings'))return {rows:[settings]};
   if(sql.startsWith('SELECT assignments FROM rotation_plans'))return {rowCount:1,rows:[{assignments:jobs}]};
   if(sql.startsWith('SELECT group_id,product_id FROM dispatch_log'))return {rows:[]};
   if(sql.startsWith('SELECT p.title'))return {rows:[{status:'active',enabled:true,chat_id:'123@g.us',connection_id:1,title:'Offer',affiliate_url:'https://example.org',image_url:null}]};
   if(sql.startsWith('UPDATE dispatch_log'))return {rowCount:1,rows:[]};
   throw Error('unexpected pool query '+sql);
  },
  connect:async()=>({
   query:async sql=>{
    if(sql==='BEGIN'||sql==='COMMIT')return {};
    if(sql.startsWith('SELECT pg_advisory_xact_lock'))return {};
    if(sql.startsWith('SELECT assignments FROM rotation_plans'))return {rows:[{assignments:jobs}]};
    if(sql.startsWith('SELECT 1 FROM dispatch_log'))return {rowCount:0};
    if(sql.startsWith('SELECT count(*)::int AS n FROM dispatch_log'))return {rows:[{n:0}]};
    if(sql.startsWith('SELECT cycle_sent FROM global_product_rotation_state'))return {rows:[{cycle_sent:[]}]}
    if(sql.startsWith('SELECT (SELECT MAX(created_at) FROM dispatch_log'))return {rows:[{group_last:null,connection_last:null}]};
    if(sql.startsWith('SELECT paused,send_enabled FROM dispatch_settings'))return {rows:[settings]};
    if(sql.startsWith('INSERT INTO dispatch_log')){reserved++;return {rowCount:1,rows:[{id:reserved}]}};
    if(sql.startsWith('INSERT INTO group_rotation_state'))return {rowCount:1};
    if(sql.startsWith('INSERT INTO global_product_rotation_state'))return {rowCount:1};
    throw Error('unexpected DB query '+sql);
   },
   release(){}
  })
 };
 const clock=()=>++clockCalls<=2?now:afterClose;
 const result=await tick(pool,{now,clock,send:async()=>{sendCalls++;return {id:'ack'}}});
 assert.equal(result.sent,1);
 assert.equal(sendCalls,1);
 assert.equal(reserved,1);
});
test('a job cannot be started within the last 15 seconds before closing',async()=>{
 const pool={query:async sql=>{
  if(sql.startsWith('SELECT * FROM dispatch_settings'))return {rows:[settings]};
  if(sql.startsWith('SELECT assignments FROM rotation_plans'))return {rowCount:1,rows:[{assignments:[{productId:'1',groupId:'1',minuteOfDay:1379,dueAt:date('2026-10-11T01:59:20Z').getTime()}]}]};
  if(sql.startsWith('SELECT group_id,product_id FROM dispatch_log'))return {rows:[]};
  throw Error('should not reserve: '+sql);
 },connect:async()=>{throw Error('late job reserved')}};
 const now=date('2026-10-11T01:59:50Z');
 const result=await tick(pool,{now,clock:()=>now,send:async()=>{throw Error('late send')}});
 assert.equal(result.sent,0);
});
test('WAHA HTTP is never invoked when its automatic deadline has expired',async()=>{
 const original=global.fetch;let called=false;
 global.fetch=async()=>{called=true;throw Error('fetch invoked')};
 try{
  await assert.rejects(()=>sendViaWaha({baseUrl:'https://example.com',session:'default',apiKey:'secret'},
    {title:'Test',description:'',affiliate_url:'https://example.org',chat_id:'123@g.us',show_disclosure:false},
    {deadlineMs:Date.now()-1000}),/Janela de publicação encerrada/);
  assert.equal(called,false);
 }finally{global.fetch=original}
});

