# Recording lifecycle fixtures

These assets belong only to the instrumentation test APK, not the shipping app.
`recording.mp4` is a one-second, silent 32 × 32 gray H.264 clip:

```sh
ffmpeg -f lavfi -i color=c=gray:s=32x32:r=5 -t 1 -an -c:v libx264 -pix_fmt yuv420p -movflags +faststart recording.mp4
```

`server.p12` is a synthetic localhost TLS server identity (alias and password:
`recording-test`); `ca.der` is its synthetic issuing CA. They authorize no Aiden
installation or external service. The fixture server binds only `127.0.0.1`.
The tests derive the server's SPKI pin and explicitly pair the fixture CA, then
exercise the production HTTPS client without relaxing app network policy.
Certificates were generated on 2026-11-02 with a 100-year validity window to keep
this test independent of release certificate rotation. The CA signing key is
not needed by tests and is not included.
