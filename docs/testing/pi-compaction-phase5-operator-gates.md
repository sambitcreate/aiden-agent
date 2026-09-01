# Pi compaction Phase 5 operator gates

Status: Pending credentialed/installed operator acceptance.

These gates exercise authority and concurrency that cannot be represented by
hermetic tests. They must use disposable conversations and content-free
evidence. Do not copy prompts, summaries, credentials, or tool payloads into
the acceptance record.

## Prerequisites

- A freshly built development package from the current checkout that passes
  `npm run package:verify`.
- One paired Telegram profile with an ordinary workspace route.
- One enabled Telegram binding for a disposable Bot whose canonical chat is
  visible on Mac and at least one paired iOS or Android client.
- The Bot chat has an explicitly saved provider and model with valid operator
  credentials. Record only their identifiers.
- Back up the disposable chat's Pi journal before starting. Record the backing
  chat ID and journal path; do not record transcript contents.

Build and resolve the exact application bundle from a clean checkout:

```sh
npm ci
npm run package
npm run package:verify
find release/development -type d -name 'Aiden Agent.app' -prune -print
```

The command must print exactly one bundle under `release/development`. Launch
that bundle, not an older copy in `/Applications`.

After creating the disposable conversation, locate its journal below the
packaged production profile. Match the file's v4 header `id` to the chat ID in
the app, then set `JOURNAL` to that exact absolute path:

```sh
find "$HOME/Library/Application Support/Aiden Agent/pi-compaction-sessions" \
  -type f -name '*.jsonl' -print
JOURNAL='/absolute/path/to/the-matched-chat.jsonl'
cp -p -- "$JOURNAL" "$JOURNAL.phase5-backup.$(date +%Y%m%d%H%M%S)"
```

Use this content-safe inspection command before and after each compaction. It
parses locally but prints only the journal path, format, chat ID, entry counts,
checkpoint IDs, and token counts—never messages or summaries:

```sh
node -e 'const fs=require("node:fs");const p=process.argv[1];const rows=fs.readFileSync(p,"utf8").trimEnd().split("\n").map(JSON.parse);const h=rows[0]??{};const cs=rows.filter(x=>x.type==="compaction");console.log(JSON.stringify({path:p,format:h.version,chatId:h.id,entries:rows.length-1,compactions:cs.length,checkpoints:cs.map(x=>({id:x.id,tokensBefore:x.tokensBefore}))},null,2))' "$JOURNAL"
```

## Gate A — credentialed Telegram parity

Status: Pending.

1. On Mac, open the canonical Bot chat and record its chat ID, Bot ID, saved
   provider ID, saved model ID, and journal path.
2. Add enough disposable history from Mac to make manual compaction useful.
3. From the bound Telegram route, choose Session → Compact and confirm it.
4. Verify Telegram reports success, Mac and the paired native client still
   open the same canonical chat, and no replacement conversation was created.
5. Inspect the journal with the content-safe command above. Verify exactly one
   new source-format-v4 `compaction` entry, a retained tail, and summary usage.
   Record counts and IDs only.
6. Send one follow-up from Telegram and one from Mac. Verify both append to the
   same journal and still use the chat's saved provider/model.
7. Switch to the ordinary Telegram workspace route and compact its disposable
   history. Verify its chat ID and journal are distinct from the Bot chat and
   no Bot persona or checkpoint crosses the boundary.

Pass evidence:

- [ ] Package build identity and timestamp
- [ ] Canonical Bot chat ID and unchanged provider/model IDs
- [ ] One checkpoint-entry count delta and unchanged journal path
- [ ] Mac/native/Telegram views point to the same Bot chat
- [ ] Ordinary Telegram chat ID and distinct journal path
- [ ] No transcript-bearing evidence captured

## Gate B — packaged multi-surface concurrency

Status: Pending.

1. In the packaged app, start a long-running turn on the canonical Bot chat
   from Mac or a paired native client.
2. While it owns the turn lease, confirm compaction from bound Telegram.
3. Verify Telegram presents the busy result, the active turn continues, and
   the journal's compaction-entry count does not change.
4. After the turn settles, retry Telegram compaction. Verify it succeeds and
   creates exactly one checkpoint.
5. Alternate disposable follow-ups across Mac, the paired native client, and
   bound Telegram. Verify one ordered history, one provider/model binding, and
   one journal are retained.
6. Exercise normal deletion/archive behavior for the disposable Bot. Verify
   all surfaces close consistently and none can append or compact afterward.

Pass evidence:

- [ ] Busy response observed while another surface held the lease
- [ ] Zero checkpoint delta during the rejected attempt
- [ ] Exactly one checkpoint after the admitted retry
- [ ] Ordered cross-surface continuation in one canonical chat
- [ ] Archive/delete closes every surface consistently
- [ ] No transcript-bearing evidence captured

## Reproducible automated baseline

Run before recording either operator gate:

```sh
npm run test:compaction
npm run test:telegram
npm run test:bots
npm run test:aiden-remote
npm run type-check
npm run lint
npm run package
npm run package:verify
```

For native consumers, run the generic signing-disabled iOS test build and
Android `testDebugUnitTest` on hosts with their documented Xcode and Java/SDK
prerequisites. A missing toolchain is a blocked gate, not a pass.
