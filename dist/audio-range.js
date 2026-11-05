import {strictAlign} from './verification.js';

export function parseAudioRange(startValue,endValue,duration){
  if(String(startValue).trim()===''||String(endValue).trim()==='')throw new Error('请填写开始和结束时间，单位为秒。');
  const start=Number(startValue),end=Number(endValue);
  if(!Number.isFinite(duration)||duration<=0)throw new Error('尚未读取到有效的音频时长，请重新选择录音。');
  if(!Number.isFinite(start)||!Number.isFinite(end))throw new Error('开始和结束时间需要是有效的秒数。');
  if(start<0||end<0)throw new Error('时间不能为负数。');
  if(end>duration+.001001||start>=duration)throw new Error(`时间不能超出音频总长 ${duration.toFixed(3)} 秒。`);
  const safeEnd=Math.min(end,duration);
  if(safeEnd-start<.1-1e-9)throw new Error('结束时间必须晚于开始时间，且至少保留 0.1 秒。');
  if(safeEnd-start>1200+.000001)throw new Error('所选范围最长 20 分钟，请缩短结束时间或调整开始时间。');
  return {start,end:safeEnd,duration:safeEnd-start};
}
export function audioRangeFrames(range,sampleRate,length){
  if(!Number.isFinite(sampleRate)||sampleRate<=0||!Number.isInteger(length)||length<=0)throw new Error('音频采样信息无效，请重新导入。');
  const selected=parseAudioRange(range.start,range.end,length/sampleRate);
  const firstSample=Math.max(0,Math.ceil(selected.start*sampleRate-1e-7));
  const lastSample=Math.min(length,Math.floor(selected.end*sampleRate+1e-7));
  if(lastSample<=firstSample)throw new Error('所选音频范围太短，请重新设置。');
  return {requestedStart:selected.start,requestedEnd:selected.end,firstSample,lastSample,start:firstSample/sampleRate,end:lastSample/sampleRate,duration:(lastSample-firstSample)/sampleRate};
}
export function cropAudioChannels(buffer,range){
  const frames=audioRangeFrames(range,buffer.sampleRate,buffer.length);
  const channels=Array.from({length:buffer.numberOfChannels},(_,channel)=>buffer.getChannelData(channel).slice(frames.firstSample,frames.lastSample));
  return {range:frames,channels,sampleRate:buffer.sampleRate,length:frames.lastSample-frames.firstSample,duration:frames.duration};
}
export function splitSelectedRange(sentences,chunks,range){
  const {segments:aligned,report}=strictAlign(sentences,chunks,range.duration);
  const relativeSegments=aligned.map((segment,index)=>({...segment,start:index===0?0:segment.start,end:index===aligned.length-1?range.duration:segment.end}));
  const segments=relativeSegments.map((segment,referenceIndex)=>({...segment,referenceIndex,start:range.start+segment.start,end:range.start+segment.end,speechStart:range.start+segment.speechStart,speechEnd:range.start+segment.speechEnd,safeStart:range.start,safeEnd:range.end}));
  return {segments,relativeSegments,report};
}
