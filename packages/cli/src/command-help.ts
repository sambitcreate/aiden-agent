// Kept free of imports: the entry prints this for `aiden help` (and bare
// `aiden`) before any of the runtime is loaded.
export const CLI_COMMAND_HELP = `Aiden commands:
  serve [--no-remote] [--pair lan|tailscale|--no-pair] [--daemon] | stop | status
                                            Server for phones and other clients (Remote on by default)
  service install [--network local|tailscale|both] [--no-pair] | uninstall | status
                                            Run the server at login and boot (systemd or launchd)
  remote status|devices|pair lan|tailscale|pair-status|pair-cancel <id>|revoke <id>|roots|approve-root <path>
  remote network local|tailscale|both        Who can reach the server; Tailscale is set up for you
  remote check                               Check each step a phone needs to reach the server, with fixes
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
