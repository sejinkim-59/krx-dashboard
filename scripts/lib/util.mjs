import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', '..', 'data');

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
