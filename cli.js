#!/usr/bin/env node
'use strict';

// nodedrift-ci — self-contained, dependency-free (Node 18+, no npm install).
// Checks whether the Node.js version your team THINKS the project targets agrees across every
// place a project can declare one: .nvmrc, package.json "engines.node", any Dockerfile's
// "FROM node:X", and any GitHub Actions workflow's "node-version:". Each of those is edited by
// a different person at a different time, so they drift silently — the classic "works in CI,
// breaks in the Docker image" (or the reverse) bug.
//
// FREE: compares .nvmrc against package.json "engines.node" only. Always runs, no key needed.
// PRO: also scans every Dockerfile and GitHub Actions workflow in the repo and cross-checks
//      every source against every other source. Unlocked by a valid offline license key — no
//      network call, no account, no phone-home.
//
// Usage:
//   node cli.js check [--dir <path>] [--json]
//
// Exit codes:
//   0 - no drift found
//   1 - a drift finding exists (any rule)
//   2 - configuration/usage error (--dir does not exist or is not a directory)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------------------
// License (BP-001 offline ECDSA-P256 verify) — same chassis as every other D-lane standalone
// CLI, including the canonical-base64url round-trip check from the first line (the tamper-
// bypass coin-flip bug this lane found and fixed 2026-09-07, then re-introduced once in
// localbolt-ci before being caught 2026-10-13 — ported in from day one here, not bolted on).
// ---------------------------------------------------------------------------------------
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEFQJIE71pIQSlpFeIs7Ho+mNxZJpjFXXvVQrCecQPYe8UP4eRPE8Gy7/sjT11yMd8jabqFn1GCr84QtkwpcpfXA==\n-----END PUBLIC KEY-----';
const LICENSE_PRODUCT = 'nodedrift-pro';

function b64urlToBuf(s) {
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const canonical = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== s) throw new Error('non-canonical base64url');
  return buf;
}

function verifyLicenseWith(key, pubPem) {
  try {
    if (typeof key !== 'string') return false;
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'ND1') return false;
    const signedData = `ND1.${parts[1]}`;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (payload.product !== LICENSE_PRODUCT) return false;
    if (payload.exp && Date.now() > payload.exp) return false;
    const v = crypto.createVerify('SHA256');
    v.update(signedData); v.end();
    return v.verify(pubPem, b64urlToBuf(parts[2]));
  } catch (e) { return false; }
}

function verifyLicense(key) {
  if (PUBLIC_KEY_PEM.includes('PLACEHOLDER')) return false;
  return verifyLicenseWith(key, PUBLIC_KEY_PEM);
}

function readLicenseKey() {
  if (process.env.NODEDRIFT_KEY) return process.env.NODEDRIFT_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.nodedrift', 'license'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function hasPro() {
  const key = readLicenseKey();
  return !!(key && verifyLicense(key));
}

// ---------------------------------------------------------------------------------------
// Version-source parsing
// ---------------------------------------------------------------------------------------

// First run of digits in a string, as an integer — "20.11.0-alpine" -> 20, "lts/hydrogen" -> null.
function parseMajor(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

// package.json "engines.node" range string -> { exact } or { min, max } (max exclusive) or null.
function parseEnginesRange(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const str = s.trim();
  const ge = str.match(/>=\s*(\d+)/);
  const lt = str.match(/<\s*(\d+)/);
  const caret = str.match(/^\^\s*(\d+)/);
  if (ge) return { min: parseInt(ge[1], 10), max: lt ? parseInt(lt[1], 10) : null, exact: null };
  if (caret) {
    const m = parseInt(caret[1], 10);
    return { min: m, max: m + 1, exact: null };
  }
  const bare = str.match(/^(\d+)/);
  if (bare) return { min: null, max: null, exact: parseInt(bare[1], 10) };
  return null;
}

function majorSatisfiesRange(major, range) {
  if (major == null || !range) return true;
  if (range.exact != null) return major === range.exact;
  if (range.min != null && major < range.min) return false;
  if (range.max != null && major >= range.max) return false;
  return true;
}

function readNvmrc(rootDir) {
  const p = path.join(rootDir, '.nvmrc');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim().replace(/^v/i, '');
  return { raw, major: parseMajor(raw) };
}

function readEnginesNode(rootDir) {
  const p = path.join(rootDir, 'package.json');
  if (!fs.existsSync(p)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const raw = pkg && pkg.engines && pkg.engines.node;
    if (!raw) return null;
    return { raw, range: parseEnginesRange(raw) };
  } catch (e) {
    return null;
  }
}

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage']);
function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir)) {
    if (DEFAULT_EXCLUDE_DIRS.has(e)) continue;
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Every "FROM node:<tag>" line in every Dockerfile under rootDir.
function findDockerfilePins(rootDir) {
  const pins = [];
  for (const fsPath of walk(rootDir)) {
    const base = path.basename(fsPath);
    if (!/^Dockerfile(\..+)?$/.test(base)) continue;
    const text = fs.readFileSync(fsPath, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*FROM\s+node:([^\s]+)/i);
      if (!m) continue;
      const tag = m[1];
      const major = parseMajor(tag);
      if (major == null) continue; // "node:lts", "node:current" — not a pinned version, skip
      pins.push({ source: `${path.relative(rootDir, fsPath)}:${i + 1}`, raw: tag, major });
    }
  }
  return pins;
}

// Every "node-version:" declaration in every .github/workflows/*.yml(.yaml) file.
// Supports a scalar value and both inline (`[16, 18, 20]`) and block (`- 16` lines) arrays.
// A matrix (more than one distinct value declared together) is reported but never compared —
// testing multiple Node versions on purpose is not drift.
function findWorkflowPins(rootDir) {
  const pins = [];
  const wfDir = path.join(rootDir, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) return pins;
  for (const e of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/i.test(e)) continue;
    const fsPath = path.join(wfDir, e);
    const lines = fs.readFileSync(fsPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\s*)node-version:\s*(.*)$/);
      if (!m) continue;
      const indent = m[1].length;
      const rest = m[2].trim();
      let values = [];
      if (rest.startsWith('[')) {
        const inline = rest.match(/\[([^\]]*)\]/);
        if (inline) values = inline[1].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, ''));
      } else if (rest) {
        values = [rest.replace(/^['"]|['"]$/g, '')];
      } else {
        // block-style list on following, more-indented lines starting with "- "
        let j = i + 1;
        while (j < lines.length) {
          const bm = lines[j].match(/^(\s*)-\s*(.+)$/);
          if (!bm || bm[1].length <= indent) break;
          values.push(bm[2].trim().replace(/^['"]|['"]$/g, ''));
          j++;
        }
      }
      if (!values.length) continue;
      const loc = `${path.relative(rootDir, fsPath)}:${i + 1}`;
      if (values.length > 1) {
        pins.push({ source: loc, raw: values.join(','), major: null, matrix: true, values });
      } else {
        const major = parseMajor(values[0]);
        if (major != null) pins.push({ source: loc, raw: values[0], major });
      }
    }
  }
  return pins;
}

// ---------------------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------------------
function buildReport(rootDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new ConfigError(`${rootDir} is not a directory`);
  }
  const nvmrc = readNvmrc(rootDir);
  const engines = readEnginesNode(rootDir);
  const pins = [];
  if (nvmrc && nvmrc.major != null) pins.push({ source: '.nvmrc', raw: nvmrc.raw, major: nvmrc.major });

  const pro = !!opts.pro;
  let matrixSources = [];
  if (pro) {
    pins.push(...findDockerfilePins(rootDir));
    const wfPins = findWorkflowPins(rootDir);
    matrixSources = wfPins.filter((p) => p.matrix).map((p) => p.source);
    pins.push(...wfPins.filter((p) => !p.matrix));
  }

  const findings = [];

  const distinctMajors = new Set(pins.map((p) => p.major));
  if (distinctMajors.size > 1) {
    findings.push({
      rule: 'pinMismatch',
      message: `Pinned Node versions disagree: ${pins.map((p) => `${p.source}=${p.major}`).join(', ')}`,
      pins,
    });
  }

  if (engines && engines.range) {
    for (const p of pins) {
      if (!majorSatisfiesRange(p.major, engines.range)) {
        findings.push({
          rule: 'enginesMismatch',
          message: `${p.source} pins Node ${p.major}, which does not satisfy package.json engines.node "${engines.raw}"`,
          source: p.source,
          major: p.major,
          enginesNode: engines.raw,
        });
      }
    }
  }

  return {
    breach: findings.length > 0,
    pro,
    sources: { nvmrc: nvmrc && nvmrc.raw, enginesNode: engines && engines.raw, pins },
    matrixSources,
    findings,
  };
}

class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function printHumanReport(result) {
  console.log(`nodedrift-ci — mode: ${result.pro ? 'Pro (nvmrc + engines + Dockerfile + CI workflows)' : 'free (nvmrc + engines only)'}`);
  if (result.matrixSources.length) {
    console.log(`  (skipped as intentional matrix testing, not drift: ${result.matrixSources.join(', ')})`);
  }
  if (!result.findings.length) {
    console.log('  no drift found.');
  } else {
    for (const f of result.findings) console.log(`  DRIFT  [${f.rule}]  ${f.message}`);
  }
  if (!result.pro) {
    console.log('  (free mode checked .nvmrc + package.json only — Pro also checks every Dockerfile and GitHub Actions workflow: https://nodedrift-ci.madeforthisday.com)');
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log('Usage: node cli.js check [--dir <path>] [--json]');
    process.exit(command ? 0 : 2);
    return;
  }
  if (command !== 'check') {
    console.error(`Unknown command "${command}". Only "check" is supported.`);
    process.exit(2);
    return;
  }

  const dir = args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd();
  let result;
  try {
    result = buildReport(dir, { pro: hasPro() });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`nodedrift-ci config error: ${e.message}`);
      process.exit(2);
      return;
    }
    throw e;
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHumanReport(result);

  process.exit(result.breach ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  buildReport, verifyLicense, verifyLicenseWith, parseMajor, parseEnginesRange,
  majorSatisfiesRange, findDockerfilePins, findWorkflowPins, readNvmrc, readEnginesNode,
};
