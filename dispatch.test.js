'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {localDay,localMinute}=require('./dispatch');
test('uses Sao Paulo time for daily scheduling',()=>{
 assert.equal(localDay(new Date('2026-10-11T02:30:00Z')),'2026-10-10');
 assert.equal(localMinute(new Date('2026-10-10T12:30:00Z')),570);
});
