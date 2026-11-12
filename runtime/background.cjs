"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { writeJSON } = require("./agent-store.cjs");
class Background {
  constructor({ dataDir, gateway, electron }) {
    this.gateway = gateway;
    this.electron = electron;
    this.file = path.join(dataDir, "background.json");
    this.preferences = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : {
          enabled: true,
          paused: false,
          login: false,
          grants: { workspace: true, computer: true, shell: false },
        };
    this.preferences.apps ||= [
      "com.google.Chrome",
      "com.apple.TextEdit",
      "local.garv.grokbot",
    ];
    this.preferences.appNames ||= {
      "com.google.Chrome": "Google Chrome",
      "com.apple.TextEdit": "TextEdit",
      "local.garv.grokbot": "Grok Bot Local",
    };
    this.preferences.policies ||= {};
    this.locked = false;
    this.suspended = false;
    this.owner = null;
    this.waiters = new Set();
  }
  status() {
    return {
      ...this.preferences,
      locked: this.locked,
      suspended: this.suspended,
      computerOwner: this.owner ? this.gateway.agent(this.owner).name : null,
    };
  }
  async configure(input) {
    for (const key of ["enabled", "paused", "login"])
      if (input[key] !== undefined) {
        if (typeof input[key] !== "boolean")
          throw new Error("Background settings must be booleans");
        this.preferences[key] = input[key];
      }
    if (input.grants) {
      for (const key of ["workspace", "computer", "shell"])
        if (input.grants[key] !== undefined) {
          if (typeof input.grants[key] !== "boolean")
            throw new Error("Background grants must be booleans");
          this.preferences.grants[key] = input.grants[key];
        }
    }
    if (input.policy) {
      const { agentId, apps, timeWindow, workspace, computer, shell } =
        input.policy;
      this.gateway.agent(agentId);
      if (
        apps !== undefined &&
        (!Array.isArray(apps) ||
          !apps.every(
            (x) => typeof x === "string" && /^[a-zA-Z0-9_.-]{1,200}$/.test(x),
          ))
      )
        throw new Error("Use valid application bundle identifiers");
      if (
        timeWindow &&
        (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeWindow.start) ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(timeWindow.end))
      )
        throw new Error("Use a start and end time in HH:mm");
      if (timeWindow)
        new Intl.DateTimeFormat("en", { timeZone: timeWindow.timeZone });
      for (const value of [workspace, computer, shell])
        if (value !== undefined && typeof value !== "boolean")
          throw new Error("Bot grants must be booleans");
      const value = { ...this.preferences.policies[agentId] };
      for (const [key, item] of Object.entries({
        apps,
        timeWindow,
        workspace,
        computer,
        shell,
      }))
        if (item !== undefined) value[key] = item;
      this.preferences.policies[agentId] = value;
    }
    writeJSON(this.file, this.preferences);
    if (input.login !== undefined) await this.loginAgent(input.login);
    this.updateTray();
    this.wake();
    if (this.preferences.enabled && !this.preferences.paused)
      await this.gateway.tasks.start();
  }
  policy(agentId) {
    return {
      ...this.preferences.grants,
      apps: this.preferences.apps,
      timeWindow: null,
      ...this.preferences.policies[agentId],
    };
  }
  canRun(agentId) {
    if (
      this.preferences.paused ||
      !(
        this.preferences.enabled ||
        !this.electron.BrowserWindow ||
        this.electron.BrowserWindow.getAllWindows().some((window) =>
          window.isVisible(),
        )
      )
    )
      return false;
    const window = agentId && this.policy(agentId).timeWindow;
    if (!window) return true;
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", {
        timeZone:
          window.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(new Date())
        .map((x) => [x.type, x.value]),
    );
    const time = parts.hour + ":" + parts.minute;
    return (
      window.start === window.end ||
      (window.start < window.end
        ? time >= window.start && time < window.end
        : time >= window.start || time < window.end)
    );
  }
  unattended(agent) {
    const task = this.gateway.tasks.running.get(agent?.id);
    return (
      !!task &&
      (task.origin?.kind !== "delegation" || task.background || task.unattended)
    );
  }
  async authorize(context, signal) {
    if (!context.agent || !this.unattended(context.agent)) return false;
    signal?.throwIfAborted();
    const blocked = (message) => {
      const error = new Error(message);
      error.code = "TASK_NEEDS_ATTENTION";
      throw error;
    };
    if (!this.canRun(context.agent.id))
      blocked("Automatic work is paused or outside this Bot’s allowed hours");
    const allowed =
      context.capability === "connections"
        ? context.automatic
        : this.policy(context.agent.id)[context.capability];
    if (!allowed)
      blocked(
        `Unattended ${context.capability || "local"} access needs a standing grant in Settings → Computer. Progress is saved.`,
      );
    return true;
  }
  async wait(signal) {
    signal?.throwIfAborted();
    await new Promise((resolve, reject) => {
      const done = () => {
        this.waiters.delete(done);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        this.waiters.delete(done);
        reject(signal.reason || new Error("Stopped"));
      };
      this.waiters.add(done);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
  wake() {
    for (const done of [...this.waiters]) done();
  }
  async acquire(agent, signal) {
    while (
      this.locked ||
      this.suspended ||
      (this.owner && this.owner !== agent.id)
    )
      await this.wait(signal);
    signal?.throwIfAborted();
    this.owner = agent.id;
  }
  release(agentId) {
    if (this.owner === agentId) {
      this.owner = null;
      this.wake();
    }
  }
  stop() {
    this.preferences.paused = true;
    writeJSON(this.file, this.preferences);
    for (const controller of this.gateway.jobs.values()) controller.abort();
    for (const task of this.gateway.tasks.list())
      if (task.status === "queued") this.gateway.tasks.pause(task.id);
    this.owner = null;
    this.wake();
    this.updateTray();
  }
  async loginAgent(enabled) {
    const file = path.join(
      os.homedir(),
      "Library/LaunchAgents/local.garv.grokbot.plist",
    );
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return;
    }
    const executable = this.electron.app.getPath("exe");
    const xml = (value) =>
      value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>local.garv.grokbot</string><key>ProgramArguments</key><array><string>${xml(executable)}</string><string>--background</string></array><key>RunAtLoad</key><true/></dict></plist>`,
      { mode: 0o600 },
    );
  }
  install() {
    const { app, powerMonitor, powerSaveBlocker, Tray, Menu, nativeImage } =
      this.electron;
    app.on("activate", () => this.show());
    app.on("second-instance", (_event, argv) => {
      if (!argv.includes("--background")) this.show();
    });
    this.locked = powerMonitor.getSystemIdleState(1) === "locked";
    for (const [event, key, value] of [
      ["lock-screen", "locked", true],
      ["unlock-screen", "locked", false],
      ["suspend", "suspended", true],
      ["resume", "suspended", false],
    ])
      powerMonitor.on(event, () => {
        this[key] = value;
        this.wake();
      });
    app.on("before-quit", () => {
      this.quitting = true;
      clearInterval(this.powerTimer);
      if (this.blocker !== undefined) powerSaveBlocker.stop(this.blocker);
      this.tray?.destroy();
    });
    app.on("browser-window-created", (_event, window) => {
      window.on("close", (event) => {
        if (!this.quitting && this.preferences.enabled) {
          event.preventDefault();
          window.hide();
        }
      });
      window.on("show", () => this.gateway.tasks.start().catch(() => {}));
      if (process.argv.includes("--background"))
        window.once("show", () => window.hide());
    });
    const icon = nativeImage
      .createFromPath(path.join(__dirname, "menubar-tray/assets/brand.png"))
      .resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
    this.tray = new Tray(icon);
    this.tray.setToolTip("Grok Bot Local");
    this.tray.on("click", () => this.show());
    this.updateTray();
    this.powerTimer = setInterval(() => {
      const busy = this.gateway.jobs.size > 0;
      if (busy && this.blocker === undefined)
        this.blocker = powerSaveBlocker.start("prevent-app-suspension");
      if (!busy && this.blocker !== undefined) {
        powerSaveBlocker.stop(this.blocker);
        this.blocker = undefined;
      }
    }, 1000);
  }
  show() {
    const window = this.electron.BrowserWindow.getAllWindows().find(
      (x) => !x.isDestroyed(),
    );
    window?.show();
    window?.focus();
    this.electron.app.focus({ steal: true });
  }
  updateTray() {
    if (!this.tray) return;
    this.tray.setContextMenu(
      this.electron.Menu.buildFromTemplate([
        { label: "Open Grok Bot Local", click: () => this.show() },
        {
          label: this.preferences.paused
            ? "Resume automation"
            : "Pause new automatic work",
          click: () => this.configure({ paused: !this.preferences.paused }),
        },
        { label: "Stop all work", click: () => this.stop() },
        { type: "separator" },
        { label: "Quit Grok Bot Local", click: () => this.electron.app.quit() },
      ]),
    );
  }
}
module.exports = { Background };
