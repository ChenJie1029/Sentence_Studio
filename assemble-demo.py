from pathlib import Path
import json
import wave

root = Path(__file__).resolve().parent
source = root / 'sample-parts'
sentences = json.loads((source / 'sentences.json').read_text(encoding='utf-8-sig'))
segments = []
cursor = 0
with wave.open(str(root / 'dist/demo.wav'), 'wb') as output:
    for i, text in enumerate(sentences):
        with wave.open(str(source / f'{i}.wav'), 'rb') as part:
            if i == 0:
                output.setparams(part.getparams())
                rate, channels, width = part.getframerate(), part.getnchannels(), part.getsampwidth()
            start = cursor / rate
            frames = part.readframes(part.getnframes())
            output.writeframes(frames)
            cursor += part.getnframes()
            end = cursor / rate
            segments.append({'text': text, 'start': start, 'end': end, 'confidence': 1})
            if i < len(sentences) - 1:
                gap = int(rate * .4)
                output.writeframes(b'\0' * gap * channels * width)
                cursor += gap
(root / 'dist/demo.json').write_text(json.dumps({'title': 'The art of small steps', 'segments': segments}, ensure_ascii=False, indent=2), encoding='utf-8')
(root / 'sample-parts/demo.srt').write_text('\n\n'.join(f'{i+1}\n00:00:{s["start"]:06.3f} --> 00:00:{s["end"]:06.3f}\n{s["text"]}' for i, s in enumerate(segments)), encoding='utf-8')
print(f'Created demo: {len(segments)} sentences, {cursor / rate:.1f} seconds')
