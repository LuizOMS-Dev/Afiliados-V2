'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('production Dockerfile includes all server runtime modules and login assets',()=>{
 const docker=fs.readFileSync(path.join(__dirname,'Dockerfile'),'utf8');
 const server=fs.readFileSync(path.join(__dirname,'server.js'),'utf8');
 const statements=docker.split('\n').filter(x=>x.startsWith('COPY '));
 const files=new Set(statements.flatMap(x=>x.split(/\s+/).slice(1,-1)));
 const modules=[...server.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g)].map(x=>x[1]+'.js');
 for(const file of [...modules,'server.js','login.css','shell.css','upload-ui.js']){
  assert.ok(files.has(file),'Docker image missing required file '+file);
 }
});
