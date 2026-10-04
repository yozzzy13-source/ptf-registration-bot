import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { isWCrossGroupPair } from '../access.js';
assert.equal(isWCrossGroupPair('Olga Sauer','Masha Geveling','W'),true);
assert.equal(isWCrossGroupPair('Maria Evangelista','Xenia Hors','Division W'),true);
assert.equal(isWCrossGroupPair('Olga Sauer','Elena Ian','W'),false);
assert.equal(isWCrossGroupPair('Olga Sauer','Masha Geveling','A'),false);

// Замена в группе подхватывается из таблицы дивизиона: Анну (группа 2)
// сменила Аксинья — Аксинья встаёт во все межгрупповые пары Анны.
const g2=['Olga Sauer','Marina Banatskaia','Daria Kozitskaya','Hyunjung Moon','Aksinya','Maria Evangelista'];
const g1=['Masha Geveling','Yana D','Elena Ian','Irina Strembitska','Tatiana Sokolova','Xenia Hors'];
let players=[...g2.map(name=>({name,letter:'W',group:'2'})),...g1.map(name=>({name,letter:'W',group:'1'}))];
const same=(a,b)=>String(a).trim().toLowerCase()===String(b).trim().toLowerCase();
const context=vm.createContext({console,Date,Map,Set,JSON,Number,String,Boolean,Math,Error,Promise});
const syn=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v)},{context});
const mods={
  './config.js':syn({ADMIN_IDS:[]}),
  './sheets.js':syn({getPlayerLeagueInfo:async()=>null,sameName:same}),
  './division.js':syn({divisionLetter:x=>String(x||'').replace(/^division\s*/i,'').trim().charAt(0).toUpperCase(),latestSeason:async()=>'2',seasonRoster:async()=>({players})})
};
const mod=new vm.SourceTextModule(await fs.readFile(new URL('../access.js',import.meta.url),'utf8'),{context});
await mod.link(s=>mods[s]);await mod.evaluate();
const a=mod.namespace;
let r=await a.resolveWCrossPairs('2');
assert.equal(JSON.stringify(r.subs),JSON.stringify([{from:'Anna Ermolina',to:'Aksinya',group:'2'}]));
assert.equal(a.isWCrossGroupPair('Aksinya','Elena Ian','W'),true);
assert.equal(a.isWCrossGroupPair('Yana D','Aksinya','W'),true);
assert.equal(a.isWCrossGroupPair('Anna Ermolina','Elena Ian','W'),false);
assert.equal(a.isWCrossGroupPair('Aksinya','Masha Geveling','W'),false);
// Совсем другой состав (новый сезон) — это не замена: базовый список не трогаем.
players=['P1','P2','P3','P4','P5','P6'].map(name=>({name,letter:'W',group:'2'}));a.forgetWCrossPairs();
r=await a.resolveWCrossPairs('2');
assert.equal(r.subs.length,0);
assert.equal(a.isWCrossGroupPair('Anna Ermolina','Elena Ian','W'),true);

// Пары больше не захардкожены в других файлах — только базовый список в access.js.
for(const f of ['results.js','sheets.js','division.js']){
  const src=await fs.readFile(new URL('../'+f,import.meta.url),'utf8');
  assert.ok(!/Anna Ermolina/.test(src),f+' must not hardcode W cross pairs');
}
console.log('PASS: W1/W2 cross-group pairs, substitutions from the division table.');
