'use strict';
const {encrypt,decrypt,readSettings}=require('./waha-settings');
async function initConnections(pool){
 await pool.query("CREATE TABLE IF NOT EXISTS waha_connections(id BIGSERIAL PRIMARY KEY,label VARCHAR(100) NOT NULL,base_url TEXT NOT NULL,session_name VARCHAR(100) NOT NULL,api_key_ciphertext TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
 const legacy=await readSettings(pool);
 if(legacy){
  await pool.query("INSERT INTO waha_connections(id,label,base_url,session_name,api_key_ciphertext) SELECT 1,'Conexão principal',base_url,session_name,api_key_ciphertext FROM waha_settings WHERE id=1 AND NOT EXISTS(SELECT 1 FROM waha_connections) ON CONFLICT (id) DO NOTHING");
  await pool.query("SELECT setval(pg_get_serial_sequence('waha_connections','id'),GREATEST((SELECT COALESCE(MAX(id),0) FROM waha_connections),(SELECT last_value FROM waha_connections_id_seq),1))");
 }
 await pool.query('ALTER TABLE rotation_groups ADD COLUMN IF NOT EXISTS connection_id BIGINT');
 // Unassigned historical groups must stay detached after deleting a connection.
 await pool.query('ALTER TABLE waha_connections ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE');
 await pool.query('UPDATE waha_connections SET is_primary=TRUE WHERE id=(SELECT id FROM waha_connections ORDER BY id LIMIT 1) AND NOT EXISTS(SELECT 1 FROM waha_connections WHERE is_primary=TRUE)');
 await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS waha_connections_only_one_primary ON waha_connections(is_primary) WHERE is_primary=TRUE');
 // Replace the former global chat_id uniqueness with per-account uniqueness.
 // Keep existing group IDs and authorization flags unchanged.
 await pool.query("DO $$ DECLARE c RECORD; BEGIN FOR c IN SELECT con.conname FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=ANY(con.conkey) WHERE t.relname='rotation_groups' AND con.contype='u' GROUP BY con.conname HAVING bool_or(a.attname='chat_id') AND count(*)=1 LOOP EXECUTE format('ALTER TABLE rotation_groups DROP CONSTRAINT %I',c.conname); END LOOP; END $$");
 await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS rotation_groups_connection_chat_unique ON rotation_groups(connection_id,chat_id)');

}
async function listConnections(pool){return (await pool.query('SELECT id,label,base_url,session_name,is_primary FROM waha_connections ORDER BY is_primary DESC,id')).rows}
async function getConnection(pool,id){
 if(!/^[0-9]+$/.test(String(id||'')))return null;
 const row=(await pool.query('SELECT * FROM waha_connections WHERE id=$1',[id])).rows[0];
 return row?{id:row.id,label:row.label,baseUrl:row.base_url,session:row.session_name,apiKey:await decrypt(row.api_key_ciphertext)}:null;
}
async function saveConnection(pool,{id,label,baseUrl,session,apiKey}){
 let url;try{url=new URL(String(baseUrl||''))}catch{throw Error('Endereço WAHA inválido')}
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname.replace(/[/]$/,'')!=='')throw Error('URL da API inválida');
 if(['localhost','127.0.0.1','::1'].includes(url.hostname))throw Error('Informe o endereço acessível ao servidor');
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(String(session||'')))throw Error('Nome da sessão inválido');
 label=String(label||'').trim();
 if(!label||label.length>100)throw Error('Informe um nome de até 100 caracteres');
 if(String(apiKey||'').length>1000)throw Error('Chave muito longa');
 const editing=/^[0-9]+$/.test(String(id||''));
 if(editing){
  const old=(await pool.query('SELECT api_key_ciphertext FROM waha_connections WHERE id=$1',[id])).rows[0];
  if(!old)throw Error('Conexão não encontrada');
  const cipher=apiKey?await encrypt(String(apiKey).trim()):old.api_key_ciphertext;
  await pool.query('UPDATE waha_connections SET label=$1,base_url=$2,session_name=$3,api_key_ciphertext=$4,updated_at=NOW() WHERE id=$5',[label,url.origin,session,cipher,id]);
  return id;
 }
 if(!apiKey||!String(apiKey).trim())throw Error('Informe a chave da API');
 const cipher=await encrypt(String(apiKey).trim());
 const inserted=(await pool.query('INSERT INTO waha_connections(label,base_url,session_name,api_key_ciphertext) VALUES($1,$2,$3,$4) RETURNING id',[label,url.origin,session,cipher])).rows[0].id;
 await pool.query('UPDATE waha_connections SET is_primary=TRUE WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM waha_connections WHERE is_primary=TRUE)',[inserted]);
 return inserted;
}
async function setPrimaryConnection(pool,id){
 if(!/^[1-9][0-9]*$/.test(String(id||'')))throw Error('Escolha uma conexão válida.');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  await db.query('SELECT pg_advisory_xact_lock(471023)');
  const found=await db.query('SELECT id FROM waha_connections WHERE id=$1',[id]);
  if(!found.rowCount)throw Error('Conexão não encontrada.');
  await db.query('UPDATE waha_connections SET is_primary=FALSE,updated_at=NOW() WHERE is_primary=TRUE');
  await db.query('UPDATE waha_connections SET is_primary=TRUE,updated_at=NOW() WHERE id=$1',[id]);
  await db.query('COMMIT');
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}finally{db.release()}
}
async function deleteConnection(pool,id){
 if(!/^[1-9][0-9]*$/.test(String(id||'')))throw Error('Escolha uma conexão válida.');
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  // Coordinate with the scheduler and other WAHA management actions.
  await db.query('SELECT pg_advisory_xact_lock(471021)');
  await db.query('SELECT pg_advisory_xact_lock(471023)');
  const row=await db.query('SELECT id,label,is_primary FROM waha_connections WHERE id=$1 FOR UPDATE',[id]);
  if(!row.rowCount)throw Error('Conexão não encontrada.');
  if(row.rows[0].is_primary)throw Error('Antes de excluir, defina outra conexão como principal.');
  const total=await db.query('SELECT count(*)::int AS n FROM waha_connections');
  if(total.rows[0].n<=1)throw Error('Não é possível excluir a única conexão.');
  const products=await db.query('SELECT count(*)::int AS n FROM product_connections WHERE connection_id=$1',[id]);
  const groups=await db.query('UPDATE rotation_groups SET enabled=FALSE,connection_id=NULL WHERE connection_id=$1 RETURNING id',[id]);
  const groupIds=groups.rows.map(x=>String(x.id));
  if(groupIds.length)await db.query('DELETE FROM group_rotation_state WHERE group_id=ANY($1::bigint[])',[groupIds]);
  await db.query('DELETE FROM product_connections WHERE connection_id=$1',[id]);
  await db.query('DELETE FROM waha_connections WHERE id=$1',[id]);
  await db.query('COMMIT');
  return {label:row.rows[0].label,groupsArchived:groups.rowCount,productLinksRemoved:products.rows[0].n};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e}finally{db.release()}
}
module.exports={initConnections,listConnections,getConnection,saveConnection,setPrimaryConnection,deleteConnection};
