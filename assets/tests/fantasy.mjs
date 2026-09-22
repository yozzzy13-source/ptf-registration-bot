import assert from 'node:assert/strict';
import { SHEETS } from '../config.js';
import { MENU_VERSION,persistentKeyboard } from '../keyboards.js';
import {
  fantasyPrice,
  fantasyPriceBreakdown,
  fantasyTransitionFactor,
  fantasyWinRateBonus,
  scoreFantasyMatch,
  validateFantasySelection
} from '../fantasy.js';

assert.equal(fantasyWinRateBonus(19.9),-1);
assert.equal(fantasyWinRateBonus(35),0);
assert.equal(fantasyWinRateBonus(62),2);
assert.equal(fantasyWinRateBonus(80),3);
assert.equal(fantasyTransitionFactor('C','B'),0.5);
assert.equal(fantasyTransitionFactor('C','A'),0.25);
assert.equal(fantasyTransitionFactor('D','W'),1);
assert.equal(fantasyPrice({matches:7,winRate:85,place:1,playoff:'champion',division:'C'},'B'),14);
assert.equal(fantasyPrice(null,'A'),10);
const breakdown=fantasyPriceBreakdown({matches:7,winRate:85,place:1,playoff:'champion',division:'C'},'B');
assert.deepEqual({base:breakdown.base,premium:breakdown.premium,transition:breakdown.transition_factor,adjusted:breakdown.adjusted_premium,final:breakdown.final},{base:10,premium:7,transition:0.5,adjusted:4,final:14});

const won=scoreFantasyMatch({score:'6:4 4:6 10:8',result:'W'},10,13);
assert.deepEqual(
  {appearance:won.appearance,win:won.win,sets:won.sets,games:won.games,upset:won.upset,total:won.total},
  {appearance:2,win:10,sets:6,games:10,upset:4,total:32}
);
const straight=scoreFantasyMatch({score:'6:0 6:0',result:'W'},12,12);
assert.equal(straight.total,2+10+6+12+3+4);
assert.equal(scoreFantasyMatch({score:'W/O',result:'W'},10,10).total,5);
assert.equal(scoreFantasyMatch({score:'W/O',result:'LOST'},10,10).total,0);
assert.equal(scoreFantasyMatch({score:'6:1 2:0 RET',result:'W'},10,10).straight,0);

const pools=['PRIME','A','B','C:1','C:2','W:1','W:2'];
const players=pools.map((pool,i)=>({key:'p'+i,name:'P'+i,pool,price:10,is_debutant:false}));
players.push({key:'flex',name:'Flex',pool:'A',price:12,is_debutant:true});
const catalog={players,pools,rosterSize:8,maxPerPool:2,budget:88};
const valid=validateFantasySelection({picks:players.map(p=>p.key),captain_key:'p0',vice_key:'p1'},catalog,{complete:true,lang:'en'});
assert.equal(valid.ok,true);
assert.equal(valid.spent,82);
const invalid=validateFantasySelection({picks:players.slice(0,7).map(p=>p.key),captain_key:'p0',vice_key:'p0'},catalog,{complete:true,lang:'en'});
assert.equal(invalid.ok,false);
assert.ok(invalid.errors.some(x=>x.includes('exactly 8')));
assert.ok(invalid.errors.some(x=>x.includes('must differ')));

assert.equal(SHEETS.fantasyTestTeams,'Fantasy Test Teams');
assert.equal(SHEETS.fantasyTestTransfers,'Fantasy Test Transfers');
assert.equal(SHEETS.fantasyTesters,'Fantasy Testers');
assert.ok(MENU_VERSION>=7);
const hidden=persistentKeyboard('en','active','',null,0,false).keyboard.flat().map(x=>x.text);
const shown=persistentKeyboard('en','active','',null,0,true).keyboard.flat().map(x=>x.text);
assert.equal(hidden.includes('✨ Fantasy'),false);
assert.equal(shown.includes('✨ Fantasy'),true);

console.log('fantasy tests passed');
