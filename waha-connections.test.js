'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {setPrimaryConnection,deleteConnection}=require('./waha-connections');
function fakePool({record={id:2,label:'Secundária',is_primary:false},total=2,groups=[{id:10},{id:11}],linked=3,exists=true}={}){
 const statements=[];
 const db={
  async query(sql,args=[]){
   statements.push({sql,args});
   if(sql.startsWith('SELECT id,label,is_primary FROM waha_connections'))return {rowCount:exists?1:0,rows:exists?[record]:[]};
   if(sql.startsWith('SELECT id FROM waha_connections'))return {rowCount:exists?1:0,rows:exists?[{id:record.id}]:[]};
   if(sql.startsWith('SELECT count(*)::int AS n FROM waha_connections'))return {rows:[{n:total}]};
   if(sql.startsWith('SELECT count(*)::int AS n FROM product_connections'))return {rows:[{n:linked}]};
   if(sql.startsWith('UPDATE rotation_groups SET enabled=FALSE'))return {rowCount:groups.length,rows:groups};
   return {rowCount:1,rows:[]};
  },
  release(){statements.push({sql:'RELEASE'})}
 };
 return {pool:{connect:async()=>db},statements};
}
test('choosing primary unsets previous account and marks selected one atomically',async()=>{
 const {pool,statements}=fakePool();
 await setPrimaryConnection(pool,2);
 const statementsSql=statements.map(x=>x.sql);
 assert.deepEqual(statementsSql.filter(x=>x==='BEGIN'||x==='COMMIT'),['BEGIN','COMMIT']);
 const unset=statementsSql.findIndex(x=>x.startsWith('UPDATE waha_connections SET is_primary=FALSE'));
 const set=statementsSql.findIndex(x=>x.startsWith('UPDATE waha_connections SET is_primary=TRUE'));
 assert.ok(unset>=0&&set>unset);
 assert.equal(statements[set].args[0],2);
});
test('primary change to unknown account rolls back without resetting existing primary',async()=>{
 const {pool,statements}=fakePool({exists:false});
 await assert.rejects(()=>setPrimaryConnection(pool,'2'),/não encontrada/);
 assert.ok(statements.some(x=>x.sql==='ROLLBACK'));
 assert.ok(!statements.some(x=>x.sql.startsWith('UPDATE waha_connections SET is_primary=FALSE')));
});
test('a primary connection cannot be deleted',async()=>{
 const {pool,statements}=fakePool({record:{id:2,label:'Principal',is_primary:true}});
 await assert.rejects(()=>deleteConnection(pool,'2'),/defina outra conexão/);
 assert.ok(statements.some(x=>x.sql==='ROLLBACK'));
 assert.ok(!statements.some(x=>x.sql.startsWith('DELETE FROM waha_connections')));
});
test('the last WhatsApp account cannot be removed',async()=>{
 const {pool,statements}=fakePool({total:1});
 await assert.rejects(()=>deleteConnection(pool,'2'),/única conexão/);
 assert.ok(!statements.some(x=>x.sql.startsWith('DELETE FROM waha_connections')));
});
test('safe deletion archives groups, detaches product links and retains history',async()=>{
 const {pool,statements}=fakePool();
 const result=await deleteConnection(pool,'2');
 assert.deepEqual(result,{label:'Secundária',groupsArchived:2,productLinksRemoved:3});
 const sql=statements.map(x=>x.sql);
 assert.ok(sql.some(x=>x.startsWith('UPDATE rotation_groups SET enabled=FALSE,connection_id=NULL')));
 assert.ok(sql.some(x=>x.startsWith('DELETE FROM group_rotation_state')));
 assert.ok(sql.some(x=>x.startsWith('DELETE FROM product_connections WHERE connection_id')));
 assert.ok(sql.some(x=>x.startsWith('DELETE FROM waha_connections WHERE id')));
 assert.ok(!sql.some(x=>/DELETE FROM (rotation_groups|products|dispatch_log)/.test(x)));
 assert.ok(sql.includes('COMMIT'));
});
