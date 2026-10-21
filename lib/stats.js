/**
 * 统计（设计稿 §7）：三条曲线，口径互不混用。
 *
 *   ① 首次作答正确率：只算 mode=first 且作答时题目处于 unseen 的那一次
 *   ② 重做正确率：按阶段分开（stage 1 / 2 / 3），不合成一条
 *   ③ 按考点正确率：多考点题按权重分摊，同一题不重复计入每个考点
 *
 * 分母为 0 时返回 null 而不是 0 —— 0% 和「没有数据」是两回事，混了曲线就会骗人。
 */

import { rate } from './util.js';

function topicWeights(store) {
  const map = new Map();
  for (const qt of store.read('questions').questionTopics) {
    if (!map.has(qt.questionId)) map.set(qt.questionId, []);
    map.get(qt.questionId).push({ topicId: qt.topicId, weight: qt.weight ?? 1 });
  }
  return map;
}

/** 主入口：一次给出面板要的全部统计。 */
export function summarize(store) {
  const attempts = store.read('attempts').attempts;
  const topics = store.read('topics').topics;
  const topicName = new Map(topics.map((t) => [t.id, t.name]));
  const weights = topicWeights(store);

  // ① 首次
  const firsts = attempts.filter((a) => a.mode === 'first' && a.wasUnseen);
  const firstStats = {
    total: firsts.length,
    passed: firsts.filter((a) => a.verdict === 'pass').length,
    rate: rate(firsts.filter((a) => a.verdict === 'pass').length, firsts.length),
  };

  // ② 分阶段重做
  const review = {};
  for (const stage of [1, 2, 3]) {
    const rows = attempts.filter((a) => a.mode !== 'first' && a.stage === stage);
    review[`stage${stage}`] = {
      label: stage === 1 ? '第 1 天原题' : stage === 2 ? '第 3 天变式' : '第 14 天混合',
      total: rows.length,
      passed: rows.filter((a) => a.verdict === 'pass').length,
      rate: rate(rows.filter((a) => a.verdict === 'pass').length, rows.length),
    };
  }

  // ③ 按考点（权重分摊）
  const byTopic = new Map();
  for (const t of topics) byTopic.set(t.id, { topicId: t.id, name: t.name, total: 0, passed: 0, lastWrongAt: null });
  for (const a of attempts) {
    const list = weights.get(a.questionId) ?? [];
    if (list.length === 0) continue;
    const sum = list.reduce((acc, x) => acc + (x.weight ?? 1), 0) || list.length;
    for (const item of list) {
      const share = (item.weight ?? 1) / sum;
      const row = byTopic.get(item.topicId);
      if (!row) continue;
      row.total += share;
      if (a.verdict === 'pass') row.passed += share;
      if (a.verdict === 'fail' && (!row.lastWrongAt || a.submittedAt > row.lastWrongAt)) row.lastWrongAt = a.submittedAt;
    }
  }
  const topicRows = [...byTopic.values()]
    .map((r) => ({ ...r, total: Math.round(r.total * 100) / 100, passed: Math.round(r.passed * 100) / 100, rate: rate(r.passed, r.total) }))
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  // 错误归因分布
  const tags = new Map();
  for (const a of attempts) {
    for (const tag of a.errorTags ?? []) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }

  return {
    first: firstStats,
    review,
    byTopic: topicRows,
    errorTags: [...tags.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
    totalAttempts: attempts.length,
    generatedAt: new Date().toISOString(),
  };
}

/** 只算某考点的历史（面板点进去看）。 */
export function topicDetail(store, topicId) {
  const qd = store.read('questions');
  const questionIds = new Set(qd.questionTopics.filter((qt) => qt.topicId === topicId).map((qt) => qt.questionId));
  const attempts = store.read('attempts').attempts.filter((a) => questionIds.has(a.questionId));
  const topic = store.read('topics').topics.find((t) => t.id === topicId) ?? null;
  return {
    topic,
    questions: questionIds.size,
    attempts: attempts.length,
    passed: attempts.filter((a) => a.verdict === 'pass').length,
    items: store.read('schedule').items.filter((i) => i.topicId === topicId),
  };
}
