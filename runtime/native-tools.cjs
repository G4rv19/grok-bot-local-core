"use strict";
const crypto = require("node:crypto");
const { MacClient } = require("./mac-client.cjs");

// Reuse the recovered file/shell executor. Computer control is implemented by
// our source-built Mac helper. This boundary owns local user consent.
class NativeTools {
  constructor({
    original,
    helperPath,
    catalog,
    getPermission,
    approve,
    background,
    ripgrepPath = "/opt/homebrew/bin/rg",
  }) {
    this.background = background;
    this.original = original;
    this.helperPath = helperPath;
    this.catalog = catalog.tools
      .filter(
        (tool) =>
          original.computerTools.includes(tool.name) &&
          !["computer_start_control", "computer_release_control"].includes(
            tool.name,
          ),
      )
      .map((tool) => ({
        ...tool,
        description: `${tool.name}: ${tool.description.split("\n")[0]}\nLocal implementation: input activates the target app and may move the real pointer. Use fresh app_state handles or screenshot coordinate tokens. No background-control overlay is provided.`,
      }));
    this.getPermission = getPermission;
    this.approve = approve;
    original.configureRipgrepPath?.(ripgrepPath);
    this.executors = new Map();
    this.computer = new MacClient(helperPath);
  }
  executor(agent) {
    if (!this.executors.has(agent.id))
      this.executors.set(
        agent.id,
        new this.original.LocalExecutor({
          root: agent.path,
          computerId: "grok-bot-local",
          isLocalUseBlocked: async () =>
            this.getPermission() === "never"
              ? "Local tools are disabled in settings"
              : undefined,
        }),
      );
    return this.executors.get(agent.id);
  }
  async authorize(detail, signal, context = {}) {
    signal?.throwIfAborted();
    const permission = this.getPermission();
    if (permission === "never")
      throw new Error(
        "Local actions are disabled. Change Local actions in Settings → Computer.",
      );
    if (await this.background?.authorize(context, signal)) return;
    if (permission !== "always" && !(await this.approve(detail)))
      throw new Error("The user declined this local action");
    signal?.throwIfAborted();
  }
  async exec(agent, message, signal) {
    const requestId = crypto.randomUUID(),
      executor = this.executor(agent),
      events = [];
    const cancel = () =>
      executor.handle({ kind: "cancel", requestId }, () => {});
    signal?.throwIfAborted();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      await executor.handle(
        { kind: "exec", requestId, serverMessageJson: JSON.stringify(message) },
        (event) => events.push(event),
      );
      signal?.throwIfAborted();
      return events;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
  async shell(
    agent,
    { command, cwd = agent.path, timeout_ms = 30000 },
    signal,
  ) {
    await this.authorize(
      `Run a command for ${agent.name}:\n\n${command}\n\nFolder: ${cwd}`,
      signal,
      { agent, capability: "shell" },
    );
    const timeout = Math.max(1000, Math.min(timeout_ms, 120000));
    const events = await this.exec(
      agent,
      {
        shellStreamArgs: {
          command,
          workingDirectory: cwd,
          timeout,
          hardTimeout: timeout,
          toolCallId: crypto.randomUUID(),
          closeStdin: true,
          conversationId: agent.id,
        },
      },
      signal,
    );
    const stdout = events
      .map((event) => event.message?.shellStream?.stdout?.data || "")
      .join("");
    const stderr = events
      .map((event) => event.message?.shellStream?.stderr?.data || "")
      .join("");
    const exit = events.find((event) => event.message?.shellStream?.exit)
      ?.message.shellStream.exit;
    const errors = events.filter(
      (event) => event.error || event.message?.throw,
    );
    return {
      stdout,
      stderr,
      exitCode: exit?.code ?? exit?.exitCode ?? (exit ? 0 : null),
      ...(errors.length ? { errors } : {}),
    };
  }
  async read(agent, { path: file, offset = 1, limit = 200 }, signal) {
    await this.authorize(`Read ${file} in ${agent.name}'s workspace`, signal, {
      agent,
      capability: "workspace",
    });
    return this.exec(
      agent,
      { readArgs: { path: file, offset, limit, maxChars: 30000 } },
      signal,
    );
  }
  async list(agent, { path: directory = "." }, signal) {
    await this.authorize(
      `List ${directory} in ${agent.name}'s workspace`,
      signal,
      { agent, capability: "workspace" },
    );
    return this.exec(
      agent,
      { lsArgs: { path: directory, timeoutMs: 10000 } },
      signal,
    );
  }
  async write(agent, { path: file, content }, signal) {
    await this.authorize(
      `Write ${file} in ${agent.name}'s workspace (${Buffer.byteLength(content)} bytes)`,
      signal,
      { agent, capability: "workspace" },
    );
    const events = [];
    await this.executor(agent).handle(
      {
        kind: "upload",
        requestId: crypto.randomUUID(),
        path: file,
        bytes: Buffer.from(content),
      },
      (event) => events.push(event),
    );
    signal?.throwIfAborted();
    return events;
  }
  async computerCall(agent, name, args, signal) {
    if (!this.catalog.some((tool) => tool.name === name))
      throw new Error("Unknown computer tool");
    await this.authorize(
      `${name} for ${agent.name}\n\n${JSON.stringify(args)}`,
      signal,
      { agent, capability: "computer" },
    );
    await this.background?.acquire(agent, signal);
    const result = await this.computer.call(
      name,
      args,
      signal,
      this.background?.unattended(agent)
        ? this.background.policy(agent.id).apps
        : undefined,
    );
    if (result.policyDenied) {
      const error = new Error(
        result.content?.[0]?.text || "Unattended app access needs approval",
      );
      error.code = "TASK_NEEDS_ATTENTION";
      throw error;
    }
    return result;
  }
  release(agentId) {
    this.background?.release(agentId);
  }
  // Original helper responses contain image blocks or paths. Expose images as
  // model inputs while retaining the complete original result in the journal.
  images(result) {
    const found = [];
    const walk = (value) => {
      if (!value || typeof value !== "object") return;
      if (value.type === "image" && typeof value.data === "string")
        found.push({
          type: "input_image",
          image_url: `data:${value.mimeType || "image/png"};base64,${value.data}`,
        });
      for (const item of Object.values(value))
        if (typeof item === "object") {
          if (Array.isArray(item)) item.forEach(walk);
          else walk(item);
        }
    };
    walk(result);
    if (typeof result?.outputJson === "string") {
      try {
        walk(JSON.parse(result.outputJson));
      } catch {}
    }
    return found;
  }
  close() {
    this.computer.close();
  }
}
module.exports = { NativeTools };
