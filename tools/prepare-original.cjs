'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const asar = require('@electron/asar');
const bundleEdits = require('./bundle-edits.json');
const computerToolEdits = require('./computer-tool-edits.json');

const sourceHash = '90cc89d452e4ba4be38f418d783e7584aa6139686a0f93e1fb10d46380d46743';
const helperHash = 'ecebae29b5c2f5b60104df5827df20141438e05d22b7a59229c558f65497c0bb';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function applyEdits(original, edits, name) {
  const parts = [];
  let cursor = 0;
  for (const [offset, remove, add] of edits) {
    if (offset < cursor || offset + remove > original.length) {
      throw new Error(`Invalid source edit in ${name}`);
    }
    parts.push(original.subarray(cursor, offset), Buffer.from(add, 'utf8'));
    cursor = offset + remove;
  }
  parts.push(original.subarray(cursor));
  return Buffer.concat(parts);
}

function recoverGatewaySchema(staging) {
  const coordinator = fs.readFileSync(path.join(staging, 'dist/node-agent-coordinator/main.cjs'), 'utf8');
  const match = coordinator.match(/\bB5\s*=\s*"([A-Za-z0-9+/=]+)"/);
  if (!match) throw new Error('Could not locate the embedded gateway schema');
  const bytes = zlib.inflateRawSync(Buffer.from(match[1], 'base64'), { maxOutputLength: 2_000_000 });
  const schema = JSON.parse(bytes);
  if (schema.contract !== 'sand-gateway' || !schema.methods?.sendPrompt) {
    throw new Error('The embedded gateway schema did not match Grok Bot 0.79.3');
  }
  return schema;
}

function recoverComputerCatalog(helper) {
  const start = helper.indexOf(Buffer.from('{\n  "tools": ['));
  const end = start < 0 ? -1 : helper.indexOf(0, start);
  if (end < 0) throw new Error('Could not locate the embedded computer tool catalog');
  const catalog = JSON.parse(helper.subarray(start, end));
  catalog.tools = catalog.tools.filter(tool => Object.hasOwn(computerToolEdits, tool.name));
  for (const tool of catalog.tools) {
    for (const [segments, ...replacement] of computerToolEdits[tool.name]) {
      const parent = segments.slice(0, -1).reduce((value, key) => value[key], tool);
      const key = segments.at(-1);
      if (replacement.length) parent[key] = replacement[0];
      else delete parent[key];
    }
  }
  if (catalog.tools.length !== Object.keys(computerToolEdits).length) {
    throw new Error('The embedded computer tool catalog is incomplete');
  }
  return catalog;
}

function prepareOriginal(sourceApp, staging) {
  const archive = path.join(sourceApp, 'Contents/Resources/app.asar');
  const helperPath = path.join(sourceApp, 'Contents/Helpers/Grok Bot Computer Use.app/Contents/MacOS/CUGrokBotService');
  if (!fs.existsSync(archive) || !fs.existsSync(helperPath)) {
    throw new Error(`Install Grok Bot 0.79.3 for Apple silicon at ${sourceApp}, or set GROK_SOURCE_APP`);
  }
  const helper = fs.readFileSync(helperPath);
  if (sha256(fs.readFileSync(archive)) !== sourceHash || sha256(helper) !== helperHash) {
    throw new Error('This build requires the original Grok Bot 0.79.3 Apple silicon bundle');
  }
  asar.extractAll(archive, staging);
  for (const [relative, { input, output, edits }] of Object.entries(bundleEdits)) {
    const file = path.join(staging, relative);
    const original = fs.readFileSync(file);
    if (sha256(original) !== input) throw new Error(`Unexpected original bytes in ${relative}`);
    const changed = applyEdits(original, edits, relative);
    if (sha256(changed) !== output) throw new Error(`Unexpected patched bytes in ${relative}`);
    fs.writeFileSync(file, changed);
  }
  const main = path.join(staging, 'dist/electron-main');
  fs.writeFileSync(path.join(main, 'local-gateway-schema.json'), JSON.stringify(recoverGatewaySchema(staging), null, 2) + '\n');
  const computerCatalog = path.join(main, 'computer-tool-catalog.json');
  fs.writeFileSync(computerCatalog, JSON.stringify(recoverComputerCatalog(helper), null, 2) + '\n');
  return computerCatalog;
}

module.exports = { prepareOriginal };
