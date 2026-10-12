# Test fixtures

## Speech audio

`speech-librispeech-1089-134686-0000-2s.wav` holds the first 2.0 seconds of LibriSpeech test-clean utterance `1089-134686-0000` ("After early nightfall…"), stored as 16 kHz mono PCM16.

- Source: LibriSpeech ASR corpus by Vassil Panayotov, Guoguo Chen, Daniel Povey and Sanjeev Khudanpur, <https://www.openslr.org/12>.
- License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- Change: trimmed to 2.0 s.
- Obtained via the sherpa-onnx `test_wavs/0.wav` sample.

The real Silero VAD test in `local-speech-engine.test.ts` uses it, so the test gets the same recorded speech on every runner.
