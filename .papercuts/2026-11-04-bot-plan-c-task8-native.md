# Task 8 native papercuts

- Prep: ios/README.md does not document the focused simulator XCTest command referenced by the C plan. Use the parent's explicit destination/derived-data settings; document the exact command with the native feature.

- Initial Android compile: shared Aiden buttons put onClick before optional style arguments, so trailing lambdas bind to the wrong final argument. Use named onClick. No dependency or API change.

- Expanded iOS test compile required the fixture-loader helper returning a private scripted transport to be private too. Corrected test visibility; no behavioral assertion changed.

- Date parity audit found Java OffsetDateTime rejects host-valid offsets past 18:00. Added a behavioral RED for +23:59, then validated the calendar locally and applied the host-bounded offset explicitly. Original timestamp text stays intact.

- Real coordinator test RED found two separate iOS opt-in allowlists (client request and saved installation validation) beyond the coordinator group list. Added bot:plans to both, keeping it out of pairing grants.
- Xcode test assertions complete quickly but on-failure sysdiagnose delays result finalization. Preserved Staging stdout/session logs before waiting; subsequent runs disable verbose sysdiagnose collection while keeping xcresult and normal test logs.
