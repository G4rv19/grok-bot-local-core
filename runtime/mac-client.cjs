"use strict";
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
class MacClient {
  constructor(command) {
    this.command = command;
    this.pending = new Map();
    this.nextId = 0;
  }
  start() {
    if (this.child) return;
    const child = spawn(this.command, [], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.child = child;
    const failed = () => {
      if (this.child !== child) return;
      this.close();
    };
    child.once("error", failed);
    child.once("close", failed);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const task = this.pending.get(message.id);
      if (!task) return;
      this.pending.delete(message.id);
      task.resolve(message.result ?? { error: message.error });
    });
    child.stdin.on("error", failed);
  }
  async request(method, params, signal) {
    this.start();
    if (!this.ready)
      this.ready = this.send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "grok-bot-local", version: "0.2.0" },
      }).then(() => {
        this.child.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }) + "\n",
        );
      });
    await this.ready;
    return this.send(method, params, signal);
  }
  async send(method, params, signal) {
    signal?.throwIfAborted();
    const id = ++this.nextId;
    let timer, abort;
    try {
      return await new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        abort = () => {
          this.pending.delete(id);
          reject(new Error("Mac action stopped"));
          this.close();
        };
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("The local Mac helper timed out"));
          this.close();
        }, 120000);
        this.child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async call(name, args, signal, allowedApps) {
    return this.request(
      "tools/call",
      {
        name,
        arguments: args,
        ...(allowedApps ? { allowed_apps: allowedApps } : {}),
      },
      signal,
    );
  }
  close() {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    for (const task of this.pending.values())
      task.reject(new Error("The local Mac helper stopped"));
    this.pending.clear();
    child?.kill("SIGTERM");
  }
}
module.exports = { MacClient };
