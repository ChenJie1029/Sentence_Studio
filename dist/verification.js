// A reference is admitted only when every spoken token agrees in order.
// Punctuation, casing and layout do not change a spoken word. Words are never repaired.
export function referenceWords(text){
  return (String(text).normalize('NFKC').replace(/[‘’]/g,"'").toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)||[]);
}
export function timestampedWords(chunks){
  return (chunks||[]).flatMap((chunk,unit)=>referenceWords(chunk.text).map(word=>({word,start:chunk.timestamp?.[0],end:chunk.timestamp?.[1],unit})));
}
export class ConsistencyError extends Error{
  constructor(message,report){super(message);this.name='ConsistencyError';this.report=report;}
}
export function verifyContent(sentences,chunks){
  const reference=sentences.flatMap((text,sentenceIndex)=>referenceWords(text).map(word=>({word,sentenceIndex})));
  const heard=timestampedWords(chunks),n=reference.length,m=heard.length;
  if(!n)throw new Error('没有找到可核验的原文，请检查提取结果。');
  if(!m)throw new Error('没有识别到语音。请检查录音后重新识别，不能跳过录音核验。');
  const differences=[];
  if(n!==m||reference.some((token,index)=>token.word!==heard[index]?.word)){
    if(n*m>24_000_000)throw new Error('素材过长，无法逐词核验。请把录音和原文一起分成较短的小段。');
    const width=m+1,trace=new Uint8Array((n+1)*width);
    let previous=Uint32Array.from({length:width},(_,j)=>j);
    for(let j=1;j<=m;j++)trace[j]=2;
    for(let i=1;i<=n;i++){
      const current=new Uint32Array(width);current[0]=i;trace[i*width]=1;
      for(let j=1;j<=m;j++){
        const diagonal=previous[j-1]+(reference[i-1].word===heard[j-1].word?0:1),deletion=previous[j]+1,insertion=current[j-1]+1;
        if(diagonal<=deletion&&diagonal<=insertion){current[j]=diagonal;trace[i*width+j]=0;}
        else if(deletion<=insertion){current[j]=deletion;trace[i*width+j]=1;}
        else{current[j]=insertion;trace[i*width+j]=2;}
      }
      previous=current;
    }
    let i=n,j=m;
    const add=(kind,ri,hi)=>{const expected=reference[ri],actual=heard[hi],near=actual||heard[Math.min(j,m-1)];differences.push({kind,expected:expected?.word||'',heard:actual?.word||'',sentenceIndex:expected?.sentenceIndex??reference[Math.min(i,n-1)]?.sentenceIndex??0,referenceIndex:ri,heardIndex:hi,start:Number.isFinite(near?.start)?near.start:null,end:Number.isFinite(near?.end)?near.end:null});};
    while(i>0||j>0){const op=trace[i*width+j];if(i>0&&j>0&&op===0){if(reference[i-1].word!==heard[j-1].word)add('replace',i-1,j-1);i--;j--;}else if(i>0&&(j===0||op===1)){add('missing',i-1,null);i--;}else{add('extra',null,j-1);j--;}}
    differences.reverse();
  }
  return {passed:differences.length===0,reference,heard,differences,referenceCount:n,heardCount:m,recognizedText:(chunks||[]).map(c=>c.text.trim()).join(' ')};
}
export function strictAlign(sentences,chunks,duration,subtitleSegments=null){
  const report=verifyContent(sentences,chunks);
  if(!report.passed)throw new ConsistencyError(`发现 ${report.differences.length} 处用词或词序差异，尚未导入。请对照原文件和录音逐项校对后重新核验。`,report);
  const {reference,heard}=report;
  let lastUnit=-1,previousEnd=0;
  for(const token of heard){
    if(!Number.isFinite(token.start)||!Number.isFinite(token.end)||token.start<0||token.end<token.start||token.end>duration+.001||(token.unit!==lastUnit&&token.start<previousEnd-.001))throw new ConsistencyError('识别到的单词时间缺失、重叠或超出录音，无法可靠切分。请重新识别。',{...report,passed:false,timingIssue:true});
    if(token.unit!==lastUnit){previousEnd=token.end;lastUnit=token.unit;}
  }
  let cursor=0;
  const groups=sentences.map((text,sentenceIndex)=>{const count=referenceWords(text).length,tokens=heard.slice(cursor,cursor+count);cursor+=count;return {text,tokens,sentenceIndex};});
  if(groups.some(g=>!g.tokens.length))throw new Error('原文中有不含词语的片段，请校对分句后再核验。');
  if(subtitleSegments){
    const conflicts=groups.flatMap((group,index)=>{const s=subtitleSegments[index];return group.tokens[0].start<s.start-.001||group.tokens.at(-1).end>s.end+.001?[{kind:'timing',sentenceIndex:index,expected:group.text,heard:'字幕时间没有完整覆盖对应语音',start:group.tokens[0].start,end:group.tokens.at(-1).end}]:[];});
    if(conflicts.length)throw new ConsistencyError('字幕文字一致，但时间轴与录音不符。请校准字幕时间，或移除时间轴后使用自动切分。',{...report,passed:false,differences:conflicts,timingIssue:true});
    return {segments:subtitleSegments.map((s,index)=>({...s,confidence:1,verified:true,speechStart:groups[index].tokens[0].start,speechEnd:groups[index].tokens.at(-1).end})),confidence:1,report};
  }
  const boundaries=[];
  for(let i=0;i<groups.length-1;i++){
    const left=groups[i].tokens.at(-1),right=groups[i+1].tokens[0];
    if(left.unit===right.unit||left.end>right.start+.001)throw new ConsistencyError('句子分界落在同一个识别单元中，无法可靠切开。请检查原文分句，或改用更准确的识别后重试。',{...report,passed:false,timingIssue:true});
    boundaries.push((left.end+right.start)/2);
  }
  const segments=groups.map((group,i)=>({text:group.text,start:i?boundaries[i-1]:Math.max(0,group.tokens[0].start-.08),end:i===groups.length-1?Math.min(duration,group.tokens.at(-1).end+.1):boundaries[i],confidence:1,verified:true,speechStart:group.tokens[0].start,speechEnd:group.tokens.at(-1).end}));
  if(segments.some(s=>s.end-s.start<.05))throw new Error('识别的句子时间太短，不能安全切分，请重新核验。');
  return {segments,confidence:1,report};
}
