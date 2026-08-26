# Ambient Music

Ambient Music generates an indefinite instrumental stream on a supported Mac
with Magenta RealTime 2. Open **Settings → Ambient Music** to choose a model,
describe up to six styles, mix their weights, and control playback. Aiden's
native player integrates macOS Now Playing and remote-command APIs so media
keys, Control Center, and compatible headset controls can project the same
state. While playing, the Settings player shows a local segmented spectrum
derived from the generated output; it does not capture the microphone or
system audio and stores no audio samples. The spectrum stays flat until a
current playback sample arrives and is cleared across pause, restart, and model
transitions. A muted Base qualification is labeled **Benchmarking** and never
projects its silent analyzer samples as live playback. Physical accessory
acceptance is still required before a distribution release claims that
integration on every supported device.

## Requirements and model choices

Ambient Music requires Apple silicon and macOS 14 or later. The current Aiden
macOS product is arm64-only; universal/Intel distribution is a separate future
product plan and has not completed Intel acceptance. On an otherwise supported
Apple-silicon build running a macOS release older than 14, the settings page
shows an unsupported explanation and no download controls.

- **Small** is the recommended model. A clean Small installation is about
  1.84 GB (1.71 GiB), including shared encoders and the audio codec.
- **Base** is about 4.16 GB (3.88 GiB) on a clean installation. It stays
  unavailable for playback until this Mac passes Aiden's muted real-time
  benchmark. If Small is already installed, shared files are reused.

Aiden reserves an additional 512 MiB safety margin while downloading or
repairing files. Continuous generation uses sustained CPU/GPU work and unified
memory; it can increase power use and reduce battery life. Pause Ambient Music
when battery life matters. A paused model unloads after five idle minutes and
reloads only after the next explicit Play.

## Download and network boundary

No MRT2 model file is included in Aiden. On a clean install, Ambient Music
makes no request until you review the model terms, select the acknowledgement,
and press **Download**. Electron main—not the renderer or native helper—then
downloads the exact files in the checked-in manifest from the pinned
`google/magenta-realtime-2` Hugging Face revision. Redirects are restricted to
reviewed Hugging Face/CDN hosts; every size and SHA-256 digest is verified
before an atomic install becomes playable.

After installation, prompt encoding and audio generation are local. Prompt
text and generated audio are not sent to Hugging Face, Aiden model providers,
telemetry, crash reports, or usage records. Playback works offline. Repair and
re-download are the only later Ambient Music actions that need network access.

Production assets live under:

```text
~/Library/Application Support/Aiden Agent/Ambient Music/
```

Development builds use the separate `Aiden Agent Dev` Application Support
directory. Downloads are revisioned and staged within this owned directory;
Aiden never writes them to Documents or a portable configuration.

## Removing model data

In **Settings → Ambient Music → On-device Models**, choose the trash button for
Small or Base and confirm **Remove**. Aiden stops and unloads that model before
deleting its verified files. Shared files remain only while another installed
model needs them. Quit Aiden before manually deleting the complete `Ambient
Music` directory shown above.

## Troubleshooting

- **Download is unavailable:** accept the displayed model terms first. If the
  Mac is unsupported, no model can be downloaded. In a helper-less development
  run, restart with `AIDEN_BUILD_AMBIENT_MUSIC=1 npm run dev`; no model download
  is allowed until the helper is present.
- **Not enough disk space:** free the displayed download size plus the 512 MiB
  safety margin, then retry. Existing verified files receive credit; corrupt
  same-size files do not.
- **Interrupted download:** choose Download again. Aiden resumes only a partial
  whose validator and byte range still match; otherwise it safely restarts the
  file.
- **Model needs repair:** choose **Repair**. Aiden re-verifies all files and
  replaces only invalid or missing assets before publishing a new revision.
- **Base cannot play:** stop the active model and run the Base benchmark. A
  failed result is hardware/OS/helper-specific and never falls back to
  unqualified playback.
- **Music pauses or reports heavy local load:** close other GPU-intensive local
  model work, use Small, or retry. Aiden does not silently switch models.
- **No sound after an output change:** confirm the current system output, then
  press Play. Route changes pause safely; sleep and wake never autoplay.
- **Media controls disagree with Settings:** retry once from Settings. A helper
  crash is isolated from Aiden and the player is rebuilt with no automatic
  resume.

## Attribution and terms

The helper uses pinned Magenta RealTime, MLX, TensorFlow Lite, SentencePiece,
and a machine-locked effective compile/link dependency graph. Exact revisions
or archive digests, build classifications, license-file hashes, and license
texts ship in Aiden's `Contents/Resources/ambient-music/` directory and in the
helper bundle. The
optional model weights are identified by their model card as CC BY 4.0 and are
downloaded from the pinned revision only after explicit acceptance. See
[`resources/ambient-music/MODEL_TERMS.md`](../resources/ambient-music/MODEL_TERMS.md)
and [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

Generated audio may reflect limitations in the upstream training data. Use it
responsibly and review the model card before downloading.

## Local rollback

Launch with `AIDEN_AMBIENT_MUSIC_ENABLED=0` to hide Ambient Music, skip its IPC
handlers, and prevent helper construction. This does not delete saved prompts
or downloaded models; re-enable the feature to use or remove them. This local
flag is a canary/rollback control, not an automatic remote switch.
