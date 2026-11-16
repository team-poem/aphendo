import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertTrustedKey, createManifest, verifySignature } from './release-signing.mjs';

const version = '9.8.7';
const data = Buffer.from('synthetic installer data');
const keyId = randomBytes(8);
const pair = generateKeyPairSync('ed25519');
const otherPair = generateKeyPairSync('ed25519');
const wrap = (value) => Buffer.from(value).toString('base64');

function publicKey(keyPair, id = keyId) {
  const der = keyPair.publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.concat([Buffer.from('Ed'), id, der.subarray(-32)]);
  return wrap(`untrusted comment: test public key\n${raw.toString('base64')}\n`);
}

function signature(keyPair, content = data, signedVersion = version, id = keyId) {
  const digest = createHash('blake2b512').update(content).digest();
  const digestSignature = sign(null, digest, keyPair.privateKey);
  const comment = `timestamp:123456\tversion:${signedVersion}`;
  const block = Buffer.concat([Buffer.from('ED'), id, digestSignature]).toString('base64');
  const globalSignature = sign(null, Buffer.concat([digestSignature, Buffer.from(comment)]), keyPair.privateKey).toString('base64');
  return wrap(`untrusted comment: test signature\n${block}\ntrusted comment: ${comment}\n${globalSignature}\n`);
}

const publicA = publicKey(pair);
const publicB = publicKey(otherPair);
const validSignature = signature(pair);
const verifyWith = (content, sig, pub = publicA, ver = version) => verifySignature(content, sig, pub, ver);

function temporaryInstaller(t, content = data, sig = validSignature) {
  const dir = mkdtempSync(join(tmpdir(), 'aphendo-signing-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const installer = join(dir, `Aphendo_${version}_x64-setup.exe`);
  writeFileSync(installer, content);
  writeFileSync(`${installer}.sig`, sig);
  return installer;
}

function config(pub = publicA, ver = version) {
  return { version: ver, plugins: { updater: { pubkey: pub } } };
}

test('accepts a correctly signed installer and matching pinned key', () => {
  assert.doesNotThrow(() => assertTrustedKey(publicA, publicA));
  assert.doesNotThrow(() => verifyWith(data, validSignature));
});

test('rejects changed public keys, including one with the same key ID', () => {
  assert.throws(() => assertTrustedKey(publicB, publicA));
  assert.throws(() => verifyWith(data, validSignature, publicB));
  assert.throws(() => verifyWith(data, validSignature, publicKey(otherPair, randomBytes(8))));
});

test('rejects tampered installer, trusted comment, and signed version', () => {
  assert.throws(() => verifyWith(Buffer.from('modified'), validSignature));
  const lines = Buffer.from(validSignature, 'base64').toString('utf8').trimEnd().split('\n');
  lines[2] = lines[2].replace('timestamp:123456', 'timestamp:123457');
  assert.throws(() => verifyWith(data, wrap(`${lines.join('\n')}\n`)));
  assert.throws(() => verifyWith(data, validSignature, publicA, '9.8.8'));
  assert.throws(() => verifyWith(data, signature(pair, data, '9.8.8')));
});

test('manifest contains correct installer name, URL, and verified signature', (t) => {
  const installer = temporaryInstaller(t);
  const manifest = createManifest(config(), installer, 'release notes');
  assert.equal(manifest.version, version);
  assert.equal(manifest.notes, 'release notes');
  assert.ok(!Number.isNaN(Date.parse(manifest.pub_date)));
  assert.deepEqual(manifest.platforms['windows-x86_64'], {
    signature: validSignature,
    url: `https://github.com/team-poem/aphendo/releases/download/v${version}/Aphendo_${version}_x64-setup.exe`,
  });
});

test('manifest rejects wrong version, wrong key, or corrupted installer', (t) => {
  const installer = temporaryInstaller(t);
  assert.throws(() => createManifest(config(publicA, '9.8.8'), installer));
  assert.throws(() => createManifest(config(publicB), installer));
  writeFileSync(installer, Buffer.from('corrupted installer'));
  assert.throws(() => createManifest(config(), installer));
});

test('preflight fails closed for empty or invalid key without leaking it', () => {
  for (const privateKey of ['', 'synthetic-invalid-private-key-DO-NOT-PRINT']) {
    const result = spawnSync(process.execPath, [resolve('scripts/release-signing.mjs'), 'preflight'], {
      env: { PATH: process.env.PATH, TAURI_SIGNING_PRIVATE_KEY: privateKey,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' },
      encoding: 'utf8', timeout: 35_000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, privateKey ? /서명하지 못했습니다/ : /비밀키가 비어 있습니다/);
    if (privateKey) assert.ok(!(`${result.stdout}${result.stderr}`).includes(privateKey));
  }
});
