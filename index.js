import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TSH = "/opt/homebrew/bin/tsh";
const DEFAULT_IDENTITY = "/Users/atlas/.tbot/identity/identity";
const DEFAULT_BEAMS_PROXY = "restless-disk.beams.sh";

const sessionBeamMap = new Map();
const pendingBeamPromises = new Map();

function isSubagentSession(sessionKey) {
  return typeof sessionKey === "string" && sessionKey.includes(":subagent:");
}

function resolveConfig(pluginConfig) {
  return {
    tsh: pluginConfig?.tshPath || process.env.TSH_PATH || DEFAULT_TSH,
    identity: pluginConfig?.identityFile || process.env.TELEPORT_IDENTITY_FILE || DEFAULT_IDENTITY,
    proxy: pluginConfig?.beamsProxy || process.env.TELEPORT_BEAMS_PROXY || DEFAULT_BEAMS_PROXY,
  };
}

async function spawnBeam(cfg, logger) {
  try {
    const { stdout } = await execFileAsync(cfg.tsh, [
      "beams", "add",
      "--proxy", cfg.proxy,
      "--identity", cfg.identity,
      "--no-console",
      "--format=json",
    ], { timeout: 60000 });

    const data = JSON.parse(stdout);
    const beamId = data.id || data.metadata?.name || data.name;
    if (!beamId) {
      logger?.warn?.("teleport-beams: beam created but no ID in response", { data });
      return null;
    }
    logger?.info?.(`teleport-beams: beam spawned: ${beamId}`);
    return beamId;
  } catch (err) {
    logger?.error?.("teleport-beams: failed to spawn beam", { error: err.message });
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

async function ensureBeamForSession(cfg, sessionKey, logger) {
  if (sessionBeamMap.has(sessionKey)) {
    return sessionBeamMap.get(sessionKey);
  }
  if (pendingBeamPromises.has(sessionKey)) {
    return pendingBeamPromises.get(sessionKey);
  }
  const promise = spawnBeam(cfg, logger).then((beamId) => {
    pendingBeamPromises.delete(sessionKey);
    if (beamId) sessionBeamMap.set(sessionKey, beamId);
    return beamId;
  });
  pendingBeamPromises.set(sessionKey, promise);
  return promise;
}

function wrapCommand(cfg, command, beamId) {
  const escaped = command.replace(/'/g, "'\\''");
  return `${cfg.tsh} beams exec --proxy=${cfg.proxy} --identity=${cfg.identity} ${beamId} -- bash -c '${escaped}'`;
}

const BEAM_CONTEXT_PROMPT = `
## Execution Environment — Teleport Beam

Your shell commands execute inside an isolated, ephemeral Beam VM (not on the host node directly).

- To read/write persistent files on the host: \`tsh ssh root@<hostname> "<command>"\`
- Beam state does not persist after your session ends — write results back to the host.
`;

export default definePluginEntry({
  id: "teleport-beams",
  name: "Teleport Beams Subagent Isolation",
  description: "Routes all subagent bash/exec tool calls through ephemeral Teleport Beam VMs",

  register(api) {
    const logger = api.logger;
    const cfg = resolveConfig(api.pluginConfig);

    api.on("before_prompt_build", (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey || !isSubagentSession(sessionKey)) return;
      return { prependContext: BEAM_CONTEXT_PROMPT };
    });

    api.on("before_tool_call", async (event, ctx) => {
      const sessionKey = ctx?.sessionKey;
      if (!sessionKey || !isSubagentSession(sessionKey)) return;

      const toolName = event.toolName?.toLowerCase();
      if (toolName !== "bash" && toolName !== "exec") return;

      const command = event.params?.command;
      if (!command || typeof command !== "string") return;

      const beamId = await ensureBeamForSession(cfg, sessionKey, logger);
      if (!beamId) return;

      const wrappedCommand = wrapCommand(cfg, command, beamId);
      logger?.debug?.(`teleport-beams: wrapping command for ${sessionKey} via beam ${beamId}`);

      return { params: { ...event.params, command: wrappedCommand } };
    });

    api.on("subagent_ended", async (event, ctx) => {
      const sessionKey = event.targetSessionKey;
      const beamId = sessionBeamMap.get(sessionKey);
      if (!beamId) return;

      logger?.info?.(`teleport-beams: destroying beam ${beamId} for ended session ${sessionKey}`);
      await destroyBeam(cfg, beamId, logger);
      sessionBeamMap.delete(sessionKey);
    });
  },
});
