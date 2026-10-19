# Remote speech request gzip (2026-10-18)

The Aiden Remote v1 contract revision 34 adds `speech-request-gzip-v1` to authenticated
`GET /server.features` only when the speech service is wired. iOS and Android
clients may send gzip-compressed JSON to `POST /speech/transcriptions` only after
seeing this token; older hosts continue to receive identity JSON. The endpoint
also accepts explicit `Content-Encoding: identity`. The existing `chat:write`
authorization, reauthorization after buffering, exact JSON and PCM validation,
and 60-second recording cap are unchanged.

The host caps encoded bytes and expanded JSON independently at 2,561,024 bytes.
It decodes exactly one gzip member, validates its CRC32 and ISIZE trailer, and
rejects trailing bytes, concatenated members, malformed streams and other or
combined content codings. The desktop router tests exercise the wire route and
its 400/413/415 failures, including compressed expansion above the limit.

On the committed two-second PCM fixture (44-byte WAV header removed), the
complete transcription JSON is 85,431 identity bytes and 55,932 gzip level 6
bytes: 29,499 bytes or 34.53% saved. This is a fixture byte comparison; live
recordings and upload latency remain unmeasured.
