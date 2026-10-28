# Built-in tools load on demand

Every request to the model carries the definitions of the tools it may call. Aiden used to send all of its built-in tools on every request, which was the biggest fixed cost in the context meter (**Built-in tools** in the Context tab). Two changes keep that cost small.

## One `skill` tool

Skills are listed once, in `<available_skills>` in the system prompt, and loaded through a single `skill` tool that takes the skill's `name`. Before, every skill was its own tool (`skill_<key>`) and was also listed in the prompt, so each installed skill cost tokens twice.

- The tool loads only skills the model may invoke in that chat. A workspace skill is unavailable under **No access**, and a skill that turned off its model invocation is never listed.
- Turning Skills off in Settings applies from the next `skill` call, as before.
- A Bot's `skill` tool loads only the skills granted to that Bot. The requested name is checked against the Bot's current grants when the call is made, so taking a skill away stops it at once.
- The per-skill key (`skillToolKey`) is still each skill's internal identity for grants and slash commands; it is no longer a tool name. The tool matches a listed name first and a key only when no name matches.

The CLI keeps Pi's own skill loading and its `skill_aiden_app` tool; CLI-hosted Bots keep their own per-skill tools.

## Rarely used tools load on demand

A chat starts with its everyday tools: files, commands, web search and page reading, questions, to-dos, memory, the `skill` tool, codemode and `tool_search`, the browser gateway and Bot cards. It also gets `load_tools`, whose description lists every other built-in tool in one line. The model loads what it needs by name, and the loaded tools are declared from its next step. The list lives in `ON_DEMAND_TOOL_NAMES` in `main/services/on-demand-tools.ts`: subagents, the advisor, scheduling, visuals and artifacts, images, classification, background jobs, pull-request following, Aiden's app tools, past-chat recall, Computer Use, form filling, devices, Bot routines and image inspection.

- Nothing is granted by loading. Every tool is still built, admitted, approved and run exactly as before; only the moment its definition is sent changes. `load_tools` refuses names the chat was not given.
- Once a chat has loaded or called a tool, later requests in that chat declare it from the start, so it stays put and its definition stays in the provider's prompt cache.
- A direct call to a tool that was not loaded yet fails as "not found", and the tool is declared on the next step so the retry works.
- The system prompt still describes held-back tools such as `aiden_help` and `subagent`; `load_tools` tells the model to load a tool before its first use.
- Workspace chats use this only when codemode is on (it is by default). Codemode scripts can still call every callable tool without loading it.
- Bots use the same list. Their tools stay installed, and a request simply leaves out the definitions of tools the Bot has not loaded. Bot computers (`computer`, `computer_shell`) stay declared from the start.
- The context meter counts only what is declared. Held-back tools are not shown as a deferred connection.

## Measured savings

Measured on 2026-10-28 with the end-to-end LM Studio fixture (a fresh workspace chat with Full access, the two built-in skills, codemode on), counting a quarter token per character of each tool definition as the context meter does:

| | Before | After |
| --- | --- | --- |
| Tools declared | 45 | 22 |
| Built-in tools in the Context tab | 9.7K | 3.6K |

Each installed skill now costs one prompt line instead of a tool definition plus a line. Computer Use (about 1.8K) and the device tools (about 0.8K) are held back too when those features are on, so a Mac with them enabled saves more. A Full Access Bot with subagents, routines, image sharing and Computer Use declares about 3.7K fewer tokens per request.
