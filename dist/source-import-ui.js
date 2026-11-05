import {extractSources,sourceDocumentText,verifyReviewedPages} from './source-reader.js';
const $=id=>document.getElementById(id);
export function setupSourceImporter({onBusy=()=>{},onChange=()=>{},onError=()=>{}}={}){
  let pages=[],files=[],selected=0,controller=null,generation=0,previewUrl=null,busy=false,reviewedText='';
  const invalidate=()=>{$('source-approved').checked=false;reviewedText='';onChange();};
  const included=()=>pages.filter(p=>p.included);
  function cleanPreview(){if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=null;}
  function updateSummary(){
    const active=included(),reviewed=active.filter(p=>p.reviewed).length;
    $('source-review-summary').textContent=`${active.length} 页参与原文 · ${reviewed} 页已校对`;
    $('source-file-status').textContent=pages.length?`${files.length} 个文件 · ${pages.length} 页已读取`:'TXT / SRT / VTT / PDF / 图片，支持按顺序选取多个文件';
    $('source-page-list').replaceChildren();
    pages.forEach((page,index)=>{const b=document.createElement('button');b.type='button';b.className='source-page-tab'+(index===selected?' selected':'');b.textContent=`${index+1}${page.included?(page.reviewed?' ✓':' · 待校对'):' · 不使用'}`;b.title=`${page.fileName} 第 ${page.page} 页`;b.onclick=()=>{selected=index;render();};$('source-page-list').append(b);});
  }
  function render(){
    $('source-review').classList.toggle('hidden',!pages.length);updateSummary();cleanPreview();const page=pages[selected];if(!page)return;
    $('source-page-name').textContent=`${page.fileName} · 第 ${page.page} 页`;
    $('source-method').textContent=page.method==='ocr'?`图片识别${Number.isFinite(page.confidence)?' · 参考置信度 '+Math.round(page.confidence)+'%':''}`:page.method==='pdf-text'?'PDF 文字层提取':'原始文本';
    $('source-page-text').value=page.text;$('source-page-included').checked=page.included;$('source-page-reviewed').checked=page.reviewed;
    $('source-page-reviewed').disabled=!page.included;$('source-page-text').disabled=!page.included;
    $('source-page-preview').classList.toggle('hidden',!page.preview);$('source-original-text').classList.toggle('hidden',!!page.preview);
    $('source-preview-open').classList.toggle('hidden',!page.preview);
    if(page.preview){previewUrl=URL.createObjectURL(page.preview);$('source-page-preview').src=previewUrl;$('source-preview-open').href=previewUrl;$('source-page-preview').alt=`${page.fileName} 第 ${page.page} 页的原文件预览`;}else{$('source-page-preview').removeAttribute('src');$('source-preview-open').removeAttribute('href');$('source-original-text').textContent=page.originalText;}
    $('source-uncertain').textContent=page.text.trim()?(page.uncertain?.length?`识别存疑词：${page.uncertain.slice(0,25).join('、')}。请逐词对照左侧原文件；置信度不能代替人工校对。`:'请对照原文件核对本页的用词、顺序及完整性，移除不属于录音原文的标题、题目或页码。'):'本页没有识别出文字，请手动填写，或明确取消“本页参与原文”。';
    $('source-page-position').textContent=`${selected+1} / ${pages.length}`;$('source-page-prev').disabled=selected===0;$('source-page-next').disabled=selected===pages.length-1;
    $('source-move-up').disabled=selected===0;$('source-move-down').disabled=selected===pages.length-1;
  }
  function compile(){const active=included();$('source-text').value=sourceDocumentText(active);invalidate();}
  function shift(delta){const next=selected+delta;if(next<0||next>=pages.length)return;[pages[selected],pages[next]]=[pages[next],pages[selected]];selected=next;compile();render();}
  $('source-move-up').onclick=()=>shift(-1);$('source-move-down').onclick=()=>shift(1);
  $('source-page-prev').onclick=()=>{if(selected){selected--;render();}};$('source-page-next').onclick=()=>{if(selected<pages.length-1){selected++;render();}};
  $('source-page-text').oninput=()=>{const page=pages[selected];if(!page)return;page.text=$('source-page-text').value;page.reviewed=false;compile();updateSummary();$('source-page-reviewed').checked=false;};
  $('source-page-included').onchange=()=>{const page=pages[selected];page.included=$('source-page-included').checked;page.reviewed=false;compile();render();};
  $('source-page-reviewed').onchange=()=>{const page=pages[selected];page.reviewed=$('source-page-reviewed').checked;invalidate();updateSummary();};
  $('source-approved').onchange=()=>{reviewedText=$('source-approved').checked?$('source-text').value:'';onChange();};
  $('source-text').addEventListener('input',invalidate);
  function setBusy(value){busy=value;onBusy(value);$('source-progress-row').classList.toggle('hidden',!value);$('source-cancel').disabled=!value;$('text-file').disabled=value;}
  function cancel(){generation++;controller?.abort();controller=null;setBusy(false);$('source-file-progress').textContent='已取消，之前的原文保留。';}
  $('source-cancel').onclick=cancel;
  $('text-file').onchange=async event=>{
    const picked=Array.from(event.target.files||[]);event.target.value='';if(!picked.length)return;
    const id=++generation;controller?.abort();controller=new AbortController();setBusy(true);$('import-error').classList.add('hidden');
    try{
      const extracted=await extractSources(picked,{signal:controller.signal,onProgress:(message,percent)=>{if(id!==generation)return;$('source-file-progress').textContent=message;if(Number.isFinite(percent)){$('source-file-progress-bar').value=percent;}else $('source-file-progress-bar').removeAttribute('value');}});
      if(id!==generation)return;
      files=picked;pages=extracted.map(p=>({...p,included:true,reviewed:false}));selected=0;compile();render();
    }catch(error){if(id===generation&&error.name!=='AbortError')onError(error.message||'原文件读取失败，请重试。');}
    finally{if(id===generation){controller=null;setBusy(false);}}
  };
  $('source-clear').onclick=()=>{cancel();cleanPreview();pages=[];files=[];selected=0;invalidate();render();};
  return {
    get busy(){return busy;},
    invalidate,
    assertReady(text){
      if(busy)throw new Error('原文文件仍在识别，请等待完成后核验。');
      if(!text.trim()||text.length>60000)throw new Error('请输入完整原文，长度需在 60000 字符以内；不会自动截断。');
      verifyReviewedPages(text,pages);
      if(!$('source-approved').checked||reviewedText!==$('source-text').value)throw new Error('请对照原文件检查最终英文原文，并勾选下方确认。修改文字后需重新确认。');
    },
    evidence(text){return {files:files.slice(),pages:pages.map(p=>({...p})),canonicalText:text,reviewedAt:Date.now()};},
    reset(){cancel();cleanPreview();pages=[];files=[];selected=0;reviewedText='';$('source-approved').checked=false;render();},
    stop(){cancel();}
  };
}
