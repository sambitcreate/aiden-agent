# Gate 5 R1 native follow-up

- The earlier canonical plan fixture had no Files item, so native transport tests could pass while phones lost the folder identity. Extended existing cases with literal paths containing spaces, read/write lifetime wording, absent file counters, and snapshot/SSE/model checks.
- No production DTO or renderer change was needed: both cards already display the host's line/details directly. Rendered UI remains outside this verification.
