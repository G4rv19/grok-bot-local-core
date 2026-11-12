"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StdioClientTransport,
} = require("@modelcontextprotocol/sdk/client/stdio.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { writeJSON } = require("./agent-store.cjs");
const cli = require("./cli-connections.cjs");

class Connectors {
  constructor({ dataDir, fetch, authorize }) {
    this.file = path.join(dataDir, "connectors.json");
    this.fetch = fetch;
    this.authorize = authorize;
    this.clients = new Map();
    this.connecting = new Map();
    this.config = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : [];
  }
  describe() {
    return this.config.map(
      ({ id, name, url, command, kind, service, automatic }) => ({
        id,
        name,
        service,
        automatic: !!automatic,
        transport: kind === "cli" ? "cli" : url ? "http" : "stdio",
        endpoint: url ? new URL(url).origin : command,
        connected: this.clients.has(id),
        status: this.statuses?.get(id) || null,
      }),
    );
  }
  catalog() {
    return cli.recipes().map(({ id, name, installed }) => ({
      id,
      name,
      installed,
      configured: this.config.some((x) => x.id === id),
    }));
  }
  get(id) {
    const item = this.config.find((x) => x.id === id);
    if (!item)
      throw new Error(
        "Unknown connection. Add it in Settings → Computer or ask to add a service.",
      );
    return item;
  }
  async add(definition, signal, context) {
    if (
      !definition ||
      typeof definition !== "object" ||
      Array.isArray(definition)
    )
      throw new Error("Enter one CLI or MCP connection definition");
    const recipe = cli.recipes().find((x) => x.id === definition.recipe);
    if (definition.recipe && !recipe)
      throw new Error("Unknown connection recipe");
    if (recipe && !recipe.installed)
      throw new Error(`${recipe.name} CLI is not installed`);
    const item = recipe
      ? { ...recipe, automatic: false }
      : { ...definition, automatic: false };
    delete item.installed;
    delete item.recipe;
    if (!context?.hostApproved)
      await this.authorize(
        `Add connection ${item.name}: ${item.url || item.command}\nArguments: ${JSON.stringify(item.args || [])}`,
        signal,
        { ...context, capability: "connectionSetup" },
      );
    await this.update((current) => [
      ...current.filter((x) => x.id !== item.id),
      item,
    ]);
    return this.describe().find((x) => x.id === item.id);
  }
  async test(id) {
    const config = this.get(id);
    const result =
      config.kind === "cli"
        ? await cli.status(config)
        : { authenticated: null, toolCount: (await this.tools(id)).length };
    this.statuses ||= new Map();
    this.statuses.set(id, result);
    this.onChanged?.();
    return result;
  }
  async refreshStatuses() {
    if (this.refreshing) return this.refreshing;
    if (this.lastStatusCheck && Date.now() - this.lastStatusCheck < 60000)
      return;
    this.refreshing = Promise.all(
      this.config
        .filter(
          (item) =>
            item.kind === "cli" &&
            ["github", "gmail", "calendar"].includes(item.service),
        )
        .map(async (item) => {
          try {
            await this.test(item.id);
          } catch {
            this.statuses ||= new Map();
            this.statuses.set(item.id, {
              authenticated: false,
              message: "Connection check failed; use Test connection",
            });
          }
        }),
    ).finally(() => {
      this.lastStatusCheck = Date.now();
      this.refreshing = null;
    });
    return this.refreshing;
  }
  configure(config) {
    return this.update(() => config);
  }
  update(change) {
    const operation = (this.configurationQueue || Promise.resolve())
      .catch(() => {})
      .then(() => this.applyConfiguration(change(this.config)));
    this.configurationQueue = operation;
    return operation;
  }
  async applyConfiguration(config) {
    if (!Array.isArray(config) || config.length > 30)
      throw new Error("Expected up to 30 connection definitions");
    const ids = new Set();
    for (const item of config) {
      if (!item || !/^[a-zA-Z0-9_-]{1,60}$/.test(item.id) || ids.has(item.id))
        throw new Error("Each connector needs a unique simple id");
      ids.add(item.id);
      if (typeof item.name !== "string" || !item.name.trim())
        throw new Error("Each connector needs a name");
      if (!!item.url === !!item.command)
        throw new Error("Configure exactly one of url or command");
      if (item.url && !["https:", "http:"].includes(new URL(item.url).protocol))
        throw new Error("MCP URL must be HTTP or HTTPS");
      if (
        item.url &&
        new URL(item.url).protocol === "http:" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(
          new URL(item.url).hostname,
        )
      )
        throw new Error("Remote connectors require HTTPS");
      if (
        item.command &&
        (typeof item.command !== "string" || !path.isAbsolute(item.command))
      )
        throw new Error("Use an absolute executable path for stdio connectors");
      if (item.kind && !["cli", "mcp"].includes(item.kind))
        throw new Error("Connection kind must be cli or mcp");
      if (
        item.kind === "cli" &&
        (!item.command ||
          !Array.isArray(item.prefixes) ||
          !item.prefixes.length ||
          !item.prefixes.every(
            (x) => typeof x === "string" && /^[a-zA-Z0-9+_-]+$/.test(x),
          ))
      )
        throw new Error(
          "CLI connections need an executable and permitted command prefixes",
        );
      if (item.automatic !== undefined && typeof item.automatic !== "boolean")
        throw new Error("Automatic access must be a boolean");
      if (
        item.args &&
        (!Array.isArray(item.args) ||
          !item.args.every((arg) => typeof arg === "string"))
      )
        throw new Error("Connector args must be strings");
      for (const field of ["env", "headers"])
        if (
          item[field] &&
          (typeof item[field] !== "object" ||
            Array.isArray(item[field]) ||
            !Object.values(item[field]).every(
              (value) => typeof value === "string",
            ))
        )
          throw new Error(`Connector ${field} must contain string values`);
    }
    const transportKey = (item) =>
      JSON.stringify({ ...item, automatic: undefined });
    const changed = this.config
      .filter(
        (previous) =>
          !config.some(
            (next) =>
              next.id === previous.id &&
              transportKey(next) === transportKey(previous),
          ),
      )
      .map((x) => x.id);
    for (const id of changed) {
      await this.connecting.get(id)?.catch(() => {});
      await this.clients
        .get(id)
        ?.close()
        .catch(() => {});
      this.clients.delete(id);
      this.statuses?.delete(id);
    }
    this.config = config;
    writeJSON(this.file, config);
    this.lastStatusCheck = 0;
    this.onChanged?.();
  }
  async client(id) {
    if (this.clients.has(id)) return this.clients.get(id);
    if (this.connecting.has(id)) return this.connecting.get(id);
    const config = this.config.find((item) => item.id === id);
    if (!config)
      throw new Error("Unknown MCP connector. Add it in Settings → Computer.");
    const client = new Client(
      { name: "grok-bot-local", version: "1.0" },
      { capabilities: {} },
    );
    const transport = config.url
      ? new StreamableHTTPClientTransport(new URL(config.url), {
          fetch: this.fetch,
          requestInit: { headers: config.headers || {} },
        })
      : new StdioClientTransport({
          command: config.command,
          args: config.args || [],
          env: { PATH: process.env.PATH || "/usr/bin:/bin", ...config.env },
          stderr: "pipe",
        });
    const connecting = client
      .connect(transport, { timeout: 30000 })
      .then(() => {
        this.clients.set(id, client);
        return client;
      })
      .catch(async (error) => {
        await client.close().catch(() => {});
        throw error;
      })
      .finally(() => this.connecting.delete(id));
    this.connecting.set(id, connecting);
    return connecting;
  }
  async tools(id) {
    const config = this.get(id);
    if (config.kind === "cli")
      return [
        {
          name: "run",
          description: `Run ${config.name} with argv, without a shell. Permitted first arguments: ${config.prefixes.join(", ")}. Request help with a service command and --help; for Google schemas use schema ${config.service}.resource.method.`,
          inputSchema: {
            type: "object",
            properties: { argv: { type: "array", items: { type: "string" } } },
            required: ["argv"],
            additionalProperties: false,
          },
        },
      ];
    const client = await this.client(id),
      tools = [];
    let cursor;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < 1000);
    return tools;
  }
  async call(id, name, args, signal, context) {
    const config = this.get(id);
    if (config.kind === "cli") {
      if (name !== "run") throw new Error("CLI connections use the run tool");
      cli.checkArgs(config, args.argv);
    }
    await this.authorize(
      `Call ${config.name}: ${name}\n\n${JSON.stringify(args)}`,
      signal,
      {
        ...context,
        capability: "connections",
        connectionId: id,
        automatic: !!config.automatic,
      },
    );
    if (config.kind === "cli")
      return cli.execute(
        config.command,
        [...(config.args || []), ...args.argv],
        { signal, env: config.env },
      );
    const client = await this.client(id);
    if (!(await this.tools(id)).some((tool) => tool.name === name))
      throw new Error("Unknown tool on this connector");
    return client.callTool({ name, arguments: args }, undefined, {
      signal,
      timeout: 120000,
    });
  }
  async close() {
    await Promise.allSettled([...this.connecting.values()]);
    await Promise.all(
      [...this.clients.values()].map((client) =>
        client.close().catch(() => {}),
      ),
    );
    this.clients.clear();
  }
}
module.exports = { Connectors };
