# Access request round 2 integration

- A partial write-protection list was reused as the temporary read privacy boundary. The process registration must supply whole profile and config directories, with the own-home exception kept explicit.
- Awaiting status repair from issue list added session-write dependencies to reads. Repair now runs in the background, retains its durable marker on failure, and reports failures through the host logger.
- The access test count changed from 51 to 52 when the parent added the malformed ordinary-issue/access-action parser case after the worker's 51-test run. This is an expected count change.

- A retained owner validator closed over the completed request tool Task API. A real Always-A then Once-B harness sequence exposed the failure; saved locations now validate through the currently executing call.
