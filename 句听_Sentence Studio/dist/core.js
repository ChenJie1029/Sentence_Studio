import {strictAlign} from './verification.js';
export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export function clock(seconds, decimals = false) {
  const s = Math.max(0, Number(seconds) || 0);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${Math.floor(s % 60).toString().padStart(2, '0')}${decimals ? '.' + Math.floor((s % 1) * 10) : ''}`;
}
export function words(text) {
  return (text.toLowerCase().normalize('NFKC').replace(/[’‘]/g, "'").match(/[a-z0-9]+(?:'[a-z]+)*/g) || []);
}
export function splitSentences(text) {
  const cleaned = text.replace(/\r/g, '').trim();
  if (typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
    return cleaned.split(/\n+/).flatMap(line => Array.from(segmenter.segment(line), p => p.segment.trim())).filter(Boolean);
  }
  return cleaned.match(/[^.!?\n]+(?:[.!?]+["'”’)]*|$)/g)?.map(t => t.trim()).filter(Boolean) || [];
}
function timestamp(value) {
  const v = value.replace(',', '.').split(':').map(Number);
  return v.length === 3 ? v[0] * 3600 + v[1] * 60 + v[2] : v[0] * 60 + v[1];
}
export function parseSubtitles(text) {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{1,3})/);
    if (!m) continue;
    const content = [];
    while (++i < lines.length && lines[i].trim()) content.push(lines[i].trim());
    const line = content.join(' ').replace(/<[^>]*>/g, '').trim();
    if (line) result.push({ text: line, start: timestamp(m[1]), end: timestamp(m[2]), confidence: 1 });
  }
  if(text.includes('-->')){
    const arrowCount=lines.filter(line=>line.includes('-->')).length;
    if(arrowCount!==result.length)throw new Error('字幕包含无效时间或空白字幕块，不能只导入其中一部分。请校对整份字幕。');
    const blocks=text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim().split(/\n\s*\n/);
    for(const block of blocks){if(block.includes('-->')||/^(WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block.trim()))continue;throw new Error('字幕中有无法识别的文本块，请检查缺失的时间轴或空行；不会忽略这些文字。');}
  }
  return result;
}
export function validateSegments(segments, duration) {
  if (!segments.length) throw new Error('没有找到可练习的句子，请检查英文原文。');
  let previous = 0;
  for (const s of segments) {
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || s.start < 0 || s.end - s.start < .05 || s.end > duration + .001 || s.start < previous - .001) {
      throw new Error('句子时间有重叠、超出音频或长度太短，请检查字幕时间。');
    }
    s.end = Math.min(duration, s.end);
    previous = s.end;
  }
  return segments;
}
export function adjustSegment(segments,index,start,end,duration){
  const changed=segments.map(s=>({...s})),old=segments[index],previous=changed[index-1],next=changed[index+1];
  const lower=previous?previous.start+.1:0,upper=next?next.end-.1:duration;
  if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<.1||start<lower-.005||end>upper+.005)throw new Error('请在可调整范围内输入时间，且片段至少保留 0.1 秒。');
  start=Math.max(lower,start);end=Math.min(upper,end);
  if(previous&&(Math.abs(previous.end-old.start)<.02||start<previous.end))previous.end=start;
  if(next&&(Math.abs(next.start-old.end)<.02||end>next.start))next.start=end;
  Object.assign(changed[index],{start,end,confidence:1});
  if(changed.some(s=>(Number.isFinite(s.safeStart)&&s.start<s.safeStart-.001)||(Number.isFinite(s.safeEnd)&&s.end>s.safeEnd+.001)))throw new Error('切点不能超出已确认的音频范围。');
  if(changed.some(s=>s.verified&&Number.isFinite(s.speechStart)&&Number.isFinite(s.speechEnd)&&(s.start>s.speechStart+.001||s.end<s.speechEnd-.001)))throw new Error('这个切点会截断已核验的单词。请在语音间隙微调，保持当前句和相邻句完整。');
  validateSegments(changed,duration);return changed;
}
export const alignTranscript = strictAlign;
export function compareWords(reference, answer) {
  const a=words(reference),b=words(answer), width=b.length+1;
  const table=new Uint16Array((a.length+1)*width);
  for(let i=1;i<=a.length;i++) for(let j=1;j<=b.length;j++) table[i*width+j]=a[i-1]===b[j-1] ? table[(i-1)*width+j-1]+1 : Math.max(table[(i-1)*width+j],table[i*width+j-1]);
  const correct=table[a.length*width+b.length];
  const matched=new Set(); let i=a.length,j=b.length;
  while(i&&j) { if(a[i-1]===b[j-1]){matched.add(i-1);i--;j--;}else if(table[(i-1)*width+j]>=table[i*width+j-1])i--;else j--; }
  return {score:Math.round(100 * correct / Math.max(a.length,b.length,1)), correct, total:a.length, extra:b.length-correct, tokens:a.map((word,index)=>({word,correct:matched.has(index)}))};
}
export function encodeWav(buffer, start=0, end=buffer.duration) {
  return encodeWavRanges(buffer,[{start,end}],0);
}
export function encodeWavRanges(buffer,ranges,gapSeconds=.2){
  if(!ranges.length)throw new Error('没有可导出的音频范围。');
  const sr=buffer.sampleRate,channels=buffer.numberOfChannels,gapSamples=Math.round(gapSeconds*sr);
  if(!Number.isFinite(gapSamples)||gapSamples<0)throw new Error('音频间隔无效。');
  const spans=ranges.map(range=>({first:range.firstSample??Math.ceil(range.start*sr-1e-7),last:range.lastSample??Math.min(buffer.length,Math.floor(range.end*sr+1e-7))}));
  if(spans.some(span=>!Number.isInteger(span.first)||!Number.isInteger(span.last)||span.first<0||span.last>buffer.length||span.last<=span.first))throw new Error('导出的音频范围无效。');
  const count=spans.reduce((sum,span)=>sum+span.last-span.first,0)+gapSamples*(spans.length-1);
  if(count*channels*2+36>0xffffffff)throw new Error('音频超过 WAV 格式长度限制，请分段导出。');
  const data=new ArrayBuffer(44+count*channels*2), view=new DataView(data);
  const put=(offset,str)=>{for(let i=0;i<str.length;i++)view.setUint8(offset+i,str.charCodeAt(i));};
  put(0,'RIFF');view.setUint32(4,36+count*channels*2,true);put(8,'WAVE');put(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,sr,true);
  view.setUint32(28,sr*channels*2,true);view.setUint16(32,channels*2,true);view.setUint16(34,16,true);put(36,'data');view.setUint32(40,count*channels*2,true);
  const streams=Array.from({length:channels},(_,c)=>buffer.getChannelData(c));
  let pos=44;spans.forEach((span,index)=>{for(let i=span.first;i<span.last;i++)for(let c=0;c<channels;c++){const v=clamp(streams[c][i],-1,1);view.setInt16(pos,v<0?v*32768:v*32767,true);pos+=2;}if(index<spans.length-1)pos+=gapSamples*channels*2;});
  return new Uint8Array(data);
}
const crcTable = Uint32Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1 ? 0xedb88320^(c>>>1) : c>>>1;return c>>>0;});
function crc32(data){let c=0xffffffff;for(const b of data)c=crcTable[(c^b)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
export function zipStore(files){
  const enc=new TextEncoder(),locals=[],central=[];let offset=0;
  for(const file of files){const name=enc.encode(file.name),data=typeof file.data==='string'?enc.encode(file.data):file.data,crc=crc32(data);
    const local=new Uint8Array(30+name.length),v=new DataView(local.buffer);v.setUint32(0,0x04034b50,true);v.setUint16(4,20,true);v.setUint16(6,0x0800,true);v.setUint32(14,crc,true);v.setUint32(18,data.length,true);v.setUint32(22,data.length,true);v.setUint16(26,name.length,true);local.set(name,30);locals.push(local,data);
    const head=new Uint8Array(46+name.length),h=new DataView(head.buffer);h.setUint32(0,0x02014b50,true);h.setUint16(4,20,true);h.setUint16(6,20,true);h.setUint16(8,0x0800,true);h.setUint32(16,crc,true);h.setUint32(20,data.length,true);h.setUint32(24,data.length,true);h.setUint16(28,name.length,true);h.setUint32(42,offset,true);head.set(name,46);central.push(head);offset+=local.length+data.length;
  }
  const size=central.reduce((s,c)=>s+c.length,0),tail=new Uint8Array(22),t=new DataView(tail.buffer);t.setUint32(0,0x06054b50,true);t.setUint16(8,files.length,true);t.setUint16(10,files.length,true);t.setUint32(12,size,true);t.setUint32(16,offset,true);
  return new Blob([...locals,...central,tail],{type:'application/zip'});
}
export function toSrt(segments){const time=n=>{const ms=Math.round(n*1000);return `${Math.floor(ms/3600000).toString().padStart(2,'0')}:${Math.floor(ms/60000)%60}`.replace(/:(\d)$/,':0$1')+`:${(Math.floor(ms/1000)%60).toString().padStart(2,'0')},${(ms%1000).toString().padStart(3,'0')}`;};return segments.map((s,i)=>`${i+1}\n${time(s.start)} --> ${time(s.end)}\n${s.text}\n`).join('\n');}
