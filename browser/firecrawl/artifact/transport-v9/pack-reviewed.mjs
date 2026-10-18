import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(recipe, '../..');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonicalText = file => Buffer.from(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
const provenance = read(path.join(recipe, 'provenance.json'));
if (process.version !== provenance.toolchain.node) throw new Error('Use the recorded Node version');
const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--dist', '--out', '--pnpm'].includes(process.argv[i]) || !process.argv[i + 1]) {
    throw new Error('Usage: node pack-reviewed.mjs --dist BUILD_DIST --out NEW_OUTPUT_DIRECTORY --pnpm PNPM_10_11_CLI');
  }
  flags.set(process.argv[i], path.resolve(process.argv[i + 1]));
}
if (flags.size !== 3) throw new Error('--dist, --out and --pnpm are required');
const out = flags.get('--out');
if (fs.existsSync(out)) throw new Error('Output must be a new directory');
function git(args) {
  const result = spawnSync('git', ['-C', packageRoot, ...args], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || 'Source Git identity check failed');
  return result.stdout.trim();
}
const repo = git(['rev-parse', '--show-toplevel']);
const relativeOut = path.relative(repo, out);
if (!relativeOut.startsWith('..') && !path.isAbsolute(relativeOut)) throw new Error('Output must be outside the source repository');
git(['merge-base', '--is-ancestor', provenance.sourceCommit, 'HEAD']);
for (const [file, expected] of Object.entries(provenance.sourceFiles)) {
  if (hash(canonicalText(path.join(packageRoot, file))) !== expected) throw new Error('Source differs: ' + file);
}
const dist = flags.get('--dist');
const names = fs.readdirSync(dist).sort();
if (JSON.stringify(names) !== JSON.stringify(Object.keys(provenance.distFiles).sort())) throw new Error('Unexpected dist file list');
for (const [file, expected] of Object.entries(provenance.distFiles)) {
  if (hash(fs.readFileSync(path.join(dist, file))) !== expected) throw new Error('Dist differs: ' + file);
}
const runtimeManifest = canonicalText(path.join(recipe, 'runtime-package.json'));
if (hash(runtimeManifest) !== provenance.runtimeManifestSha256) throw new Error('Runtime manifest differs');
const version = spawnSync(process.execPath, [flags.get('--pnpm'), '--version'], { encoding: 'utf8', windowsHide: true });
if (version.status !== 0 || version.stdout.trim() !== '10.11.0') throw new Error('Use the recorded pnpm10.11.0 CLI');
if (hash(fs.readFileSync(flags.get('--pnpm'))) !== provenance.toolchain.pnpmCliSha256) throw new Error('pnpm CLI identity differs');
fs.mkdirSync(path.join(out, 'stage/dist'), { recursive: true });
for (const file of names) fs.copyFileSync(path.join(dist, file), path.join(out, 'stage/dist', file));
fs.writeFileSync(path.join(out, 'stage/package.json'), runtimeManifest);
fs.mkdirSync(path.join(out, 'artifacts'));
const args = [flags.get('--pnpm'), '--dir', path.join(out, 'stage'), '--ignore-workspace', '--config.ignore-scripts=true', 'pack', '--pack-destination', path.join(out, 'artifacts')];
const result = spawnSync(process.execPath, args, { cwd: path.join(out, 'stage'), encoding: 'utf8', windowsHide: true, timeout: 30000 });
fs.writeFileSync(path.join(out, 'pack.stdout.txt'), result.stdout ?? '');
fs.writeFileSync(path.join(out, 'pack.stderr.txt'), result.stderr ?? '');
if (result.status !== 0) throw new Error('pnpm pack failed: ' + result.stderr);
const produced = path.join(out, 'artifacts', provenance.normalPackFilename);
const bytes = fs.readFileSync(produced);
const actual = { sha256: hash(bytes), integrity: 'sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') };
if (actual.sha256 !== provenance.artifact.sha256 || actual.integrity !== provenance.artifact.integrity) throw new Error('Archive differs from reviewed bytes');
if (provenance.normalPackFilename !== provenance.artifact.filename) fs.renameSync(produced, path.join(out, 'artifacts', provenance.artifact.filename));
const receipt = { sourceCommit: provenance.sourceCommit, sourceHead: git(['rev-parse', 'HEAD']), node: process.version, nodeSha256: hash(fs.readFileSync(process.execPath)), pnpmCliSha256: hash(fs.readFileSync(flags.get('--pnpm'))), recipeSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))), provenanceSha256: hash(fs.readFileSync(path.join(recipe, 'provenance.json'))), actualChildPid: result.pid, actualExit: result.status, artifact: { filename: provenance.artifact.filename, ...actual }, sourceAndDistHashesMatch: true, scope: 'Normal pnpm pack of exact reviewed dist/DTS and production manifest; no rebuild, install, lock mutation, external publish or provider operation.' };
fs.writeFileSync(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt));
