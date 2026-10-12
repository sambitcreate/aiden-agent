# Aiden UI Markup evaluation

This is the Phase 2 model evaluation gate from the [inline generative UI spec](../specs/2026-10-08-inline-generative-ui-design.md) §12.

The harness is `scripts/eval-aiden-ui.ts`. It sends 30 prompts that call for a visual and 10 plain questions, each with the real `render_ui` schema and the generated `catalog` guide. It then measures:

- how often the markup parses after repair (gate: at least 98%);
- how many repairs each visual needs;
- how many characters of markup each visual uses;
- how many plain questions wrongly drew a visual (gate: none).

## Run it

```bash
npx tsx scripts/eval-aiden-ui.ts --dry-run
```

```bash
ANTHROPIC_API_KEY=… npx tsx scripts/eval-aiden-ui.ts --provider anthropic --model claude-sonnet-5-5
```

```bash
OPENAI_API_KEY=… npx tsx scripts/eval-aiden-ui.ts --provider openai --model gpt-5
```

The script uses only the key you export. It is not part of CI.

## Results

| Run | Date | Parse after repair | Repairs per visual | Markup chars | Plain-question false positives |
|---|---|---|---|---|---|
| Fixture corpus (`--dry-run`) | 2026-10-09 | 100% (8/8) | 1.13 (the deliberately broken fixture contributes 9) | 788 | n/a |
| Claude, GPT, Gemini live runs | pending | — | — | — | — |

The live runs are pending because no provider keys were available in the build environment. Run them before calling the Phase 2 gate passed. If the parse rate falls below 98%, the spec says to try a JSON fallback format.
