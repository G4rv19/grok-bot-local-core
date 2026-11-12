'use strict';
// Build a separate local app using the installed vendor app as input.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const asar = require('@electron/asar');
const { prepareOriginal } = require('./prepare-original.cjs');
const root = path.resolve(__dirname, '..');
const sourceApp = process.env.GROK_SOURCE_APP || '/Applications/Grok Bot.app';
const output = path.join(root, 'build/Grok Bot Local.app');
const staging = path.join(root, 'build/staging');
async function main() {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
  const computerCatalog = prepareOriginal(sourceApp, staging);
  for (const name of fs.readdirSync(path.join(root, 'runtime')).filter(name => name.endsWith('.cjs'))) fs.copyFileSync(path.join(root, 'runtime', name), path.join(staging, 'dist/electron-main', name));
  for(const name of fs.readdirSync(path.join(root,'src/renderer')).filter(name=>/\.(js|css)$/.test(name))) fs.copyFileSync(path.join(root,'src/renderer',name),path.join(staging,'dist/renderer/assets',name));
  fs.cpSync(path.join(root, 'src/skill-packs'), path.join(staging, 'dist/electron-main/skill-packs'), { recursive: true });
  if (fs.existsSync(path.join(root, 'node_modules'))) fs.cpSync(path.join(root, 'node_modules'), path.join(staging, 'node_modules'), { recursive: true, filter: file => !file.includes('/.cache/') && !file.split(path.sep).includes('.bin') });
  if (!fs.existsSync(output)) cp.execFileSync('ditto', [sourceApp, output]);
  fs.rmSync(path.join(output, 'Contents/Helpers/Grok Bot Computer Use.app'), { recursive: true, force: true });
  const resources = path.join(output, 'Contents/Resources');
  fs.rmSync(path.join(resources, 'local-runtime'), { recursive: true, force: true });
  fs.mkdirSync(path.join(resources, 'local-tools'), { recursive: true });
  fs.copyFileSync('/opt/homebrew/bin/rg', path.join(resources, 'local-tools/rg'));
  fs.chmodSync(path.join(resources, 'local-tools/rg'), 0o755);
  const nativeApp = path.join(output, 'Contents/Helpers/Grok Bot Local Helper.app');
  fs.mkdirSync(path.join(nativeApp, 'Contents/MacOS'), { recursive: true });
  fs.mkdirSync(path.join(nativeApp, 'Contents/Resources'), { recursive: true });
  cp.execFileSync('swiftc', ['-swift-version', '5', '-parse-as-library', '-O', '-target', 'arm64-apple-macos14',
    '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
    path.join(root, 'src/native/LocalHelper.swift'), '-o', path.join(nativeApp, 'Contents/MacOS/GrokBotLocalHelper')], { stdio: 'inherit' });
  fs.copyFileSync(path.join(root, 'src/native/Info.plist'), path.join(nativeApp, 'Contents/Info.plist'));
  fs.copyFileSync(computerCatalog, path.join(nativeApp, 'Contents/Resources/computer-tools.json'));
  const archive = path.join(resources, 'app.asar');
  await asar.createPackageWithOptions(staging, archive, { unpack: '**/*.{node,dylib,wasm}', unpackDir: '{dist/native,dist/deps}' });
  const hash = crypto.createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex');
  const plist = path.join(output, 'Contents/Info.plist');
  cp.execFileSync('python3', ['-c', 'import plistlib,sys;p=sys.argv[1];d=plistlib.load(open(p,"rb"));d.update(CFBundleDisplayName="Grok Bot Local",CFBundleName="Grok Bot",CFBundleIdentifier="local.garv.grokbot");d["ElectronAsarIntegrity"]={"Resources/app.asar":{"algorithm":"SHA256","hash":sys.argv[2]}};d["CFBundleURLTypes"][0]["CFBundleURLSchemes"]=["grokbot-local"];plistlib.dump(d,open(p,"wb"))', plist, hash]);
  const entitlements = path.join(root, 'build/entitlements.plist');
  fs.writeFileSync(entitlements, '<?xml version="1.0"?><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
  cp.execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, output], { stdio: 'inherit' });
  cp.execFileSync('codesign', ['--verify', '--deep', '--strict', output]);
  const manifest = { sourceApp, outputApp: output, sourceDirectory: 'build/staging', backendDirectory: 'runtime', nativeSource: 'src/native/LocalHelper.swift',
    archiveSha256: crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    nativeSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(nativeApp, 'Contents/MacOS/GrokBotLocalHelper'))).digest('hex'),
    builtAt: new Date().toISOString(), codexBundled: false, nativeBinaryRewrites: false };
  fs.writeFileSync(path.join(root, 'build/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(output);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
