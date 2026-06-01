import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const AGENT_COMMANDS = {
  claude: ["claude", "--print", "--permission-mode", "bypassPermissions"],
  codex: ["codex", "exec", "--full-auto"],
};

function resolveConfig(pluginConfig) {
  const tsh = pluginConfig?.tshPath || process.env.TSH_PATH || "tsh";
  const identity = pluginConfig?.identityFile || process.env.TELEPORT_IDENTITY_FILE;
  const proxy = pluginConfig?.beamsProxy || process.env.TELEPORT_BEAMS_PROXY;
  const defaultAgent = pluginConfig?.defaultAgent || "claude";
  const defaultTimeout = pluginConfig?.defaultTimeout || 300;

  if (!identity) throw new Error("teleport-beams: identityFile is required (set in plugin config or TELEPORT_IDENTITY_FILE)");
  if (!proxy) throw new Error("teleport-beams: beamsProxy is required (set in plugin config or TELEPORT_BEAMS_PROXY)");

  return { tsh, identity, proxy, defaultAgent, defaultTimeout };
}

async function spawnBeam(cfg, logger) {
  const { stdout } = await execFileAsync(cfg.tsh, [
    "beams", "add",
    "--proxy", cfg.proxy,
    "--identity", cfg.identity,
    "--no-console",
    "--format=json",
  ], { timeout: 60000 });

  const data = JSON.parse(stdout);
  const beamId = data.id || data.metadata?.name || data.name;
  if (!beamId) throw new Error("Beam created but no ID in response");
  logger?.info?.(`teleport-beams: beam spawned: ${beamId}`);
  return beamId;
}

async function publishBeam(cfg, beamId, logger) {
  try {
    await execFileAsync(cfg.tsh, [
      "beams", "publish",
      "--proxy", cfg.proxy,
      "--identity", cfg.identity,
      beamId,
    ], { timeout: 30000 });
    const url = `https://${beamId}.${cfg.proxy}`;
    logger?.info?.(`teleport-beams: beam published: ${url}`);
    return url;
  } catch (err) {
    logger?.warn?.("teleport-beams: failed to publish beam", { beamId, error: err.message });
    return null;
  }
}

async function destroyBeam(cfg, beamId, logger) {
  try {
    await execFileAsync(cfg.tsh, [
      "beams", "rm",
      "--proxy", cfg.proxy,
      "--identity", cfg.identity,
      beamId,
    ], { timeout: 30000 });
    logger?.info?.(`teleport-beams: beam destroyed: ${beamId}`);
  } catch (err) {
    logger?.warn?.("teleport-beams: failed to destroy beam", { beamId, error: err.message });
  }
}

function buildAgentArgs(agent, task) {
  const preset = AGENT_COMMANDS[agent];
  if (preset) return [...preset, task];
  return [agent, task];
}

export default definePluginEntry({
  id: "teleport-beams",
  name: "Teleport Beams Agent Delegation",
  description: "Delegates tasks to autonomous agents running inside ephemeral Teleport Beam VMs",

  register(api) {
    const logger = api.logger;
    const cfg = resolveConfig(api.pluginConfig);

    api.registerTool({
      name: "beam_agent",
      label: "Beam Agent",
      description: "Run an autonomous AI agent inside an isolated Teleport Beam VM. The agent has its own LLM credentials and full tool access. Use for tasks requiring code execution, web access, file creation, or long-running work. Set publish=true to expose a web server running on port 8080 via a public URL.",
      parameters: {
        type: "object",
        required: ["task"],
        properties: {
          task: { type: "string", description: "Task description for the agent to complete." },
          agent: { type: "string", description: "Agent CLI to use: 'claude' (default), 'codex', or a custom command." },
          timeout: { type: "number", description: "Max execution time in seconds (default: 300)." },
          publish: { type: "boolean", description: "If true, publish port 8080 as a public HTTPS URL and keep the beam alive after the agent finishes. The URL is returned in the result." },
        },
      },

      async execute(toolCallId, params) {
        const task = params.task?.trim();
        if (!task) throw new Error("task is required");

        const agent = params.agent?.trim() || cfg.defaultAgent;
        const timeoutSec = params.timeout || cfg.defaultTimeout;
        const timeoutMs = timeoutSec * 1000;
        const publish = params.publish === true;

        let beamId;
        try {
          beamId = await spawnBeam(cfg, logger);
        } catch (err) {
          throw new Error(`Failed to spawn beam: ${err.message}`);
        }

        let output;
        let url;
        try {
          const effectiveTask = publish
            ? `${task}\n\nIMPORTANT: You are running inside an ephemeral Beam VM. If you start a web server, it MUST listen on port 8080 (the only externally accessible port). Start the server as a background process (e.g. nohup, &, or daemonize) so it keeps running after you finish. Do not use any other port.`
            : task;
          const agentArgs = buildAgentArgs(agent, effectiveTask);
          const { stdout, stderr } = await execFileAsync(cfg.tsh, [
            "beams", "exec",
            "--proxy", cfg.proxy,
            "--identity", cfg.identity,
            beamId,
            "--",
            ...agentArgs,
          ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });

          output = stdout.trim() || stderr.trim() || "(no output)";

          if (publish) {
            url = await publishBeam(cfg, beamId, logger);
            if (url) {
              output += `\n\n---\nPublished URL: ${url}`;
            }
          }
        } catch (err) {
          const timedOut = err.killed || err.code === "ETIMEDOUT";
          output = timedOut
            ? `Agent timed out after ${timeoutSec}s. Partial output:\n${err.stdout?.trim() || "(none)"}`
            : `Agent failed: ${err.message}\n${err.stderr?.trim() || err.stdout?.trim() || ""}`;
        } finally {
          if (!publish || !url) {
            await destroyBeam(cfg, beamId, logger);
          }
        }

        return {
          content: [{ type: "text", text: output }],
          details: { beamId, agent, timeoutSec, url: url || null, keepAlive: !!url },
        };
      },
    });
  },
});
