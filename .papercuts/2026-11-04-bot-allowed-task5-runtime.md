# Task 5 runtime/service

- Initial service RED `/tmp/bot-allowed-d-task5-service-red.log` is missing-module setup evidence only.
- B behavioral RED `/tmp/bot-allowed-d-task5-b-red.log`: 20 pass/2 fail, no settle hook or retry-safe successful authorization receipt.
- Service boundary RED `/tmp/bot-allowed-d-task5-service-boundary-red.log`: 11 pass/1 fail; tally completion I/O after a real publication incorrectly aborted the current human allowance. Publication-phase bookkeeping now logs/refuses release and leaves history repairable.
- B history RED `/tmp/bot-allowed-d-task5-b-history-red.log`: an Always whose D settlement failed must recover as historical saved-for-future on every retry choice, without reinstalling aliases.
- Concurrent storage/application APIs arrived as agreed; earlier type errors in the new B hook/deps were owned in-progress changes, not root/store regressions.
- The concurrency fixture initially made reads wait on their own update transaction, deadlocking live publication guards. Keep updates serialized and reads on the current committed snapshot, as the real store does. This cancelled test run was fixture/setup evidence, not a production RED.
- A final acknowledgement-loss test initially passed assembly deps into the service factory after the live helper shadowed its deps field. Corrected the test to call the existing service's history reconciliation; that failure was setup only.
