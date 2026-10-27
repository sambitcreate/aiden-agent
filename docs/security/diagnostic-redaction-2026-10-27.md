# Diagnostic credential handling, 2026-10-27

The reproduced gap was a bare Replicate-style `r8_` credential surviving the complete subagent startup diagnostic sanitizer. Namespaced assignments such as x-api-key were already covered by the richer subagent sanitizer; they were not a new bypass.

A shared self-identifying-token grammar now serves ordinary diagnostic text, subagent text and Git/remote redaction. It includes existing vendor shapes plus Replicate, Groq, Perplexity, Cerebras, NVIDIA, temporary AWS, Tailscale and UUID-plus-token credential formats. Prefixes, minimum lengths and boundaries are explicit; no entropy classifier treats ordinary prose as a secret.

Provider and provider-hook free-form detail is omitted from the private runtime journal. Typed stage, code, timing and provider category remain. Sanitized bounded startup/module-loader evidence remains available. Arbitrary opaque secrets cannot be recognized reliably from text, so this is not an assurance that any unknown free-form text is safe to export. The runtime journal remains owner-only and excluded from support exports; production legacy diagnostic messages retain their existing typed filtering.

Behavioral coverage writes actual journal bytes using synthetic bare and encoded/multiline assignment credentials, verifies omission of opaque provider detail and preservation of useful bootstrap evidence. The diagnostics and subagent suites, root types and scoped lint are the local gates; exact-head review and CI remain tracked in the remediation plan.
