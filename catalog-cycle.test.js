'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {selectCycleProducts,sqlRecordCycleAttempt}=require('./rotation-persistence');

function simulate({size,additions=[],days=100,daily=5}){
 const queue=Array.from({length:size},(_,i)=>String(i+1)),sent=[],dayGroups=[];
 let cycleSent=[],nextId=size+1;
 for(let day=1;day<=days;day++){
  for(const {day:scheduled,count} of additions){
   if(scheduled===day)for(let i=0;i<count;i++)queue.push(String(nextId++));
  }
  const state=selectCycleProducts({queue,cycleSent,needed:daily});
  cycleSent=state.cycleSent;
  assert.ok(state.selected.length<=daily);
  assert.equal(new Set(state.selected).size,state.selected.length);
  for(const product of state.selected){
   assert.ok(!cycleSent.includes(product),'cannot select attempted product before finishing current cycle');
   cycleSent.push(product);
   sent.push(product);
  }
  dayGroups.push(state.selected);
 }
 return {queue,sent,dayGroups,cycleSent};
}
test('100 products: five attempts per day, all 100 before the first repeat',()=>{
 const data=simulate({size:100,days:21});
 assert.equal(data.sent.length,105);
 assert.equal(new Set(data.sent.slice(0,100)).size,100);
 assert.deepEqual(data.sent.slice(0,100),Array.from({length:100},(_,i)=>String(i+1)));
 assert.deepEqual(data.sent.slice(100,105),['1','2','3','4','5']);
});
test('300 products: initial complete cycle must span 60 days with no lost item',()=>{
 const data=simulate({size:300,days:61});
 assert.equal(new Set(data.sent.slice(0,300)).size,300);
 assert.deepEqual(data.sent.slice(295,300),['296','297','298','299','300']);
 assert.deepEqual(data.dayGroups[60],['1','2','3','4','5']);
});
test('200 existing products plus 100 new products: newcomers enter current cycle before any repeat',()=>{
 const data=simulate({size:200,additions:[{day:8,count:100}],days:61});
 assert.equal(data.queue.length,300);
 assert.equal(new Set(data.sent.slice(0,300)).size,300);
 assert.deepEqual(data.sent.slice(195,205),['196','197','198','199','200','201','202','203','204','205']);
 assert.deepEqual(data.sent.slice(295,300),['296','297','298','299','300']);
 assert.deepEqual(data.sent.slice(300,305),['1','2','3','4','5']);
});
test('repeated replans do not consume products until reservation has occurred',()=>{
 const queue=Array.from({length:100},(_,i)=>String(i+1));
 let prev=selectCycleProducts({queue,needed:5});
 for(let i=0;i<30;i++){
  const replanned=selectCycleProducts({queue,needed:5,prior:prev.selected,cycleSent:[]});
  assert.deepEqual(replanned.selected,['1','2','3','4','5']);
  assert.deepEqual(replanned.cycleSent,[]);
  prev=replanned;
 }
 const afterDispatch=selectCycleProducts({queue,needed:5,cycleSent:['1','2','3','4','5']});
 assert.deepEqual(afterDispatch.selected,['6','7','8','9','10']);
});
test('products registered mid-day are appended and not lost when prior work is retained',()=>{
 const queue=Array.from({length:100},(_,i)=>String(i+1));
 const first=selectCycleProducts({queue,needed:5});
 const updated=selectCycleProducts({queue:[...queue,'101','102'],needed:5,prior:first.selected});
 assert.deepEqual(updated.selected,first.selected);
 const seen=new Set();
 for(let i=0;i<21;i++){
  const next=selectCycleProducts({queue:[...queue,'101','102'],cycleSent:[...seen],needed:5});
  for(const id of next.selected)seen.add(id);
 }
 assert.ok(seen.has('101')&&seen.has('102'));
});
test('inactive catalog products are not selected but keep their place upon reactivation',()=>{
 const progress=['1','2'],active=['1','3','4'];
 const duringPause=selectCycleProducts({queue:active,cycleSent:progress,needed:5});
 assert.deepEqual(duringPause.selected,['3','4']);
 const afterReactivation=selectCycleProducts({queue:['1','2','3','4'],cycleSent:['1','3','4'],needed:5});
 assert.deepEqual(afterReactivation.selected,['2']);
});
test('only a delivery reservation updates persistent cycle; the SQL is idempotent',()=>{
 const sql=sqlRecordCycleAttempt();
 assert.ok(sql.includes('INSERT INTO group_rotation_state'));
 assert.ok(sql.includes('ON CONFLICT(group_id) DO UPDATE'));
 assert.ok(sql.includes('cycle_sent'));
 assert.ok(sql.includes('group_rotation_state.cycle_sent @> jsonb_build_array($2::text)'));
 assert.ok(!sql.includes('DELETE FROM'));
});
