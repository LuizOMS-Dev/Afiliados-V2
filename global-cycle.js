'use strict';
const VERSION=7;
// Global catalog allocation; only dispatch reservations advance persistent progress.
function chooseGlobal({groups,productOrder,cycleSent=[],attemptsByGroup=new Map(),blockedByGroup=new Map(),lastGroupId=null,daily=4}){
 const list=groups.map(g=>({...g,id:String(g.id),connectionId:String(g.connectionId),products:g.products.map(String)}));
 const allowed=new Set(list.flatMap(g=>g.products));
 const order=[...new Set(productOrder.map(String))].filter(id=>allowed.has(id));
 const initial=new Set(cycleSent.map(String).filter(id=>allowed.has(id)));
 let used=new Set(initial),phase=0;
 const output=[],selected=new Map(),last=list.findIndex(g=>g.id===String(lastGroupId));
 const rotated=[...list.slice(last+1),...list.slice(0,last+1)];
 // Least-served groups first; each receives its next contiguous catalog block.
 rotated.sort((a,b)=>(attemptsByGroup.get(a.id)||0)-(attemptsByGroup.get(b.id)||0));
 for(const group of rotated){
  const blocked=new Set((blockedByGroup.get(group.id)||[]).map(String));
  const permitted=new Set(group.products);
  const needed=Math.max(0,daily-(attemptsByGroup.get(group.id)||0));
  for(let slot=0;slot<needed;slot++){
   if(order.length&&order.every(id=>used.has(id))){used=new Set();phase++;}
   const id=order.find(id=>permitted.has(id)&&!used.has(id)&&!blocked.has(id));
   if(!id)break;
   used.add(id);blocked.add(id);
   output.push({productId:id,groupId:group.id,connectionId:group.connectionId,cyclePhase:phase,groupSlot:slot});
  }
 }
 // Preserve catalog phases and each connection's internal queue, but alternate WAHA connections
 // across eligible offers instead of publishing consecutive blocks per account.
 output.sort((a,b)=>a.cyclePhase-b.cyclePhase||a.groupSlot-b.groupSlot);
 const interleaved=[],connections=[...new Set(output.map(x=>x.connectionId))];
 let cursor=0,lastConnection=null;
 for(let start=0;start<output.length;){
  let end=start+1;
  while(end<output.length&&output[end].cyclePhase===output[start].cyclePhase)end++;
  const queues=new Map(connections.map(id=>[id,[]]));
  for(const item of output.slice(start,end))queues.get(item.connectionId).push(item);
  let remaining=end-start;
  while(remaining){
   let selected=-1;
   for(let n=0;n<connections.length;n++){
    const index=(cursor+n)%connections.length,id=connections[index];
    if(queues.get(id).length&&id!==lastConnection){selected=index;break;}
   }
   if(selected<0)selected=connections.findIndex(id=>queues.get(id).length);
   const connection=connections[selected];
   interleaved.push(queues.get(connection).shift());
   lastConnection=connection;cursor=(selected+1)%connections.length;remaining--;
  }
  start=end;
 }
 return {assignments:interleaved,cycleSent:[...initial],reset:false};
}
function globalAttemptSQL(){
 return "INSERT INTO global_product_rotation_state(id,product_order,cycle_sent,last_group_id) VALUES(1,'[]'::jsonb,jsonb_build_array($1::text),$2::bigint) ON CONFLICT(id) DO UPDATE SET cycle_sent=CASE WHEN global_product_rotation_state.product_order <@ global_product_rotation_state.cycle_sent THEN jsonb_build_array($1::text) WHEN global_product_rotation_state.cycle_sent @> jsonb_build_array($1::text) THEN global_product_rotation_state.cycle_sent ELSE global_product_rotation_state.cycle_sent || jsonb_build_array($1::text) END,last_group_id=$2,updated_at=NOW()";
}
module.exports={VERSION,chooseGlobal,globalAttemptSQL};
