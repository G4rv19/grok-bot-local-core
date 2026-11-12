"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { BUILTINS } = require("./agent-builtins.cjs");
const { RootSkills } = require("./root-skills.cjs");

class AgentSkills {
  constructor(store, options = {}) {
    this.store = store;
    this.shared = new RootSkills(path.dirname(store.root), options.bundled);
  }
  list(agent) {
    const stored = [
      ...this.store.load(agent.id).skills,
      ...BUILTINS.map((skill) => ({
        ...this.shape({ ...skill, createdAt: 1794268800000 }),
        source: "managed",
        sourceRef: "grok-bot-local/reconstructed-v1",
      })),
      ...this.shared
        .list()
        .map((skill) => ({
          ...this.shape(skill),
          source: "managed",
          sourceRef: "pstack/0.2.0",
        })),
    ];
    const root = path.join(agent.path, ".grokbot/skills");
    if (!fs.existsSync(root)) return stored;
    const discovered = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(root, entry.name, "SKILL.md");
      if (!fs.existsSync(file)) continue;
      const relative = path.relative(
        fs.realpathSync(root),
        fs.realpathSync(file),
      );
      if (
        relative.startsWith("..") ||
        path.isAbsolute(relative) ||
        fs.statSync(file).size > 200000
      )
        continue;
      const markdown = fs.readFileSync(file, "utf8");
      const description =
        /^description:\s*(.+)$/m
          .exec(markdown)?.[1]
          ?.replace(/^['"]|['"]$/g, "") ??
        markdown
          .split("\n")
          .find((line) => line.trim() && !line.startsWith("#")) ??
        "";
      discovered.push(
        this.shape({
          id:
            "file-" +
            crypto.createHash("sha256").update(file).digest("hex").slice(0, 20),
          name:
            /^name:\s*(.+)$/m
              .exec(markdown)?.[1]
              ?.replace(/^['"]|['"]$/g, "") || entry.name,
          description,
          body: markdown,
          filePath: file,
          createdAt: fs.statSync(file).birthtimeMs,
        }),
      );
    }
    return [...stored, ...discovered];
  }
  shape({
    id = crypto.randomUUID(),
    name,
    description = "",
    body,
    filePath = "",
    createdAt = Date.now(),
  }) {
    return {
      id,
      name,
      description,
      body,
      filePath,
      createdAt,
      helperScripts: [],
      lastRunAt: null,
      nextRunAt: null,
      pluginId: null,
      publishedByCurrentUser: false,
      runs: [],
      scheduleDescription: null,
      source: "workflow",
      sourceRef: null,
      trigger: null,
    };
  }
  save(agent, spec, id) {
    if (
      typeof spec.name !== "string" ||
      !spec.name.trim() ||
      typeof spec.body !== "string" ||
      spec.body.length > 200000
    )
      throw new Error("Enter a skill name and a body under 200,000 characters");
    if (spec.trigger)
      throw new Error(
        "Scheduled skills are not implemented; save this skill without a schedule",
      );
    const previous =
      id && this.store.load(agent.id).skills.find((skill) => skill.id === id);
    if (id && !previous) throw new Error("This saved skill does not exist");
    const skill = this.shape({
      ...previous,
      ...spec,
      id: previous?.id,
      createdAt: previous?.createdAt,
    });
    this.store.commit(agent.id, "skill", skill);
    return this.list(agent);
  }
  read(agent, id, resource) {
    const skill = this.list(agent).find(
      (skill) => skill.id === id || skill.name === id,
    );
    if (!skill) throw new Error("This Grok Bot skill does not exist");
    if (resource) return this.shared.resource(skill, resource);
    return {
      id: skill.id,
      name: skill.name,
      body: skill.body,
      filePath: skill.filePath,
    };
  }
  remove(agent, id) {
    if (!this.store.load(agent.id).skills.some((skill) => skill.id === id))
      throw new Error("Only user-created saved skills can be deleted");
    this.store.commit(agent.id, "delete-skill", id);
    return this.list(agent);
  }
}
module.exports = { AgentSkills };
