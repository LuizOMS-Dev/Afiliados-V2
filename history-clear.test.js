'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {clearHistory,localDay}=require('./dispatch');
const mock=({maxId='217',oldCount=41,fail=false}={})=>{
 const operations=[];
 let released=false;
 const client={
  async query(sql,params=[]){
   operations.push({sql,params});
   if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.includes('pg_advisory_xact_lock'))return {rowCount:0};
   if(sql.startsWith('SELECT COALESCE(MAX(id)'))return {rows:[{id:maxId}]};
   if(sql.startsWith('DELETE FROM dispatch_log WHERE day <'))return {rowCount:oldCount};
   if(sql.startsWith('UPDATE dispatch_settings SET history_hidden_before_id')){
    if(fail)throw Error('update failed');
    return {rowCount:1};
   }
   throw Error('Unexpected query: '+sql);
  },
  release(){released=true}
 };
 return {pool:{connect:async()=>client},operations,isReleased:()=>released};
};
test('clear history only deletes days older than Sao Paulo today',async()=>{
 const x=mock();
 const now=new Date('2026-10-11T02:59:59Z'); // 23:59 previous day in Brazil
 assert.equal(localDay(now),'2026-10-10');
 const result=await clearHistory(x.pool,now);
 assert.equal(result.olderDeleted,41);
 const deletion=x.operations.find(o=>o.sql.startsWith('DELETE FROM dispatch_log'));
 assert.equal(deletion.sql,'DELETE FROM dispatch_log WHERE day < $1');
 assert.deepEqual(deletion.params,['2026-10-10']);
 assert.ok(!x.operations.some(o=>/DELETE FROM (products|rotation_groups|rotation_plans)/i.test(o.sql)));
 assert.equal(x.operations.at(-1).sql,'COMMIT');
 assert.equal(x.isReleased(),true);
});
test('today entries are hidden by monotonic ID and retained for duplicate safety',async()=>{
 const x=mock({maxId:'922337203685477580'});
 const result=await clearHistory(x.pool,new Date('2026-10-11T09:00:00Z'));
 assert.equal(result.hiddenUpToId,'922337203685477580');
 const update=x.operations.find(o=>o.sql.startsWith('UPDATE dispatch_settings SET history_hidden_before_id'));
 assert.ok(update.sql.includes('GREATEST(history_hidden_before_id,$1::bigint)'));
 assert.deepEqual(update.params,['922337203685477580']);
 assert.ok(x.operations.some(o=>o.sql.includes('pg_advisory_xact_lock(471021)')));
 assert.ok(!x.operations.some(o=>/DELETE FROM dispatch_log WHERE day ?=/.test(o.sql)));
});
test('failure rolls back both history cleanup and visibility change',async()=>{
 const x=mock({fail:true});
 await assert.rejects(()=>clearHistory(x.pool),/update failed/);
 assert.equal(x.operations.at(-1).sql,'ROLLBACK');
 assert.equal(x.isReleased(),true);
});
test('clearing empty history is harmless',async()=>{
 const x=mock({maxId:'0',oldCount:0});
 const result=await clearHistory(x.pool);
 assert.deepEqual(result,{olderDeleted:0,hiddenUpToId:'0'});
 assert.equal(x.operations.at(-1).sql,'COMMIT');
});
