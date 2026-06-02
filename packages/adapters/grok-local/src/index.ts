export const type = "grok_local";
export const label = "Grok Build (local)";

export const DEFAULT_GROK_LOCAL_MODEL = "grok-build";

export const models = [
  { id: DEFAULT_GROK_LOCAL_MODEL, label: DEFAULT_GROK_LOCAL_MODEL },
];

export const agentConfigurationDoc = `# grok_local agent configuration

Adapter: grok_local

Use when:
- You want Paperclip to run the native Grok Build CLI locally on the host machine
- You want resumable Grok sessions across heartbeats via \`--resume\`
- You want Paperclip-managed instructions and skills staged into the execution workspace using Grok's native discovery paths (\`Agents.md\` and \`.claude/skills\`)

Don't use when:
- You need a webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script without an AI coding agent loop (use process)
- Grok CLI is not installed or authenticated on the machine that runs Paperclip

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file. Paperclip stages it into the execution workspace as \`Agents.md\` when safe, otherwise falls back to \`--rules @file\`
- promptTemplate (string, optional): run prompt template
- model (string, optional): Grok model id. Defaults to grok-build.
- permissionMode (string, optional): Grok permission mode. Defaults to \`dontAsk\`
- reasoningEffort (string, optional): Grok reasoning effort passed via \`--reasoning-effort\`
- maxTurns (number, optional): maximum agent turns for the run
- outputFormat (string, optional): value passed to \`--output-format\` for the streaming event mode that the parser supports. Allowed: \`streaming-json\` (default), \`stream-json\`. Defaults to \`streaming-json\`. Set to \`stream-json\` on hosts whose \`grok\` CLI only accepts that spelling for the streaming-jsonl mode (prevents launch \`adapter_failed\`). Non-streaming \`json\`/\`text\` are accepted by some grok CLIs but are not supported here (parser expects streaming events; would lose sessionId/summary).
- command (string, optional): defaults to "grok"
- extraArgs (string[], optional): additional CLI args (note: outputFormat is applied first; put other flags here)
- env (object, optional): KEY=VALUE environment variables

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- Runs use \`grok --single\` with \`--output-format <outputFormat>\` (default \`streaming-json\`; override per-host via config if the local grok CLI requires \`stream-json\` spelling for its streaming mode).
- Only streaming-compatible values are supported (parser requires thought/text/end events); this makes launch flag choice a governed adapter policy detail for provider-fallback (ELI-880-G).
- Adapter launch is resilient to grok CLI version differences in flag spelling for the streaming output mode (addresses launch invariants surfaced in recovery runs).
- Sessions resume with \`--resume <sessionId>\` when the saved session cwd matches the current cwd.
- Paperclip stages desired runtime skills into \`.claude/skills\` inside the execution workspace so Grok discovers them as project skills.
- Use \`grok models\` to inspect authentication and available models on the host.
`;
