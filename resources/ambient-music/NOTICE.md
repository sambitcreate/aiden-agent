# Ambient Music third-party notices

The Ambient Music helper is built from the reviewed, pinned sources recorded in
`source-provenance.json`:

- Magenta RealTime `v2.0.3` — Apache License 2.0. The distributed license is
  `LICENSE.magenta-realtime.txt`.
- MLX `v0.31.1` — MIT License. The distributed license is `LICENSE.mlx.txt`.
  MLX's complete pinned `ACKNOWLEDGMENTS.md` is distributed as
  `LICENSE.mlx-acknowledgments.txt`; it includes the BSD-style binary notice
  for the compiled vendored PocketFFT implementation (copyright 2010–2018
  Max-Planck-Society) and MLX's other upstream acknowledgments.
- TensorFlow Lite `v2.21.0` — Apache License 2.0, including the upstream Caffe
  notice. The distributed license is `LICENSE.tensorflow-lite.txt`.
- SentencePiece `v0.2.0` — Apache License 2.0. The distributed license is
  `LICENSE.sentencepiece.txt`. Its compiled vendored sources also include
  Abseil flags (`LICENSE.sentencepiece-abseil.txt`), Protocol Buffers Lite
  (`LICENSE.sentencepiece-protobuf-lite.txt`), and Darts-clone
  (`LICENSE.sentencepiece-darts-clone.txt`). Darts-clone is copyright
  2008–2011 Susumu Yata and uses a BSD-style license.

The reviewed effective compile and link graph also includes:

- Abseil `d38452e…` — Apache-2.0.
- cpuinfo (including CLOG) `8a92100…` — BSD-style permissive licenses.
- Eigen `dcbaf2d…` — MPL-2.0 with the packaged Apache, BSD, MINPACK, and
  upstream explanatory notices.
- FarmHash `0d859a8…` — MIT-style.
- Ooura FFT2D 1.0 — Takuya Ooura's permissive notice.
- FlatBuffers `1872409…`, gemmlowp `16e8662…`, ml_dtypes `00d98cd…`, and Ruy
  `3286a34…` — Apache-2.0, with ml_dtypes' Eigen notice also included.
- fmt `407c905…` and nlohmann/json 3.11.3 — MIT.
- Apple metal-cpp 26 — Apache-2.0.

Protocol Buffers `90b73ac…` is fetched separately for build tooling and is
recorded as build-only under its BSD license; this is distinct from the
protobuf-lite sources compiled from the pinned SentencePiece vendored tree.
Every exact revision or archive digest, dependency classification, packaged
license filename, and license-file SHA-256 is locked in
`source-provenance.json`. The helper build fails if a fetched or vendored
license differs from that reviewed inventory.

The optional `google/magenta-realtime-2` model files are not bundled. Aiden
downloads the pinned revision only after an explicit user action. Its model
card identifies the weights as Creative Commons Attribution 4.0; see
`MODEL_TERMS.md` for the source, revision, license link, and responsible-use
notice.
