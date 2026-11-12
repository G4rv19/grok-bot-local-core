'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const parser = require('@babel/parser');
const root = path.resolve(__dirname, '..');
const manifest = require('../build/build-manifest.json');
const archive = path.join(manifest.outputApp, 'Contents/Resources/app.asar');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(sha(archive), manifest.archiveSha256, 'Archive changed since build');
const native = path.join(manifest.outputApp, 'Contents/Helpers/Grok Bot Local Helper.app/Contents/MacOS/GrokBotLocalHelper');
assert.equal(sha(native), manifest.nativeSha256, 'Native helper changed since build');
let verifiedSourceFiles = 0;
function verify(directory, prefix = '') {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, item.name), source = path.join(directory, item.name);
    if (item.isDirectory()) verify(source, relative);
    else {
      assert.ok(asar.extractFile(archive, relative).equals(fs.readFileSync(source)), `Source differs from archive: ${relative}`);
      verifiedSourceFiles++;
    }
  }
}
// Verify every packaged byte against the actual source staging directory.
verify(path.join(root, 'build/staging'));
for (const name of fs.readdirSync(path.join(root, 'runtime')).filter(name => name.endsWith('.cjs'))) {
  const source = fs.readFileSync(path.join(root, 'runtime', name));
  assert.ok(asar.extractFile(archive, 'dist/electron-main/' + name).equals(source), `Backend source mismatch: ${name}`);
  parser.parse(source.toString(), { sourceType: 'script' });
  assert.ok(!/codex exec|codexPath|CODEX_HOME|GROK_LOCAL_CODEX/.test(source.toString()), `Legacy launcher in ${name}`);
}
for(const name of fs.readdirSync(path.join(root,'src/renderer')).filter(name=>/\.(js|css)$/.test(name))){
  const source=fs.readFileSync(path.join(root,'src/renderer',name));
  assert.ok(asar.extractFile(archive,'dist/renderer/assets/'+name).equals(source),`Renderer source mismatch: ${name}`);
  if(name.endsWith('.js'))parser.parse(source.toString(),{sourceType:'module'});
}
assert.equal(fs.existsSync(path.join(manifest.outputApp, 'Contents/Resources/local-runtime')), false);
assert.equal(fs.existsSync(path.join(manifest.outputApp, 'Contents/Helpers/Grok Bot Computer Use.app')), false);
cp.execFileSync('codesign', ['--verify', '--deep', '--strict', manifest.outputApp]);
const original = path.join(manifest.sourceApp, 'Contents/Resources/app.asar');
let originalFilesReused = 0, originalFilesChanged = 0;
for (const entry of asar.listPackage(original).map(file => file.replace(/^\//, ''))) {
  if (asar.statFile(original, entry).files) continue;
  try { if (asar.extractFile(original, entry).equals(asar.extractFile(archive, entry))) originalFilesReused++; else originalFilesChanged++; }
  catch { originalFilesChanged++; }
}
const result = { verifiedSourceFiles, originalFilesReused, originalFilesChanged, signatureVerified: true, nativeBuiltFromSource: true, codexBundled: false };
fs.writeFileSync(path.join(root, 'build/verification.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
