# Reading web pages and extract mode

Aiden's agent can open a public web page and read it with the `web_fetch` tool. With extract mode on, it can instead ask for a few named values, such as a price, a version or a date, and get back only those values, each with the page line it came from.

## Where it runs

`web_fetch` is offered in normal chats on macOS and Linux wherever Web Search is on, including turns sent from a paired phone. Bots, scheduled tasks, helper agents, the Assistant and Telegram don't get it yet, and the CLI doesn't have it.

Settings → Web Search → **Web pages** has two switches:

- **Read web pages** (on by default) lets the agent read a public page as text. With Web Search off, the tool isn't offered and the row says to turn Web Search on.
- **Extract only the values asked for** (off by default) turns on extract mode. It can only be turned on once its model is set up, and it stays off while the setup is incomplete.

## What the agent sees

In read mode, `web_fetch(url)` returns the page's title and text, cut at 40,000 characters with a note when the page is longer.

With extract mode on, the tool also offers `mode: "extract"` and `fields`, and its description tells the model to use extract when it needs only specific facts:

```
web_fetch(url, mode: "extract", fields: { pro_monthly: "number: Pro plan monthly price" })
```

Each field is `"type"` or `"type: what to find"`, with up to 16 fields per call. Field names are up to 64 letters, digits or underscores and don't start with a digit, which keeps them within what Cloudflare accepts. The types are `text`, `number`, `integer`, `date`, `time`, `datetime`, `duration` (optionally `duration.days` and the other units), `list`, `list.number` and `list.date`. A bad field fails the call before anything is fetched. While extract mode is off, the model never sees `mode` or `fields`.

Every field comes back with one of three statuses:

| Status | Meaning | Shape |
| --- | --- | --- |
| `extracted` | Typed, confident (0.80 or more) and found on the page | `{ status, value, confidence, sourceLine }` |
| `uncertain` | A guess: low confidence, the wrong type, or not on the page | `{ status, guess, confidence?, sourceLine?, notFound? }` |
| `null` | The page has no value | `{ status: "null", value: null }` |

A value counts as found only when it appears in the page text (numbers, dates and words are matched the way people write them, so `$1,399` matches `1399`). A duration counts only when the page writes it with a unit that converts exactly to the one asked for ("2 weeks" is 14 days, but years never become days), and a date and time only when the date, the time and any UTC offset are on the same line. A value the page doesn't contain is always `uncertain` with `notFound: true`, never `extracted`, however confident the model was. An uncertain value is a `guess`, never a `value`, so code can't mistake one for the other.

If extraction fails (setup, a rejected key, quota, a timeout, the service being down, or an answer Aiden can't read), the tool says why and returns the page text instead, so the agent can still answer.

## Scripts and codemode

`web_fetch` declares an output schema and is available in codemode. A script gets typed data:

```ts
const page = await web_fetch({ url, mode: "extract", fields: { pro_monthly: "number" } });
const price = page.fields.pro_monthly;
if (price.status === "extracted") total += price.value;
```

The structured result is `{ url, title, mode: "read", text, truncated }` for a read, `{ url, title, mode: "extract", fields, cut }` for an extract, and `{ url, title, mode: "extract", error, text, truncated }` when extraction failed. A page read is never replayed after a crash.

## Setting up extract mode

Extract mode runs Cloudflare Workers AI's Clairic model (`@cf/cloudflare/clairic`) on your own Cloudflare account.

1. Find your 32-character account ID on the Cloudflare dashboard and save it in **Cloudflare account ID**.
2. Create a Workers AI API token and add it to the key list below it. This is the same write-only key pool Web Search uses: you can add several keys, and a key that is rejected or rate-limited cools down while the next one is tried.
3. Turn on **Extract only the values asked for**.

The model is pluggable. Adding one means a definition in `renderer/shared/web-fetch-settings.ts` and an adapter in `main/services/web-extract-models.ts`; the tool and the page checks don't change.

## What leaves the device

- **Read mode:** Aiden requests the page from its own site. It sends no cookies or credentials, refuses addresses on this computer or a private network (checked again on every redirect and when the connection opens), follows at most 5 redirects, reads at most 5 MB and gives up after 20 seconds. Only web pages and text are read; PDFs and images are refused.
- **Extract mode:** the page's text (up to 200,000 characters), the field names and their descriptions, and today's date go to Cloudflare. Your chat, your files and your keys' labels don't. Keys stay encrypted on this device and are never passed to the model or shown in the transcript.

## The values in the transcript

A completed extract shows a card under its activity line, on the desktop and on Aiden On The Go for iPhone and Android. Each field shows its name as words, its value, and the page line it came from. A guess carries a **Guess** label, a value the page doesn't have reads "Not on the page", and a guess that appears nowhere on the page reads "Not found on the page". The card is display-only: it carries at most 200 characters of each value and line, and never the page itself. Phones get it through Aiden Remote contract revision 40 (provisional); see "Web page extract recap" in [aiden-remote-api-v1.md](aiden-remote-api-v1.md). Older phones keep showing the activity line without the card.

## Smaller tool definitions

The same change trimmed the web and browser tool definitions the model reads on every turn, as pi-web-access 0.45.0 did. Measured with the o200k tokenizer over `web_search`, the browser tool loader, the 14 browser tools and the browser guidance:

| | Before | After |
| --- | --- | --- |
| Description text | 1,015 tokens | 440 tokens (−57%) |
| Whole definitions, schemas included | 2,754 tokens | 1,566 tokens (−43%) |

Browser tools no longer show the model their length and range limits. Those limits are still enforced when a tool runs. `web_fetch` itself adds 51 tokens in read mode and 163 with extract mode on.

## Credits

Field types, the 0.80 confidence threshold and the text-matching rules follow [pi-web-access](https://github.com/nicobailon/pi-web-access) (MIT); see `THIRD_PARTY_NOTICES.md`. The code is Aiden's own.
