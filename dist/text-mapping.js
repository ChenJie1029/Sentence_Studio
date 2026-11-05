import {referenceWords,timestampedWords} from './verification.js';

export function originalTokens(text){
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['’‘][\p{L}\p{N}]+)*/gu)].map(match=>({word:referenceWords(match[0]).join(''),start:match.index,end:match.index+match[0].length}));
}
function matchingAnchors(reference,heard){
  const n=reference.length,m=heard.length;
  if(!m||n*m>24_000_000)return [];
  const width=m+1,trace=new Uint8Array((n+1)*width);let previous=Uint32Array.from({length:width},(_,j)=>j);
  for(let j=1;j<=m;j++)trace[j]=2;
  for(let i=1;i<=n;i++){
    const current=new Uint32Array(width);current[0]=i;trace[i*width]=1;
    for(let j=1;j<=m;j++){
      const diagonal=previous[j-1]+(reference[i-1].word===heard[j-1].word?0:1),deletion=previous[j]+1,insertion=current[j-1]+1;
      if(diagonal<=deletion&&diagonal<=insertion){current[j]=diagonal;trace[i*width+j]=0;}else if(deletion<=insertion){current[j]=deletion;trace[i*width+j]=1;}else{current[j]=insertion;trace[i*width+j]=2;}
    }
    previous=current;
  }
  const anchors=[];let i=n,j=m;
  while(i||j){const op=trace[i*width+j];if(i&&j&&op===0){const word=heard[j-1];if(reference[i-1].word===word.word&&Number.isFinite(word.start)&&Number.isFinite(word.end)&&word.start>=0&&word.end>=word.start)anchors.push({referenceIndex:i-1,...word});i--;j--;}else if(i&&(!j||op===1))i--;else j--;}
  return anchors.reverse();
}
export function textFromBreaks(text,tokens,breaks){
  if(breaks.some((value,index)=>!Number.isInteger(value)||value<1||value>=tokens.length||(index&&value<=breaks[index-1])))throw new Error('每段需保留原文，分界顺序不能重叠。');
  const positions=[0,...breaks.map(index=>tokens[index].start),text.length];
  return positions.slice(0,-1).map((start,index)=>text.slice(start,positions[index+1]).trim());
}
export function mapOriginalText(text,chunks,plan){
  const tokens=originalTokens(text),heard=timestampedWords(chunks),anchors=matchingAnchors(tokens,heard),boundaries=plan.segments.slice(0,-1).map(s=>s.end);
  if(!tokens.length)throw new Error('没有找到英文原文。');
  if(plan.segments.length>tokens.length)throw new Error('音频分段数量多于原文词数，请确认录音范围与原文是否对应。');
  const breaks=[],reviews=[];
  for(let index=0;index<boundaries.length;index++){
    const time=boundaries[index],left=anchors.filter(a=>(a.start+a.end)/2<time).at(-1),right=anchors.find(a=>(a.start+a.end)/2>=time);
    const min=(breaks.at(-1)??0)+1,max=tokens.length-(boundaries.length-index);
    let wordIndex=right?.referenceIndex??Math.round(time/plan.segments.at(-1).end*tokens.length);
    let reliable=anchors.length/tokens.length>=.65&&!!left&&!!right&&right.referenceIndex===left.referenceIndex+1&&left.unit!==right.unit&&left.end<=time+.15&&right.start>=time-.15&&time-left.end<2.5&&right.start-time<2.5;
    if(wordIndex<min||wordIndex>max)reliable=false;
    wordIndex=Math.max(min,Math.min(max,wordIndex));breaks.push(wordIndex);
    reviews.push({time,reliable:reliable&&!plan.segments[index].needsBoundaryReview,wordIndex});
  }
  const texts=textFromBreaks(text,tokens,breaks);
  return {text,tokens,breaks,reviews,texts,matchedWords:anchors.length,referenceCount:tokens.length,heardCount:heard.length,recognizedText:(chunks||[]).map(c=>c.text.trim()).join(' '),needsReview:reviews.some(r=>!r.reliable),manualConfirmed:false};
}
export function applyTextMapping(plan,mapping,range){
  const texts=textFromBreaks(mapping.text,mapping.tokens,mapping.breaks);
  if(texts.length!==plan.segments.length||mapping.needsReview&&!mapping.manualConfirmed)throw new Error('请先试听并确认分段原文。');
  return plan.segments.map((segment,index)=>({...segment,text:texts[index],start:range.start+segment.start,end:range.start+segment.end,safeStart:range.start,safeEnd:range.end,confidence:mapping.manualConfirmed||!mapping.needsReview?1:.5,verified:false,textReviewed:mapping.manualConfirmed||!mapping.needsReview}));
}
