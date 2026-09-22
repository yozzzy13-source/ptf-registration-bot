import assert from 'node:assert/strict';
import sharp from 'sharp';

process.env.MATCH_POSTER_PROMPT='BASE {{player_1}} vs {{player_2}}. {{comment}}';
process.env.MATCH_POSTER_VARIANTS='2';
process.env.OPENAI_API_KEY='test-key';
process.env.POSTER_SIZE='1008x1792';
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
assert.equal(poster.posterSettings().apiConnected,true);
assert.equal(poster.posterEnabled(),true);
assert.equal(poster.posterConsentAllowed('NO'),false);
assert.equal(poster.posterConsentAllowed('no'),false);
assert.equal(poster.posterConsentAllowed('YES'),true);
assert.equal(poster.posterConsentAllowed(''),true);
assert.equal(poster.posterConsentAllowed('NOT_ANSWERED'),true);

const background=await sharp({create:{width:540,height:960,channels:3,background:'#48789b'}}).png().toBuffer();
const result=await poster.composeMatchPoster(background,match);
const meta=await sharp(result).metadata();
assert.equal(meta.width,1080);
assert.equal(meta.height,1920);
assert.equal(meta.format,'png');

const requests=[];
globalThis.fetch=async (url,options)=>{
  requests.push({url,options,body:JSON.parse(options.body)});
  return {ok:true,status:200,json:async()=>({data:[{b64_json:background.toString('base64')} ]})};
};
const source=await sharp({create:{width:300,height:500,channels:3,background:'#ccbbaa'}}).jpeg().toBuffer();
const generated=await poster.generatePosterBackgrounds({
  consent:[{allowed:true},{allowed:true}],
  prompts:[{variant:1,prompt:first},{variant:2,prompt:second}]
},[source,source]);
assert.equal(generated.length,2);
assert.equal(requests.length,2);
assert.equal(requests[0].url,'https://api.openai.com/v1/images/edits');
assert.equal(requests[0].options.headers.Authorization,'Bearer test-key');
assert.equal(requests[0].body.model,'gpt-image-2');
assert.equal(requests[0].body.size,'1008x1792');
assert.equal(requests[0].body.input_fidelity,'high');
assert.equal(requests[0].body.images.length,2);
assert.match(requests[0].body.images[0].image_url,/^data:image\/jpeg;base64,/);
await assert.rejects(()=>poster.generatePosterBackgrounds({
  consent:[{allowed:true},{allowed:false}],prompts:[{variant:1,prompt:first}]
},[source,source]),/poster_consent_required/);

console.log('PASS: poster API payload, consent policy, two variants and exact 1080x1920 overlay.');
