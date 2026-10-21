/**
 * 资料库：导入 / 列资料 / 认考点 / 看覆盖。
 *
 * 一条不可让的规矩：**导入不等于可出题**。
 *   status = raw      → 刚导入，尚未抽查（OCR 或手工转录时容易出错）
 *   status = reviewed → 抽查过，可以出题
 *   status = active   → 正常使用
 *   status = archived → 停用（旧版教材、换书）
 * 出题时只从 reviewed / active 的资料里抽 chunk。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId, normalizeText, pickString } from './util.js';
import { chunkMarkdown } from './chunker.js';

export const SOURCE_STATUSES = ['raw', 'reviewed', 'active', 'archived'];
export const USABLE_STATUSES = new Set(['reviewed', 'active']);

/**
 * 导入一份资料。
 * @param {import('./store.js').Store} store
 * @param {object} input
 * @param {string} [input.file]
 * @param {string} [input.raw]
 * @param {string} input.book 书名（必填，出题时显示出处用）
 * @param {string} [input.edition]
 * @param {string} [input.type] textbook|notes|worksheet|pastpaper|markingscheme
 * @param {number} [input.priority] 1=marking scheme, 2=textbook, 3=notes
 * @param {string} [input.status]
 */
export function importSource(store, input = {}) {
  const book = pickString(input.book, '');
  if (!book) throw new Error('importSource: 缺少 book（书名）。没有书名的资料无法作为出处。');
  const raw = typeof input.raw === 'string' ? input.raw : input.file ? readFileSync(input.file, 'utf8') : '';
  if (!normalizeText(raw)) throw new Error('importSource: 资料内容为空。');

  const type = pickString(input.type, 'textbook');
  const sourceId = newId('s');
  const status = SOURCE_STATUSES.includes(input.status) ? input.status : 'active';
  const priority = Number.isFinite(input.priority) ? input.priority : type === 'markingscheme' ? 1 : type === 'textbook' ? 2 : 3;

  const { meta, chunks } = chunkMarkdown({ raw, sourceId, maxChars: input.maxChars });
  if (chunks.length === 0) throw new Error('importSource: 切不出任何段落，检查文件是否是 Markdown 且有小节标题。');

  const sourcesDir = join(store.dir, 'sources');
  if (!existsSync(sourcesDir)) mkdirSync(sourcesDir, { recursive: true });
  const savedPath = join(sourcesDir, `${sourceId}.md`);
  writeFileSync(savedPath, raw, 'utf8');

  const source = {
    id: sourceId,
    book,
    edition: pickString(input.edition, meta.edition ?? ''),
    type,
    pages: pickString(meta.pages, ''),
    priority,
    status,
    path: savedPath,
    chunkCount: chunks.length,
    addedAt: new Date().toISOString(),
  };
  store.update('sources', (d) => {
    d.sources.push(source);
  });
  store.update('chunks', (d) => {
    d.chunks.push(...chunks);
  });
  return { source, chunkCount: chunks.length };
}

/** 列资料（可按状态过滤）。 */
export function listSources(store, { status } = {}) {
  return store.read('sources').sources.filter((s) => (status ? s.status === status : true));
}

/** 可出题的 chunk：只来自 reviewed / active 的资料。 */
export function usableChunks(store) {
  const okIds = new Set(store.read('sources').sources.filter((s) => USABLE_STATUSES.has(s.status)).map((s) => s.id));
  return store.read('chunks').chunks.filter((c) => okIds.has(c.sourceId));
}

/** 改资料状态（抽查完标记 reviewed、换书时 archived）。 */
export function setSourceStatus(store, sourceId, status) {
  if (!SOURCE_STATUSES.includes(status)) throw new Error(`非法状态：${status}`);
  let found = null;
  store.update('sources', (d) => {
    for (const s of d.sources) {
      if (s.id === sourceId) {
        s.status = status;
        found = s;
      }
    }
  });
  if (!found) throw new Error(`找不到资料：${sourceId}`);
  return found;
}

// ───────────────────────────────────────── 考点

/** 认一个考点：已存在就返回，不存在就建。别名用于把「機會成本 / opportunity cost」并成一个。 */
export function ensureTopic(store, name, aliases = []) {
  const clean = pickString(name, '');
  if (!clean) throw new Error('ensureTopic: 考点名不能为空。');
  let topic = findTopic(store, clean, aliases);
  if (topic) return topic;
  topic = { id: newId('t'), name: clean, aliases: aliases.filter(Boolean), createdAt: new Date().toISOString() };
  store.update('topics', (d) => {
    d.topics.push(topic);
  });
  return topic;
}

/** 按名字或别名找考点（大小写与首尾空白不敏感）。 */
export function findTopic(store, name, aliases = []) {
  const wanted = [name, ...aliases].map((s) => normalizeText(String(s ?? '')).toLowerCase());
  for (const topic of store.read('topics').topics) {
    const names = [topic.name, ...(topic.aliases ?? [])].map((s) => normalizeText(String(s ?? '')).toLowerCase());
    if (names.some((n) => wanted.includes(n))) return topic;
  }
  return null;
}

/** 覆盖面板：哪些考点有题、哪些资料不足、哪些段落还没出过题。 */
export function coverage(store) {
  const topics = store.read('topics').topics;
  const questions = store.read('questions').questions.filter((q) => q.active);
  const qTopics = store.read('questions').questionTopics;
  const qChunks = store.read('questions').questionChunks;
  const chunks = usableChunks(store);

  const countByTopic = new Map();
  for (const qt of qTopics) {
    if (!questions.some((q) => q.id === qt.questionId)) continue;
    countByTopic.set(qt.topicId, (countByTopic.get(qt.topicId) ?? 0) + 1);
  }
  const usedChunkIds = new Set(qChunks.map((qc) => qc.chunkId));

  return {
    topics: topics.map((t) => ({ id: t.id, name: t.name, questions: countByTopic.get(t.id) ?? 0 })),
    uncoveredTopics: topics.filter((t) => !countByTopic.get(t.id)).map((t) => t.name),
    uncoveredChunks: chunks.filter((c) => !usedChunkIds.has(c.id)).length,
    totalChunks: chunks.length,
  };
}
