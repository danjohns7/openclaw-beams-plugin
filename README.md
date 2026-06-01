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
# From a directory
openclaw plugins install --link /path/to/openclaw-teleport-beams

# Or from npm (once published)
openclaw plugins install @openclaw/teleport-beams
```

Then enable:

```bash
openclaw plugins enable teleport-beams
openclaw gateway restart
```

## Configuration

The plugin resolves settings in this order: plugin config → environment variables → defaults.

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
| `TSH_PATH` | Path to `tsh` binary | `/opt/homebrew/bin/tsh` |
| `TELEPORT_IDENTITY_FILE` | tbot identity file path | `/Users/atlas/.tbot/identity/identity` |
| `TELEPORT_BEAMS_PROXY` | Cluster proxy for beams | `restless-disk.beams.sh` |

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

```bash
# Example tbot config (tbot.yaml)
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

## Troubleshooting

**Beam spawn fails with "cannot relogin in non-interactive session"**
- The identity file path is wrong or the certificate expired
- Verify: `tsh beams ls --proxy=<proxy> --identity=<identity-path>`

**Commands time out**
- Beams need network access to reach the target APIs
- Check beam networking/firewall configuration in your Teleport cluster

**Plugin loaded but not intercepting**
- Verify the subagent session key contains `:subagent:` (cron and main sessions are not intercepted)
- Check gateway logs: `openclaw logs --limit 50`

## License

MIT
