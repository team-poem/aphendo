import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinnedKey = readFileSync(join(root, 'scripts/updater-public-key.pub'), 'utf8').trim();

function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}

function decodeBase64(value) {
  const text = value.trim();
  requireValid(text.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(text), '잘못된 서명 데이터입니다.');
  const bytes = Buffer.from(text, 'base64');
  requireValid(bytes.toString('base64') === text, '잘못된 서명 인코딩입니다.');
  return bytes;
}

function publicKeyBytes(encoded) {
  const lines = decodeBase64(encoded).toString('utf8').split(/\r?\n/);
  requireValid(lines[0]?.startsWith('untrusted comment: ') && lines[1], '공개키 형식이 잘못되었습니다.');
  const bytes = decodeBase64(lines[1]);
  requireValid(bytes.length === 42 && bytes.subarray(0, 2).toString() === 'Ed', '지원하지 않는 공개키입니다.');
  return bytes;
}

export function assertTrustedKey(configuredKey, trustedKey) {
  requireValid(publicKeyBytes(configuredKey).equals(publicKeyBytes(trustedKey)),
    '업데이트 공개키가 기존 배포 키와 다릅니다. 새 키로 교체하지 말고 기존 키를 복구하세요.');
}

export function verifySignature(data, encodedSignature, encodedPublicKey, version) {
  const pub = publicKeyBytes(encodedPublicKey);
  const lines = decodeBase64(encodedSignature).toString('utf8').trimEnd().split(/\r?\n/);
  requireValid(lines.length === 4 && lines[0].startsWith('untrusted comment: ')
    && lines[2].startsWith('trusted comment: '), '서명 형식이 잘못되었습니다.');
  const signature = decodeBase64(lines[1]);
  requireValid(signature.length === 74 && signature.subarray(0, 2).toString() === 'ED',
    '지원하지 않는 서명 형식입니다.');
  requireValid(signature.subarray(2, 10).equals(pub.subarray(2, 10)),
    '서명 키가 기존 앱의 공개키와 다릅니다. 배포를 중단합니다.');
  const key = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub.subarray(10)]),
    format: 'der', type: 'spki',
  });
  const comment = lines[2].slice('trusted comment: '.length);
  requireValid(verify(null, createHash('blake2b512').update(data).digest(), key, signature.subarray(10)),
    '설치 파일 서명 검증에 실패했습니다.');
  requireValid(verify(null, Buffer.concat([signature.subarray(10), Buffer.from(comment)]), key, decodeBase64(lines[3])),
    '서명의 버전 정보 검증에 실패했습니다.');
  requireValid(comment.split('\t').includes(`version:${version}`), '서명된 버전이 앱 버전과 다릅니다.');
}

export function createManifest(config, artifact, notes = '') {
  const name = `Aphendo_${config.version}_x64-setup.exe`;
  requireValid(basename(artifact) === name, '설치 파일 이름과 앱 버전이 다릅니다.');
  const signature = readFileSync(`${artifact}.sig`, 'utf8').trim();
  verifySignature(readFileSync(artifact), signature, config.plugins.updater.pubkey, config.version);
  return {
    version: config.version, notes, pub_date: new Date().toISOString(),
    platforms: { 'windows-x86_64': {
      signature,
      url: `https://github.com/team-poem/aphendo/releases/download/v${config.version}/${name}`,
    } },
  };
}

function configuration() {
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  assertTrustedKey(config.plugins.updater.pubkey, pinnedKey);
  if (Object.hasOwn(process.env, 'TAURI_SIGNING_PUBLIC_KEY')) {
    requireValid(process.env.TAURI_SIGNING_PUBLIC_KEY?.trim(), 'GitHub에 고정한 업데이트 공개키가 없습니다.');
    assertTrustedKey(config.plugins.updater.pubkey, process.env.TAURI_SIGNING_PUBLIC_KEY);
  }
  return config;
}

function preflight(config) {
  let privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (privateKey === undefined) {
    const path = process.env.APHENDO_SIGNING_KEY || join(homedir(), '.tauri/aphendo.key');
    requireValid(existsSync(path), '기존 업데이트 비밀키가 없습니다. 새 키를 생성하지 말고 백업에서 복구하세요.');
    privateKey = readFileSync(path, 'utf8');
  } else if (existsSync(privateKey)) {
    privateKey = readFileSync(privateKey, 'utf8');
  }
  requireValid(privateKey?.trim(), '업데이트 서명 비밀키가 비어 있습니다. 기존 키를 복구하세요.');
  const temporary = mkdtempSync(join(tmpdir(), 'aphendo-signing-'));
  try {
    const challenge = join(temporary, 'challenge');
    writeFileSync(challenge, randomBytes(64));
    const result = spawnSync(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'),
      'signer', 'sign', '--app-version', config.version, challenge], {
      env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY: privateKey,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD || '' },
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
    });
    requireValid(result.status === 0, '기존 비밀키로 서명하지 못했습니다. 키와 암호를 확인하세요. 키 내용은 출력하지 않습니다.');
    verifySignature(readFileSync(challenge), readFileSync(`${challenge}.sig`, 'utf8'), config.plugins.updater.pubkey, config.version);
    console.log('기존 배포 키와 비밀키의 서명 일치를 확인했습니다.');
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = configuration();
    if (process.argv[2] === 'preflight') {
      preflight(config);
    } else if (process.argv[2] === 'prepare' && process.argv[3]) {
      const artifact = resolve(process.argv[3]);
      const manifest = createManifest(config, artifact, process.argv[4] || '변경 사항은 릴리스 노트를 확인해 주세요.');
      writeFileSync(join(dirname(artifact), 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
      console.log('설치 파일의 기존 키 서명과 버전을 검증하고 latest.json을 생성했습니다.');
    } else {
      throw new Error('Usage: node scripts/release-signing.mjs preflight | prepare <installer> [notes]');
    }
  } catch (error) {
    console.error(`릴리스 중단: ${error.message}`);
    process.exitCode = 1;
  }
}
