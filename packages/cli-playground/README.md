# Aiden CLI Design Studio

A separate React + [DialKit](https://www.dialkit.dev/) playground for choosing the CLI's appearance. It uses Aiden's shared theme tokens and local font assets. Sessions, permissions and prompts are simulated; the app has no connection to the CLI, credentials, models, or workspace files.

From the repository root:

```sh
npm ci --prefix packages/cli-playground
npm run cli:playground
```

Open http://127.0.0.1:4178. The server binds only to loopback. Requires Node 22.12+.

## Ten starting points

| Direction | Customization to explore |
| --- | --- |
| Quiet | Spacious stream, grouped activity, understated metadata |
| Blueprint | Project rail, timestamps, tighter spacing |
| Field Notes | Light moss journal with numbered entries |
| Midnight | Dark berry, conversation beside a split diff |
| Focus | Narrow reading column, hidden chrome and tool details |
| Workshop | Changes first, daytime palette, detailed tool results |
| Expedition | Agent roster alongside the main task |
| Signal | Compact event log, terse prompt, dense rows |
| Paper | Unframed light journal, Courier, text-only change summaries |
| Observatory | Model/context/usage strip above the conversation |

Choose a direction, then adjust palette, contrast, typography, spacing, layout, window chrome, activity, timestamps, context, usage, diff style, prompt and motion in DialKit. Try Conversation, Tools & diff, Approval and Startup. The prompt accepts a local demonstration follow-up. Replay resets the sample; Pause stops the indicator. OS reduced-motion preferences are honored.

Compare any baseline direction with your current settings (side by side on wide screens, stacked on smaller screens). Save named looks with notes in this browser, restore or delete them, and export a JSON design brief to discuss which changes to apply. DialKit's own presets save control values; the studio's Save look also stores the direction and notes. Browser storage is local and can be cleared by the browser; export a brief for a portable copy.

Font family, size and line height represent terminal-emulator preferences. Window chrome is a preview aid. Layout and motion ideas require CLI renderer work; themes use Aiden's existing token pipeline. Exported briefs explicitly remain proposals until the user chooses the implementation.

## Validation

```sh
npm run cli:playground:build
# Install the test browser once:
cd packages/cli-playground
npx playwright install chromium
npm test
```

The dedicated CI job builds this package and runs its Playwright suite. Tests cover all directions, actual DialKit edits, persistence/restoration/export, comparison, demo interactions, reduced motion, malformed saved data and phone-width layout. This package does not alter shared server contracts or mobile clients.
