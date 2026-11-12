"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const cp = require("node:child_process");
const { writeJSON } = require("./agent-store.cjs");
const MAX_FILE = 20 * 1024 * 1024,
  MAX_TEXT = 200000;
const imageTypes = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
const officeTypes = new Set([
  ".doc",
  ".docx",
  ".rtf",
  ".odt",
  ".xlsx",
  ".pptx",
]);
const textTypes = new Set([
  ".txt",
  ".md",
  ".csv",
  ".json",
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".css",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".log",
  ".sql",
  ".sh",
  ".ini",
]);
const decode = (value) => {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(MAX_FILE / 3) * 4 + 4
  )
    throw new Error("Invalid or oversized attachment bytes");
  const data = Buffer.from(value, "base64");
  if (data.toString("base64") !== value)
    throw new Error("Invalid attachment encoding");
  return data;
};
const plain = (xml) =>
  xml
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
class Attachments {
  constructor(dataDir) {
    this.root = path.join(dataDir, "attachments");
    for (const name of ["index", "blobs", "uploads"])
      fs.mkdirSync(path.join(this.root, name), {
        recursive: true,
        mode: 0o700,
      });
  }
  id(ref) {
    const found = /^\/attachments\/([a-f0-9]{32})\//.exec(ref || "");
    if (!found) throw new Error("Unknown attachment reference");
    return found[1];
  }
  metadata(ref, agentId) {
    const id = this.id(ref),
      file = path.join(this.root, "index", id + ".json");
    if (!fs.existsSync(file))
      throw new Error("This attachment is no longer available");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (agentId && value.owners.length && !value.owners.includes(agentId))
      throw new Error("This attachment belongs to a different Bot");
    return value;
  }
  bytes(meta) {
    const data = fs.readFileSync(path.join(this.root, "blobs", meta.blob));
    if (
      data.length !== meta.bytes ||
      crypto.createHash("sha256").update(data).digest("hex") !== meta.sha256
    )
      throw new Error("Attachment integrity check failed");
    return data;
  }
  upload({ filename, bytesBase64, agentId }) {
    return this.store(filename, decode(bytesBase64), agentId);
  }
  store(filename, data, agentId) {
    if (
      typeof filename !== "string" ||
      !filename.trim() ||
      /[\x00-\x1f]/.test(filename)
    )
      throw new Error("Enter a valid attachment filename");
    const name = path.basename(filename).slice(0, 200),
      ext = path.extname(name).toLowerCase();
    if (!data.length || data.length > MAX_FILE)
      throw new Error("Attachments must contain 1 byte to 20 MB");
    const image = imageTypes[ext],
      pdf = ext === ".pdf",
      office = officeTypes.has(ext);
    if (!image && !pdf && !office && (!textTypes.has(ext) || data.includes(0)))
      throw new Error(
        "Unsupported attachment. Use an image, PDF, text/code, CSV, DOCX, XLSX or PPTX file.",
      );
    if (pdf && !data.subarray(0, 8).toString().startsWith("%PDF-"))
      throw new Error("This file is not a PDF");
    if (
      image &&
      !(
        (image === "image/png" &&
          data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) ||
        (image === "image/jpeg" &&
          data[0] === 255 &&
          data[1] === 216 &&
          data[2] === 255) ||
        (image === "image/gif" &&
          /^GIF8[79]a/.test(data.subarray(0, 6).toString())) ||
        (image === "image/webp" &&
          data.subarray(0, 4).toString() === "RIFF" &&
          data.subarray(8, 12).toString() === "WEBP")
      )
    )
      throw new Error("Image bytes do not match the file type");
    const hash = crypto.createHash("sha256").update(data).digest("hex"),
      id = crypto
        .createHash("sha256")
        .update(`${agentId || ""}\0${name}\0${hash}`)
        .digest("hex")
        .slice(0, 32);
    const ref = `/attachments/${id}/${encodeURIComponent(name)}`,
      blob = hash + ext;
    const blobPath = path.join(this.root, "blobs", blob);
    if (!fs.existsSync(blobPath))
      fs.writeFileSync(blobPath, data, { mode: 0o600, flag: "wx" });
    const file = path.join(this.root, "index", id + ".json");
    const previous =
      fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8"));
    const meta = {
      id,
      path: ref,
      name,
      bytes: data.length,
      sha256: hash,
      blob,
      kind: image ? "image" : pdf ? "pdf" : office ? "office" : "text",
      mime: image || (pdf ? "application/pdf" : "text/plain"),
      owners: previous?.owners || (agentId ? [agentId] : []),
      createdAt: previous?.createdAt || Date.now(),
    };
    writeJSON(file, meta);
    return { path: ref };
  }
  chunk(args) {
    if (
      !/^[a-zA-Z0-9_-]{1,100}$/.test(args.uploadId) ||
      !Number.isSafeInteger(args.offset) ||
      args.offset < 0 ||
      !Number.isSafeInteger(args.totalSize) ||
      args.totalSize < 1 ||
      args.totalSize > MAX_FILE
    )
      throw new Error("Invalid attachment chunk");
    const data = decode(args.bytesBase64),
      file = path.join(this.root, "uploads", args.uploadId + ".json"),
      temporary = path.join(this.root, "uploads", args.uploadId + ".data");
    let item = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, "utf8"))
      : {
          filename: args.filename,
          agentId: args.agentId,
          totalSize: args.totalSize,
        };
    if (
      item.filename !== args.filename ||
      item.agentId !== args.agentId ||
      item.totalSize !== args.totalSize ||
      args.offset + data.length > args.totalSize
    )
      throw new Error("Attachment upload parameters changed");
    if (item.committedPath) {
      const original = this.bytes(this.metadata(item.committedPath));
      if (
        !original.subarray(args.offset, args.offset + data.length).equals(data)
      )
        throw new Error("Repeated attachment chunk differs");
      return { committedPath: item.committedPath };
    }
    if (!fs.existsSync(temporary)) {
      if (args.offset !== 0)
        throw new Error("Upload must start at offset zero");
      fs.writeFileSync(temporary, Buffer.alloc(0), { mode: 0o600 });
    }
    const received = fs.statSync(temporary).size;
    if (args.offset < received) {
      const old = fs
        .readFileSync(temporary)
        .subarray(args.offset, args.offset + data.length);
      if (!old.equals(data))
        throw new Error("Repeated attachment chunk differs");
    } else if (args.offset !== received)
      throw new Error("Attachment chunk is out of order");
    else fs.appendFileSync(temporary, data);
    if (fs.statSync(temporary).size === args.totalSize) {
      item.committedPath = this.store(
        args.filename,
        fs.readFileSync(temporary),
        args.agentId,
      ).path;
      fs.rmSync(temporary);
    }
    writeJSON(file, item);
    return { committedPath: item.committedPath || null };
  }
  claim(ref, agentId) {
    const meta = this.metadata(ref, agentId);
    if (!meta.owners.length) {
      meta.owners = [agentId];
      writeJSON(path.join(this.root, "index", meta.id + ".json"), meta);
    }
    return meta;
  }
  share(ref, from, to) {
    const meta = this.metadata(ref, from);
    if (!meta.owners.includes(to)) {
      meta.owners.push(to);
      writeJSON(path.join(this.root, "index", meta.id + ".json"), meta);
    }
    return meta.path;
  }
  readChunk({ path: ref, agentId, offset, length }) {
    const meta = this.metadata(ref, agentId);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_FILE
    )
      throw new Error("Invalid attachment range");
    return {
      bytesBase64: this.bytes(meta)
        .subarray(offset, offset + length)
        .toString("base64"),
      mime: meta.mime,
      resolvedName: meta.name,
      totalSize: meta.bytes,
    };
  }
  text(meta) {
    const file = path.join(this.root, "blobs", meta.blob);
    if (meta.kind === "text") return this.bytes(meta).toString("utf8");
    const ext = path.extname(meta.name).toLowerCase();
    if ([".doc", ".docx", ".rtf", ".odt"].includes(ext))
      return cp.execFileSync(
        "/usr/bin/textutil",
        ["-convert", "txt", "-stdout", file],
        { encoding: "utf8", timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
      );
    if (ext === ".xlsx" || ext === ".pptx") {
      const started = Date.now();
      const entries = cp
        .execFileSync("/usr/bin/unzip", ["-Z1", file], {
          encoding: "utf8",
          timeout: 3000,
          maxBuffer: 200000,
        })
        .trim()
        .split("\n");
      const read = (name) =>
        cp.execFileSync("/usr/bin/unzip", ["-p", file, name], {
          encoding: "utf8",
          timeout: Math.max(1, Math.min(3000, 8000 - (Date.now() - started))),
          maxBuffer: 2 * 1024 * 1024,
        });
      const shared =
        ext === ".xlsx" && entries.includes("xl/sharedStrings.xml")
          ? [
              ...read("xl/sharedStrings.xml").matchAll(
                /<si\b[^>]*>([\s\S]*?)<\/si>/g,
              ),
            ].map((x) => plain(x[1]))
          : [];
      const files = entries
        .filter((x) =>
          ext === ".pptx"
            ? /^ppt\/slides\/slide\d+\.xml$/.test(x)
            : /^xl\/worksheets\/sheet\d+\.xml$/.test(x),
        )
        .slice(0, ext === ".pptx" ? 100 : 20);
      const sections = [];
      let size = 0;
      for (const name of files) {
        if (Date.now() - started >= 8000 || size > MAX_TEXT) break;
        const xml = read(name);
        const text =
          ext === ".pptx"
            ? plain(xml)
            : [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)]
                .slice(0, 1000)
                .map((row) =>
                  [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)]
                    .map((cell) => {
                      const value =
                        /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] ||
                        plain(cell[2]);
                      return /\bt="s"/.test(cell[1])
                        ? shared[Number(value)] || value
                        : value;
                    })
                    .join("\t"),
                )
                .join("\n");
        sections.push(name + "\n" + text.slice(0, MAX_TEXT + 1));
        size += text.length;
      }
      return (
        sections.join("\n\n") +
        "\n[Bounded local extraction. Raw cell values; formulas are not executed. Up to 20 sheets with 1,000 rows each or 100 slides, 200,000 characters and eight seconds.]"
      );
    }
    return null;
  }
  readText(args) {
    const meta = this.metadata(args.path, args.agentId),
      text = this.text(meta);
    return text === null
      ? { kind: "binary", bytes: meta.bytes }
      : {
          kind: "text",
          bytes: meta.bytes,
          text: text.slice(0, MAX_TEXT),
          truncated: text.length > MAX_TEXT,
        };
  }
  readImage({ path: ref }) {
    const meta = this.metadata(ref);
    return meta.kind === "image"
      ? {
          dataUrl: `data:${meta.mime};base64,${this.bytes(meta).toString("base64")}`,
          width: null,
          height: null,
        }
      : null;
  }
  list(agentId) {
    return fs
      .readdirSync(path.join(this.root, "index"))
      .filter((x) => x.endsWith(".json"))
      .map((x) =>
        JSON.parse(fs.readFileSync(path.join(this.root, "index", x), "utf8")),
      )
      .filter((x) => x.owners.includes(agentId))
      .map(({ path, name, bytes, kind }) => ({ path, name, bytes, kind }))
      .slice(-50);
  }
  parts(ref, agentId) {
    const meta = this.metadata(ref, agentId);
    if (meta.kind === "image")
      return [
        {
          type: "input_image",
          image_url: `data:${meta.mime};base64,${this.bytes(meta).toString("base64")}`,
        },
      ];
    if (meta.kind === "pdf")
      return [
        {
          type: "input_file",
          filename: meta.name,
          file_data: `data:application/pdf;base64,${this.bytes(meta).toString("base64")}`,
        },
      ];
    const result = this.readText({ path: ref, agentId });
    return [
      {
        type: "input_text",
        text: `Attached file: ${meta.name}\n${result.text}${result.truncated ? "\n[Excerpt; use read_attachment to inspect the stored file.]" : ""}`,
      },
    ];
  }
  content(message, history) {
    const attached = message.batchId
      ? history.filter(
          (item) =>
            item.kind === "user-attachment" && item.batchId === message.batchId,
        )
      : [];
    return attached.length
      ? [
          {
            type: "input_text",
            text: message.content || "Please inspect the attached files.",
          },
          ...attached.map((item) => {
            const meta = this.metadata(item.file_path);
            return {
              type: "grok_attachment",
              ref: meta.path,
              bytes: meta.bytes,
              name: meta.name,
              kind: meta.kind,
            };
          }),
        ]
      : message.content;
  }
  hydrate(input, agentId) {
    return input.map((item) =>
      Array.isArray(item.content)
        ? {
            ...item,
            content: item.content.flatMap((part) =>
              part.type === "grok_attachment"
                ? this.parts(part.ref, agentId)
                : [part],
            ),
          }
        : item,
    );
  }
}
module.exports = { Attachments, MAX_FILE };
