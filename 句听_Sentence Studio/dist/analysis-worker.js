import {findPauses,planPauseSegments,speakerChangesFromTurns} from './pause-segmentation.js';
const stage=message=>self.postMessage({type:'stage',message});
const progress=event=>{if(event.status==='progress')self.postMessage({type:'download',file:event.file,progress:event.progress});};

self.onmessage=async({data})=>{
  try{
    const samples=data.audio,duration=samples.length/16000,warnings=[];
    stage('正在分析声音停顿，按 8–15 秒规划分段…');
    const acoustic=findPauses(samples,16000);let speakerChanges=[],speakerDetection='not-needed',library;
    const getLibrary=async()=>{
      if(!library){library=await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');library.env.allowLocalModels=false;library.env.backends.onnx.wasm.numThreads=1;library.env.backends.onnx.wasm.proxy=false;}
      return library;
    };
    if(duration>8&&data.detectSpeakers!==false){
      try{
        stage('正在加载说话人分析组件，检测声音切换…');
        const {AutoProcessor,AutoModelForAudioFrameClassification}=await getLibrary(),modelId='onnx-community/pyannote-segmentation-3.0';
        const model=await AutoModelForAudioFrameClassification.from_pretrained(modelId,{device:'wasm',dtype:'fp32',progress_callback:progress}),processor=await AutoProcessor.from_pretrained(modelId);
        const windowSamples=20*16000,stepSamples=10*16000;
        for(let from=0;from<samples.length;from+=stepSamples){
          const to=Math.min(samples.length,from+windowSamples),clip=samples.slice(from,to);if(clip.length<16000)break;
          stage(`正在检测说话人变化（${Math.round(to/samples.length*100)}%）…`);
          const output=await model(await processor(clip)),turns=processor.post_process_speaker_diarization(output.logits,clip.length)[0];
          // Speaker IDs are local to each window. Compare turns only within it.
          speakerChanges.push(...speakerChangesFromTurns(turns,{offset:from/16000,keepStart:from?5:0,keepEnd:to===samples.length?Infinity:15}));
          if(to===samples.length)break;
        }
        speakerChanges=speakerChanges.sort((a,b)=>a.time-b.time).filter((change,index,list)=>!index||change.time-list[index-1].time>.35);
        speakerDetection='completed';await model.dispose();
      }catch(error){speakerDetection='unavailable';warnings.push('说话人分析未完成，本次使用声音停顿切分。可试听确认或联网重试。');}
    }
    const plan=planPauseSegments(duration,acoustic.pauses,speakerChanges);let chunks=[],recognition='not-needed';
    if(plan.segments.length>1){
      try{
        stage('音频切点已确定，正在辅助匹配原文；识别文字不会替换原文…');
        const {pipeline}=await getLibrary(),modelId=data.model==='tiny'?'Xenova/whisper-tiny.en':'Xenova/whisper-base.en';
        const transcriber=await pipeline('automatic-speech-recognition',modelId,{device:'wasm',dtype:'q8',progress_callback:progress});
        const result=await transcriber(samples,{return_timestamps:'word',chunk_length_s:30,stride_length_s:5,do_sample:false,chunk_callback:()=>stage('正在辅助匹配原文，音频切点保持不变…')});
        chunks=result.chunks;recognition='completed';await transcriber.dispose();
      }catch(error){recognition='unavailable';warnings.push('原文自动匹配未完成，音频已经切好，请试听确认每段对应的原文。');}
    }
    self.postMessage({type:'done',result:{plan,chunks,speakerDetection,recognition,warnings:[...plan.warnings,...warnings]}});
  }catch(error){self.postMessage({type:'error',message:error?.message||String(error)});}
};
