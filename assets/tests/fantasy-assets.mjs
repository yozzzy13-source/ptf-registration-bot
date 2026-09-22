
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import express from 'express';

// Exercise the actual static and Fantasy page registrations from index.js.
// Do not start the bot or connect to Sheets.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=await fs.readFile(path.join(root,'index.js'),'utf8');
const registrations=source.split(/\r?\n/).filter(line=>
  /^app\.use\('\/public', express\.static/.test(line) ||
  /^app\.get\('\/fantasy',/.test(line));
assert.equal(registrations.length,2,'Locate production Fantasy asset registrations');
const app=express();
vm.runInNewContext(registrations.join('\n'),{app,express,path,__dirname:root,noCache:res=>res.set('Cache-Control','no-store')});
const server=app.listen(0,'127.0.0.1');
await new Promise(resolve=>server.once('listening',resolve));
try {
  const base='http://127.0.0.1:'+server.address().port;
  const page=await fetch(base+'/fantasy');
  assert.equal(page.status,200);
  const html=await page.text();
  const src=html.match(/<script type="module" src="([^"]+)"/)?.[1];
  assert.ok(src,'Fantasy must load the onboarding module');
  const moduleUrl=new URL(src,base+'/fantasy');
  const module=await fetch(moduleUrl);
  assert.equal(module.status,200,'Onboarding script must resolve through the production static mount');
  assert.match(module.headers.get('content-type'),/javascript/);
  const js=await module.text();
  const dependency=js.match(/from ['"](\.\/fantasy-model\.js)['"]/)?.[1];
  assert.ok(dependency,'Locate shared slot model import');
  const model=await fetch(new URL(dependency,moduleUrl));
  assert.equal(model.status,200,'Shared slot model must resolve relative to the onboarding module');
  assert.match(model.headers.get('content-type'),/javascript/);
  assert.match(await model.text(),/export function assignSlots/);
  console.log('PASS: Fantasy HTML, onboarding module and slot model load through production /public routes.');
} finally {
  await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
}

