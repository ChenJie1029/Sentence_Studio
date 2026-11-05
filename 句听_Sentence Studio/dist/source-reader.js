import {referenceWords} from './verification.js';
const PDF_VERSION='4.10.38',OCR_VERSION='6.0.1';
let pdfLibrary,ocrLibrary;
const aborted=signal=>{if(signal?.aborted)throw new DOMException('已取消素材识别','AbortError');};
export function fileKind(file){
  const extension=file.name.split('.').at(-1).toLowerCase();
  if(['txt','srt','vtt'].includes(extension))return 'text';
  if(extension==='pdf'||file.type==='application/pdf')return 'pdf';
  if(['png','jpg','jpeg','webp','bmp'].includes(extension))return 'image';
  throw new Error(`不支持“${file.name}”。请使用 TXT、SRT、VTT、PDF 或 PNG / JPG / WEBP / BMP 图片。`);
}
export function validateSourceFiles(files){
  if(!files.length)throw new Error('请先选择原文文件。');
  if(files.length>12)throw new Error('一次最多导入 12 个原文文件，请分批整理。');
  let total=0;
  for(const file of files){const kind=fileKind(file),limit=kind==='text'?1024*1024:25*1024*1024;if(file.size>limit)throw new Error(`${file.name} 超过大小限制：文本 1 MB，PDF / 图片 25 MB。`);total+=file.size;}
  if(total>80*1024*1024)throw new Error('本批原文文件合计超过 80 MB，请分批导入。');
  if(files.length>1&&files.some(f=>/\.(srt|vtt)$/i.test(f.name)))throw new Error('带时间轴的 SRT / VTT 请单独导入，避免合并时间轴造成顺序错误。');
}
export function pdfTextLines(items){
  const lines=[];let line='',last=null;
  for(const item of items){if(typeof item.str!=='string')continue;const y=item.transform?.[5],x=item.transform?.[4];
    if(last&&Number.isFinite(y)&&Number.isFinite(last.y)&&Math.abs(y-last.y)>Math.max(2,(item.height||10)*.45)){if(line.trim())lines.push(line.trim());line='';}
    const gap=last&&Number.isFinite(x)?x-last.right:0;
    if(line&&gap>Math.max(1,(item.height||10)*.1)&&!line.endsWith(' '))line+=' ';
    line+=item.str;if(item.hasEOL){if(line.trim())lines.push(line.trim());line='';last=null;}else last={y,right:(x||0)+(item.width||0)};
  }
  if(line.trim())lines.push(line.trim());return lines.join('\n');
}
export function sourceDocumentText(pages){return pages.map(p=>p.method==='text'?p.text.trim():p.text.replace(/\s*\n\s*/g,' ').trim()).join(' ');}
export function verifyReviewedPages(text,pages){
  if(!pages.length)return;
  const included=pages.filter(page=>page.included);
  if(!included.length)throw new Error('没有选中任何原文页，请选择参与原文的页面，或清除原文件后手动录入。');
  const pending=included.filter(page=>!page.reviewed||!page.text.trim());
  if(pending.length)throw new Error(`还有 ${pending.length} 页尚未完成校对。请逐页对照预览，填写完整文字并勾选“本页文字已核对”。`);
  const reviewed=referenceWords(sourceDocumentText(included)),final=referenceWords(text);
  if(reviewed.length!==final.length||reviewed.some((word,index)=>word!==final[index]))throw new Error('最终原文与已校对页面的用词或顺序不一致。请在对应页的文字框修正并重新校对，再确认最终原文；不能只改最终文本而跳过原文件校对。');
}
async function canvasBlob(canvas){return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法生成原文件预览，请换一张图片后重试。')),'image/png'));}
export async function extractSources(files,{signal,onProgress=()=>{},onPage=()=>{}}={}){
  validateSourceFiles(files);const pages=[];let ocrWorker=null,loadingTask=null,pdf=null;
  const cancel=()=>{ocrWorker?.terminate().catch(()=>{});loadingTask?.destroy().catch(()=>{});};signal?.addEventListener('abort',cancel,{once:true});
  const progress=(message,percent)=>{aborted(signal);onProgress(message,percent);};
  async function ocr(image,label){
    aborted(signal);progress(`正在加载图片文字识别：${label}`);
    ocrLibrary??=import(`https://cdn.jsdelivr.net/npm/tesseract.js@${OCR_VERSION}/dist/tesseract.esm.min.js`);
    const ocrModule=await ocrLibrary;const {createWorker,PSM}=ocrModule.default||ocrModule;aborted(signal);
    if(!ocrWorker){const created=await createWorker('eng',1,{workerPath:`https://cdn.jsdelivr.net/npm/tesseract.js@${OCR_VERSION}/dist/worker.min.js`,corePath:'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0',logger:entry=>{if(!signal?.aborted)onProgress(`正在识别英文：${label}`,entry.status==='recognizing text'?entry.progress*100:undefined);}});if(signal?.aborted){await created.terminate();aborted(signal);}ocrWorker=created;await ocrWorker.setParameters({tessedit_pageseg_mode:PSM.AUTO,user_defined_dpi:'200'});}
    const {data}=await ocrWorker.recognize(image,{}, {text:true,blocks:true});aborted(signal);
    const uncertain=(data.blocks||[]).flatMap(b=>b.paragraphs||[]).flatMap(p=>p.lines||[]).flatMap(l=>l.words||[]).filter(w=>w.confidence<85).map(w=>w.text);
    return {text:data.text.trim(),confidence:data.confidence,uncertain,method:'ocr'};
  }
  async function add(page){aborted(signal);if(pages.length>=60)throw new Error('本批原文件超过 60 页，请拆分后导入；不会截断页面。');pages.push(page);onPage(page,pages.length);}
  try{
    for(let fileIndex=0;fileIndex<files.length;fileIndex++){
      aborted(signal);const file=files[fileIndex],kind=fileKind(file);progress(`正在读取 ${file.name}（${fileIndex+1}/${files.length}）`);
      if(kind==='text'){
        let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer()).replace(/^\uFEFF/,'');}catch{throw new Error(`${file.name} 不是 UTF-8 文本。请另存为 UTF-8 后导入，避免乱码被当作原文。`);}
        await add({id:crypto.randomUUID(),fileName:file.name,page:1,method:'text',text,originalText:text,preview:null});
      }else if(kind==='image'){
        const bitmap=await createImageBitmap(file);aborted(signal);
        if(bitmap.width*bitmap.height>40_000_000){bitmap.close();throw new Error(`${file.name} 超过 4000 万像素，请缩小或分成多张清晰图片。`);}
        const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
        const preview=await canvasBlob(canvas),result=await ocr(preview,file.name);canvas.width=canvas.height=0;
        await add({id:crypto.randomUUID(),fileName:file.name,page:1,...result,originalText:result.text,preview});
      }else{
        pdfLibrary??=import(`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_VERSION}/build/pdf.min.mjs`);const pdfjs=await pdfLibrary;aborted(signal);
        pdfjs.GlobalWorkerOptions.workerSrc=`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_VERSION}/build/pdf.worker.min.mjs`;
        loadingTask=pdfjs.getDocument({data:new Uint8Array(await file.arrayBuffer()),stopAtErrors:true,isEvalSupported:false,enableXfa:false,cMapUrl:`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_VERSION}/cmaps/`,cMapPacked:true,standardFontDataUrl:`https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDF_VERSION}/standard_fonts/`});
        pdf=await loadingTask.promise;aborted(signal);if(pdf.numPages>30)throw new Error(`${file.name} 有 ${pdf.numPages} 页，超过本次 30 页限制。请先拆分 PDF；不会只读取前几页。`);
        for(let number=1;number<=pdf.numPages;number++){
          progress(`正在读取 ${file.name} · 第 ${number}/${pdf.numPages} 页`);const page=await pdf.getPage(number),content=await page.getTextContent(),extracted=pdfTextLines(content.items);
          const unitViewport=page.getViewport({scale:1}),scale=Math.min(2.4,2200/Math.max(unitViewport.width,unitViewport.height)),viewport=page.getViewport({scale});
          const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
          await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;aborted(signal);const preview=await canvasBlob(canvas);canvas.width=canvas.height=0;
          const operators=await page.getOperatorList();
          const imageOperations=new Set([pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject,pdfjs.OPS.paintImageXObjectRepeat,pdfjs.OPS.paintImageMaskXObject]);
          const hasImages=operators.fnArray.some(fn=>imageOperations.has(fn))||referenceWords(extracted).length<3;
          const result=hasImages?await ocr(preview,`${file.name} 第 ${number} 页`):{text:extracted,method:'pdf-text',confidence:null,uncertain:[]};
          await add({id:crypto.randomUUID(),fileName:file.name,page:number,...result,originalText:result.text,preview});page.cleanup();
        }
        await pdf.destroy();pdf=null;loadingTask=null;
      }
    }
    if(!pages.some(p=>p.text.trim())&&pages.every(p=>p.method==='text'))throw new Error('所选文本文件没有内容，请检查原文文件。');
    if(sourceDocumentText(pages).length>60000)throw new Error('提取的原文超过 60000 字符，请缩短或拆分素材后导入；不会截断原文。');
    return pages;
  }catch(error){if(error.name==='PasswordException')throw new Error('PDF 需要密码。请先解除密码保护后再导入。');throw error;}
  finally{signal?.removeEventListener('abort',cancel);await ocrWorker?.terminate().catch(()=>{});if(pdf)await pdf.destroy().catch(()=>{});else if(loadingTask)await loadingTask.destroy().catch(()=>{});}
}
