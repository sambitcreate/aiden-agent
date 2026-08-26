# Third-party notices

## Ambient Music

Ambient Music uses the following pinned native components in its separately
signed helper:

- Magenta RealTime `v2.0.3` — Apache License 2.0
- MLX `v0.31.1` — MIT License
- MLX-vendored PocketFFT — BSD 3-Clause license, copyright 2010–2018 Max-Planck-Society; the complete pinned MLX acknowledgments are packaged
- TensorFlow Lite `v2.21.0` — Apache License 2.0, including its upstream Caffe notice
- SentencePiece `v0.2.0` — Apache License 2.0
- SentencePiece-vendored Abseil flags — Apache License 2.0
- SentencePiece-vendored Protocol Buffers Lite — BSD 3-Clause license
- SentencePiece-vendored Darts-clone — BSD 3-Clause license, copyright 2008–2011 Susumu Yata
- Abseil `d38452e…` — Apache License 2.0
- cpuinfo and CLOG `8a92100…` — BSD-style permissive licenses
- Eigen `dcbaf2d…` — MPL 2.0 with supplemental Apache, BSD, MINPACK, and explanatory notices
- FarmHash `0d859a8…` — MIT-style license
- Ooura FFT2D 1.0 — Takuya Ooura permissive notice
- FlatBuffers `1872409…`, gemmlowp `16e8662…`, ml_dtypes `00d98cd…`, and Ruy `3286a34…` — Apache License 2.0 (ml_dtypes also carries Eigen notices)
- fmt `407c905…` and nlohmann/json 3.11.3 — MIT License
- Apple metal-cpp 26 — Apache License 2.0

Protocol Buffers `90b73ac…` is a separate build-only dependency under its BSD
license; it is distinct from the protobuf-lite code compiled from the
SentencePiece vendored tree.

The exact source revisions/archive digests, build classifications, license-file
SHA-256 values, and complete distributed license texts are packaged under
`Contents/Resources/ambient-music/` and inside the Ambient Music helper. See
`source-provenance.json` for the machine-checked inventory.

The optional `google/magenta-realtime-2` model weights are not bundled. Their
model card identifies them as Creative Commons Attribution 4.0 (CC BY 4.0).
Aiden downloads only the pinned revision after the user accepts the terms and
chooses Download. See `resources/ambient-music/MODEL_TERMS.md` for the source,
revision, license link, and responsible-use notice.

## thinking-orbs

Copyright (c) 2026 Jakub Antalik

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
