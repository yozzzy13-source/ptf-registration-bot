import fs from 'node:fs/promises';
import path from 'node:path';
import { renderMatchCard } from '../matchcard.js';

const args=process.argv.slice(2);
const value=(key,fallback='')=>{const i=args.indexOf('--'+key);return i>=0?String(args[i+1]||''):fallback};
const out=value('out','outputs/match-card-preview.png');
const match={
  winner:value('winner','Oliver'),
  loser:value('loser','Viacheslav'),
  score:value('score','6:1 6:0'),
  division:value('division','Division B'),
  season:value('season','2'),
  date:value('date',new Date().toISOString().slice(0,10)),
  court:value('court','Court A')
};
const image=await renderMatchCard(match);
await fs.mkdir(path.dirname(out),{recursive:true});
await fs.writeFile(out,image);
console.log('Preview saved:',path.resolve(out));
