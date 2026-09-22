import assert from 'node:assert/strict';
import sharp from 'sharp';

process.env.MATCH_POSTER_PROMPT='BASE {{player_1}} vs {{player_2}}. {{comment}}';
process.env.MATCH_POSTER_VARIANTS='2';
const poster=await import('../matchposter.js');

const match={
  winner:'Alice One',loser:'Bob Two',score:'6:4 6:3',division:'Division A',season:'2',
  winnerMeta:{position:{before:3,after:2},form:['W','L','W']},
  loserMeta:{position:{before:2,after:3},form:['L','W','L']}
};
const first=poster.buildPosterPrompt(match,{comment:'Season semifinal',variant:1});
const second=poster.buildPosterPrompt(match,{comment:'Season semifinal',variant:2});
assert.match(first,/BASE Alice One vs Bob Two/);
assert.match(first,/Season semifinal/);
assert.match(first,/no tennis rackets/);
assert.match(first,/bottom 15 percent/);
assert.notEqual(first,second);
assert.equal(poster.posterPromptSource(),'MATCH_POSTER_PROMPT');
assert.equal(poster.posterSettings().apiConnected,false);
assert.equal(poster.posterEnabled(),false);

const background=await sharp({create:{width:540,height:960,channels:3,background:'#48789b'}}).png().toBuffer();
const result=await poster.composeMatchPoster(background,match);
const meta=await sharp(result).metadata();
assert.equal(meta.width,1080);
assert.equal(meta.height,1920);
assert.equal(meta.format,'png');
await assert.rejects(()=>poster.generatePosterBackgrounds(),/poster_api_not_connected/);

console.log('PASS: poster prompt Variable, two prompt variants, no API call, and exact 1080x1920 overlay.');