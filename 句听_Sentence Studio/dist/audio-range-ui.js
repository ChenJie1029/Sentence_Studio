import {parseAudioRange,audioRangeFrames} from './audio-range.js';
import {encodeWavRanges,clock} from './core.js';
const $=id=>document.getElementById(id);

export function setupAudioRange({getBuffer,onChange=()=>{},onBusy=()=>{},onError=()=>{}}){
  let file=null,buffer=null,confirmed=null,version=0,previewVersion=0,previewUrl=null;
  const player=$('range-preview-player');
  function stop(){previewVersion++;player.pause();player.removeAttribute('src');player.classList.add('hidden');if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;$('range-preview-status').textContent='';}
  function error(message){$('range-error').textContent=message;$('range-error').classList.toggle('hidden',!message);}
  function draft(){return parseAudioRange($('audio-start').value,$('audio-end').value,buffer?.duration);}
  function updateDraft(){stop();error('');try{const range=draft();$('range-duration').textContent=`本次使用 ${range.duration.toFixed(3)} 秒`; }catch{$('range-duration').textContent='请填写有效的起止时间。';}}
  function renderSummary(){
    $('audio-range-summary').classList.toggle('hidden',!file);$('edit-audio-range').disabled=!buffer;
    $('audio-range-label').textContent=confirmed?`已选 ${confirmed.start.toFixed(3)}–${confirmed.end.toFixed(3)} 秒 · 共 ${confirmed.duration.toFixed(3)} 秒`:buffer?'录音已读取，请设置并确认起止时间。':'正在读取录音时长，随后请设置起止时间…';
    $('edit-audio-range').textContent=confirmed?'调整范围':'设置范围';
  }
  function show(){
    if(!buffer)return;stop();error('');
    $('range-file-name').textContent=file.name;$('range-total').textContent=`录音总长 ${buffer.duration.toFixed(3)} 秒（${clock(buffer.duration,true)}）`;
    $('audio-start').max=$('audio-end').max=String(Math.ceil(buffer.duration*1000)/1000);
    $('audio-start').value=String(confirmed?.start??0);$('audio-end').value=confirmed?String(confirmed.end):buffer.duration.toFixed(3);
    updateDraft();$('audio-range-dialog').showModal();
  }
  function cancel(){stop();$('audio-range-dialog').close();renderSummary();}
  $('audio-start').oninput=updateDraft;$('audio-end').oninput=updateDraft;
  $('edit-audio-range').onclick=show;$('range-cancel').onclick=cancel;$('range-close').onclick=cancel;
  $('audio-range-dialog').addEventListener('cancel',event=>{event.preventDefault();cancel();});
  $('audio-range-dialog').addEventListener('close',stop);
  $('range-preview-button').onclick=async()=>{
    try{
      const range=draft(),current=++previewVersion,activeFile=file;$('range-preview-button').disabled=true;$('range-preview-status').textContent='正在准备所选范围的试听…';
      const decoded=await getBuffer(activeFile);if(current!==previewVersion||file!==activeFile||!$('audio-range-dialog').open)return;
      const frames=audioRangeFrames(range,decoded.sampleRate,decoded.length),blob=new Blob([encodeWavRanges(decoded,[frames],0)],{type:'audio/wav'});
      if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=URL.createObjectURL(blob);player.src=previewUrl;player.classList.remove('hidden');$('range-preview-status').textContent=`仅试听 ${frames.start.toFixed(3)}–${frames.end.toFixed(3)} 秒`;
      await player.play();
    }catch(e){error(e.message||'试听未能开始，请重试。');}
    finally{$('range-preview-button').disabled=false;}
  };
  $('audio-range-form').onsubmit=event=>{
    event.preventDefault();try{const range=audioRangeFrames(draft(),buffer.sampleRate,buffer.length);confirmed=range;stop();$('audio-range-dialog').close();renderSummary();onChange({...range});}catch(e){error(e.message);}
  };
  return {
    get ready(){return !!confirmed;},
    async setFile(nextFile){
      const request=++version;stop();file=nextFile;buffer=null;confirmed=null;renderSummary();onChange(null);onBusy(true);
      try{const decoded=await getBuffer(nextFile);if(request!==version)return;buffer=decoded;renderSummary();if($('import-dialog').open)show();}
      catch(e){if(request===version)onError('录音读取失败，请确认文件可以正常播放，或压缩、分段后重新导入。'+(e.message?' '+e.message:''));}
      finally{if(request===version)onBusy(false);}
    },
    assertReady(){if(!confirmed)throw new Error('请先设置并确认音频的开始和结束时间。');return {...confirmed};},
    reset(){version++;stop();if($('audio-range-dialog').open)$('audio-range-dialog').close();file=null;buffer=null;confirmed=null;renderSummary();onChange(null);onBusy(false);},
    cancel,stop
  };
}
