'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {selectDistinctProducts}=require('./rotation-persistence');
test('20 groups and four offers rotate across the groups with no same-day product duplication',()=>{
 const queue=['1','2','3','4'], groups=20,perGroup=3,rounds=[];
 for(let g=0;g<groups;g++){
  const x=selectDistinctProducts({queue,offset:g%queue.length,needed:perGroup});
  assert.equal(x.selected.length,perGroup);
  assert.equal(new Set(x.selected).size,perGroup);
  rounds.push(x.selected);
 }
 assert.deepEqual(rounds.slice(0,4).map(x=>x[0]),queue);
 for(let i=0;i<perGroup;i++)assert.equal(rounds.map(x=>x[i]).length,groups);
});
test('two active products with three-per-group quota generate at most two unique offers',()=>{
 const x=selectDistinctProducts({queue:['11','12'],cursor:0,needed:3});
 assert.deepEqual(x.selected,['11','12']);
 assert.equal(new Set(x.selected).size,2);
});
test('already posted or attempted products cannot reappear on restart today',()=>{
 const x=selectDistinctProducts({queue:['1','2','3','4'],offset:0,needed:2,already:['1','2'],restart:true});
 assert.deepEqual(x.selected,['3','4']);
});
test('a previously planned offer is preserved on resume while already sent offers are excluded',()=>{
 const x=selectDistinctProducts({queue:['1','2','3','4'],cursor:2,prior:['1','2'],already:['1'],needed:2});
 assert.deepEqual(x.selected,['2','3']);
});
test('new products enter later days without resetting the group cursor',()=>{
 const day1=selectDistinctProducts({queue:['1','2'],needed:2});
 const day2=selectDistinctProducts({queue:['1','2','3','4'],cursor:day1.cursor,needed:3});
 assert.deepEqual(day1.selected,['1','2']);
 assert.deepEqual(day2.selected,['3','4','1']);
 assert.equal(new Set(day2.selected).size,3);
});
