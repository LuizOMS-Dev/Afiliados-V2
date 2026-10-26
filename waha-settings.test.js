'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {encrypt,decrypt}=require('./waha-settings');
test('WAHA API key encryption uses AES-GCM and survives consecutive reads',async()=>{
  const original=process.env.WAHA_KEY_FILE;
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'afiliados-key-'));
  process.env.WAHA_KEY_FILE=path.join(dir,randomUUID()+'.key');
  try{
    const a=await encrypt('example-secret');
    const b=await encrypt('example-secret');
    assert.notEqual(a,b);
    assert.equal(await decrypt(a),'example-secret');
    assert.equal(await decrypt(b),'example-secret');
    const corrupt=Buffer.from(a,'base64');
    corrupt[corrupt.length-1]^=0xff;
    await assert.rejects(decrypt(corrupt.toString('base64')));
  }finally{
    if(original===undefined)delete process.env.WAHA_KEY_FILE;else process.env.WAHA_KEY_FILE=original;
    await fs.rm(dir,{recursive:true,force:true});
  }
});
