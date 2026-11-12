"use strict";
const fs = require("node:fs");
const cp = require("node:child_process");
const PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const find = (paths) => paths.find((file) => fs.existsSync(file));
function recipes() {
  const gh = find(["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);
  const gws = find([
    require("node:path").join(require("node:os").homedir(), ".cargo/bin/gws"),
    "/opt/homebrew/bin/gws",
    "/usr/local/bin/gws",
  ]);
  return [
    {
      id: "github",
      name: "GitHub",
      command: gh,
      service: "github",
      prefixes: [
        "api",
        "repo",
        "issue",
        "pr",
        "search",
        "run",
        "workflow",
        "release",
        "gist",
        "project",
      ],
    },
    {
      id: "gmail",
      name: "Gmail",
      command: gws,
      service: "gmail",
      prefixes: ["gmail", "schema"],
    },
    {
      id: "calendar",
      name: "Google Calendar",
      command: gws,
      service: "calendar",
      prefixes: ["calendar", "schema"],
    },
  ].map((item) => ({ ...item, kind: "cli", installed: !!item.command }));
}
function checkArgs(config, args) {
  if (
    !Array.isArray(args) ||
    args.length > 100 ||
    !args.every(
      (x) => typeof x === "string" && x.length <= 100000 && !x.includes("\0"),
    )
  )
    throw new Error("Use an array of command arguments");
  if (!args.length || !config.prefixes.includes(args[0]))
    throw new Error(
      "This command is outside this connection’s configured commands",
    );
  if (config.service === "github") {
    if (
      args.some((x) => /^(?:--hostname|--host)(?:=|$)/.test(x)) ||
      args.some((x) => /^https?:\/\//.test(x))
    )
      throw new Error(
        "Use GitHub resource paths on the configured GitHub account",
      );
    if (args.some((x) => /^(?:--jq|--template|--editor|--web)(?:=|$)/.test(x)))
      throw new Error(
        "Interactive and executable output options are unavailable here",
      );
    if (
      args[0] === "api" &&
      args.some((x) => /^(?:--input|-H|--header)(?:=|$)/.test(x))
    )
      throw new Error(
        "Use JSON fields; arbitrary input files and authentication headers are unavailable",
      );
  }
  if (
    ["gmail", "calendar"].includes(config.service) &&
    args[0] === "schema" &&
    !args[1]?.startsWith(config.service + ".")
  )
    throw new Error("Request a schema for this connection’s service");
  // Credentials and executable extensions are managed by the host, never by a model tool.
  if (
    args.some((x) =>
      /^(?:--access-token|--token|--credential-file|--credentials)(?:=|$)/.test(
        x,
      ),
    )
  )
    throw new Error("Credentials must stay in the CLI credential store");
}
async function execute(
  command,
  args,
  { signal, env = {}, timeout = 120000 } = {},
) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout,
        maxBuffer: 2 * 1024 * 1024,
        signal,
        env: { ...process.env, PATH, ...env },
      },
      (error, stdout, stderr) => {
        if (signal?.aborted)
          return reject(signal.reason || new Error("Stopped"));
        resolve({
          stdout,
          stderr,
          exitCode: error?.code ?? 0,
          ...(error && typeof error.code !== "number"
            ? { error: error.message }
            : {}),
        });
      },
    );
  });
}
async function status(config) {
  if (config.service === "github") {
    const result = await execute(
      config.command,
      ["auth", "status", "--json", "hosts"],
      { timeout: 15000 },
    );
    try {
      const hosts = JSON.parse(result.stdout).hosts;
      const accounts = Object.values(hosts)
        .flat()
        .filter((x) => x.active);
      return {
        authenticated: accounts.some((x) => x.state === "success"),
        accounts: accounts.map((x) => ({ login: x.login, state: x.state })),
      };
    } catch {
      return {
        authenticated: false,
        message: "Run gh auth login to connect GitHub",
      };
    }
  }
  if (["gmail", "calendar"].includes(config.service)) {
    const result = await execute(config.command, ["auth", "status"], {
      timeout: 15000,
    });
    try {
      const value = JSON.parse(result.stdout);
      return {
        authenticated: value.auth_method !== "none" && !!value.auth_method,
        setupRequired: !value.client_config_exists,
        message:
          value.auth_method === "none" ? "Google authorization required" : null,
      };
    } catch {
      return { authenticated: false, message: "Google authorization required" };
    }
  }
  return {
    authenticated: null,
    message: "Custom connection; test a documented read command",
  };
}
module.exports = { recipes, checkArgs, execute, status };
