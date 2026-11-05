import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAudioRange,audioRangeFrames,cropAudioChannels,splitSelectedRange} from '../dist/audio-range.js';
import {buildPracticeAudioPlan} from '../dist/audio-export.js';
import {ConsistencyError} from '../dist/verification.js';
import {encodeWav,encodeWavRanges,toSrt,adjustSegment} from '../dist/core.js';

const buffer=(channels,sampleRate=10)=>({sampleRate,length:channels[0].length,duration:channels[0].length/sampleRate,numberOfChannels:channels.length,getChannelData:index=>channels[index]});
const chunks=[{text:'Keep',timestamp:[.2,.6]},{text:'going.',timestamp:[.7,1.1]},{text:'Every',timestamp:[1.8,2.1]},{text:'day.',timestamp:[2.2,2.6]}];

test('start/end accept decimal seconds and clamp a rounded full duration',()=>{
  assert.deepEqual(parseAudioRange('30.5','90.25',100),{start:30.5,end:90.25,duration:59.75});
  assert.equal(parseAudioRange(0,'2.346',2.3456).end,2.3456);
});
test('invalid or empty bounds cannot silently become a full recording',()=>{
  for(const [start,end] of [['',2],[0,''],[' ',2],['abc',2],[0,Infinity],[-1,2],[0,-1],[2,1],[1,1],[0,.09],[0,3.1],[3,3]])assert.throws(()=>parseAudioRange(start,end,3));
  assert.throws(()=>parseAudioRange(0,1,NaN));
  assert.throws(()=>audioRangeFrames({start:0,end:1},0,10));
});
test('only the selected window has a twenty-minute limit, longer originals are accepted',()=>{
  assert.equal(parseAudioRange(3600,4800,7200).duration,1200);
  assert.throws(()=>parseAudioRange(0,1200.1,7200),/20 分钟/);
});
test('stereo crop excludes every sample outside the user bounds and leaves source intact',()=>{
  const original=buffer([Float32Array.from([-.9,-.8,.1,.2,.3,.4,.5,.6,.8,.9]),Float32Array.from([.9,.8,-.1,-.2,-.3,-.4,-.5,-.6,-.8,-.9])]);
  const cropped=cropAudioChannels(original,{start:.21,end:.79});
  assert.equal(cropped.range.firstSample,3);assert.equal(cropped.range.lastSample,7);
  assert.deepEqual([...cropped.channels[0]],[...original.getChannelData(0).slice(3,7)]);
  assert.deepEqual([...cropped.channels[1]],[...original.getChannelData(1).slice(3,7)]);
  cropped.channels[0][0]=1;assert.notEqual(original.getChannelData(0)[3],1);
  const view=new DataView(encodeWavRanges(original,[cropped.range],0).buffer);
  assert.equal(view.getUint16(22,true),2);assert.equal(view.getUint32(40,true),16);
  assert.equal(view.getInt16(44,true),Math.trunc(original.getChannelData(0)[3]*32767));
  assert.equal(view.getInt16(46,true),Math.trunc(original.getChannelData(1)[3]*32768));
  assert.equal(view.getInt16(56,true),Math.trunc(original.getChannelData(0)[6]*32767));
});
test('fractional decimal arithmetic never leaks an extra sample at either boundary',()=>{
  const range=audioRangeFrames({start:.1+.2,end:.7},10,10);
  assert.equal(range.firstSample,3);assert.equal(range.lastSample,7);
  const samples=buffer([new Float32Array(10)]);
  assert.equal(encodeWav(samples,.1+.2,.7).length,52);
});
test('chosen window is preserved, internal cuts are shared, and times map to original recording',()=>{
  const range={start:45,end:48,duration:3};
  const result=splitSelectedRange(['Keep going.','Every day.'],chunks,range);
  assert.equal(result.segments[0].start,45);assert.equal(result.segments.at(-1).end,48);
  assert.equal(result.segments[0].end,result.segments[1].start);
  assert.equal(result.segments[0].speechStart,45.2);assert.equal(result.relativeSegments[1].speechEnd,2.6);
  assert.equal(result.segments[1].safeStart,45);assert.equal(result.segments[1].safeEnd,48);
  assert.equal(result.report.passed,true);
});
test('extra speech inside the chosen window must be corrected rather than automatically skipped',()=>{
  assert.throws(()=>splitSelectedRange(['Keep going.','Every day.'],[...chunks,{text:'Goodbye',timestamp:[2.7,2.9]}],{start:5,end:8,duration:3}),error=>error instanceof ConsistencyError&&error.report.differences.some(d=>d.heard==='goodbye'));
  assert.throws(()=>splitSelectedRange(['Keep walking.','Every day.'],chunks,{start:5,end:8,duration:3}),ConsistencyError);
});
test('calibration cannot expand outside the confirmed recording window',()=>{
  const {segments}=splitSelectedRange(['Keep going.','Every day.'],chunks,{start:5,end:8,duration:3});
  assert.throws(()=>adjustSegment(segments,0,4.9,segments[0].end,10),/已确认的音频范围/);
  assert.throws(()=>adjustSegment(segments,1,segments[1].start,8.1,10),/已确认的音频范围/);
});
test('practice WAV and subtitles share one contiguous, cropped timeline starting at zero',()=>{
  const {segments}=splitSelectedRange(['Keep going.','Every day.'],chunks,{start:5,end:8,duration:3});
  const plan=buildPracticeAudioPlan(segments,10);
  assert.equal(plan.ranges.length,1);assert.equal(plan.ranges[0].firstSample,50);assert.equal(plan.ranges[0].lastSample,80);
  assert.equal(plan.duration,3);assert.equal(plan.outputSegments[0].start,0);assert.equal(plan.outputSegments.at(-1).end,3);
  assert.match(toSrt(plan.outputSegments),/00:00:00,000/);
  assert.equal(encodeWavRanges(buffer([new Float32Array(100)]),plan.ranges,plan.gapSeconds).length,104);
});
test('historical disjoint materials can still export without including intervening audio',()=>{
  const plan=buildPracticeAudioPlan([{start:1,end:2,text:'One.'},{start:4,end:5,text:'Two.'}],10);
  assert.equal(plan.ranges.length,2);assert.equal(plan.duration,2.2);assert.equal(plan.outputSegments[1].start,1.2);
});
