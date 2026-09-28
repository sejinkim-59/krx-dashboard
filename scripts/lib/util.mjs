import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// 로컬 개발용: .env.local이 있으면 읽어서 process.env에 채운다.
// GitHub Actions 등 CI에서는 파일이 없으므로 조용히 건너뛰고 Secrets로 주입된 값을 그대로 쓴다.
async function loadEnvLocal() {
  const envPath = path.join(__dirname, '..', '..', '.env.local');
  try {
    const text = await readFile(envPath, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // .env.local 없음 (CI 환경) — 무시
  }
}
await loadEnvLocal();

export async function writeJson(filename, obj) {
  await mkdir(DATA_DIR, { recursive: true });
  const filePath = path.join(DATA_DIR, filename);
  await writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8');
  console.log(`[write] ${filename} (${JSON.stringify(obj).length} bytes)`);
}

function kstNow() {
  // KST = UTC+9, 서버 타임존과 무관하게 계산
  const now = new Date();
  return new Date(now.getTime() + 9 * 60 * 60 * 1000);
}

export function todayKst() {
  const d = kstNow();
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function daysAgoKst(n) {
  const d = kstNow();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
