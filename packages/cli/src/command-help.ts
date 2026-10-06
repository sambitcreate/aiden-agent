// Kept free of imports: the entry prints this for `aiden help` before any of
// the runtime is loaded.
export const CLI_COMMAND_HELP = `Aiden commands:
  workspace list|add|remove|access|scratch    Workspace registry and tool approval tiers
  search <query>                            Search all session titles/previews
  import <desktop-journal|aiden-chat.json>   Copy a conversation into a new CLI session
  export <session.jsonl> [output.aiden-chat.json]
  auth list|login|logout                     Provider credentials (OAuth or API key)
  mcp list|presets|add|preset|login|remove    MCP servers and browser OAuth
  pi-mcp add|remove|list|login|logout         Native pi MCP configuration (also /mcp)
  provider list|import <models.json>         Custom OpenAI-compatible/Ollama/LM Studio providers
  catalog refresh|models-dev fetch|models-dev status
  insights aa|openrouter show|fetch|disconnect
  theme import <variant.json> <light|dark> <name> | export <name> <file>
  web-search show|import <settings.json>     Provider routing; keys from environment
  files list|read <relative-path>           Inspect bounded workspace files
  git status|review|branches|worktrees
  worktree list|create <branch>|remove <path>
  schedule list|save <file>|preview <cron> [timezone]|runs|notifications [since-ms]|run|pause|resume|remove <id>
  telegram status|connect|configure <file>|disable|disconnect
  speech status|download|select|delete <id>|transcribe <pcm16-file> <model-id>
  serve [--remote] [--daemon] | stop | status   Scheduling, Telegram, and Remote daemon
  remote status|devices|pair lan|tailscale|pair-status|pair-cancel <id>|revoke <id>|roots|approve-root <path>
  bots list|get|catalog|notice|acknowledge|create|update|archive|restore|access|chat|chat-access
  reset                                     Reset first-run onboarding only
`;
