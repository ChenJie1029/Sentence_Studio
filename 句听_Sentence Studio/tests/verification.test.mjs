import test from 'node:test';
import assert from 'node:assert/strict';
import {referenceWords,verifyContent,strictAlign,ConsistencyError} from '../dist/verification.js';
import {fileKind,validateSourceFiles,pdfTextLines,sourceDocumentText,verifyReviewedPages,extractSources} from '../dist/source-reader.js';
const chunks=text=>text.split(' ').map((text,index)=>({text,timestamp:[index,index+.6]}));
test('only casing, punctuation and whitespace are ignored; original wording survives',()=>{
  const text='“Keep GOING!”';const result=strictAlign([text],chunks('keep going'),2);assert.equal(result.segments[0].text,text);assert.equal(result.report.passed,true);
  assert.deepEqual(referenceWords('I’m ready.'),["i'm",'ready']);
  assert.deepEqual(referenceWords('Keep going 中文'),['keep','going','中文']);
});
for(const [label,reference,heard] of [['missing','Every small step matters.','every step matters'],['extra','Every step matters.','every small step matters'],['similar spelling','Small steps matter.','smell steps matter'],['reordered','Keep going every day.','every day keep going'],['repeated words','Go go now.','go now'],['dropped nonEnglish','Keep going 中文','keep going']]){
  test(`strict import blocks ${label} instead of guessing or rewriting`,()=>{
    assert.throws(()=>strictAlign([reference],chunks(heard),10),error=>error instanceof ConsistencyError&&error.report.passed===false&&error.report.differences.length>0);
  });
}
test('report covers missing, extra and changed words in their original order',()=>{
  const report=verifyContent(['A small step.'],chunks('a big step today'));
  assert.equal(report.referenceCount,3);assert.equal(report.heardCount,4);assert.equal(report.differences[0].expected,'small');assert.equal(report.differences[0].heard,'big');assert.equal(report.differences.at(-1).heard,'today');
});
test('missing, overlapping or out-of-recording word times block import',()=>{
  assert.throws(()=>strictAlign(['Keep going.'],[{text:'keep',timestamp:[0,null]},{text:'going',timestamp:[1,2]}],2),/时间/);
  assert.throws(()=>strictAlign(['Keep going.'],[{text:'keep',timestamp:[0,1.5]},{text:'going',timestamp:[1,2]}],2),/重叠/);
  assert.throws(()=>strictAlign(['Keep going.'],[{text:'keep',timestamp:[0,1]},{text:'going',timestamp:[1,3]}],2),/超出/);
});
test('a recognition unit spanning two sentences is never divided by interpolation',()=>{
  assert.throws(()=>strictAlign(['Keep.','Going.'],[{text:'keep going',timestamp:[0,2]}],2),/同一个识别单元/);
});
test('subtitle text and time are verified against the recording rather than bypassing recognition',()=>{
  const subtitles=[{text:'Keep going.',start:0,end:2},{text:'Every day.',start:2,end:4}];
  const result=strictAlign(subtitles.map(s=>s.text),chunks('keep going every day'),4,subtitles);
  assert.deepEqual(result.segments.map(s=>[s.start,s.end]),[[0,2],[2,4]]);
  assert.throws(()=>strictAlign(subtitles.map(s=>s.text),chunks('keep going every week'),4,subtitles),ConsistencyError);
  assert.throws(()=>strictAlign(subtitles.map(s=>s.text),chunks('keep going every day'),4,[{...subtitles[0],end:1},{...subtitles[1],start:1}]),/时间轴/);
});
test('supported source types and file bounds are explicit, never a partial import',()=>{
  assert.equal(fileKind({name:'SCAN.PDF'}),'pdf');assert.equal(fileKind({name:'page.JPEG'}),'image');assert.equal(fileKind({name:'original.srt'}),'text');
  assert.throws(()=>fileKind({name:'original.docx'}),/不支持/);
  assert.throws(()=>validateSourceFiles([{name:'large.png',size:26*1024*1024}]),/超过/);
  assert.throws(()=>validateSourceFiles([{name:'a.srt',size:20},{name:'b.txt',size:20}]),/单独导入/);
  assert.throws(()=>validateSourceFiles(Array.from({length:13},(_,i)=>({name:`${i}.jpg`,size:1}))),/12/);
});
test('PDF line positioning and image page ordering preserve words without guessing',()=>{
  const items=[{str:'Every',transform:[1,0,0,1,10,100],width:30,height:10},{str:'step.',transform:[1,0,0,1,45,100],width:20,height:10,hasEOL:true},{str:'Keep going.',transform:[1,0,0,1,10,80],width:55,height:10}];
  assert.equal(pdfTextLines(items),'Every step.\nKeep going.');
  assert.equal(sourceDocumentText([{text:'Every\nstep.',method:'ocr'},{text:'Keep going.',method:'pdf-text'}]),'Every step. Keep going.');
});
test('invalid text encoding and canceled extraction are rejected instead of altering original text',async()=>{
  const valid=new File(['Every small step matters.'],'original.txt',{type:'text/plain'}),pages=await extractSources([valid]);assert.equal(pages[0].text,'Every small step matters.');assert.equal(pages[0].originalText,pages[0].text);
  await assert.rejects(extractSources([new File([new Uint8Array([255,254,13])],'bad.txt')]),/UTF-8/);
  const abort=new AbortController();abort.abort();await assert.rejects(extractSources([valid],{signal:abort.signal}),{name:'AbortError'});
});
test('final text cannot bypass the reviewed source pages or silently change their order',()=>{
  const pages=[{text:'A small step.',originalText:'A small step.',method:'ocr',included:true,reviewed:true},{text:'Keep going.',method:'pdf-text',included:true,reviewed:true}];
  assert.doesNotThrow(()=>verifyReviewedPages('A SMALL step! Keep going.',pages));
  assert.throws(()=>verifyReviewedPages('A large step. Keep going.',pages),/已校对页面/);
  assert.throws(()=>verifyReviewedPages('Keep going. A small step.',pages),/顺序/);
  pages[0].text='A large step.';pages[0].reviewed=false;
  assert.throws(()=>verifyReviewedPages('A large step. Keep going.',pages),/尚未完成校对/);
  pages[0].reviewed=true;assert.doesNotThrow(()=>verifyReviewedPages('A large step. Keep going.',pages));assert.equal(pages[0].originalText,'A small step.');
});
