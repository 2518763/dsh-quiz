/**
 * 错题回炉排程（设计稿 §2）。
 *
 * 排程主体是**考点**，不是单道题 —— 记住题目的外观毫无意义。
 *
 * 阶段：
 *   stage 1  错后 1 天   原题或近似题      通过 = 恢复信号（不算掌握）
 *   stage 2  错后 3 天   同考点变式        通过 = 证据一
 *   stage 3  错后 14 天  混合情境          通过 = 证据二
 *   mastered 需要 stage2 与 stage3 都通过，**且两次都不是原题**
 *
 * 失败：
 *   退回上一阶段，due 顺延 1 天；连续两次失败 → 进入「重新学习」，看原文或解析后才回池。
 */

import { newId, addDays, nowIso } from './util.js';

export const STAGES = [1, 2, 3];

/** 阶段对应的间隔（天）与要求。 */
const STAGE_PLAN = {
  1: { gapDays: 1, label: '原题重做', kind: 'same' },
  2: { gapDays: 3, label: '同考点变式', kind: 'variant' },
  3: { gapDays: 14, label: '混合情境', kind: 'transfer' },
};

export function stagePlan(stage) {
  return STAGE_PLAN[stage] ?? null;
}

/** 找某考点的排程项；没有就建一个（stage=1，因为进排程的起点是「错了一次」）。 */
export function ensureItem(store, { topicId, originQuestionId }) {
  const existing = store.read('schedule').items.find((i) => i.topicId === topicId && !i.masteredAt);
  if (existing) return existing;
  const item = {
    id: newId('m'),
    topicId,
    originQuestionId,
    stage: 1,
    successCount: 0,
    failures: 0,
    lastResult: null,
    dueAt: addDays(1),
    masteredAt: null,
    relearning: false,
    createdAt: nowIso(),
  };
  store.update('schedule', (d) => {
    d.items.push(item);
  });
  return item;
}

function patchItem(store, itemId, patch) {
  let updated = null;
  store.update('schedule', (d) => {
    d.items = d.items.map((item) => {
      if (item.id !== itemId) return item;
      updated = { ...item, ...patch };
      return updated;
    });
  });
  return updated;
}

/**
 * 记一次作答结果并推进排程。
 * @param {import('./store.js').Store} store
 * @param {object} input
 * @param {string} input.topicId
 * @param {string} input.questionId
 * @param {string} input.originQuestionId 该排程最初因哪道题触发
 * @param {number} input.stage 本次作答发生在第几阶段
 * @param {boolean} input.passed
 * @returns {object} 更新后的排程项 + 判定说明
 */
export function advance(store, { topicId, questionId, originQuestionId, stage, passed }) {
  const item = ensureItem(store, { topicId, originQuestionId });
  const plan = stagePlan(stage);
  const isOriginal = questionId === originQuestionId;

  // 变式/混合阶段不能拿原题充数，否则「掌握」判定失真
  if (passed && stage >= 2 && isOriginal) {
    return {
      item: patchItem(store, item.id, { dueAt: addDays(1), lastResult: 'same-question' }),
      note: '这次过的还是原题，不能作为掌握证据；已排到明天的变式题。',
    };
  }

  if (passed) {
    if (stage >= 3) {
      const updated = patchItem(store, item.id, {
        stage: 3,
        successCount: item.successCount + 1,
        failures: 0,
        lastResult: 'pass',
        masteredAt: nowIso(),
        dueAt: null,
        relearning: false,
      });
      return { item: updated, note: '变式与混合都过了，记为 mastered。' };
    }
    const nextStage = stage + 1;
    const nextPlan = stagePlan(nextStage);
    const updated = patchItem(store, item.id, {
      stage: nextStage,
      successCount: item.successCount + 1,
      failures: 0,
      lastResult: 'pass',
      dueAt: addDays(nextPlan.gapDays),
      relearning: false,
    });
    return { item: updated, note: `${plan?.label ?? ''}通过，进入「${nextPlan.label}」，${nextPlan.gapDays} 天后。` };
  }

  // 答错
  const prevStage = Math.max(1, stage - 1);
  const failures = item.failures + 1;
  const relearning = failures >= 2;
  const updated = patchItem(store, item.id, {
    stage: prevStage,
    failures,
    lastResult: 'fail',
    dueAt: addDays(1),
    relearning,
  });
  return {
    item: updated,
    note: relearning
      ? '连续两次失败，先回去看原文或解析，再回池重练。'
      : `答错，退回「${stagePlan(prevStage)?.label ?? '原题重做'}」，明天再来。`,
  };
}

/** 到期的排程项（dueAt <= now）。 */
export function dueItems(store, now = new Date()) {
  const t = now.getTime();
  return store.read('schedule').items.filter((i) => !i.masteredAt && i.dueAt && new Date(i.dueAt).getTime() <= t && !i.relearning);
}

/** 还没掌握的排程项（不含已 mastered）。 */
export function activeItems(store) {
  return store.read('schedule').items.filter((i) => !i.masteredAt);
}
