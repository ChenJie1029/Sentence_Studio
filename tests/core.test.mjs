import test from 'node:test';
import assert from 'node:assert/strict';
import {alignTranscript,parseSubtitles,validateSegments,adjustSegment,compareWords,encodeWav,zipStore,toSrt,splitSentences} from '../dist/core.js';
test('alignment uses complete matching word timestamps and keeps supplied wording',()=>{
  const sentences=['A small step makes a difference.','Keep going every day.'];
  const chunks=['a','small','step','makes','a','difference','keep','going','every','day'].map((text,i)=>({text,timestamp:[i,i+.6]}));
  const result=alignTranscript(sentences,chunks,10);
  assert.equal(result.segments.length,2);assert.equal(result.segments[0].text,sentences[0]);
  assert.equal(result.segments[0].end,result.segments[1].start);assert.ok(result.segments[0].end<6);
  assert.equal(result.confidence,1);assert.equal(result.segments[0].verified,true);
});
test('unrelated transcript fails explicitly rather than inventing timestamps',()=>{
  assert.throws(()=>alignTranscript(['The weather is wonderful.'],[{text:'another unrelated recording about football',timestamp:[0,4]}],4),/差异/);
});
test('SRT and VTT preserve timestamps, combine cue lines, and reject overlap',()=>{
  const srt='1\n00:00:00,500 --> 00:00:02,000\nHello there.\n\n2\n00:00:02,100 --> 00:00:04,500\nKeep going\nevery day.\n';
  const segments=parseSubtitles(srt);assert.equal(segments.length,2);assert.equal(segments[1].text,'Keep going every day.');assert.equal(segments[0].start,.5);validateSegments(segments,5);
  assert.equal(parseSubtitles('WEBVTT\n\n00:00.000 --> 00:02.100\nHello.\n')[0].end,2.1);
  assert.throws(()=>validateSegments([{start:0,end:2},{start:1,end:3}],4),/重叠/);
  assert.throws(()=>validateSegments([{start:0,end:10}],4),/超出/);
  assert.match(toSrt([{start:65.125,end:3665.5,text:'Test.'}]),/00:01:05,125 --> 01:01:05,500/);
});
test('word comparison respects order, ignores case and punctuation, and counts extra words',()=>{
  assert.equal(compareWords('Hello, WORLD!','hello world').score,100);
  const reverse=compareWords('one two three','three two one');assert.equal(reverse.correct,1);
  const extra=compareWords('small steps','small extra steps');assert.equal(extra.extra,1);assert.equal(extra.score,67);
  assert.equal(compareWords('I’m ready.',"I'm ready").score,100);
});
test('malformed or partially readable subtitles cannot silently omit a cue',()=>{
  assert.throws(()=>parseSubtitles('1\n00:00:00,000 --> 00:00:01,000\nHello.\n\n2\nnot-a-time --> 00:00:02,000\nKeep going.'),/不能只导入/);
  assert.throws(()=>parseSubtitles('1\n00:00:00,000 --> 00:00:01,000\nHello.\n\n2\nA cue without a time.'),/不会忽略/);
  assert.throws(()=>validateSegments([{start:0,end:2.02,text:'Hello.'}],2),/超出/);
});
test('calibration can move shared boundaries in both directions without overlaps',()=>{
  const initial=[{start:0,end:2,text:'One.'},{start:2,end:4,text:'Two.'},{start:4,end:6,text:'Three.'}];
  const moved=adjustSegment(initial,1,1.5,4.5,6);assert.equal(moved[0].end,1.5);assert.equal(moved[2].start,4.5);assert.equal(initial[0].end,2);
  const shrunk=adjustSegment(moved,1,2.2,3.8,6);assert.equal(shrunk[0].end,2.2);assert.equal(shrunk[2].start,3.8);
  assert.throws(()=>adjustSegment(initial,1,0,6,6),/范围/);
});
test('WAV export physically contains only the selected audio samples',()=>{
  const samples=Float32Array.from([0,.1,.2,.3,.4,.5,.6,.7,.8,.9]);
  const buffer={sampleRate:10,length:10,duration:1,numberOfChannels:1,getChannelData:()=>samples};
  const wav=encodeWav(buffer,.2,.5),view=new DataView(wav.buffer);assert.equal(wav.length,50);assert.equal(view.getUint32(40,true),6);assert.equal(view.getUint32(24,true),10);assert.equal(view.getInt16(44,true),Math.trunc(.2*32767));
});
test('calibration cannot cut verified spoken words in the current or adjacent sentence',()=>{
  const segments=[{start:0,end:2,speechStart:0,speechEnd:1.8,verified:true},{start:2,end:4,speechStart:2.2,speechEnd:3.8,verified:true}];
  assert.throws(()=>adjustSegment(segments,1,1.5,4,4),/截断/);
  assert.throws(()=>adjustSegment(segments,1,2.5,4,4),/截断/);
  assert.equal(adjustSegment(segments,1,1.9,4,4)[0].end,1.9);
});
test('ZIP has valid file and central directory signatures and UTF8 filename flag',async()=>{
  const blob=zipStore([{name:'第一句.txt',data:'Small steps.'},{name:'001.wav',data:new Uint8Array([1,2,3])}]);
  const v=new DataView(await blob.arrayBuffer());assert.equal(v.getUint32(0,true),0x04034b50);assert.equal(v.getUint16(6,true),0x0800);assert.equal(v.getUint32(v.byteLength-22,true),0x06054b50);assert.equal(v.getUint16(v.byteLength-14,true),2);
});
test('sentence splitter handles punctuation and explicit newlines',()=>{
  assert.deepEqual(splitSentences('Listen carefully. Keep going!\nOne more time.'),['Listen carefully.','Keep going!','One more time.']);
});
