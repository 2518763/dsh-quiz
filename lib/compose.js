/**
 * 组卷（设计稿 §6）：范围由插件自动选，用户无需每次指定。
 *
 * 显式配比（不写「优先」这种含糊话）：
 *   40% 到期复习 / 30% 未掌握考点 / 20% 最近学过的章节 / 10% 混合迁移
 *
 * 硬限制：
 *   · 模拟模式只用 official + verified；练习模式可用 draft（题面会标「AI 生成」）
 *   · 到期任务每天最多取 20 题，多出来的顺延，不一次性塞爆
 *   · 没有对应题目的考点，进「跳过」清单并说明原因
 */

import { newId, nowIso } from './util.js';
import { dueItems, activeItems, stagePlan } from './schedule.js';
import { listQuestions } from './questions.js';
import { usableChunks } from './library.js';

export const QUOTA = { due: 0.4, weak: 0.3, recent: 0.2, mixed: 0.1 };
export const DAILY_DUE_CAP = 20;
export const DEFAULT_COUNT = 10;

/** 某考点下可用的题（按审核状态过滤）。 */
function questionsOfTopic(store, topicId, allowDraft) {
  const qTopics = store.read('questions').questionTopics.filter((qt) => qt.topicId === topicId);
  const ids = new Set(qTopics.map((qt) => qt.questionId));
  return listQuestions(store).filter((q) => ids.has(q.id) && (allowDraft || q.reviewStatus === 'official' || q.originType === 'official' || q.reviewStatus === 'verified'));
}

/** 某考点属于哪个 chunk（用于「最近学过」排序）。 */
function chunkRecency(store) {
  const chunks = new Map(store.read('chunks').chunks.map((c) => [c.id, c]));
  const sources = new Map(store.read('sources').sources.map((s) => [s.id, s]));
  const map = new Map();
  for (const qc of store.read('questions').questionChunks) {
    const chunk = chunks.get(qc.chunkId);
    if (!chunk) continue;
    const source = sources.get(chunk.sourceId);
    if (!source) continue;
    const ts = new Date(source.addedAt ?? 0).getTime();
    map.set(qc.questionId, Math.max(map.get(qc.questionId) ?? 0, ts));
  }
  return map;
}

function takeUnique(pool, need, taken, out) {
  for (const q of pool) {
    if (out.length >= need) break;
    if (taken.has(q.id)) continue;
    taken.add(q.id);
    out.push(q);
  }
}

/**
 * 组一份卷。
 * @param {import('./store.js').Store} store
 * @param {object} opts
 * @param {number} [opts.count]
 * @param {'practice'|'mock'} [opts.mode]
 * @param {string[]} [opts.topicIds] 限定考点（可选）
 */
export function composeSession(store, opts = {}) {
  const mode = opts.mode === 'mock' ? 'mock' : 'practice';
  const allowDraft = mode === 'practice';
  const count = Number.isFinite(opts.count) && opts.count > 0 ? Math.min(60, Math.round(opts.count)) : DEFAULT_COUNT;
  const quota = opts.count ? QUOTA : QUOTA;

  const taken = new Set();
  const picked = [];
  const skipped = [];
  const recency = chunkRecency(store);

  const filterTopic = (q) => !opts.topicIds || opts.topicIds.length === 0 || (store.read('questions').questionTopics.some((qt) => qt.questionId === q.id && opts.topicIds.includes(qt.topicId)));

  // ① 到期复习
  const due = dueItems(store).slice(0, DAILY_DUE_CAP);
  const dueQuota = Math.min(count, Math.max(0, Math.round(count * quota.due)));
  const duePool = [];
  for (const item of due) {
    const plan = stagePlan(item.stage);
    const pool = questionsOfTopic(store, item.topicId, allowDraft).filter((q) => filterTopic(q));
    // 变式/混合阶段优先非原题
    const ordered = plan && plan.kind !== 'same' ? pool.filter((q) => q.id !== item.originQuestionId) : pool;
    if (ordered.length === 0) {
      skipped.push({ topicId: item.topicId, reason: plan ? `该阶段（${plan.label}）没有可用的题` : '没有可用题' });
      continue;
    }
    duePool.push(...ordered);
  }
  takeUnique(duePool, dueQuota, taken, picked);
  if (due.length > dueQuota) skipped.push({ reason: `到期 ${due.length} 项，本卷只取 ${dueQuota} 题，其余顺延` });

  // ② 未掌握考点
  const weakQuota = Math.min(count, Math.round(count * quota.weak));
  const weakPool = [];
  for (const item of activeItems(store)) {
    if (due.some((d) => d.id === item.id)) continue;
    const pool = questionsOfTopic(store, item.topicId, allowDraft).filter(filterTopic);
    if (pool.length === 0) {
      skipped.push({ topicId: item.topicId, reason: '考点还没有题' });
      continue;
    }
    weakPool.push(...pool);
  }
  const beforeWeak = picked.length;
  takeUnique(weakPool, beforeWeak + weakQuota, taken, picked);

  // ③ 最近学过的章节（按资料入库时间新→旧）
  const recentQuota = Math.min(count, Math.round(count * quota.recent));
  const all = listQuestions(store).filter((q) => (allowDraft ? true : q.originType === 'official' || q.reviewStatus === 'verified') && filterTopic(q));
  const recentPool = [...all].sort((a, b) => (recency.get(b.id) ?? 0) - (recency.get(a.id) ?? 0));
  const beforeRecent = picked.length;
  takeUnique(recentPool, beforeRecent + recentQuota, taken, picked);

  // ④ 混合迁移：补满为止
  takeUnique(all, count, taken, picked);

  // 补不满时说明原因，不偷偷拿别的题糊过去
  if (picked.length < count) {
    skipped.push({ reason: `题数不够：可选题 ${picked.length} 道（想要 ${count} 道）。先导入更多资料或出更多题。` });
  }

  const session = {
    id: newId('sess'),
    mode,
    count,
    questionIds: picked.map((q) => q.id),
    startedAt: nowIso(),
    endedAt: null,
  };
  store.update('sessions', (d) => {
    d.sessions.push(session);
  });

  return {
    session,
    questions: picked,
    coverage: summarizeCoverage(store, picked),
    skipped,
    dir: store.dir,
  };
}

/** 本卷覆盖了哪些考点、来源是哪本书哪几页。 */
export function summarizeCoverage(store, questions) {
  const qTopics = store.read('questions').questionTopics;
  const topicName = new Map(store.read('topics').topics.map((t) => [t.id, t.name]));
  const qChunks = store.read('questions').questionChunks;
  const chunks = new Map(store.read('chunks').chunks.map((c) => [c.id, c]));
  const sources = new Map(store.read('sources').sources.map((s) => [s.id, s]));

  const topicCount = new Map();
  const books = new Set();
  const pages = [];
  for (const q of questions) {
    for (const qt of qTopics.filter((x) => x.questionId === q.id)) {
      topicCount.set(qt.topicId, (topicCount.get(qt.topicId) ?? 0) + 1);
    }
    for (const qc of qChunks.filter((x) => x.questionId === q.id)) {
      const chunk = chunks.get(qc.chunkId);
      if (!chunk) continue;
      const src = sources.get(chunk.sourceId);
      if (src?.book) books.add(src.book);
      if (chunk.pageFrom) pages.push(`${chunk.pageFrom}${chunk.pageTo && chunk.pageTo !== chunk.pageFrom ? `–${chunk.pageTo}` : ''}`);
    }
  }
  const topics = [...topicCount.entries()]
    .map(([id, n]) => `${topicName.get(id) ?? id}(${n})`)
    .join('、');
  const pageText = [...new Set(pages)].sort((a, b) => parseInt(a) - parseInt(b)).join('、');
  return {
    topicsText: topics || '（无）',
    booksText: [...books].join('、') || '（无）',
    pagesText: pageText || '（无页码）',
  };
}

/** 练习模式下载入题目时要带的「是否已见过」判断。 */
export function seenState(store, questionId) {
  const attempts = store.read('attempts').attempts.filter((a) => a.questionId === questionId);
  if (attempts.length === 0) return 'unseen';
  if (attempts.some((a) => a.revealed)) return 'revealed';
  return 'answered';
}
