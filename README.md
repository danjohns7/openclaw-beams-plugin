# openclaw-teleport-beams

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that automatically routes subagent shell execution through [Teleport Beams](https://goteleport.com/docs/enroll-resources/beams/) — ephemeral, isolated VMs.

## What it does

When OpenClaw spawns a subagent, every `bash`/`exec` tool call from that subagent is transparently wrapped to execute inside a dedicated Beam VM. The main agent session and LLM inference stay on your host node; only shell commands run in the Beam.

```
Host (OpenClaw gateway)
  ├── Main agent session (local)
  └── Subagent session
        ├── LLM inference (local, via API)
        └── bash/exec tool calls → routed through Beam VM
```

**Lifecycle:**
1. Subagent makes its first `bash`/`exec` call → plugin spawns a Beam
2. All subsequent shell commands in that session execute inside the same Beam
3. Subagent ends → plugin destroys the Beam

If beam creation fails, the plugin degrades gracefully — commands run locally.

## Requirements

- [OpenClaw](https://github.com/openclaw/openclaw) `>= 2026.4.x`
- [Teleport](https://goteleport.com) cluster with Beams enabled
- `tsh` CLI installed on the host
- A machine identity ([tbot](https://goteleport.com/docs/enroll-resources/machine-id/getting-started/)) or active `tsh` session with `beam-user` role

## Install

```bash
# Clone and link
git clone https://github.com/danjohns7/openclaw-beams-plugin.git
openclaw plugins install --link ./openclaw-beams-plugin
```

Then enable and configure:

```bash
openclaw plugins enable teleport-beams
openclaw gateway restart
```

## Configuration

Both `identityFile` and `beamsProxy` are **required** — the plugin will error on load if they're missing.

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
          "beamsProxy": "your-cluster.teleport.sh"
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
| `TELEPORT_BEAMS_PROXY` | Cluster proxy address for beams | *(required)* |

## How it works

The plugin registers three OpenClaw hooks:

### `before_prompt_build`

For subagent sessions, injects context into the system prompt telling the agent that its shell commands execute in an isolated Beam VM and how to access persistent storage on the host.

### `before_tool_call`

Intercepts `bash` and `exec` tool calls from subagent sessions. Lazily spawns a Beam on first use, then wraps every command:

```bash
# Original command from the subagent:
curl https://api.example.com/data

# Wrapped by plugin:
tsh beams exec --proxy=cluster.teleport.sh --identity=/path/to/identity beam-id -- bash -c 'curl https://api.example.com/data'
```

### `subagent_ended`

When the subagent session completes (or errors/times out), destroys the associated Beam via `tsh beams rm`.

## Identity setup

The recommended approach is [tbot](https://goteleport.com/docs/enroll-resources/machine-id/getting-started/) for renewable machine credentials:

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

The identity needs a role with `beam-user` permissions to create and manage beams.

## Subagent access to host

Since commands execute in the Beam, subagents that need to read/write persistent files must SSH back to the host:

```bash
# From inside the Beam:
tsh ssh root@your-host "cat /path/to/file"
tsh ssh root@your-host "echo 'result' > /path/to/output"
```

The plugin automatically injects this guidance into the subagent's system prompt.

## Limitations

- **Orphan beams on crash**: If the gateway process dies mid-session, the associated Beam won't be cleaned up (it will expire naturally based on your cluster's TTL). A periodic `tsh beams ls` + cleanup cron is recommended for production use.
- **Beam startup latency**: The first `bash`/`exec` call in a subagent session incurs ~5-10s of beam provisioning time.
- **Beam environment is minimal**: Beams are fresh VMs. Tools like `curl`, `node`, etc. may not be pre-installed. Subagents adapt (e.g., using `python3 urllib` instead of `curl`).

## Troubleshooting

**Plugin fails to load with "identityFile is required"**
- Set `identityFile` in plugin config or export `TELEPORT_IDENTITY_FILE`

**Beam spawn fails with "cannot relogin in non-interactive session"**
- The identity file path is wrong or the certificate has expired
- Verify: `tsh beams ls --proxy=<proxy> --identity=<identity-path>`

**Commands time out**
- Beams need network access to reach target APIs
- Check beam networking/firewall configuration in your Teleport cluster

**Plugin loaded but not intercepting**
- Only subagent sessions are intercepted (session key must contain `:subagent:`)
- Main agent, cron, and direct chat sessions are not affected
- Check gateway logs: `openclaw logs --limit 50`

## License

MIT
