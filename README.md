# openclaw-teleport-beams

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that delegates tasks to autonomous AI agents running inside [Teleport Beams](https://goteleport.com/docs/enroll-resources/beams/) — ephemeral, isolated VMs with their own LLM credentials.

## What it does

Provides a `beam_agent` tool that OpenClaw's main agent can call to delegate work. The task runs as a full autonomous agent (Claude Code, Codex, etc.) inside an isolated Beam VM, using the beam's own API credentials. The host never shares its keys.

```
OpenClaw (host) — orchestrator
  └── beam_agent("build a REST API for todos")
        └── Beam VM spawns
              └── claude --print runs autonomously
                    ├── Uses beam's ANTHROPIC_API_KEY (proxied via Teleport)
                    ├── Full tool access (bash, files, web)
                    └── Returns output
        └── Output captured, beam destroyed
```

**Lifecycle:**
1. Main agent calls `beam_agent` tool with a task
2. Plugin spawns a Beam, runs the agent CLI inside it
3. Agent executes autonomously using the beam's LLM credentials
4. Output is returned to the main agent
5. Beam is destroyed

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) `>= 2026.4.x`
- [Teleport](https://goteleport.com) cluster with Beams enabled
- `tsh` CLI installed on the host
- A machine identity ([tbot](https://goteleport.com/docs/enroll-resources/machine-id/getting-started/)) with `beam-user` role
- Beams configured with LLM API access (API keys/proxy in beam environment)

## Install

```bash
git clone https://github.com/danjohns7/openclaw-beams-plugin.git
openclaw plugins install --link ./openclaw-beams-plugin
openclaw plugins enable teleport-beams
openclaw gateway restart
```

## Configuration

`identityFile` and `beamsProxy` are **required**.

### Via `openclaw.json`

```json
{
  "plugins": {
    "entries": {
      "teleport-beams": {
        "enabled": true,
        "config": {
          "tshPath": "/usr/local/bin/tsh",
          "identityFile": "/var/lib/tbot/identity/identity",
          "beamsProxy": "your-cluster.teleport.sh",
          "defaultAgent": "claude",
          "defaultTimeout": 300
        }
      }
    }
  }
}
```

### Via environment variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TSH_PATH` | Path to `tsh` binary | `tsh` (uses PATH) |
| `TELEPORT_IDENTITY_FILE` | tbot identity file path | *(required)* |
| `TELEPORT_BEAMS_PROXY` | Cluster proxy address | *(required)* |

### Config options

| Option | Description | Default |
|--------|-------------|---------|
| `defaultAgent` | Agent CLI: `"claude"`, `"codex"`, or custom command | `"claude"` |
| `defaultTimeout` | Max execution time in seconds | `300` |

## Tool usage

The main agent sees `beam_agent` as a tool it can call:

```
beam_agent({ task: "Build a snake game in Python and run it" })
beam_agent({ task: "Research current BTC price", agent: "claude", timeout: 60 })
beam_agent({ task: "Fix the tests", agent: "codex" })
```

### Parameters

| Param | Type | Description |
|-------|------|-------------|
| `task` | string | Task description (required) |
| `agent` | string | Agent CLI to use (optional, default from config) |
| `timeout` | number | Max seconds (optional, default from config) |

### Agent presets

| Name | Command |
|------|---------|
| `claude` | `claude --print --permission-mode bypassPermissions "<task>"` |
| `codex` | `codex exec --full-auto "<task>"` |
| *(custom)* | `<command> "<task>"` |

## How beams provide LLM access

Teleport Beams come pre-configured with LLM API credentials as environment variables:

```bash
ANTHROPIC_API_KEY=teleport
ANTHROPIC_BASE_URL=https://anthropic.your-cluster.teleport.sh
OPENAI_API_KEY=teleport
OPENAI_BASE_URL=https://openai.your-cluster.teleport.sh
```

These proxy LLM requests through the Teleport cluster, providing:
- **No key sharing** — the host never exposes its API keys to subagents
- **Audit trail** — all LLM calls are logged through Teleport
- **Access control** — beam-level policies govern which models are available
- **Cost isolation** — usage is attributed to the beam's identity

## Identity setup

Use [tbot](https://goteleport.com/docs/enroll-resources/machine-id/getting-started/) for renewable machine credentials:

```yaml
# tbot.yaml
version: v2
onboarding:
  join_method: token
  token: your-join-token
storage:
  type: directory
  path: /var/lib/tbot/identity
outputs:
  - type: identity
    destination:
      type: directory
      path: /var/lib/tbot/identity
```

The identity needs a role with permissions to create, exec, and remove beams.

## Limitations

- **Beam startup latency**: Spawning a beam adds ~5-10s before the agent starts.
- **No persistent state**: Beam filesystem is destroyed after the task. Output must be captured in the tool result.
- **Output size**: Agent output is buffered in memory (max 10MB). Very large outputs may be truncated.
- **Orphan beams on crash**: If the gateway process dies mid-execution, the beam persists until its TTL expires.

## Troubleshooting

**Plugin fails to load with "identityFile is required"**
- Set `identityFile` in plugin config or export `TELEPORT_IDENTITY_FILE`

**Beam spawn fails with "cannot relogin in non-interactive session"**
- Identity file path is wrong or certificate expired
- Verify: `tsh beams ls --proxy=<proxy> --identity=<identity-path>`

**Agent times out**
- Increase `defaultTimeout` in config or pass `timeout` per-call
- Check if the beam has network access to LLM API endpoints

**Agent returns empty output**
- The agent CLI may not be installed in the beam
- Check beam has `claude` or `codex` available

## License

MIT
