# Pi compaction CI worker prerequisite

The new zero-retained-tail child compaction coverage can enter VCC summary-budget recovery. The standalone runtime-subagents CI lane omitted `vcc-build`, while local `npm test` built the worker via `test:compaction` → `test:vcc`. CI run37033546177 job110926895585 failed at agent-compatibility.test.ts667 with provider_failed/compaction-failed. Removing only build/main/pi-vcc-worker.js locally reproduced the exact failure; restoring the build resolved it.

Registered vcc-build as a runtime-subagents prerequisite and included that lane in its allowed mapping. Extended the existing CI registry behavioral mapping test so child compaction cannot silently lose its worker build. Validation on Node22.22.3:47 CI policy/registry tests; actual lane-plan-selected VCC build from absent worker followed by zero-recent compaction test passes.

Separate renderer-other job110926895509 failed during npm ci, before tests, with esbuild's binary rejected by macOS as EBADMACHO (errno88). No source workaround or infrastructure retry is included.
