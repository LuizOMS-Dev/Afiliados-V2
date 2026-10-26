'use strict';
const DEFAULTS=Object.freeze({products:100,groups:10,daily:10,start:'06:00',end:'23:00',timezone:'America/Sao_Paulo',alternateGroups:true,sendEnabled:false});
function integer(x,name){if(!Number.isInteger(x)||x<1)throw new Error(`${name} must be positive integer`);return x}
function minutes(t){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(t))throw new Error('Invalid time');const [h,m]=t.split(':').map(Number);return h*60+m}
function shuffle(input,rng=Math.random){const a=[...input];for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a}
function buildCycle(productIds,rng=Math.random){if(!Array.isArray(productIds)||!productIds.length||new Set(productIds).size!==productIds.length)throw new Error('Unique products required');return shuffle(productIds,rng)}
function createDailyPlan({queue,groupIds,daily=10,start='06:00',end='23:00',dayIndex=0,cursor=0,rng=Math.random}){
 if(!Array.isArray(queue)||!queue.length||new Set(queue).size!==queue.length)throw new Error('Valid product queue required');
 if(!Array.isArray(groupIds)||!groupIds.length||new Set(groupIds).size!==groupIds.length)throw new Error('Unique groups required');
 integer(daily,'daily');if(!Number.isInteger(cursor)||cursor<0||cursor>queue.length)throw new Error('Invalid cursor');if(!Number.isInteger(dayIndex)||dayIndex<0)throw new Error('Invalid dayIndex');
 const a=minutes(start),b=minutes(end);if(b<=a)throw new Error('End must be later than start');
 const n=Math.min(daily,groupIds.length,queue.length-cursor);
 // Never start a new cycle within the same day.
 const rotated=groupIds.map((_,i)=>groupIds[(i+(dayIndex%groupIds.length))%groupIds.length]);
 const destinations=shuffle(rotated.slice(0,n),rng);
 const slots=Array.from({length:n},(_,i)=>a+Math.floor((i+0.5)*(b-a)/n));
 const assignments=Array.from({length:n},(_,i)=>({productId:queue[cursor+i],groupId:destinations[i],minuteOfDay:slots[i]}));
 return {assignments,nextCursor:cursor+n,cycleComplete:cursor+n===queue.length,sendEnabled:false};
}
function seeded(seed){let n=seed>>>0;return ()=>((n=(1664525*n+1013904223)>>>0)/4294967296)}
module.exports={DEFAULTS,buildCycle,createDailyPlan,seeded};
