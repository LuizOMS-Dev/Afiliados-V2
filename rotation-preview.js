// Preview only. No WAHA calls, no mutations.
const {DEFAULTS,buildCycle,createDailyPlan,seeded}=require('./rotation');
const products=Array.from({length:DEFAULTS.products},(_,i)=>i+1);
const groups=Array.from({length:DEFAULTS.groups},(_,i)=>'Grupo '+(i+1));
const queue=buildCycle(products,seeded(20261010));
let cursor=0;
for(let day=0;day<10;day++){
 const result=createDailyPlan({queue,groupIds:groups,daily:DEFAULTS.daily,start:DEFAULTS.start,end:DEFAULTS.end,dayIndex:day,cursor,rng:seeded(day+123)});
 console.log('Dia',day+1,result.assignments.map(x=>x.productId+' -> '+x.groupId).join('; '));
 cursor=result.nextCursor;
}
console.log('Ciclo completo:',cursor===DEFAULTS.products,'Disparos habilitados:',false);
