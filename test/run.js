'use strict';
// Standalone-package test suite for nodedrift-ci. Exercises the exact exported functions the
// shipped cli.js ships against real fixture trees on disk (.nvmrc, package.json, Dockerfile,
// .github/workflows/*.yml) — never a mocked file tree.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  buildReport, verifyLicenseWith, parseMajor, parseEnginesRange, majorSatisfiesRange,
  findDockerfilePins, findWorkflowPins, readNvmrc, readEnginesNode,
} = require('../cli.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  ok -', name);
  }).catch((err) => {
    failures.push({ name, err });
    console.log('FAIL -', name, '\n       ', err.message);
  });
}

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  await check('parseMajor extracts the first integer, or null for an unversioned alias', () => {
    assert.equal(parseMajor('20.11.0-alpine'), 20);
    assert.equal(parseMajor('v18'), 18);
    assert.equal(parseMajor('lts/hydrogen'), null);
    assert.equal(parseMajor('current'), null);
  });

  await check('parseEnginesRange handles >=, caret, bare, and >= with an upper bound', () => {
    assert.deepEqual(parseEnginesRange('>=18.0.0'), { min: 18, max: null, exact: null });
    assert.deepEqual(parseEnginesRange('>=18.0.0 <19.0.0'), { min: 18, max: 19, exact: null });
    assert.deepEqual(parseEnginesRange('^18.0.0'), { min: 18, max: 19, exact: null });
    assert.deepEqual(parseEnginesRange('18'), { min: null, max: null, exact: 18 });
    assert.equal(parseEnginesRange(''), null);
  });

  await check('majorSatisfiesRange: a floor-only range never flags a HIGHER major', () => {
    const range = parseEnginesRange('>=18.0.0');
    assert.equal(majorSatisfiesRange(20, range), true);
    assert.equal(majorSatisfiesRange(18, range), true);
    assert.equal(majorSatisfiesRange(16, range), false);
  });

  await check('majorSatisfiesRange: a bounded range excludes majors outside [min, max)', () => {
    const range = parseEnginesRange('>=18.0.0 <19.0.0');
    assert.equal(majorSatisfiesRange(18, range), true);
    assert.equal(majorSatisfiesRange(20, range), false);
    assert.equal(majorSatisfiesRange(17, range), false);
  });

  await check('readNvmrc strips a leading "v" and reads the major', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodedrift-nvmrc-'));
    fs.writeFileSync(path.join(dir, '.nvmrc'), 'v20.11.0\n');
    assert.deepEqual(readNvmrc(dir), { raw: '20.11.0', major: 20 });
    assert.equal(readNvmrc(os.tmpdir() + '/does-not-exist-nodedrift'), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('readEnginesNode reads package.json engines.node, null when absent or missing field', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodedrift-engines-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=18' } }));
    assert.equal(readEnginesNode(dir).raw, '>=18');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({}));
    assert.equal(readEnginesNode(dir), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findDockerfilePins finds every "FROM node:X" across any Dockerfile*, skips unversioned tags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodedrift-docker-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:18-slim\nRUN echo hi\n');
    fs.mkdirSync(path.join(dir, 'services', 'api'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'services', 'api', 'Dockerfile.prod'), 'FROM node:lts\nFROM node:20\n');
    const pins = findDockerfilePins(dir);
    assert.equal(pins.length, 2); // the "node:lts" FROM is skipped, "node:18-slim" and "node:20" are kept
    assert.deepEqual(pins.map((p) => p.major).sort(), [18, 20]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowPins reads a scalar node-version, ignores a template expression', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodedrift-wf-scalar-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), [
      'jobs:', '  test:', '    steps:', '      - uses: actions/setup-node@v4',
      '        with:', "          node-version: '20'", '',
    ].join('\n'));
    const pins = findWorkflowPins(dir);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].major, 20);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowPins treats a block-style matrix list as matrix, not a comparable pin', () => {
    const pins = findWorkflowPins(path.join(FIXTURES, 'matrix'));
    const matrixPins = pins.filter((p) => p.matrix);
    assert.equal(matrixPins.length, 1);
    assert.deepEqual(matrixPins[0].values, ['16', '18', '20']);
  });

  await check('buildReport free mode (no Pro): consistent fixture has zero findings', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: false });
    assert.equal(result.breach, false);
    assert.equal(result.pro, false);
    // Dockerfile/CI pins are not even collected in free mode.
    assert.equal(result.sources.pins.length, 1);
  });

  await check('buildReport Pro mode: consistent fixture (nvmrc=20, engines>=18, Dockerfile node:20, CI node-version 20) is clean', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.pins.length, 3);
  });

  await check('buildReport Pro mode: drift fixture flags both pinMismatch and enginesMismatch', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: true });
    assert.equal(result.breach, true);
    assert.ok(result.findings.some((f) => f.rule === 'pinMismatch'));
    assert.ok(result.findings.some((f) => f.rule === 'enginesMismatch'));
  });

  await check('buildReport free mode on the drift fixture: narrower engines range still catches nvmrc vs engines, even without Docker/CI scanning', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: false });
    assert.equal(result.breach, true);
    assert.equal(result.findings.every((f) => f.rule === 'enginesMismatch'), true);
    assert.equal(result.sources.pins.length, 1); // .nvmrc only — no Dockerfile/CI pin collected
  });

  await check('buildReport Pro mode: a deliberate version matrix in CI is reported as skipped, never as drift', () => {
    const result = buildReport(path.join(FIXTURES, 'matrix'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.matrixSources.length, 1);
  });

  await check('buildReport on a tree with only .nvmrc (no package.json, no Docker, no CI) is clean, not an error', () => {
    const result = buildReport(path.join(FIXTURES, 'minimal'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.enginesNode, null);
  });

  await check('buildReport throws ConfigError when --dir does not exist', () => {
    assert.throws(() => buildReport(path.join(FIXTURES, 'does-not-exist'), {}), /is not a directory/);
  });

  await check('CLI end-to-end via real subprocess: free mode runs with no key, Pro mode engages with a real minted key', () => {
    const cliPath = path.join(__dirname, '..', 'cli.js');

    const runCli = (args, env) => {
      try {
        const out = execFileSync('node', [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
      }
    };

    // Free mode, no key at all: consistent fixture is still clean (exit 0), and the CLI runs
    // successfully rather than refusing outright — license absence narrows scope, it is not a
    // hard gate on the whole tool.
    const freeRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { NODEDRIFT_KEY: '' });
    assert.equal(freeRun.code, 0);
    assert.ok(freeRun.out.includes('free'));

    // Pro mode with a real minted key: the drift fixture now fails (Dockerfile pins node:18
    // against a .nvmrc/CI of 20, which free mode alone could not see).
    const devVarsPath = path.join(os.homedir(), '.hive_devtools_license_keys', 'nodedrift.dev.vars');
    const devVars = fs.readFileSync(devVarsPath, 'utf8');
    const privB64 = devVars.match(/LICENSE_PRIVATE_KEY=(\S+)/)[1];
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
    const payload = Buffer.from(JSON.stringify({ product: 'nodedrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`ND1.${payload}`).end().sign(privateKey).toString('base64url');
    const realKey = `ND1.${payload}.${sig}`;

    const proRun = runCli(['check', '--dir', path.join(FIXTURES, 'drift')], { NODEDRIFT_KEY: realKey });
    assert.equal(proRun.code, 1);
    assert.ok(proRun.out.includes('Pro'));

    const proCleanRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { NODEDRIFT_KEY: realKey });
    assert.equal(proCleanRun.code, 0);
  });

  await check('license: a key signed by the real private key verifies true against the matching public key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'nodedrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`ND1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`ND1.${payload}.${sig}`, pubPem), true);
  });

  await check('license: a tampered key is rejected', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'nodedrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`ND1.${payload}`).end().sign(privateKey).toString('base64url');
    const tamperedPayload = Buffer.from(JSON.stringify({ product: 'nodedrift-pro', iat: 0 })).toString('base64url');
    assert.equal(verifyLicenseWith(`ND1.${tamperedPayload}.${sig}`, pubPem), false);
  });

  await check('license: non-canonical base64url (coin-flip tamper-bypass shape) is rejected, not accepted by luck', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'nodedrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`ND1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`ND1.${payload}.${sig}AB`, pubPem), false);
  });

  await check('license: a key signed by a DIFFERENT private key is rejected by this public key', () => {
    const { publicKey: pubA } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { privateKey: privB } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPemA = pubA.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'nodedrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`ND1.${payload}`).end().sign(privB).toString('base64url');
    assert.equal(verifyLicenseWith(`ND1.${payload}.${sig}`, pubPemA), false);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  else console.log('All nodedrift-ci standalone test groups passed.');
}

main();
