// Audio determines the boundaries. Recognition is only used to place the supplied text.
export const DEFAULT_SEGMENT_RULES=Object.freeze({minSeconds:8,maxSeconds:15,minPause:.22});
const quantile=(sorted,q)=>sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*q))]||0;

export function findPauses(samples,sampleRate=16000,{minPause=.22}={}){
  if(!samples?.length||!Number.isFinite(sampleRate)||sampleRate<=0)throw new Error('没有可分析的音频。');
  const hop=Math.max(1,Math.round(sampleRate*.01)),window=Math.max(hop,Math.round(sampleRate*.02)),levels=[];
  for(let start=0;start<samples.length;start+=hop){let energy=0;const end=Math.min(samples.length,start+window);for(let i=start;i<end;i++)energy+=samples[i]*samples[i];levels.push(Math.sqrt(energy/(end-start)));}
  const sorted=levels.slice().sort((a,b)=>a-b),voice=quantile(sorted,.85),peak=sorted.at(-1);
  if(peak<.00001)throw new Error('所选范围没有可用的声音，请检查音频起止时间。');
  const threshold=Math.max(.000001,Math.min(voice*.25,Math.max(voice*.075,quantile(sorted,.1)*2)));
  const quiet=levels.map(level=>level<threshold);
  // Ignore an isolated click in an otherwise quiet interval.
  for(let i=1;i<quiet.length-1;i++)if(!quiet[i]&&quiet[i-1]&&quiet[i+1])quiet[i]=true;
  const duration=samples.length/sampleRate,pauses=[];let from=null;
  for(let i=0;i<=quiet.length;i++){
    if(i<quiet.length&&quiet[i]){if(from===null)from=i;continue;}
    if(from!==null){const start=from*hop/sampleRate,end=Math.min(duration,i*hop/sampleRate);if(end-start>=minPause-1e-6&&start>.08&&end<duration-.08)pauses.push({start,end,time:(start+end)/2,duration:end-start,reason:'pause'});from=null;}
  }
  return {pauses,duration,threshold};
}

export function speakerChangesFromTurns(turns,{offset=0,keepStart=0,keepEnd=Infinity,minTurn=.3,minConfidence=.5}={}){
  // Class zero is silence; classes four to six contain overlapping speakers.
  const stable=[];
  for(const turn of turns||[]){
    if(![1,2,3].includes(turn.id)||turn.end-turn.start<minTurn||turn.confidence<minConfidence)continue;
    const last=stable.at(-1);
    if(last&&last.id===turn.id&&turn.start-last.end<.5){last.end=turn.end;last.confidence=Math.min(last.confidence,turn.confidence);}else stable.push({...turn});
  }
  const result=[];
  for(let i=1;i<stable.length;i++){
    const left=stable[i-1],right=stable[i],gap=right.start-left.end;
    if(left.id===right.id||gap<-.02||gap>5)continue;
    const local=(left.end+right.start)/2;
    if(local<keepStart||local>=keepEnd)continue;
    result.push({time:offset+local,confidence:Math.min(left.confidence,right.confidence),reason:'speaker-change'});
  }
  return result;
}

export function planPauseSegments(duration,pauses,speakerChanges=[],rules=DEFAULT_SEGMENT_RULES){
  const {minSeconds=8,maxSeconds=15}=rules;
  if(!Number.isFinite(duration)||duration<=0||minSeconds<=0||maxSeconds<minSeconds)throw new Error('音频分段参数无效。');
  const candidates=pauses.filter(p=>p.time>0&&p.time<duration).map(p=>({...p,reason:'pause',speakerChange:false}));
  for(const change of speakerChanges){
    if(!Number.isFinite(change.time)||change.time<=0||change.time>=duration)continue;
    const near=candidates.filter(p=>Math.abs(p.time-change.time)<=.8).sort((a,b)=>Math.abs(a.time-change.time)-Math.abs(b.time-change.time))[0];
    if(near){near.speakerChange=true;near.speakerConfidence=change.confidence;near.reason='speaker-change';}
    else candidates.push({...change,start:change.time,end:change.time,duration:0,speakerChange:true,needsBoundaryReview:true});
  }
  const ordered=candidates.sort((a,b)=>a.time-b.time).filter((p,i,a)=>!i||p.time-a[i-1].time>.05);
  const nodes=[{time:0,reason:'start'},...ordered,{time:duration,reason:'end'}],cost=new Float64Array(nodes.length).fill(Infinity),parent=new Int32Array(nodes.length).fill(-1);
  cost[0]=0;
  for(let end=1;end<nodes.length;end++)for(let start=0;start<end;start++){
    if(!Number.isFinite(cost[start]))continue;
    const length=nodes[end].time-nodes[start].time,final=end===nodes.length-1;
    if(length<minSeconds-.001&&!final)continue;
    let penalty=length<minSeconds?35+(minSeconds-length)*5:length>maxSeconds?100+(length-maxSeconds)*8:Math.abs(length-(minSeconds+maxSeconds)/2)*.12;
    // Prefer a real change of voice when the length constraint allows it.
    if(!final)penalty+=1-Math.min(nodes[end].duration||0,1)*.8-(nodes[end].speakerChange?2:0);
    const score=cost[start]+penalty;
    if(score<cost[end]){cost[end]=score;parent[end]=start;}
  }
  const indices=[];for(let cursor=nodes.length-1;cursor>0;cursor=parent[cursor]){if(parent[cursor]<0)throw new Error('无法生成完整的音频分段。');indices.push(cursor);}indices.reverse();
  let start=0;
  const segments=indices.map(index=>{const node=nodes[index],end=node.time,length=end-start,result={start,end,boundaryReason:node.reason,speakerChange:!!node.speakerChange,needsBoundaryReview:!!node.needsBoundaryReview,lengthException:length>maxSeconds+.001?'long':length<minSeconds-.001?'short':null};start=end;return result;});
  return {segments,pauses:ordered.filter(p=>!p.needsBoundaryReview),speakerChanges,rules:{minSeconds,maxSeconds},warnings:segments.flatMap((segment,index)=>segment.lengthException==='long'?[`第 ${index+1} 段超过 ${maxSeconds} 秒：没有找到符合时长要求的可靠切点，已保留连续语音。`]:segment.lengthException==='short'?[`第 ${index+1} 段不足 ${minSeconds} 秒：保留结尾的剩余内容。`]:[])};
}
