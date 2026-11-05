import {textFromBreaks} from './text-mapping.js';
import {encodeWav,clock} from './core.js';
const $=id=>document.getElementById(id);

export function setupSegmentReview(){
  let pending=null,url=null,resolve=null;
  const player=$('segment-review-player');
  function stop(){player.pause();player.removeAttribute('src');player.classList.add('hidden');if(url)URL.revokeObjectURL(url);url=null;}
  function finish(value){stop();$('segment-review-dialog').close();const done=resolve;resolve=null;pending=null;done?.(value);}
  function render(){
    const {mapping,result,range,buffer}=pending,texts=textFromBreaks(mapping.text,mapping.tokens,mapping.breaks),container=$('segment-review-rows');container.replaceChildren();
    result.plan.segments.forEach((segment,index)=>{
      const row=document.createElement('section');row.className='segment-review-row';
      const head=document.createElement('div');head.className='segment-review-head';const caption=document.createElement('strong');caption.textContent=`第 ${index+1} 段 · ${(segment.end-segment.start).toFixed(1)} 秒`;
      const button=document.createElement('button');button.type='button';button.className='text-button';button.textContent='试听本段';button.onclick=async()=>{stop();url=URL.createObjectURL(new Blob([encodeWav(buffer,range.start+segment.start,range.start+segment.end)],{type:'audio/wav'}));player.src=url;player.classList.remove('hidden');$('segment-review-now').textContent=`正在试听第 ${index+1} 段 · 原录音 ${clock(range.start+segment.start,true)}–${clock(range.start+segment.end,true)}`;try{await player.play();}catch{$('segment-review-now').textContent='点击上方播放器开始试听。';}};head.append(caption,button);row.append(head);
      const text=document.createElement('p');text.lang='en';text.className='segment-review-text';text.textContent=texts[index];row.append(text);
      if(index<texts.length-1){
        const boundary=document.createElement('div');boundary.className='text-boundary-controls';
        const label=document.createElement('span');label.textContent=`与下一段的原文分界${mapping.reviews[index]?.reliable?'':' · 请试听核对'}`;boundary.append(label);
        for(const [delta,title] of [[-1,'本段少一个词'],[1,'本段多一个词']]){const move=document.createElement('button');move.type='button';move.textContent=title;const next=mapping.breaks[index]+delta;move.disabled=next<=(mapping.breaks[index-1]??0)||next>=(mapping.breaks[index+1]??mapping.tokens.length);move.onclick=()=>{mapping.breaks[index]=next;$('segment-review-approved').checked=false;render();};boundary.append(move);}row.append(boundary);
      }
      container.append(row);
    });
  }
  $('segment-review-back').onclick=()=>finish(null);$('segment-review-close').onclick=()=>finish(null);
  $('segment-review-dialog').addEventListener('cancel',event=>{event.preventDefault();finish(null);});
  $('segment-review-confirm').onclick=()=>{if(!$('segment-review-approved').checked){$('segment-review-error').textContent='请先试听核对，并勾选确认。';$('segment-review-error').classList.remove('hidden');return;}const mapping=pending.mapping;mapping.manualConfirmed=true;finish(mapping);};
  return {
    show(result,mapping,buffer,range){if(resolve)finish(null);pending={result,mapping,buffer,range};$('segment-review-approved').checked=false;$('segment-review-error').classList.add('hidden');$('segment-review-now').textContent='';$('segment-review-summary').textContent=`音频已按停顿与声音变化切成 ${result.plan.segments.length} 段。部分原文分界无法可靠自动确定，请试听后确认；原文用词保持不变。`;$('segment-review-original').textContent=mapping.text;render();$('segment-review-dialog').showModal();return new Promise(done=>{resolve=done;});},
    cancel:()=>finish(null),stop
  };
}
