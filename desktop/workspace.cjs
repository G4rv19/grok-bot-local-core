'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { exec } = require('node:child_process');

const maxBytes = 256 * 1024;

async function workspacePath(agent, input, allowMissingLeaf = false) {
  if (typeof input !== 'string' || !input || input.includes('\0')) {
    throw new Error('Enter a workspace path');
  }
  const root = await fs.realpath(agent.path);
  const target = path.resolve(root, input);
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Choose a path inside the Bot workspace');
  }
  const components = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = await fs.lstat(current).catch(error => {
      if (allowMissingLeaf && index === components.length - 1 && error.code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink()) throw new Error('Workspace tools do not follow symbolic links');
  }
  return target;
}

class WorkspaceTools {
  constructor({ approve, getPermission, background }) {
    Object.assign(this, { approve, getPermission, background });
    this.catalog = [];
  }

  async authorize(detail, signal, context) {
    signal?.throwIfAborted();
    if (this.getPermission() === 'never') throw new Error('Local actions are disabled in Settings');
    if (await this.background.authorize(context, signal)) return;
    if (!await this.approve(detail)) throw new Error('The user declined this action');
    signal?.throwIfAborted();
  }

  async read(agent, { path: input, offset = 1, limit = 200 }, signal) {
    await this.authorize(`Read ${input} in ${agent.name}'s workspace`, signal, { agent, capability: 'workspace' });
    const file = await workspacePath(agent, input);
    if (!(await fs.stat(file)).isFile()) throw new Error('Choose a regular file');
    const handle = await fs.open(file);
    try {
      const bytes = Buffer.alloc(maxBytes + 1);
      const result = await handle.read(bytes);
      const lines = bytes.subarray(0, Math.min(maxBytes, result.bytesRead)).toString('utf8').split('\n');
      return { text: lines.slice(offset - 1, offset - 1 + limit).join('\n'), truncated: result.bytesRead > maxBytes || lines.length >= offset + limit };
    } finally {
      await handle.close();
    }
  }

  async list(agent, { path: input = '.' }, signal) {
    await this.authorize(`List ${input} in ${agent.name}'s workspace`, signal, { agent, capability: 'workspace' });
    const entries = await fs.readdir(await workspacePath(agent, input), { withFileTypes: true });
    return entries.slice(0, 500).map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
  }

  async write(agent, { path: input, content }, signal) {
    if (Buffer.byteLength(content) > maxBytes) throw new Error('Write up to 256 KB at a time');
    await this.authorize(`Write ${input} in ${agent.name}'s workspace`, signal, { agent, capability: 'workspace' });
    const file = await workspacePath(agent, input, true);
    await fs.writeFile(file, content, { encoding: 'utf8', mode: 0o600, signal });
    return { path: input, bytes: Buffer.byteLength(content) };
  }

  async shell(agent, { command, cwd = '.', timeout_ms = 30000 }, signal) {
    const directory = await workspacePath(agent, cwd);
    await this.authorize(`Run this command for ${agent.name} in ${directory}?\n\n${command}`, signal, { agent, capability: 'shell' });
    return new Promise((resolve, reject) => {
      exec(command, { cwd: directory, signal, timeout: Math.max(1000, Math.min(120000, timeout_ms)), maxBuffer: maxBytes, windowsHide: true }, (error, stdout, stderr) => {
        if (signal?.aborted) return reject(signal.reason);
        resolve({ stdout, stderr, exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0, ...(error && { error: error.message }) });
      });
    });
  }

  images() { return []; }
  release() {}
}

module.exports = { WorkspaceTools };
