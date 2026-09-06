# Aiden On The Go (Android)

Android is a debug-APK validation client for Aiden Agent on macOS. The Mac owns execution, persistence, providers, workspaces, and permissions. This app is a paired remote-control surface over a local network or Tailscale.

Public Android availability is planned for **October 2026**. Until then, pull requests run the Android verification gates without retaining an installable artifact; relevant merges to `main` publish the debug APK and its checksum. Do not treat this tree as a Play Store release.

## Current contract

- `applicationId` `sbtbiswas.AidenOnTheGo`, `versionName` `0.1.0`, `versionCode` `1`
- `AidenAppVersion.NAME` is `BuildConfig.VERSION_NAME` (Gradle `versionName` is the source of truth)
- Release minify stays off
- Pairing `deviceType` remains `iphone` or `ipad` until the OpenAPI contract, Mac, and iOS change together
- Manual setup codes use Crockford Base32 without `I` or `L`

Open the Gradle project in Android Studio, or from this directory run:

```sh
./gradlew :app:testDebugUnitTest :app:lintDebug
```

Pairing needs a reachable Mac HTTPS endpoint such as a Tailscale Serve URL. Do not use `127.0.0.1` on the phone; that address is the Android device itself.

The product and protocol sources of truth are:

- [`../docs/plans/aiden-on-the-go-plan.md`](../docs/plans/aiden-on-the-go-plan.md)
- [`../docs/aiden-remote-api-v1.md`](../docs/aiden-remote-api-v1.md)
- [`../protocol/aiden-remote/v1/openapi.json`](../protocol/aiden-remote/v1/openapi.json)
