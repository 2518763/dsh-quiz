/**
 * 批改：机判部分 + 阈值判定。
 *
 * 分工写在设计稿 §5、§6：
 *   mcq / matching_fill → 机器判（全对小算通过，配对错一格即失败）
 *   short / long        → 不由这里判，由调用方（AI）按 rubric 给出逐点结果与分数；
 *                         本模块只负责「按阈值判定这次算不算过」。
 */

import { normalizeText } from './util.js';

/** 各题型的通过阈值（设计稿 §2.4）。 */
export const THRESHOLDS = {
  mcq: { mode: 'exact' },
  matching_fill: { mode: 'exact' },
  short: { mode: 'ratio', ratio: 0.8 },
  long: { mode: 'ratio', ratio: 0.7 },
};

/**
 * 机器批改 mcq / matching_fill。
 * @returns {{auto: true, pass: boolean, score: number, detail: object}}
 * @throws 当题型不支持自动批改时
 */
export function autoGrade(question, answer = {}) {
  if (question.type === 'mcq') {
    const choice = Number(answer.choice);
    const pass = Number.isInteger(choice) && choice === question.answerIndex;
    return { auto: true, pass, score: pass ? question.maxScore : 0, detail: { choice, correct: question.answerIndex } };
  }
  if (question.type === 'matching_fill') {
    const fills = Array.isArray(answer.fills) ? answer.fills.map((f) => normalizeText(String(f ?? '')).toUpperCase()) : [];
    const correct = question.pairs.map((p) => normalizeText(p.code).toUpperCase());
    const grid = correct.map((c, i) => ({ index: i, expected: c, got: fills[i] ?? '', ok: fills[i] === c }));
    const pass = grid.every((g) => g.ok);
    return { auto: true, pass, score: pass ? question.maxScore : 0, detail: { grid } };
  }
  throw new Error(`autoGrade: 题型 ${question.type} 不支持机器批改，请传入逐点结果与分数。`);
}

/**
 * 按阈值判定一次作答是否通过。
 * @param {object} question
 * @param {object} result { pass?: boolean, score: number, coreHit?: boolean }
 */
export function judge(question, result = {}) {
  const threshold = THRESHOLDS[question.type];
  if (!threshold) throw new Error(`judge: 未知题型 ${question.type}`);
  if (typeof result.pass === 'boolean') return result.pass;
  if (threshold.mode === 'exact') {
    return Number(result.score) >= question.maxScore;
  }
  const ratio = question.maxScore > 0 ? Number(result.score) / question.maxScore : 0;
  const ok = ratio >= threshold.ratio;
  // 短答另有一条：核心评分点必须命中（coreHit 未提供时按分数判定，不额外惩罚）
  if (!ok) return false;
  if (typeof result.coreHit === 'boolean' && !result.coreHit) return false;
  return true;
}

/** 给人看的判定说明（面板与工具输出共用，避免两处文案漂移）。 */
export function describeVerdict(question, passed) {
  const threshold = THRESHOLDS[question.type];
  if (threshold.mode === 'exact') {
    return passed ? '全对，通过。' : question.type === 'matching_fill' ? '有空格错，进入复习。' : '答错，进入复习。';
  }
  return passed ? `得分率达标（≥${Math.round(threshold.ratio * 100)}%），通过。` : `得分率未达 ${Math.round(threshold.ratio * 100)}%，进入复习。`;
}
