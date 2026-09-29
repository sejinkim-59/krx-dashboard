// Selection Engine 공용 헬퍼 — 점수화(Available Weight 정규화)와 표시용 포맷.

export const sgn = (n) => (n > 0 ? '+' : '');

export function fmtWon(n) {
  if (n == null) return '-';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}조`;
  if (abs >= 1e8) return `${sign}${Math.round(abs / 1e8).toLocaleString()}억`;
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e4).toLocaleString()}만`;
  return `${sign}${abs.toLocaleString()}`;
}

/**
 * rules: [{id,points,label}], checks: {id: true|false|null}.
 * null = 평가 불가 → 0점이 아니라 분모(만점)에서 제외한다. 이것이 Available Weight 원칙이다.
 */
export function scoreRules(rules, checks, weight) {
  let earnedRaw = 0, applicableMax = 0;
  const breakdown = [];
  for (const r of rules) {
    const v = checks[r.id];
    if (v == null) continue;
    applicableMax += r.points;
    if (v) { earnedRaw += r.points; breakdown.push(`+${r.points} ${r.label}`); }
  }
  if (applicableMax === 0) return unavailable();
  return { available: true, score: (earnedRaw / applicableMax) * weight, availableWeight: weight, earnedRaw, applicableMax, breakdown };
}

export function unavailable(missingReason) {
  return { available: false, score: 0, availableWeight: 0, breakdown: [], ...(missingReason ? { missingReason } : {}) };
}

/** "2027년 10월 20일" → Date */
export function parseKoreanDate(s) {
  const m = /(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(s || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

/** "20260928" → Date */
export function parseYyyymmdd(s) {
  if (!/^\d{8}$/.test(s || '')) return null;
  return new Date(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)));
}

/** 달력일 → 영업일 근사(주말 제외). 공휴일은 반영하지 않는다. */
export function businessDaysBetween(from, to) {
  if (!from || !to) return null;
  const sign = to >= from ? 1 : -1;
  const [a, b] = sign > 0 ? [from, to] : [to, from];
  let days = 0;
  const cur = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const end = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  while (cur < end) {
    cur.setDate(cur.getDate() + 1);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) days++;
  }
  return days * sign;
}
