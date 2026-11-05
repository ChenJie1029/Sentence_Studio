import test from 'node:test';
import assert from 'node:assert/strict';
import {findPauses,planPauseSegments,speakerChangesFromTurns} from '../dist/pause-segmentation.js';
import {mapOriginalText,textFromBreaks,applyTextMapping} from '../dist/text-mapping.js';
const pause=time=>({start:time-.25,end:time+.25,time,duration:.5});
const heard=text=>text.split(' ').map((text,index)=>({text,timestamp:[index,index+.5]}));

test('waveform analysis detects quiet intervals without using recognized words',()=>{
  const sr=1000,samples=Float32Array.from({length:22000},(_,i)=>i>9700&&i<10300?0:.2*Math.sin(i*.5));
  const result=findPauses(samples,sr);assert.equal(result.pauses.length,1);assert.ok(Math.abs(result.pauses[0].time-10)<.05);
  assert.throws(()=>findPauses(new Float32Array(2000),sr),/没有可用的声音/);
});
test('short word gaps are not sentence pauses and leading/trailing silence is not a cut',()=>{
  const sr=1000,samples=Float32Array.from({length:5000},(_,i)=>i<500||i>4500||i>1990&&i<2090?0:.2*Math.sin(i*.5));
  assert.deepEqual(findPauses(samples,sr).pauses,[]);
});
test('speaker change before eight seconds waits for a later boundary',()=>{
  const plan=planPauseSegments(20,[pause(10)],[{time:4,confidence:.9}]);
  assert.deepEqual(plan.segments.map(s=>[s.start,s.end]),[[0,10],[10,20]]);
  assert.ok(plan.segments.every(s=>s.end-s.start>=8));
});
test('speaker change in the allowed interval has priority and uses the nearby pause',()=>{
  const plan=planPauseSegments(24,[pause(9),pause(12)],[{time:12.1,confidence:.9}]);
  assert.equal(plan.segments[0].end,12);assert.equal(plan.segments[0].boundaryReason,'speaker-change');
});
test('all normal cuts respect 8–15 seconds while sharing exact adjacent endpoints',()=>{
  const plan=planPauseSegments(36,[pause(5),pause(10),pause(12),pause(20),pause(24),pause(30)]);
  assert.equal(plan.segments[0].start,0);assert.equal(plan.segments.at(-1).end,36);
  plan.segments.forEach((s,i)=>{assert.ok(s.end-s.start>=8&&s.end-s.start<=15);if(i)assert.equal(plan.segments[i-1].end,s.start);});
});
test('continuous speech is never blindly chopped at fifteen seconds',()=>{
  const plan=planPauseSegments(28,[]);assert.equal(plan.segments.length,1);assert.equal(plan.segments[0].end,28);assert.equal(plan.segments[0].lengthException,'long');assert.match(plan.warnings[0],/没有找到/);
});
test('remaining tail is retained even when less than eight seconds',()=>{
  const plan=planPauseSegments(17,[pause(10)]);assert.equal(plan.segments.at(-1).end,17);assert.equal(plan.segments.at(-1).lengthException,'short');
});
test('speaker classes ignore silence, overlapping speech and unstable brief classifications',()=>{
  const turns=[{id:1,start:0,end:5,confidence:.9},{id:0,start:5,end:5.5,confidence:.9},{id:1,start:5.5,end:7,confidence:.9},{id:3,start:7,end:7.1,confidence:.9},{id:2,start:7.1,end:12,confidence:.9}];
  const changes=speakerChangesFromTurns(turns);assert.equal(changes.length,1);assert.ok(changes[0].time>=7&&changes[0].time<=7.1);
  assert.equal(speakerChangesFromTurns([{id:4,start:0,end:3,confidence:.9},{id:2,start:3,end:5,confidence:.9}]).length,0);
});
test('local speaker IDs are cropped to the middle of a window, never compared across windows',()=>{
  const turns=[{id:1,start:0,end:3,confidence:.8},{id:2,start:3,end:10,confidence:.8},{id:1,start:10,end:18,confidence:.8}];
  const changes=speakerChangesFromTurns(turns,{offset:10,keepStart:5,keepEnd:15});assert.equal(changes.length,1);assert.equal(changes[0].time,20);
});
test('a real switch after a sentence pause longer than 1.5 seconds is retained',()=>{
  const turns=[{id:2,start:8.9884,end:12.0015,confidence:.9495},{id:0,start:12.0015,end:13.6773,confidence:.9678},{id:3,start:13.6773,end:15.5901,confidence:.9382}];
  const changes=speakerChangesFromTurns(turns);assert.equal(changes.length,1);
  const plan=planPauseSegments(24.3417,[pause(8.4),pause(12.78)],changes);assert.equal(plan.segments[0].boundaryReason,'speaker-change');assert.equal(plan.segments[0].end,12.78);
});
test('speaker-only boundary is marked for listening review instead of claiming a safe pause',()=>{
  const plan=planPauseSegments(24,[],[{time:12,confidence:.9}]);assert.equal(plan.segments[0].end,12);assert.equal(plan.segments[0].needsBoundaryReview,true);
});
test('text mapping preserves original wording and punctuation across acoustic boundaries',()=>{
  const text='Keep GOING! Every day, listen again.';
  const plan={segments:[{start:0,end:1.7},{start:1.7,end:6}]},mapping=mapOriginalText(text,heard('keep going every day listen again'),plan);
  assert.deepEqual(mapping.texts,['Keep GOING!','Every day, listen again.']);assert.equal(mapping.needsReview,false);
  const segments=applyTextMapping(plan,mapping,{start:30,end:36});assert.equal(segments[0].start,30);assert.equal(segments.at(-1).end,36);assert.equal(segments[0].text,'Keep GOING!');
});
test('recognition mistakes inside a segment do not block audio cuts or rewrite correct words',()=>{
  const text='A small step. Keep going every day.',plan={segments:[{start:0,end:2.7},{start:2.7,end:8}]};
  const mapping=mapOriginalText(text,heard('a smell step keep going every day'),plan);
  assert.equal(mapping.needsReview,false);assert.deepEqual(mapping.texts,['A small step.','Keep going every day.']);
});
test('unknown text boundary requires review, retains every word, and cannot pass silently',()=>{
  const text='A small step. Keep going every day.',plan={segments:[{start:0,end:4},{start:4,end:8}]},mapping=mapOriginalText(text,[],plan);
  assert.equal(mapping.needsReview,true);assert.throws(()=>applyTextMapping(plan,mapping,{start:0}),/确认分段原文/);
  mapping.breaks=[3];mapping.manualConfirmed=true;
  assert.deepEqual(applyTextMapping(plan,mapping,{start:0}).map(s=>s.text),['A small step.','Keep going every day.']);
});
test('adjusting a text boundary never permits missing, reordered or overlapping original words',()=>{
  const mapping=mapOriginalText('One two three four five six.',[],{segments:[{start:0,end:8},{start:8,end:16},{start:16,end:24}]});
  for(const breaks of [[0,4],[3,3],[4,2],[2,6]])assert.throws(()=>textFromBreaks(mapping.text,mapping.tokens,breaks),/分界/);
  assert.equal(textFromBreaks(mapping.text,mapping.tokens,[1,5]).join(' '),'One two three four five six.');
});
