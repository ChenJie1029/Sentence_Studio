Add-Type -AssemblyName System.Speech
$sampleDirectory = Join-Path $PSScriptRoot 'sample-parts'
New-Item -ItemType Directory -Force -Path $sampleDirectory | Out-Null
$sentences = @(
  'Every big change begins with a small step.',
  'You do not need to see the whole staircase to take the first step.',
  'Learning a language is a journey, not a race.',
  'Some days you will understand every word, and other days you may need to listen again.',
  'That is all part of the process, so be patient with yourself.',
  'Try to practice a little every day, even when you only have a few minutes.',
  'The small things you do today will make a difference tomorrow.',
  'Keep listening, keep learning, and trust the progress you are making.'
)
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speaker.SelectVoice('Microsoft Zira Desktop')
$speaker.Rate = -1
for ($i = 0; $i -lt $sentences.Length; $i++) {
  $speaker.SetOutputToWaveFile((Join-Path $sampleDirectory "$i.wav"))
  $speaker.Speak($sentences[$i])
  $speaker.SetOutputToNull()
}
$speaker.Dispose()
$sentences | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $sampleDirectory 'sentences.json') -Encoding UTF8
