/**
 * 通用小工具。这一层不碰业务语义，只负责「确定性的、可测的」小函数。
 */

/** 生成短 id：前缀 + 时间基 36 进制 + 随机 4 位，够本地用又不重复。 */
export function newId(prefix = 'q') {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${t}${r}`;
}

/** 当前时间 ISO 字符串（统一时区无关，排序用）。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 加天数后的 ISO。 */
export function addDays(days, from = new Date()) {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/** 把文本压成可比较的形状：去 BOM、统一空白、去零宽字符。 */
export function normalizeText(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(/^\uFEFF/, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/**
 * 判断 quote 是否真的出现在 chunk 原文里。
 * 比对前两边都归一化，并容忍「换行被合并」这种最常见的 OCR 差异。
 */
export function quoteFoundIn(quote, text) {
  const q = normalizeText(quote);
  const t = normalizeText(text);
  if (!q) return false;
  if (t.includes(q)) return true;
  // 再退一步：忽略所有空白再比一次（应对原文里断行位置不同）
  const q2 = q.replace(/\s+/g, '');
  const t2 = t.replace(/\s+/g, '');
  return q2.length > 0 && t2.includes(q2);
}

/** 数字夹在范围内。 */
export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** 取对象里第一段非空字符串，用于配置兜底。 */
export function pickString(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/** 把数组里重复项去掉（按 JSON 比较，够用）。 */
export function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/** 百分比四舍五入到 1 位小数；分母为 0 返回 null（不是 0，避免曲线骗人）。 */
export function rate(numerator, denominator) {
  if (!denominator || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}
