// Node.js SEA (Single Executable Application) Build Script for DISLogger.
// Bundles the application code and dependencies, generates the SEA blob,
// and fuses it into a standalone binary executable for Windows and Linux.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const STAGING = path.join(DIST, 'dislogger-dist');

const isWin = os.platform() === 'win32';
const exeName = isWin ? 'dislogger.exe' : 'dislogger';
const targetExe = path.join(DIST, exeName);
const bundlePath = path.join(DIST, 'bundle.cjs');
const blobPath = path.join(DIST, 'sea-prep.blob');

console.log('=== DISLogger SEA Build Pipeline ===\n');

// 1. Prepare output directories
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(STAGING, { recursive: true });

// 2. Bundle application into a single CommonJS file using esbuild
console.log('1. Bundling JavaScript with esbuild...');
try {
  execSync(`npx -y esbuild "${path.join(ROOT, 'src/server.js')}" --bundle --platform=node --target=node18 --format=cjs --outfile="${bundlePath}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (err) {
  console.error('Failed to bundle with esbuild:', err.message);
  process.exit(1);
}

// 3. Generate SEA preparation blob
console.log('\n2. Generating SEA blob...');
try {
  execSync(`node --experimental-sea-config "${path.join(ROOT, 'sea-config.json')}"`, {
    cwd: ROOT,
    stdio: 'inherit',
  });
} catch (err) {
  console.error('Failed to generate SEA blob:', err.message);
  process.exit(1);
}

// 4. Copy Node.js binary
console.log(`\n3. Copying Node.js runtime binary to ${exeName}...`);
fs.copyFileSync(process.execPath, targetExe);

// Remove code signature on macOS if applicable
if (os.platform() === 'darwin') {
  try { execSync(`codesign --remove-signature "${targetExe}"`); } catch {}
}

// 5. Inject SEA blob into executable via postject
console.log('\n4. Injecting SEA blob via postject...');
const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const postjectCmd = isWin
  ? `npx -y postject "${targetExe}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse "${fuse}" --overwrite`
  : (os.platform() === 'darwin'
      ? `npx -y postject "${targetExe}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse "${fuse}" --macho-segment-name NODE_SEA --overwrite`
      : `npx -y postject "${targetExe}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse "${fuse}" --overwrite`);

try {
  execSync(postjectCmd, { cwd: ROOT, stdio: 'inherit' });
} catch (err) {
  console.warn('Postject note:', err.message);
}

// 6. Assemble complete distribution folder
console.log('\n5. Assembling distribution folder...');
const distBin = path.join(STAGING, exeName);
fs.copyFileSync(targetExe, distBin);
if (!isWin) {
  fs.chmodSync(distBin, 0o755);
}

// Copy config.json and public assets
if (fs.existsSync(path.join(ROOT, 'config.json'))) {
  fs.copyFileSync(path.join(ROOT, 'config.json'), path.join(STAGING, 'config.json'));
}

const copyDir = (src, dest) => {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
};
copyDir(path.join(ROOT, 'public'), path.join(STAGING, 'public'));
const logsStaging = path.join(STAGING, 'logs');
fs.mkdirSync(logsStaging, { recursive: true });
const sampleLogsDir = path.join(ROOT, 'sample_logs');
if (fs.existsSync(sampleLogsDir)) {
  for (const f of fs.readdirSync(sampleLogsDir)) {
    if (f.endsWith('.dislog') || f.endsWith('.json')) {
      fs.copyFileSync(path.join(sampleLogsDir, f), path.join(logsStaging, f));
    }
  }
}

console.log('\n==================================================');
console.log(`SUCCESS! Single Executable Application built successfully:`);
console.log(`Executable Binary : ${distBin}`);
console.log(`Distribution Dir  : ${STAGING}`);
console.log('==================================================\n');
