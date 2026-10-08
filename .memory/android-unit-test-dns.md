# Android unit tests: resolver-independent loopback

- Symptom: AidenChatTest / AidenRemoteClientTest waits on MockWebServer requests timed out
  intermittently (e.g. `heldTurnReceiptPreservesOtherOwnerAndCannotCrossRemoval`,
  `testFiveStalledBodiesDoNotBlockAnotherRequestToTheSameHost`), on `main` as well as
  feature branches, mostly when the Mac was heavily loaded.
- Root cause: okhttp-mockwebserver 4.12 `RecordedRequest.<init>` (RecordedRequest.kt:109)
  calls `InetAddress.getHostName()` on the loopback socket address for every request.
  That reverse lookup goes to the macOS system resolver, which stalled for 5 s or more
  under load. A thread dump at the failure showed the server threads in
  `Inet6AddressImpl.getHostByAddr` and the OkHttp clients in `readResponseHeaders`.
- Fix (2026-10-05): `testOptions.unitTests.all` in `android/app/build.gradle.kts` sets
  `-Djdk.net.hosts.file=android/app/src/test/jvm-hosts`. That file maps
  127.0.0.1 and ::1 to localhost. The JDK then uses its hosts-file resolver for forward
  and reverse lookups and never calls the system resolver. Names missing from the file
  fail fast with `UnknownHostException`.
- Do not "fix" these flakes by raising wait budgets. If a new test needs another
  hostname to resolve, add it to `jvm-hosts`.
