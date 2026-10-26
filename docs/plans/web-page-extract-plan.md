# Web page reading and extract mode

Status: in review (2026-10-26) on branch `claude/project-thread-xxl0o7`. User guide: [web-fetch-extract.md](../web-fetch-extract.md).

## Goal

Bring pi-web-access v0.45.0's extract mode into Aiden as a native feature, without installing the plugin. The agent asks a page for named values (`fetch(url, mode: "extract", fields: { pro_monthly: "number: Pro plan monthly price" })`) and gets back only those values, each with its status, confidence and the page line it came from, instead of the whole page.

## Owner decisions

- **Where it lives (2026-10-26):** option a, a new page reader tool. `web_fetch` is offered in attended chats on the desktop and turns sent from paired phones, wherever Web Search is on. Bots, schedules, helper agents, the Assistant and Telegram don't get it yet.
- **Extraction model:** Cloudflare Workers AI Clairic on the person's own account, with keys in the existing Web Search key pool. The model sits behind a small adapter so another can be added later.
- **Opt-in:** extract mode is off by default and can't turn on until its model is set up. While it is off, the model never sees `mode` or `fields`.

## What shipped in the PR

1. **Tool.** `main/services/web-fetch.ts` builds `web_fetch` per generation. Read mode returns up to 40,000 characters of page text. Extract mode takes 1 to 16 typed fields. The tool declares an output schema and `codemode: true`, so scripts get typed data, and it is never replayed after a crash.
2. **Safe transport.** `main/services/web-fetch-transport.ts` reads public http(s) pages only. It refuses private and local addresses (checked at connect time and on each redirect), sends no cookies, and bounds bytes, time and redirects.
3. **Extraction.** `main/services/web-extract-core.ts` sets each field's status:
   - `extracted` only when the value is typed, its confidence is at least 0.80, and it is found in the page text;
   - otherwise `uncertain`, with the value under `guess` and `notFound` when it isn't on the page;
   - `null` when the page has no value.

   The Clairic adapter (`web-extract-models.ts`) rotates pool keys on 401, 403 and 429. When extraction fails, the tool returns the page text with the reason.
4. **Settings.** Settings → Web Search → Web pages holds the reading switch, the extract switch with its status badge, the Cloudflare account ID, the key pool and a privacy line. Portable config carries the settings without keys.
5. **Transcript.** A completed extract step carries a bounded, display-only recap (`renderer/shared/web-extract.ts`). The desktop, iOS and Android show it as a card under the step's activity line. Remote contract revision 40 (provisional) adds `extraction` to `GenerationToolStep`.
6. **Smaller tool definitions.** The web and browser tool descriptions were trimmed, measured with o200k:
   - description text went from 1,015 to 440 tokens (−57%);
   - whole definitions went from 2,754 to 1,566 tokens (−43%).

   Browser schemas no longer advertise their length and range limits, which execution still enforces.

## Open

- Re-claim Remote revision 40 at merge, after whatever `main` holds then (38 and 39 are held by open PRs).
- iOS and Android code was not compiled in the cloud container, so rely on CI and a TestFlight or Android build to hand-check the card.
- Later, possibly: give Bots and schedules the tool, add extraction models, and give the CLI `web_fetch`.
