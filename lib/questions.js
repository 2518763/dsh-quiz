/**
 * 题目：入库、校验、状态流转。
 *
 * 这里是「无出处不出题」真正落地的地方，**校验在 addQuestion 里，不在提示词里**：
 *   · 每道题至少绑一个 chunk（且该 chunk 来自 reviewed/active 的资料）
 *   · 每个给分点必须有 evidenceChunkId + quote
 *   · quote 必须能在那个 chunk 的原文里找到（归一化后比对）
 * 任何一条不过就直接抛错，拒绝入库。宁可少一道题，不要一道无源题。
 */

import { newId, normalizeText, quoteFoundIn, clamp } from './util.js';
import { usableChunks } from './library.js';

export const QUESTION_TYPES = ['mcq', 'matching_fill', 'short', 'long'];
export const ORIGIN_TYPES = ['official', 'generated'];
export const REVIEW_STATUSES = ['draft', 'verified', 'disputed', 'rejected'];
export const PURPOSE_TYPES = ['stem', 'answer', 'distractor'];

const TYPE_DEFAULT_SCORE = { mcq: 2, matching_fill: 4, short: 4, long: 8 };

/**
 * 入库一道题。
 * @param {import('./store.js').Store} store
 * @param {object} input
 * @param {'mcq'|'matching_fill'|'short'|'long'} input.type
 * @param {string} input.stem
 * @param {string[]} input.chunkIds
 * @param {string[]} input.topicIds
 * @param {Array<{text:string, points:number, evidenceChunkId:string, quote:string}>} input.answerPoints
 * @param {number} [input.maxScore]
 * @param {number} [input.difficulty] 1-3
 * @param {string[]} [input.options] mcq 用
 * @param {number} [input.answerIndex] mcq 用
 * @param {Array<{prompt:string, code:string}>} [input.pairs] matching_fill 用（code 是正确代号）
 * @param {string} [input.originType]
 * @param {string} [input.reviewStatus]
 */
export function addQuestion(store, input = {}) {
  const type = input.type;
  if (!QUESTION_TYPES.includes(type)) throw new Error(`addQuestion: 题型不合法（${type}），只支持 ${QUESTION_TYPES.join('/')}`);

  const stem = normalizeText(input.stem);
  if (!stem) throw new Error('addQuestion: 题干为空。');

  const usable = new Set(usableChunks(store).map((c) => c.id));
  const chunkIds = Array.isArray(input.chunkIds) ? input.chunkIds.filter(Boolean) : [];
  if (chunkIds.length === 0) throw new Error('addQuestion: 没有绑定任何 chunk。无出处不出题。');
  for (const id of chunkIds) {
    if (!usable.has(id)) throw new Error(`addQuestion: chunk ${id} 不存在或所属资料未启用（需 reviewed/active）。`);
  }

  const topicIds = Array.isArray(input.topicIds) ? input.topicIds.filter(Boolean) : [];
  if (topicIds.length === 0) throw new Error('addQuestion: 至少绑定一个考点。');
  const knownTopics = new Set(store.read('topics').topics.map((t) => t.id));
  for (const id of topicIds) {
    if (!knownTopics.has(id)) throw new Error(`addQuestion: 考点 ${id} 不存在，先用 ensureTopic 建。`);
  }

  const pointsInput = Array.isArray(input.answerPoints) ? input.answerPoints : [];
  if (pointsInput.length === 0) throw new Error('addQuestion: 没有给分点。没有给分点的题无法批改。');
  const chunksById = new Map(store.read('chunks').chunks.map((c) => [c.id, c]));
  const answerPoints = pointsInput.map((p, index) => {
    const text = normalizeText(p.text);
    if (!text) throw new Error(`addQuestion: 第 ${index + 1} 个给分点没有内容。`);
    const evidenceChunkId = p.evidenceChunkId;
    const chunk = chunksById.get(evidenceChunkId);
    if (!chunk) throw new Error(`addQuestion: 给分点「${text.slice(0, 20)}」的证据 chunk 不存在（${evidenceChunkId}）。`);
    if (!quoteFoundIn(p.quote, chunk.text)) {
      throw new Error(
        `addQuestion: 给分点「${text.slice(0, 20)}」的引文在 chunk ${evidenceChunkId} 里找不到。原文里必须有这句，否则就是无源要点。\n引文：${String(p.quote).slice(0, 80)}`,
      );
    }
    return {
      id: newId('ap'),
      text,
      points: Number.isFinite(p.points) ? p.points : 1,
      evidenceChunkId,
      quote: normalizeText(p.quote),
      sortOrder: index,
    };
  });

  // 题型各自的必备字段
  let options = [];
  let answerIndex = null;
  let pairs = [];
  if (type === 'mcq') {
    options = (Array.isArray(input.options) ? input.options : []).map((o) => normalizeText(o)).filter(Boolean);
    if (options.length < 2) throw new Error('addQuestion: mcq 至少要有 2 个选项。');
    if (!Number.isInteger(input.answerIndex) || input.answerIndex < 0 || input.answerIndex >= options.length) {
      throw new Error('addQuestion: mcq 的 answerIndex 必须是合法下标。');
    }
    answerIndex = input.answerIndex;
  }
  if (type === 'matching_fill') {
    pairs = (Array.isArray(input.pairs) ? input.pairs : []).map((p) => ({
      prompt: normalizeText(p.prompt),
      code: normalizeText(p.code),
    }));
    if (pairs.length < 2) throw new Error('addQuestion: matching_fill 至少要有 2 个空格。');
    if (pairs.some((p) => !p.prompt || !p.code)) throw new Error('addQuestion: matching_fill 的每个空格都要有题干与正确代号。');
  }

  const maxScore = Number.isFinite(input.maxScore) ? input.maxScore : TYPE_DEFAULT_SCORE[type];
  const now = new Date().toISOString();
  const question = {
    id: newId('q'),
    type,
    stem,
    options,
    answerIndex,
    pairs,
    maxScore,
    difficulty: clamp(Number.isFinite(input.difficulty) ? input.difficulty : 2, 1, 3),
    originType: ORIGIN_TYPES.includes(input.originType) ? input.originType : 'generated',
    reviewStatus: REVIEW_STATUSES.includes(input.reviewStatus) ? input.reviewStatus : 'draft',
    active: true,
    createdAt: now,
  };

  store.update('questions', (d) => {
    d.questions.push(question);
    for (const topicId of topicIds) d.questionTopics.push({ questionId: question.id, topicId, weight: 1 });
    for (const chunkId of chunkIds) d.questionChunks.push({ questionId: question.id, chunkId, purpose: 'stem' });
    for (const ap of answerPoints) d.answerPoints.push({ ...ap, questionId: question.id });
  });

  return { question, answerPoints };
}

/** 取一道题的全部内容（含给分点、出处）。 */
export function getQuestion(store, questionId) {
  const qd = store.read('questions');
  const question = qd.questions.find((q) => q.id === questionId);
  if (!question) return null;
  const answerPoints = qd.answerPoints.filter((ap) => ap.questionId === questionId).sort((a, b) => a.sortOrder - b.sortOrder);
  const topics = qd.questionTopics.filter((qt) => qt.questionId === questionId);
  const chunks = qd.questionChunks.filter((qc) => qc.questionId === questionId);
  const chunkById = new Map(store.read('chunks').chunks.map((c) => [c.id, c]));
  const sourceById = new Map(store.read('sources').sources.map((s) => [s.id, s]));
  const chunkInfo = chunks
    .map((qc) => chunkById.get(qc.chunkId))
    .filter(Boolean)
    .map((c) => ({
      id: c.id,
      heading: c.heading,
      pageFrom: c.pageFrom,
      pageTo: c.pageTo,
      book: sourceById.get(c.sourceId)?.book ?? '',
    }));
  return { ...question, answerPoints, topicIds: topics.map((t) => t.topicId), topicWeights: topics, chunks: chunkInfo };
}

/** 状态流转：draft → verified / disputed → rejected。 */
export function setReviewStatus(store, questionId, status) {
  if (!REVIEW_STATUSES.includes(status)) throw new Error(`非法审核状态：${status}`);
  let found = null;
  store.update('questions', (d) => {
    for (const q of d.questions) {
      if (q.id === questionId) {
        q.reviewStatus = status;
        found = q;
      }
    }
  });
  if (!found) throw new Error(`找不到题目：${questionId}`);
  return found;
}

/** 按条件挑题（组卷用）。 */
export function listQuestions(store, { reviewStatus, originType, type } = {}) {
  return store.read('questions').questions.filter(
    (q) => q.active && (!reviewStatus || q.reviewStatus === reviewStatus) && (!originType || q.originType === originType) && (!type || q.type === type),
  );
}
