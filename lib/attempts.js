/**
 * 记一次作答：判分 → 推进排程 → 题目可信度升级 → 存记录。
 *
 * 这条链路是插件的「心脏」，所以顺序固定、每一步都可追溯：
 *   1. 判分（mcq/配对机判；短答/长答用调用方给的逐点结果）
 *   2. judge() 按题型阈值定「过没过」
 *   3. 对题目的每个考点推进 schedule
 *   4. draft 题在「无争议批改」后自动升 verified（设计稿 §3.2）
 *   5. 写 attempts 与 session 进度
 */

import { newId, nowIso } from './util.js';
import { getQuestion, setReviewStatus } from './questions.js';
import { autoGrade, judge, describeVerdict } from './grading.js';
import { advance, ensureItem } from './schedule.js';

export const ATTEMPT_MODES = ['first', 'review', 'transfer', 'mock'];
export const ERROR_TAGS = ['概念不清', '记忆混淆', '计算错误', '看错题意', '时间不足', '粗心', '资料不足'];

/**
 * @param {import('./store.js').Store} store
 * @param {object} input
 * @param {string} input.questionId
 * @param {object} input.answer mcq:{choice} matching_fill:{fills} short/long:{text}
 * @param {number} [input.score] 短答/长答必填
 * @param {Array<{pointId:string, hit:'hit'|'partial'|'miss'}>} [input.pointHits]
 * @param {string[]} [input.errorTags]
 * @param {string} [input.mode]
 * @param {boolean} [input.userAdjusted] 用户是否改过分
 * @param {string} [input.sessionId]
 * @param {number} [input.seconds]
 */
export function recordAttempt(store, input = {}) {
  const question = getQuestion(store, input.questionId);
  if (!question) throw new Error(`recordAttempt: 找不到题目 ${input.questionId}`);

  const priorAttempts = store.read('attempts').attempts.filter((a) => a.questionId === question.id);
  const wasUnseen = priorAttempts.length === 0;

  // 1. 判分
  let result;
  if (question.type === 'mcq' || question.type === 'matching_fill') {
    result = autoGrade(question, input.answer ?? {});
  } else {
    const score = Number(input.score);
    if (!Number.isFinite(score)) {
      throw new Error(`recordAttempt: ${question.type} 需要传 score（逐点评完后的合计分）。`);
    }
    const corePoint = question.answerPoints[0];
    const coreHit = Array.isArray(input.pointHits) && corePoint
      ? input.pointHits.some((p) => p.pointId === corePoint.id && p.hit !== 'miss')
      : undefined;
    result = { auto: false, score, detail: { pointHits: input.pointHits ?? [], coreHit } };
    result.pass = judge(question, { score, coreHit });
  }
  const passed = typeof result.pass === 'boolean' ? result.pass : judge(question, result);

  // 2. 排程：每个考点各自推进（多考点题拆成多个 mastery item）
  const notes = [];
  let stage = null;
  const items = [];
  for (const topicId of question.topicIds) {
    const item = ensureItem(store, { topicId, originQuestionId: question.id });
    stage = item.stage;
    const out = advance(store, {
      topicId,
      questionId: question.id,
      originQuestionId: item.originQuestionId,
      stage: item.stage,
      passed,
    });
    items.push(out.item);
    if (out.note) notes.push(out.note);
  }

  // 3. 可信度升级：draft 在无争议批改后升 verified
  let promoted = false;
  if (question.reviewStatus === 'draft' && !input.userAdjusted) {
    setReviewStatus(store, question.id, 'verified');
    promoted = true;
  }

  // 4. 写记录
  const mode = ATTEMPT_MODES.includes(input.mode) ? input.mode : wasUnseen ? 'first' : 'review';
  const attempt = {
    id: newId('a'),
    questionId: question.id,
    sessionId: input.sessionId ?? null,
    mode,
    stage: mode === 'first' ? null : stage,
    answer: input.answer ?? {},
    score: result.score ?? 0,
    maxScore: question.maxScore,
    verdict: passed ? 'pass' : 'fail',
    detail: result.detail ?? null,
    errorTags: (Array.isArray(input.errorTags) ? input.errorTags : []).filter((t) => ERROR_TAGS.includes(t)),
    userAdjusted: Boolean(input.userAdjusted),
    wasUnseen,
    seconds: Number.isFinite(input.seconds) ? input.seconds : null,
    submittedAt: nowIso(),
  };
  store.update('attempts', (d) => {
    d.attempts.push(attempt);
  });

  if (input.sessionId) {
    store.update('sessions', (d) => {
      const s = d.sessions.find((x) => x.id === input.sessionId);
      if (s) {
        s.endedAt = nowIso();
        s.answers = (s.answers ?? 0) + 1;
      }
    });
  }

  return {
    attempt,
    passed,
    verdictText: describeVerdict(question, passed),
    scheduleNotes: [...new Set(notes)],
    items,
    promoted,
    question: { id: question.id, type: question.type, stem: question.stem, reviewStatus: promoted ? 'verified' : question.reviewStatus },
  };
}
