// Kept free of imports: the entry prints this for `aiden help` (and bare
// `aiden`) before any of the runtime is loaded.
export const CLI_COMMAND_HELP = `Aiden commands:
  serve [--remote] [--daemon] | stop | status   Headless server: Remote, scheduling, Bots, and Telegram
  remote status|devices|pair lan|tailscale|pair-status|pair-cancel <id>|revoke <id>|roots|approve-root <path>
  auth list|login|logout                     Provider credentials (OAuth or API key)
  provider list|import <models.json>         Custom OpenAI-compatible/Ollama/LM Studio providers
  workspace list|add|remove|access|scratch    Workspace registry and tool approval tiers
  mcp list|presets|add|preset|login|logout|remove  MCP servers and browser OAuth
  schedule list|save <file>|preview <cron> [timezone]|runs|notifications [since-ms]|run|pause|resume|remove <id>
  bots list|get|catalog|notice|acknowledge|create|update|access|chat|chat-access|pause|unpause <id>
  bots enable-durable                       Back up legacy Bot history; restart daemon to switch
  bots session|send|resume|dismiss|stop|delete|approvals|approve
  telegram status|connect|configure <file>|disable|disconnect
  speech status|download|select|delete <id>|transcribe <pcm16-file> <model-id>
  app help|status|get <topic>|set <control> <value> <revision> [operation-id]
  catalog refresh|models-dev fetch|models-dev status
  insights aa|openrouter show|fetch|disconnect
  web-search show|import <settings.json>     Provider routing; keys from environment
  search <query>                            Search all session titles/previews
  import <desktop-journal|aiden-chat.json>   Copy a conversation into a new CLI session
  export <session.jsonl> [output.aiden-chat.json]
  files list|read <relative-path>           Inspect bounded workspace files
  git status|review|branches|worktrees
  worktree list|create <branch>|remove <path>
  help | --version
`;
