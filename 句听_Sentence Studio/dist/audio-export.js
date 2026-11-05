export function buildPracticeAudioPlan(segments,sampleRate,gapSeconds=.2){
  if(!segments.length)throw new Error('没有可导出的练习音频。');
  if(!Number.isFinite(sampleRate)||sampleRate<=0||!Number.isFinite(gapSeconds)||gapSeconds<0)throw new Error('合并音频参数无效。');
  const ranges=[];
  for(let i=0;i<segments.length;i++){
    const segment=segments[i],previous=segments[i-1],last=ranges.at(-1);
    if(!Number.isFinite(segment.start)||!Number.isFinite(segment.end)||segment.end<=segment.start||(previous&&segment.start<previous.end-.001))throw new Error('导出切点重叠或顺序不一致，请先检查切点。');
    const adjoining=previous&&(Number.isInteger(previous.recordingWordEnd)&&Number.isInteger(segment.recordingWordStart)?previous.recordingWordEnd+1===segment.recordingWordStart:segment.start<=previous.end+.001);
    if(last&&adjoining){last.end=segment.end;last.segmentIndices.push(i);}else ranges.push({start:segment.start,end:segment.end,segmentIndices:[i]});
  }
  const gapSamples=Math.round(gapSeconds*sampleRate),outputSegments=new Array(segments.length);let cursor=0;
  ranges.forEach((range,index)=>{
    range.firstSample=Math.ceil(range.start*sampleRate-1e-7);range.lastSample=Math.floor(range.end*sampleRate+1e-7);range.start=range.firstSample/sampleRate;range.end=range.lastSample/sampleRate;range.outputStart=cursor/sampleRate;
    for(const segmentIndex of range.segmentIndices){const segment=segments[segmentIndex];outputSegments[segmentIndex]={...segment,start:range.outputStart+(segment.start-range.start),end:range.outputStart+(segment.end-range.start)};}
    cursor+=range.lastSample-range.firstSample;range.outputEnd=cursor/sampleRate;if(index<ranges.length-1)cursor+=gapSamples;
  });
  return {ranges,outputSegments,duration:cursor/sampleRate,gapSeconds:gapSamples/sampleRate};
}
