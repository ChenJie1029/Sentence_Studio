import {clamp,clock,words,parseSubtitles,validateSegments,adjustSegment,compareWords,encodeWav,encodeWavRanges,zipStore,toSrt} from './core.js';
import {setupSourceImporter} from './source-import-ui.js';
import {cropAudioChannels} from './audio-range.js';
import {mapOriginalText,applyTextMapping} from './text-mapping.js';
import {setupSegmentReview} from './segment-review-ui.js';
import {setupAudioRange} from './audio-range-ui.js';
import {buildPracticeAudioPlan} from './audio-export.js';
const $=id=>document.getElementById(id), $$=selector=>Array.from(document.querySelectorAll(selector));
const icon=id=>`<svg aria-hidden="true"><use href="#i-${id}"/></svg>`;
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state={materials:[],material:null,buffer:null,index:0,revealed:false,playing:false,waiting:false,lap:1,speed:1,repeat:3,gap:1,autoNext:false,objectUrl:null,db:null,worker:null,processing:false};
const audio=new Audio();audio.preservesPitch=true;audio.preload='auto';
let repeatTimer,saveTimer,toastTimer,frame,context,importAudio=null,previewAudio=null,calibrationPreview=false,saveSequence=Promise.resolve();
let recognitionCache=null,proofUrls=[];let importBufferCache=null,sourceBusy=false,audioBusy=false,audioRangeConfirmed=false;
function toast(message){$('toast').textContent=message;$('toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.add('hidden'),4000);}
function notice(message){$('storage-warning').textContent=message;$('storage-warning').classList.remove('hidden');}
function showDialog(id){if(!$(id).open)$(id).showModal();}
function closeDialog(dialog){if(dialog.id==='segment-review-dialog'){reviewUi.cancel();return;}if(dialog.id==='audio-range-dialog'){rangeUi.cancel();return;}dialog.close();if(dialog.id==='calibrate-dialog'){previewAudio?.pause();previewAudio=null;}if(dialog.id==='import-dialog'){sourceUi.stop();rangeUi.stop();}}
$$('[data-close]').forEach(button=>button.addEventListener('click',()=>closeDialog(button.closest('dialog'))));
$$('dialog').forEach(dialog=>dialog.addEventListener('click',e=>{if(e.target===dialog&&dialog.id!=='processing-dialog'){const rect=dialog.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)closeDialog(dialog);}}));
function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open('sentence-studio',1);request.onupgradeneeded=()=>request.result.createObjectStore('materials',{keyPath:'id'});request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);});}
function dbRequest(mode,operation){return new Promise((resolve,reject)=>{if(!state.db){reject(new Error('本机存储不可用'));return;}const transaction=state.db.transaction('materials',mode);const request=operation(transaction.objectStore('materials'));let value;request.onsuccess=()=>value=request.result;transaction.oncomplete=()=>resolve(value);transaction.onerror=()=>reject(transaction.error||request.error);transaction.onabort=()=>reject(transaction.error||request.error);});}
async function persist(material=state.material){
  if(!material)return;
  material.updatedAt=Date.now();
  // Queue writes so switching sentences quickly cannot overwrite a later answer.
  const snapshot=structuredClone(material);
  saveSequence=saveSequence.catch(()=>{}).then(()=>dbRequest('readwrite',store=>store.put(snapshot))).then(()=>{
    $('save-status').innerHTML=icon('check')+'本机保存';$('answer-save').textContent='已自动保存';
  }).catch(()=>{notice('浏览器未能保存这次修改。当前练习仍可使用，请及时导出听写记录。');$('save-status').textContent='尚未保存';});
  return saveSequence;
}
function scheduleSave(){clearTimeout(saveTimer);$('answer-save').textContent='正在保存…';saveTimer=setTimeout(()=>{persist();},350);}
async function decodeAudio(blob){context??=new(window.AudioContext||window.webkitAudioContext)();return context.decodeAudioData(await blob.arrayBuffer());}
function sentence(){return state.material?.segments[state.index];}
function refreshLibrary(){
  $('material-list').replaceChildren();
  for(const m of state.materials){const button=document.createElement('button');button.className='material-item'+(m.id===state.material?.id?' current':'');button.innerHTML=icon('file')+'<span>'+escape(m.title)+'</span>';button.title=m.title;button.onclick=()=>selectMaterial(m);$('material-list').append(button);}
}
function refreshQueue(){
  if(!state.material)return;
  const segments=state.material.segments,done=segments.filter(s=>s.done).length;
  $('queue-count').textContent=segments.length+' 句';$('progress-label').textContent=`${done} / ${segments.length}`;$('progress-bar').style.width=(done/segments.length*100)+'%';
  $('sentence-list').replaceChildren();
  segments.forEach((s,i)=>{const button=document.createElement('button');button.className=`sentence-item${i===state.index?' current':''}${s.done?' done':''}${i===state.index&&state.playing?' playing':''}`;button.setAttribute('aria-current',i===state.index?'true':'false');button.setAttribute('aria-label',`第 ${i+1} 句，${(s.end-s.start).toFixed(1)} 秒，${s.done?'已完成':'待练习'}`);
    const status=i===state.index?'<i></i><i></i><i></i>':s.done?'已完成':s.lengthException==='long'?'较长片段':s.lengthException==='short'?'尾段':s.confidence<.6?'待校准':'待练习';
    button.innerHTML=`<span class="queue-index">${s.done?icon('check'):String(i+1).padStart(2,'0')}</span><span class="queue-text"><strong>第 ${String(i+1).padStart(2,'0')} 句</strong><small>${(s.end-s.start).toFixed(1)} 秒 · ${words(s.text).length} words</small></span><span class="queue-status">${status}</span>`;
    button.onclick=()=>loadSentence(i);$('sentence-list').append(button);
  });
}
let materialLoadToken=0;
async function selectMaterial(material,preparedBuffer=null){
  const token=++materialLoadToken;
  pause();clearTimeout(saveTimer);
  await persist();
  try{
    const buffer=preparedBuffer||await decodeAudio(material.audio);
    if(token!==materialLoadToken)return;
    state.material=material;state.buffer=buffer;state.index=clamp(material.lastIndex||0,0,material.segments.length-1);
    $('material-title').textContent=material.title;$('material-tag').textContent=material.demo?'内置示例 · 合成语音':material.verification?.policy==='pause-speaker-v5'?'按停顿切分 · 8–15 秒优先':material.verification?.policy==='manual-range-v4'?'已设置音频范围 · 已逐句对齐':material.verification?.policy==='reference-extraction-v3'?'历史定位素材':material.verification?.policy==='strict-v2'?'已逐词核验 · 原文已校对':'旧版素材 · 尚未严格核验';
    const warnings=material.verification?.warnings||[];$('segmentation-note').textContent=warnings.join(' ');$('segmentation-note').classList.toggle('hidden',!warnings.length);
    $('material-meta').textContent=`${clock(material.audioRange?.duration??buffer.duration)} · ${material.segments.length} 个句子`;
    $('sentence-total').textContent=String(material.segments.length).padStart(2,'0');refreshLibrary();loadSentence(state.index);
  }catch(error){toast('音频读取失败：'+error.message);}
}
function loadSentence(index,autoplay=false){
  if(!state.material||!state.buffer)return;
  pause();previewAudio?.pause();clearTimeout(saveTimer);
  state.index=clamp(index,0,state.material.segments.length-1);state.lap=1;state.waiting=false;state.revealed=false;state.material.lastIndex=state.index;
  $('sentence-number').textContent=String(state.index+1).padStart(2,'0');$('answer').value=sentence().answer||'';$('word-count').textContent=words($('answer').value).length+' words';
  $('comparison').classList.add('hidden');$('previous-button').disabled=state.index===0;$('next-button').disabled=state.index===state.material.segments.length-1;
  $('complete-button').innerHTML=sentence().done?'已完成 '+icon('check'):'完成本句'+icon('check');
  updateTranscript();prepareAudio();refreshQueue();refreshPlayer();persist();
  if(autoplay)start();
}
function prepareAudio(){
  audio.pause();if(state.objectUrl)URL.revokeObjectURL(state.objectUrl);
  const s=sentence();state.objectUrl=URL.createObjectURL(new Blob([encodeWav(state.buffer,s.start,s.end)],{type:'audio/wav'}));
  audio.src=state.objectUrl;audio.playbackRate=state.speed;audio.preservesPitch=true;audio.load();
  $('duration').textContent=clock(s.end-s.start,true);$('elapsed').textContent='00:00';$('seek').value='0';
  $('segment-range').textContent=`原音频 ${clock(s.start,true)} – ${clock(s.end,true)}`;
  $('playing-label').textContent='准备好就开始';drawWave();
}
function updateTranscript(){
  const s=sentence();$('transcript').textContent=state.revealed?s?.text||'':'';
  $('transcript').classList.toggle('hidden',!state.revealed);$('hidden-transcript').classList.toggle('hidden',state.revealed);
  $('reveal-button').innerHTML=icon(state.revealed?'eyeoff':'eye')+`<span>${state.revealed?'隐藏原文':'显示原文'}</span><kbd>T</kbd>`;
  $('reveal-button').setAttribute('aria-expanded',String(state.revealed));
}
function reveal(force){if(!sentence())return;state.revealed=typeof force==='boolean'?force:!state.revealed;updateTranscript();}
function refreshPlayer(){
  $('play-button').innerHTML=icon(state.playing?'pause':'play');$('play-button').setAttribute('aria-label',state.playing?'暂停':'播放');
  $('loop-dots').innerHTML=Array.from({length:state.repeat},(_,i)=>`<i class="${i<state.lap?'on':''}"></i>`).join('');
  $('loop-status').textContent=state.repeat===1?'单次播放':`第 ${state.lap} / ${state.repeat} 遍`;
  document.querySelector('.sentence-item.current')?.classList.toggle('playing',state.playing&&!state.waiting);
}
function pause(){
  audio.pause();state.playing=false;clearTimeout(repeatTimer);cancelAnimationFrame(frame);refreshPlayer();
  if(sentence())$('playing-label').textContent=state.waiting?'已暂停 · 等待重播':'已暂停';
}
async function start(restart=false){
  if(!sentence())return;
  clearTimeout(repeatTimer);
  if(restart){state.lap=1;state.waiting=false;audio.currentTime=0;}
  if(state.waiting){state.waiting=false;state.lap=Math.min(state.lap+1,state.repeat);audio.currentTime=0;}
  if(audio.ended || audio.currentTime >= (sentence().end-sentence().start)-.01){audio.currentTime=0;state.lap=1;}
  state.playing=true;audio.playbackRate=state.speed;audio.preservesPitch=true;refreshPlayer();
  $('playing-label').textContent='正在播放';
  try{await audio.play();if(state.playing)animate();}catch(error){state.playing=false;refreshPlayer();$('playing-label').textContent='点击重试';toast('播放未能开始，请再点击一次播放。');}
}
audio.addEventListener('ended',()=>{
  cancelAnimationFrame(frame);drawWave();if(!state.playing)return;
  if(state.lap<state.repeat){
    state.waiting=true;$('playing-label').textContent=state.gap?`${state.gap} 秒后重播`:'即将重播';refreshPlayer();
    repeatTimer=setTimeout(()=>{if(!state.playing)return;state.waiting=false;state.lap++;audio.currentTime=0;start();},state.gap*1000);
  }else{
    state.playing=false;refreshPlayer();$('playing-label').textContent=state.repeat===1?'本句播放完成 · 可以核对了':'循环完成 · 可以核对了';
    if(state.autoNext&&state.index<state.material.segments.length-1)loadSentence(state.index+1,true);
    else toast(state.repeat===1?'本句已播放一次':`已完成本句 ${state.repeat} 遍循环`);
  }
});
audio.addEventListener('error',()=>{if(state.material&&audio.error){pause();toast('音频播放出现问题，请重新选择本句。');}});
function animate(){if(!state.playing||state.waiting)return;const duration=sentence().end-sentence().start;$('elapsed').textContent=clock(audio.currentTime,true);$('seek').value=String(clamp(audio.currentTime/duration*1000,0,1000));drawWave();frame=requestAnimationFrame(animate);}
function drawWave(){
  const canvas=$('waveform'),rect=canvas.getBoundingClientRect();if(!rect.width)return;
  const ratio=window.devicePixelRatio||1,width=rect.width,height=rect.height;canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
  const ctx=canvas.getContext('2d');ctx.scale(ratio,ratio);ctx.clearRect(0,0,width,height);
  if(!state.buffer||!sentence())return;
  const s=sentence(),samples=state.buffer.getChannelData(0),sr=state.buffer.sampleRate,start=Math.floor(s.start*sr),length=Math.floor((s.end-s.start)*sr);
  const bars=Math.max(20,Math.floor(width/5)),progress=audio.currentTime/Math.max(.1,s.end-s.start);
  ctx.strokeStyle='#f1f4eb';ctx.beginPath();ctx.moveTo(0,height/2);ctx.lineTo(width,height/2);ctx.stroke();
  for(let i=0;i<bars;i++){
    let sum=0,count=0;const from=start+Math.floor(length*i/bars),to=Math.min(samples.length,start+Math.floor(length*(i+1)/bars));
    const step=Math.max(1,Math.floor((to-from)/35));for(let k=from;k<to;k+=step){sum+=samples[k]*samples[k];count++;}
    const amp=Math.sqrt(sum/Math.max(1,count));const h=clamp(Math.pow(amp,.65)*height*1.6,3,height-4);
    ctx.fillStyle=i/bars<=progress?'#69986c':'#dce7d3';ctx.beginPath();ctx.roundRect(i*(width/bars)+1,(height-h)/2,2.5,h,2);ctx.fill();
  }
  if(progress>0&&progress<1){ctx.strokeStyle='#648d5b';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(width*progress,0);ctx.lineTo(width*progress,height);ctx.stroke();}
}
new ResizeObserver(()=>drawWave()).observe($('waveform'));
$('play-button').onclick=()=>state.playing?pause():start();$('replay-button').onclick=()=>start(true);
$('previous-button').onclick=()=>loadSentence(state.index-1);$('next-button').onclick=()=>loadSentence(state.index+1);$('reveal-button').onclick=()=>reveal();
$('seek').addEventListener('input',()=>{if(!sentence())return;state.waiting=false;clearTimeout(repeatTimer);audio.currentTime=Number($('seek').value)/1000*(sentence().end-sentence().start);$('elapsed').textContent=clock(audio.currentTime,true);drawWave();if(state.playing&&audio.paused)start();});
function saveSettings(){try{localStorage.setItem('sentence-studio-settings',JSON.stringify({speed:state.speed,repeat:state.repeat,gap:state.gap,autoNext:state.autoNext}));}catch{}}
function applySettings(){
  $('speed').value=String(Math.round(state.speed*10));$('speed-label').textContent=state.speed.toFixed(1)+'×';
  $$('#repeat-options button').forEach(b=>{b.classList.toggle('selected',Number(b.dataset.repeat)===state.repeat);b.setAttribute('aria-pressed',String(Number(b.dataset.repeat)===state.repeat));});
  $('gap').value=String(state.gap);$('gap').disabled=state.repeat===1;$('auto-next').checked=state.autoNext;refreshPlayer();
}
$('speed').oninput=()=>{state.speed=Number($('speed').value)/10;audio.playbackRate=state.speed;$('speed-label').textContent=state.speed.toFixed(1)+'×';saveSettings();};
$$('#repeat-options button').forEach(button=>button.onclick=()=>{pause();state.repeat=Number(button.dataset.repeat);state.lap=1;state.waiting=false;audio.currentTime=0;applySettings();saveSettings();drawWave();toast(state.repeat===1?'已设为单次播放，不循环':`每句循环已设为 ${state.repeat} 遍`);});
$('gap').onchange=()=>{state.gap=Number($('gap').value);saveSettings();};$('auto-next').onchange=()=>{state.autoNext=$('auto-next').checked;saveSettings();};
$('answer').oninput=()=>{if(!sentence())return;sentence().answer=$('answer').value;$('word-count').textContent=words($('answer').value).length+' words';$('comparison').classList.add('hidden');scheduleSave();};
$('check-button').onclick=()=>{
  if(!sentence())return;if(!$('answer').value.trim()){toast('先写下你听到的内容，再核对吧。');return;}
  reveal(true);const result=compareWords(sentence().text,$('answer').value);sentence().score=result.score;
  $('comparison').innerHTML=`<div class="comparison-head"><span>词序与用词匹配度 · ${result.correct} / ${result.total} 词</span><strong>${result.score}%</strong></div><div class="comparison-tokens" lang="en">${result.tokens.map(t=>`<span class="${t.correct?'correct':'missing'}">${escape(t.word)}</span>`).join('')}</div><div class="comparison-note">绿色：听写匹配；黄色：漏写或用词不同。忽略大小写和标点${result.extra?`；有 ${result.extra} 个输入词未匹配`:''}。仅作为核对辅助。</div>`;
  $('comparison').classList.remove('hidden');persist();
};
$('complete-button').onclick=async()=>{
  if(!sentence())return;sentence().done=true;sentence().answer=$('answer').value;await persist();
  if(state.index<state.material.segments.length-1){loadSentence(state.index+1);toast('本句已完成，继续下一句。');}
  else{pause();refreshQueue();$('complete-button').innerHTML='已完成 '+icon('check');toast(state.material.segments.every(s=>s.done)?'这份素材已全部完成，今天又进步了一点。':'最后一句已完成，可以回到列表继续练习。');}
};
document.addEventListener('keydown',e=>{
  if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing||document.querySelector('dialog[open]')||/^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(e.target.tagName)||e.target.isContentEditable)return;
  if(e.code==='Space'){e.preventDefault();state.playing?pause():start();}
  else if(e.code==='ArrowLeft'){e.preventDefault();if(state.index>0)loadSentence(state.index-1);}
  else if(e.code==='ArrowRight'){e.preventDefault();if(state.index<state.material.segments.length-1)loadSentence(state.index+1);}
  else if(e.code==='KeyR'){e.preventDefault();start(true);}
  else if(e.code==='KeyT'){e.preventDefault();reveal();}
});
function openImport(){pause();$('import-error').classList.add('hidden');showDialog('import-dialog');}
['import-button','side-import','side-add'].forEach(id=>$(id).onclick=openImport);
$('help-button').onclick=()=>showDialog('help-dialog');$('workspace-nav').onclick=()=>window.scrollTo({top:0,behavior:'smooth'});
function refreshImportReady(){$('import-submit').disabled=sourceBusy||audioBusy||!!importAudio&&!audioRangeConfirmed;}
function importError(message){$('import-error').textContent=message;$('import-error').classList.remove('hidden');}
function getImportBuffer(file){
  if(importBufferCache?.file!==file){const promise=decodeAudio(file);importBufferCache={file,promise};promise.catch(()=>{if(importBufferCache?.promise===promise)importBufferCache=null;});}
  return importBufferCache.promise;
}
async function chooseAudio(file){
  if(!file)return;
  importAudio=null;recognitionCache=null;importBufferCache=null;rangeUi.reset();clearImportFeedback();$('import-error').classList.add('hidden');
  if(file.size>100*1024*1024){$('audio-file').value='';$('audio-file-label').textContent='点击选择或拖入录音';importError('音频超过 100 MB，请先压缩或拆分后导入。');return;}
  importAudio=file;$('audio-file-label').textContent=file.name;
  if(!$('lesson-name').value)$('lesson-name').value=file.name.replace(/\.[^.]+$/,'');
  await rangeUi.setFile(file);
}
$('audio-file').onchange=e=>chooseAudio(e.target.files[0]);
for(const event of ['dragenter','dragover'])$('drop-zone').addEventListener(event,e=>{e.preventDefault();$('drop-zone').classList.add('dragging');});
for(const event of ['dragleave','drop'])$('drop-zone').addEventListener(event,e=>{e.preventDefault();$('drop-zone').classList.remove('dragging');});
$('drop-zone').addEventListener('drop',e=>{const file=e.dataTransfer.files[0];chooseAudio(file);if(importAudio===file){const dt=new DataTransfer();dt.items.add(file);$('audio-file').files=dt.files;}});
function clearImportFeedback(){$('import-error').classList.add('hidden');}
const sourceUi=setupSourceImporter({onBusy:busy=>{sourceBusy=busy;refreshImportReady();},onChange:clearImportFeedback,onError:importError});
const rangeUi=setupAudioRange({getBuffer:getImportBuffer,onBusy:busy=>{audioBusy=busy;refreshImportReady();},onChange:range=>{audioRangeConfirmed=!!range;recognitionCache=null;clearImportFeedback();refreshImportReady();},onError:importError});
const reviewUi=setupSegmentReview();
function updateProcessing(message,percent){$('processing-message').textContent=message;if(Number.isFinite(percent)){$('processing-progress').max=100;$('processing-progress').value=percent;}else $('processing-progress').removeAttribute('value');}
function analyzeAudio(audioData,model,detectSpeakers){return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./analysis-worker.js',import.meta.url),{type:'module'});state.worker=worker;
  state.cancelRecognition=()=>{worker.terminate();reject(new DOMException('处理已取消','AbortError'));};
  worker.onerror=()=>{worker.terminate();state.worker=null;reject(new Error('音频分析未能开始，请检查网络或刷新页面重试。'));};
  worker.onmessage=({data})=>{
    if(data.type==='done'){worker.terminate();state.worker=null;state.cancelRecognition=null;resolve(data.result);}
    else if(data.type==='error'){worker.terminate();state.worker=null;reject(new Error('音频分析未完成：'+data.message+'。请检查网络和录音后重试。'));}
    else if(data.type==='download')updateProcessing(`正在下载模型文件 ${data.file}（${Math.round(data.progress||0)}%）`,data.progress);
    else if(data.message)updateProcessing(data.message);
  };
  worker.postMessage({audio:audioData,model,detectSpeakers},[audioData.buffer]);
});}
async function resample(buffer){
  const offline=new OfflineAudioContext(1,Math.ceil(buffer.duration*16000),16000),source=offline.createBufferSource();source.buffer=buffer;source.connect(offline.destination);source.start();
  return (await offline.startRendering()).getChannelData(0);
}
let processingId=0;
$('cancel-processing').onclick=()=>{processingId++;state.processing=false;state.cancelRecognition?.();state.worker?.terminate();state.worker=null;$('processing-dialog').close();showDialog('import-dialog');toast('已取消，原有素材已保留。');};
$('processing-dialog').addEventListener('cancel',e=>{e.preventDefault();$('cancel-processing').click();});
$('import-form').onsubmit=async e=>{
  e.preventDefault();if(state.processing)return;
  const file=importAudio,text=$('source-text').value.trim(),model=$('recognition-model').value,detectSpeakers=$('detect-speakers').checked;if(!file||!text)return;
  let chosenRange;
  try{sourceUi.assertReady(text);chosenRange=rangeUi.assertReady();}catch(error){importError(error.message);return;}
  clearImportFeedback();
  const id=++processingId;state.processing=true;$('import-dialog').close();showDialog('processing-dialog');updateProcessing('正在准备你确认的音频范围…');
  try{
    const buffer=await getImportBuffer(file);if(id!==processingId)return;
    const cropped=cropAudioChannels(buffer,chosenRange),range=cropped.range,subtitles=parseSubtitles(text);
    if(!subtitles.length&&text.includes('-->'))throw new Error('字幕时间格式未能识别，请检查 SRT / VTT 格式。');
    const canonicalText=subtitles.length?subtitles.map(s=>s.text).join('\n'):text;
    let result;
    if(recognitionCache?.file===file&&recognitionCache.model===model&&recognitionCache.detectSpeakers===detectSpeakers&&recognitionCache.firstSample===range.firstSample&&recognitionCache.lastSample===range.lastSample)result=recognitionCache.result;
    else{
      updateProcessing('正在分析停顿与说话人变化，优先保留 8–15 秒…');
      const selected=context.createBuffer(cropped.channels.length,cropped.length,cropped.sampleRate);cropped.channels.forEach((channel,index)=>selected.copyToChannel(channel,index));
      const samples=await resample(selected);if(id!==processingId)return;
      result=await analyzeAudio(samples,model,detectSpeakers);if(id!==processingId)return;
      // Resampling may pad a fraction of a sample. Keep the user-confirmed endpoint exact.
      result.plan.segments.at(-1).end=range.duration;
      recognitionCache={file,model,detectSpeakers,firstSample:range.firstSample,lastSample:range.lastSample,result};
    }
    let mapping=mapOriginalText(canonicalText,result.chunks,result.plan);
    if(mapping.needsReview){
      state.processing=false;$('processing-dialog').close();mapping=await reviewUi.show(result,mapping,buffer,range);
      if(id!==processingId)return;
      if(!mapping){showDialog('import-dialog');return;}
      state.processing=true;showDialog('processing-dialog');updateProcessing('正在保存确认后的分段…');
    }
    const segments=applyTextMapping(result.plan,mapping,range);validateSegments(segments,buffer.duration);
    const verification={policy:'pause-speaker-v5',model,speakerDetection:result.speakerDetection,recognition:result.recognition,rules:result.plan.rules,pauses:result.plan.pauses,speakerChanges:result.plan.speakerChanges,warnings:result.warnings,canonicalText,referenceCount:mapping.referenceCount,heardCount:mapping.heardCount,matchedWords:mapping.matchedWords,recognizedText:mapping.recognizedText,chunks:result.chunks,textMapping:{breaks:mapping.breaks,reviews:mapping.reviews,manualConfirmed:mapping.manualConfirmed},checkedAt:Date.now()};
    const material={id:crypto.randomUUID(),title:$('lesson-name').value.trim()||file.name.replace(/\.[^.]+$/,''),audio:file,audioRange:range,segments,source:'pause',confidence:1,sourceEvidence:sourceUi.evidence(text),verification,createdAt:Date.now(),updatedAt:Date.now(),lastIndex:0};
    state.materials.unshift(material);await persist(material);await selectMaterial(material,buffer);
    state.processing=false;state.cancelRecognition=null;$('processing-dialog').close();
    $('import-form').reset();sourceUi.reset();importAudio=null;recognitionCache=null;importBufferCache=null;rangeUi.reset();$('audio-file-label').textContent='点击选择或拖入录音';
    toast('已按停顿切分为 '+segments.length+' 段，原文用词已保留。');
  }catch(error){
    if(id!==processingId)return;state.processing=false;state.worker?.terminate();state.worker=null;state.cancelRecognition=null;$('processing-dialog').close();
    importError(error.message||'导入失败，请检查素材后重试。');showDialog('import-dialog');
  }
};
$('import-dialog').addEventListener('close',()=>{if(!state.processing)sourceUi.stop();rangeUi.stop();});
$('recognition-model').onchange=clearImportFeedback;$('detect-speakers').onchange=clearImportFeedback;
$('source-proof-button').onclick=()=>{
  const material=state.material;if(!material)return;pause();const container=$('source-proof-content');container.replaceChildren();
  for(const url of proofUrls)URL.revokeObjectURL(url);proofUrls=[];
  const status=document.createElement('p');status.className='proof-status';
  status.textContent=material.verification?.policy==='pause-speaker-v5'?`按声音停顿切分，优先 8–15 秒；说话人检测：${material.verification.speakerDetection==='completed'?'已完成，发现 '+material.verification.speakerChanges.length+' 处切换候选':material.verification.speakerDetection==='unavailable'?'未完成，本次仅使用停顿':'未启用或无需检测'}。原录音范围 ${material.audioRange.start.toFixed(3)}–${material.audioRange.end.toFixed(3)} 秒。原文用词完整保留；分段原文${material.verification.textMapping.manualConfirmed?'已人工试听确认':'已辅助匹配'}。${material.verification.warnings.join(' ')}`:material.verification?.policy==='manual-range-v4'?`已确认原录音范围：${material.audioRange.start.toFixed(3)}–${material.audioRange.end.toFixed(3)} 秒，共 ${material.audioRange.duration.toFixed(3)} 秒。范围内原文 ${material.verification.referenceCount} 词，录音识别 ${material.verification.heardCount} 词，已逐句对齐。校对时间：${new Date(material.verification.checkedAt).toLocaleString('zh-CN')}。`:material.verification?.policy==='reference-extraction-v3'?`以原文为准：已提取 ${material.segments.length}/${material.verification.totalSentenceCount} 句，共 ${material.verification.matchedWordCount} 词；整段录音识别 ${material.verification.heardCount} 词，跳过其他 ${material.verification.ignoredWordCount} 词。${material.verification.omitted?.length?'另有 '+material.verification.omitted.length+' 句未提取，已明确确认仅提取所选内容。':''}`:material.verification?.policy==='strict-v2'?`已逐词核验：原文 ${material.verification.referenceCount} 词，录音识别 ${material.verification.heardCount} 词。校对记录：${new Date(material.verification.checkedAt).toLocaleString('zh-CN')}。仅忽略大小写、标点和排版空白。`:material.demo?'内置合成语音示例；句子时间来自生成时的分段记录。':'这份素材来自旧版，尚未经过当前严格核验流程。请保留已有记录，重新导入原文和录音完成核验。';container.append(status);
  if(['pause-speaker-v5','manual-range-v4','reference-extraction-v3'].includes(material.verification?.policy)){
    const locations=document.createElement('div');locations.className='proof-locations';
    for(const [index,segment] of material.segments.entries()){const line=document.createElement('p');line.textContent=material.verification.policy==='pause-speaker-v5'?`第 ${index+1} 段 · 原录音 ${clock(segment.start,true)}–${clock(segment.end,true)} · ${segment.boundaryReason==='speaker-change'?'说话人切换':segment.boundaryReason==='pause'?'声音停顿':'所选范围结束'} · ${segment.text}`:`原文第 ${(segment.referenceIndex??0)+1} 句 · 原录音 ${clock(segment.start,true)}–${clock(segment.end,true)} · ${segment.text}`;locations.append(line);}
    for(const omitted of material.verification.omitted||[]){const line=document.createElement('p');line.className='proof-omitted';line.textContent=`未提取：原文第 ${omitted.referenceIndex+1} 句 · ${omitted.text}`;locations.append(line);}
    container.append(locations);
  }
  const evidence=material.sourceEvidence;
  if(evidence){
    const caption=document.createElement('h3');caption.textContent='导入时确认的最终原文';const original=document.createElement('pre');original.className='proof-canonical';original.textContent=evidence.canonicalText;container.append(caption,original);
    for(const file of evidence.files||[]){const button=document.createElement('button');button.className='button secondary compact';button.textContent='下载原文件：'+file.name;button.onclick=()=>download(file,file.name);container.append(button);}
    for(const page of evidence.pages||[]){const section=document.createElement('section');section.className='proof-page';const title=document.createElement('h3');title.textContent=`${page.fileName} · 第 ${page.page} 页 · ${page.included?'参与原文，已人工校对':'已明确排除'}`;section.append(title);
      if(page.preview){const img=document.createElement('img');const url=URL.createObjectURL(page.preview);proofUrls.push(url);img.src=url;img.alt=title.textContent;section.append(img);}
      const text=document.createElement('pre');text.textContent=page.text;section.append(text);container.append(section);
    }
  }
  showDialog('source-proof-dialog');
};
$('source-proof-dialog').addEventListener('close',()=>{for(const url of proofUrls)URL.revokeObjectURL(url);proofUrls=[];});
$('calibrate-button').onclick=()=>{
  if(!sentence())return;pause();const s=sentence();$('segment-start').value=s.start.toFixed(2);$('segment-end').value=s.end.toFixed(2);
  const locked=state.material.verification?.policy==='pause-speaker-v5';$('segment-start').disabled=locked&&state.index===0;if(locked&&state.index===0)$('segment-start').value=String(state.material.audioRange.start);$('segment-end').disabled=locked&&state.index===state.material.segments.length-1;if(locked&&state.index===state.material.segments.length-1)$('segment-end').value=String(state.material.audioRange.end);
  const lower=Math.max(sentence().safeStart??0,state.index?state.material.segments[state.index-1].start+.1:0),upper=Math.min(sentence().safeEnd??state.buffer.duration,state.index<state.material.segments.length-1?state.material.segments[state.index+1].end-.1:state.buffer.duration);
  $('calibration-limit').textContent=`可调整范围 ${lower.toFixed(2)}–${upper.toFixed(2)} 秒。移动共享切点时会同步调整相邻句的边界。`;$('calibrate-error').classList.add('hidden');showDialog('calibrate-dialog');
};
function readBoundary(){
  const start=Number($('segment-start').value),end=Number($('segment-end').value);
  if(!$('segment-start').value||!$('segment-end').value)throw new Error('请填写起点与终点。');
  const lower=Math.max(sentence().safeStart??0,state.index?state.material.segments[state.index-1].start+.1:0),upper=Math.min(sentence().safeEnd??state.buffer.duration,state.index<state.material.segments.length-1?state.material.segments[state.index+1].end-.1:state.buffer.duration);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end-start<.1||start<lower-.005||end>upper+.005)throw new Error('请在可调整范围内输入时间，且片段至少保留 0.1 秒。');
  if(state.material.verification?.policy==='pause-speaker-v5'&&((state.index===0&&Math.abs(start-state.material.audioRange.start)>.005)||(state.index===state.material.segments.length-1&&Math.abs(end-state.material.audioRange.end)>.005)))throw new Error('请只调整相邻片段之间的切点；修改整体音频范围需要重新导入。');
  return {start:Math.max(lower,start),end:Math.min(upper,end)};
}
function boundaryError(error){$('calibrate-error').textContent=error.message;$('calibrate-error').classList.remove('hidden');}
$('preview-boundary').onclick=async()=>{try{const {start,end}=readBoundary();previewAudio?.pause();if(previewAudio?.src)URL.revokeObjectURL(previewAudio.src);previewAudio=new Audio(URL.createObjectURL(new Blob([encodeWav(state.buffer,start,end)],{type:'audio/wav'})));previewAudio.playbackRate=state.speed;previewAudio.preservesPitch=true;await previewAudio.play();}catch(error){boundaryError(error);}};
$('save-boundary').onclick=async()=>{
  try{
    const times=readBoundary(),updated=adjustSegment(state.material.segments,state.index,times.start,times.end,state.buffer.duration),material=state.material;
    if(material.verification?.policy==='pause-speaker-v5'){
      const range=material.audioRange,plan={segments:updated.map(segment=>({...segment,start:segment.start-range.start,end:segment.end-range.start}))};
      let mapping=mapOriginalText(material.verification.canonicalText,material.verification.chunks,plan);
      $('calibrate-dialog').close();
      if(mapping.needsReview){mapping=await reviewUi.show({plan},mapping,state.buffer,range);if(!mapping){showDialog('calibrate-dialog');return;}}
      material.segments=applyTextMapping(plan,mapping,range).map((segment,index)=>({...updated[index],...segment,...(segment.text!==material.segments[index].text?{done:false,score:undefined}:{})}));
      material.verification.textMapping={breaks:mapping.breaks,reviews:mapping.reviews,manualConfirmed:mapping.manualConfirmed};material.verification.checkedAt=Date.now();
    }else{material.segments=updated;$('calibrate-dialog').close();}
    previewAudio?.pause();loadSentence(state.index);toast('切点与对应原文已保存。');
  }catch(error){boundaryError(error);}
};
$('calibrate-dialog').addEventListener('close',()=>{previewAudio?.pause();if(previewAudio?.src)URL.revokeObjectURL(previewAudio.src);previewAudio=null;});
function download(blob,name){const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function practiceAudio(){const plan=buildPracticeAudioPlan(state.material.segments,state.buffer.sampleRate);return {plan,bytes:encodeWavRanges(state.buffer,plan.ranges,plan.gapSeconds)};}
function safeName(text){return text.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80)||'句听';}
$('export-button').onclick=()=>{pause();showDialog('export-dialog');};
$('export-current').onclick=()=>{const s=sentence();if(!s)return;download(new Blob([encodeWav(state.buffer,s.start,s.end)],{type:'audio/wav'}),`${safeName(state.material.title)}_${String(state.index+1).padStart(2,'0')}.wav`);toast('当前句已导出。');};
$('export-audio').onclick=()=>{if(!state.material)return;try{const {bytes}=practiceAudio();download(new Blob([bytes],{type:'audio/wav'}),safeName(state.material.title)+'_练习音频.wav');toast('练习音频已导出。');}catch(error){toast(error.message);}};
$('export-all').onclick=async()=>{
  if(!state.material)return;const button=$('export-all');button.disabled=true;toast('正在打包全部句子音频…');
  try{await new Promise(r=>setTimeout(r,50));const files=[];for(let i=0;i<state.material.segments.length;i++){const s=state.material.segments[i];files.push({name:`${String(i+1).padStart(3,'0')}.wav`,data:encodeWav(state.buffer,s.start,s.end)});if(i%5===0)await new Promise(r=>setTimeout(r,0));}
    files.push({name:'transcript.txt',data:state.material.segments.map((s,i)=>`${String(i+1).padStart(3,'0')}  ${s.text}`).join('\n')},{name:'subtitles.srt',data:toSrt(state.material.segments)});
    const merged=practiceAudio();files.push({name:'practice.wav',data:merged.bytes},{name:'practice.srt',data:toSrt(merged.plan.outputSegments)});
    if(state.material.sourceEvidence){
      const evidence=state.material.sourceEvidence;
      files.push({name:'verification.json',data:JSON.stringify({verification:state.material.verification,audioRange:state.material.audioRange,segments:state.material.segments,practiceTimeline:merged.plan.outputSegments,canonicalText:evidence.canonicalText,reviewedAt:evidence.reviewedAt,pages:evidence.pages.map(({fileName,page,method,text,originalText,confidence,included,reviewed})=>({fileName,page,method,text,originalText,confidence,included,reviewed}))},null,2)});
      for(let index=0;index<(evidence.files||[]).length;index++){const file=evidence.files[index];files.push({name:`originals/${String(index+1).padStart(2,'0')}_${safeName(file.name)}`,data:new Uint8Array(await file.arrayBuffer())});}
    }
    download(zipStore(files),safeName(state.material.title)+'_逐句音频.zip');toast('逐句音频、字幕与核验材料已打包导出。');
  }catch(error){toast('导出失败：'+error.message);}finally{button.disabled=false;}
};
$('export-notes').onclick=()=>{if(!state.material)return;const m=state.material;const text=`${m.title}\n导出时间：${new Date().toLocaleString('zh-CN')}\n\n`+m.segments.map((s,i)=>`第 ${i+1} 句 [${s.done?'已完成':'待练习'}] ${clock(s.start,true)} – ${clock(s.end,true)}\n我的听写：${s.answer||'（未填写）'}\n英文原文：${s.text}${s.score!==undefined?'\n最近核对匹配度：'+s.score+'%':''}\n`).join('\n');download(new Blob(['\uFEFF'+text],{type:'text/plain;charset=utf-8'}),safeName(m.title)+'_听写记录.txt');toast('听写记录已导出。');};
function showHistory(){
  const materials=state.materials,total=materials.reduce((n,m)=>n+m.segments.length,0),done=materials.reduce((n,m)=>n+m.segments.filter(s=>s.done).length,0);
  $('history-content').innerHTML=`<div class="history-stats"><div class="history-stat"><strong>${materials.length}</strong><span>学习素材</span></div><div class="history-stat"><strong>${done}</strong><span>已完成句子</span></div><div class="history-stat"><strong>${total?Math.round(done/total*100):0}%</strong><span>整体完成度</span></div></div>`;
  for(const m of materials){const row=document.createElement('div');row.className='history-row';row.innerHTML=`<div><strong>${escape(m.title)}</strong><small>${m.segments.filter(s=>s.done).length} / ${m.segments.length} 句已完成 · ${m.demo?'内置示例':new Date(m.createdAt).toLocaleDateString('zh-CN')}</small></div><button class="resume-material">继续练习 →</button>${!m.demo?'<button class="delete-material" title="删除本机素材">删除</button>':''}`;
    row.querySelector('.resume-material').onclick=()=>{$('history-dialog').close();selectMaterial(m);};
    const del=row.querySelector('.delete-material');if(del)del.onclick=async()=>{if(del.dataset.armed!=='yes'){del.dataset.armed='yes';del.textContent='确认删除';setTimeout(()=>{del.dataset.armed='no';del.textContent='删除';},4000);return;}pause();clearTimeout(saveTimer);await persist();await dbRequest('readwrite',store=>store.delete(m.id));state.materials=state.materials.filter(item=>item.id!==m.id);if(state.material?.id===m.id){state.material=null;await selectMaterial(state.materials[0]);}refreshLibrary();showHistory();toast('素材与对应练习记录已从本机删除。');};
    $('history-content').append(row);
  }
  showDialog('history-dialog');
}
$('history-nav').onclick=()=>{pause();showHistory();};
// Small screens retain access to the learning history through the breadcrumb.
$('material-title').title='点击查看练习记录';$('material-title').style.cursor='pointer';$('material-title').onclick=()=>{pause();showHistory();};
document.addEventListener('visibilitychange',()=>{if(document.hidden){pause();clearTimeout(saveTimer);persist();}});
window.addEventListener('pagehide',()=>{pause();clearTimeout(saveTimer);persist();});
async function boot(){
  try{state.db=await openDb();state.materials=await dbRequest('readonly',store=>store.getAll());state.materials.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));}catch{notice('当前浏览器未开启本机存储。你仍可练习和导出，但刷新后记录可能丢失。');}
  try{const settings=JSON.parse(localStorage.getItem('sentence-studio-settings')||'{}');if(settings.speed>=.5&&settings.speed<=1.5)state.speed=Math.round(settings.speed*10)/10;if([1,2,3,4,5].includes(settings.repeat))state.repeat=settings.repeat;if([0,1,2,3,5].includes(settings.gap))state.gap=settings.gap;state.autoNext=!!settings.autoNext;}catch{}
  applySettings();
  if(!state.materials.some(m=>m.id==='demo-small-steps')){
    try{const [metadata,response]=await Promise.all([fetch('./demo.json').then(r=>{if(!r.ok)throw new Error('示例信息读取失败');return r.json();}),fetch('./demo.wav')]);if(!response.ok)throw new Error('示例音频读取失败');
      const demo={...metadata,id:'demo-small-steps',demo:true,source:'subtitle',audio:await response.blob(),createdAt:Date.now(),updatedAt:0,lastIndex:0};state.materials.push(demo);await persist(demo);
    }catch(error){notice('内置示例暂时无法读取。请通过“导入新素材”开始练习。');}
  }
  if(state.materials.length)await selectMaterial(state.materials[0]);
}
boot();
