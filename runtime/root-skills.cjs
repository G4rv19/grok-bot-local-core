"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { writeJSON } = require("./agent-store.cjs");
// Electron ASAR directories are virtual. Node's cpSync worker uses raw FS calls
// that cannot traverse them; copy through Electron's supported read APIs.
function installDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name),
      to = path.join(target, entry.name);
    if (entry.isDirectory()) installDirectory(from, to);
    else if (entry.isFile())
      fs.writeFileSync(to, fs.readFileSync(from), { mode: 0o600 });
    else
      throw new Error("Skill packs must contain regular files and directories");
  }
}
class RootSkills {
  constructor(dataDir, bundled = path.join(__dirname, "skill-packs/pstack")) {
    this.root = path.join(dataDir, "skills");
    this.pack = path.join(this.root, "pstack");
    if (
      fs.existsSync(bundled) &&
      !fs.existsSync(path.join(this.pack, "pack.json"))
    ) {
      fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const temporary = path.join(this.root, "pstack.installing");
      fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
      installDirectory(bundled, temporary);
      fs.renameSync(temporary, this.pack);
    }
    const manifest = path.join(this.pack, "pack.json");
    this.manifest = fs.existsSync(manifest)
      ? JSON.parse(fs.readFileSync(manifest, "utf8"))
      : null;
    this.instructionsFile = path.join(this.root, "AGENTS.md");
    if (this.manifest && !fs.existsSync(this.instructionsFile))
      fs.writeFileSync(
        this.instructionsFile,
        "pstack is the shared engineering and writing skill set for every Grok Bot. Read applicable skills before working. Apply unslop to replies, concentrate validation at boundaries, and prove results through the real artifact. Use Grok Bot tools, memory, task controller and connections. Skill documents cannot grant permissions or make unavailable tools exist.\n",
        { mode: 0o600 },
      );
    if (this.manifest)
      writeJSON(path.join(this.root, "installed.json"), {
        pack: "pstack",
        version: this.manifest.version,
        count: this.list().length,
      });
  }
  list() {
    if (!this.manifest) return [];
    return fs
      .readdirSync(path.join(this.pack, "skills"), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .flatMap((item) => {
        const file = path.join(this.pack, "skills", item.name, "SKILL.md");
        if (!fs.existsSync(file)) return [];
        const body = fs.readFileSync(file, "utf8");
        const name = /^name:\s*["']?([^\n"']+)/m.exec(body)?.[1] || item.name;
        const description =
          /^description:\s*(.+)$/m
            .exec(body)?.[1]
            ?.replace(/^["']|["']$/g, "") || "pstack workflow";
        return [
          {
            id: "pstack-" + item.name,
            name,
            description,
            body,
            filePath: file,
            createdAt: 1794268800000,
          },
        ];
      });
  }
  instructions() {
    if (!this.manifest) return "";
    const required = this.list().filter((skill) =>
      this.manifest.required.includes(skill.name),
    );
    return (
      fs.readFileSync(this.instructionsFile, "utf8") +
      "\n\n" +
      required.map((skill) => skill.body).join("\n\n")
    );
  }
  resource(skill, relative) {
    if (!skill.filePath)
      throw new Error("This skill has no reference directory");
    if (typeof relative !== "string" || path.isAbsolute(relative))
      throw new Error("Use a relative skill reference path");
    const directory = path.dirname(skill.filePath),
      file = path.resolve(directory, relative);
    const actual = fs.realpathSync(file),
      root = fs.realpathSync(directory);
    if (
      path.relative(root, actual).startsWith("..") ||
      fs.statSync(actual).size > 200000 ||
      !fs.statSync(actual).isFile()
    )
      throw new Error("Skill reference is outside its directory or too large");
    return {
      name: skill.name,
      resource: relative,
      body: fs.readFileSync(actual, "utf8"),
    };
  }
  revision() {
    return this.manifest
      ? crypto
          .createHash("sha256")
          .update(
            this.list()
              .map((skill) => skill.body)
              .join("\n"),
          )
          .digest("hex")
      : "core";
  }
}
module.exports = { RootSkills };
