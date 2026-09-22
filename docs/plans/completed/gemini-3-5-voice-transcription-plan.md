# Gemini 3.5 Voice Transcription

Status: Complete (August 2026)

Aiden's Voice settings now replace the legacy Gemini Flash choices with the dedicated
`gemini-3.5-transcribe-live` and `gemini-3.5-transcribe` models.

The Live path keeps credentials and the Google Gen AI SDK session in Electron's main
process. Renderer microphone capture produces mono PCM16 at 16 kHz in 100 ms chunks,
serializes every chunk through owner-bound IPC, flushes the audio tail before
`audioStreamEnd`, and exposes committed plus tentative transcript snapshots. Composer
voice and the dictation pill retain a parallel recording and fall back to a supported
PCM16 WAV request through the Interactions API if Live setup or finalization fails.
The AudioWorklet is emitted as a same-origin production asset so Electron's CSP permits
the Live path in packaged builds.

The implementation enforces document ownership, bounded chunks and queue depth, a
10-minute audio limit, cancellation on document invalidation, and transcription usage
accounting. Tests cover model migration, Interactions envelopes, delayed final segments,
owner invalidation, transcript reduction, PCM resampling/chunking, WAV encoding, usage
normalization, IPC allowlists, and the production AudioWorklet asset contract.

This completes voice-only Gemini Live transcription. The broader realtime multimodal
screen-sharing track remains deferred.
