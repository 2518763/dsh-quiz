/**
 * 把一份 Markdown 资料切成 chunk。
 *
 * 规则（与设计稿 §8.3 对齐）：
 *   ① 按小节（## ）切，保住前后文，不按字数硬切；
 *   ② 单段上限 maxChars（默认 1200），超长时按 ### 或空行段落再切，但保留父标题与页范围；
 *   ③ 每段记 pageFrom / pageTo：优先取标题里的「（p.12）」或「(p.12-15)」，取不到用 frontmatter 的 pages；
 *   ④ 不丢标题：每个 chunk 的 text 里都带着自己的小节标题，出题时模型看得到上下文。
 */

import { newId, normalizeText } from './util.js';

export const DEFAULT_MAX_CHARS = 1200;

/** 解析 frontmatter（只支持 `key: value` 这种单层写法，够用且不引依赖）。 */
export function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { meta: {}, body: text };
  const head = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^[\r\n]+/, '');
  const meta = {};
  for (const line of head.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

/** 从文本里抓页码范围：支持 p.12 / p.12-15 / P12 / 第12頁。 */
export function parsePages(text) {
  if (typeof text !== 'string') return { from: null, to: null };
  let m = /[（(]\s*(?:p\.?|P\.?|第)\s*([0-9]+)\s*(?:[-–~至]\s*([0-9]+)\s*)?[）)]/.exec(text);
  if (!m) m = /\bp\.?\s*([0-9]+)\s*(?:[-–~]\s*([0-9]+))?/i.exec(text);
  if (!m) {
    const range = /^\s*([0-9]+)\s*[-–~]\s*([0-9]+)\s*$/.exec(text ?? '');
    if (range) return { from: Number(range[1]), to: Number(range[2]) };
    return { from: null, to: null };
  }
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  return { from, to };
}

/** 按标题级别切出 section（level 2 为准，没有 level 2 就退回 level 1）。 */
function splitSections(body) {
  const lines = body.split('\n');
  let minLevel = null;
  for (const line of lines) {
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m) {
      const level = m[1].length;
      if (minLevel === null || level < minLevel) minLevel = level;
    }
  }
  if (minLevel === null) {
    return [{ heading: '', body: body.trim(), level: 0 }];
  }
  const sections = [];
  let current = null;
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m && m[1].length === minLevel) {
      if (current) sections.push(current);
      current = { heading: m[2].trim(), body: '', level: minLevel };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) sections.push(current);
  return sections.filter((s) => normalizeText(s.heading) || normalizeText(s.body));
}

/** 超长段落再切：优先按空行段落，其次按句子，最后硬切。 */
function splitLongText(text, maxChars) {
  const norm = normalizeText(text);
  if (norm.length <= maxChars) return [norm];
  const paragraphs = norm.split(/\n(?=\S)/).filter((p) => p.trim());
  const pieces = [];
  let buf = '';
  const push = () => {
    if (normalizeText(buf)) pieces.push(normalizeText(buf));
    buf = '';
  };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      push();
      // 段落自己就超长：按句子攒
      const sentences = p.split(/(?<=[。！？；.!?;])\s*/);
      let sbuf = '';
      for (const s of sentences) {
        if ((sbuf + s).length > maxChars && sbuf) {
          pieces.push(normalizeText(sbuf));
          sbuf = '';
        }
        if (s.length > maxChars) {
          for (let i = 0; i < s.length; i += maxChars) {
            pieces.push(normalizeText(s.slice(i, i + maxChars)));
          }
          continue;
        }
        sbuf += s;
      }
      if (normalizeText(sbuf)) pieces.push(normalizeText(sbuf));
      continue;
    }
    if ((buf + '\n' + p).length > maxChars && buf) push();
    buf += (buf ? '\n' : '') + p;
  }
  push();
  return pieces.length > 0 ? pieces : [norm];
}

/**
 * 主入口：把一份 Markdown 原文切成 chunk 列表。
 * @param {object} input
 * @param {string} input.raw 原始 Markdown（含 frontmatter）
 * @param {string} input.sourceId 归属资料 id
 * @param {number} [input.maxChars]
 * @returns {{meta: object, chunks: Array}}
 */
export function chunkMarkdown({ raw, sourceId, maxChars = DEFAULT_MAX_CHARS }) {
  const { meta, body } = parseFrontmatter(raw);
  const docPages = parsePages(meta.pages ?? '');
  const sections = splitSections(body);
  const chunks = [];
  let order = 0;

  for (const section of sections) {
    const headingPages = parsePages(section.heading);
    const pageFrom = headingPages.from ?? docPages.from;
    const pageTo = headingPages.to ?? docPages.to;
    const pieces = splitLongText(section.body, maxChars);
    for (const piece of pieces) {
      // 每段都带自己的小节标题：出题时模型与批改都能看到上下文，切断了也不至于断章取义
      const text = section.heading ? `## ${section.heading}\n\n${piece}` : piece;
      chunks.push({
        id: newId('c'),
        sourceId,
        heading: section.heading || '',
        parentHeading: meta.book ? String(meta.book) : '',
        pageFrom,
        pageTo,
        text,
        order: order++,
      });
    }
  }
  return { meta, chunks };
}
