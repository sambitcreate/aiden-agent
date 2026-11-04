# Bot plans C round 1 tool fixes

- Initial batched reads exceeded the tool output budget. Switched to bounded reads for source and review evidence.
- The counting transaction proxy must bind untouched methods to the real transaction because it uses private fields. The durable Conversation reads LiveDoc through commit, not snapshot. Corrected test instrumentation before counting these failures as behavioral RED.
- Steers join the run at the next tool boundary. The mixed-input counting case now queues the steer behind a held tool and measures the following tool.
- The transaction's appendEntry has typed and untyped overloads. Counting instrumentation forwards both through Reflect.apply; the initial narrowly typed wrapper failed whole-project types.
- The assigned .papercuts file is Git-ignored. It exists on disk and needs explicit inclusion by the committing owner.
