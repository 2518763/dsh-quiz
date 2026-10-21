/**
 * Agent 侧工具（5 个）：
 *   quiz_import        导入资料（切段入库）
 *   quiz_topics        考点：列 / 认 / 覆盖
 *   quiz_add_question  出题入库（校验出处，无源不收）
 *   quiz_start         组卷（范围自动选，返回本次覆盖说明）
 *   quiz_record        记录作答（判分 → 排程 → 可信度升级）
 *   quiz_stats         统计与覆盖
 *
 * 这些工具是「插件的数据面」，对话里由模型调用；客户端面板走 HTTP 读同一份数据。
 */

import { storeFor, workspaceOf } from './runtime.js';
import { importSource, listSources, ensureTopic, coverage, setSourceStatus } from './library.js';
import { addQuestion, getQuestion, listQuestions } from './questions.js';
import { composeSession, seenState } from './compose.js';
import { recordAttempt, ERROR_TAGS } from './attempts.js';
import { summarize } from './stats.js';
import { dueItems, activeItems, stagePlan } from './schedule.js';
import { QUESTION_TYPES, ORIGIN_TYPES } from './questions.js';

function ctxStore(exec) {
  const root = workspaceOf(exec);
  return { store: storeFor(root), root };
}

/** 给面板/工具共用的一段「为什么这题现在出现」。 */
function whyNow(store, question) {
  const qTopics = store.read('questions').questionTopics.filter((qt) => qt.questionId === question.id);
  const items = store.read('schedule').items.filter((i) => qTopics.some((qt) => qt.topicId === i.topicId));
  const due = items.filter((i) => !i.masteredAt && i.dueAt && new Date(i.dueAt) <= new Date());
  if (due.length > 0) return `到期复习：${stagePlan(due[0].stage)?.label ?? '第 1 天'}（${due[0].stage} 阶段）`;
  const weak = items.filter((i) => !i.masteredAt);
  if (weak.length > 0) return `未掌握考点：${stagePlan(weak[0].stage)?.label ?? ''}`;
  const attempts = store.read('attempts').attempts.filter((a) => a.questionId === question.id);
  if (attempts.length === 0) return '新题（第一次出现）';
  return '最近学过的章节';
}

export function buildQuizTools() {
  return [
    {
      name: 'quiz_import',
      description:
        '把一份 Markdown 资料导入本地资料库并切段。必须给 book（书名）；资料库只认有书名的出处。导入后默认 active，可先用 quiz_topics 看覆盖。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['book'],
        properties: {
          book: { type: 'string', description: '书名，例如「經濟學 中四上」' },
          file: { type: 'string', description: '资料文件路径（Markdown）' },
          raw: { type: 'string', description: '直接给 Markdown 原文（与 file 二选一）' },
          edition: { type: 'string', description: '版本，例如「2024 版」' },
          type: { type: 'string', enum: ['textbook', 'notes', 'worksheet', 'pastpaper', 'markingscheme'], description: '资料类型' },
          priority: { type: 'integer', minimum: 1, maximum: 3, description: '1=marking scheme，2=课本，3=笔记' },
          maxChars: { type: 'integer', minimum: 200, maximum: 4000, description: '单段字数上限，默认 1200' },
        },
      },
      async execute(args, exec) {
        const { store } = ctxStore(exec);
        const out = importSource(store, args ?? {});
        return {
          ok: true,
          sourceId: out.source.id,
          book: out.source.book,
          chunks: out.chunkCount,
          status: out.source.status,
          dir: store.dir,
        };
      },
    },
    {
      name: 'quiz_topics',
      description: '考点管理：action=list 列出已有考点；action=ensure 新建或复用考点（name 必填）；action=coverage 看覆盖（哪些考点没题、哪些段落没出过题）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'ensure', 'coverage'] },
          name: { type: 'string', description: '考点名（ensure 用）' },
          aliases: { type: 'array', items: { type: 'string' }, description: '别名，例如 opportunity cost' },
        },
      },
      async execute(args, exec) {
        const { store } = ctxStore(exec);
        const action = args?.action;
        if (action === 'ensure') {
          const topic = ensureTopic(store, args?.name, args?.aliases ?? []);
          return { ok: true, topic };
        }
        if (action === 'coverage') return { ok: true, coverage: coverage(store) };
        return {
          ok: true,
          topics: store.read('topics').topics.map((t) => ({
            id: t.id,
            name: t.name,
            questions: store.read('questions').questionTopics.filter((qt) => qt.topicId === t.id).length,
          })),
        };
      },
    },
    {
      name: 'quiz_add_question',
      description:
        '把一道已生成的题入库并强制校验出处：每个给分点必须带 evidenceChunkId 和 quote，quote 必须能在该段原文里找到，否则拒绝入库。题型 mcq/matching_fill/short/long。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'stem', 'chunkIds', 'answerPoints'],
        properties: {
          type: { type: 'string', enum: QUESTION_TYPES },
          stem: { type: 'string', description: '题干' },
          chunkIds: { type: 'array', items: { type: 'string' }, description: '至少一个 chunk id（出处）' },
          topicIds: { type: 'array', items: { type: 'string' }, description: '考点 id（与 topicNames 二选一）' },
          topicNames: { type: 'array', items: { type: 'string' }, description: '考点名（不存在会自动建）' },
          answerPoints: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'evidenceChunkId', 'quote'],
              properties: {
                text: { type: 'string', description: '给分点描述' },
                points: { type: 'number', description: '分值，默认 1' },
                evidenceChunkId: { type: 'string', description: '证据所在 chunk' },
                quote: { type: 'string', description: '原文原句（必须能在 chunk 里找到）' },
              },
            },
          },
          maxScore: { type: 'number' },
          difficulty: { type: 'integer', minimum: 1, maximum: 3 },
          options: { type: 'array', items: { type: 'string' }, description: 'mcq 选项' },
          answerIndex: { type: 'integer', description: 'mcq 正确选项下标（从 0 起）' },
          pairs: {
            type: 'array',
            description: 'matching_fill 的空格与正确代号',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['prompt', 'code'],
              properties: { prompt: { type: 'string' }, code: { type: 'string' } },
            },
          },
          originType: { type: 'string', enum: ORIGIN_TYPES },
        },
      },
      async execute(args, exec) {
        const { store } = ctxStore(exec);
        const topicIds = [...(args?.topicIds ?? [])];
        for (const name of args?.topicNames ?? []) {
          topicIds.push(ensureTopic(store, name).id);
        }
        const out = addQuestion(store, { ...args, topicIds });
        return { ok: true, questionId: out.question.id, reviewStatus: out.question.reviewStatus, points: out.answerPoints.length };
      },
    },
    {
      name: 'quiz_start',
      description:
        '组卷：范围由插件自动选（到期复习 40% / 未掌握考点 30% / 最近章节 20% / 混合 10%）。mode=mock 时只出 official 或 verified 的题，且不返回答案。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 60, description: '题数，默认 10' },
          mode: { type: 'string', enum: ['practice', 'mock'] },
          topicIds: { type: 'array', items: { type: 'string' }, description: '限定考点（可选）' },
        },
      },
      async execute(args, exec) {
        const { store } = ctxStore(exec);
        const out = composeSession(store, args ?? {});
        const isMock = out.session.mode === 'mock';
        const questions = out.questions.map((q) => {
          const full = getQuestion(store, q.id);
          const base = {
            id: q.id,
            type: q.type,
            stem: q.stem,
            options: q.options,
            pairs: full?.type === 'matching_fill' ? full.pairs.map((p) => ({ prompt: p.prompt })) : [],
            maxScore: q.maxScore,
            source: full?.chunks?.[0] ? { book: full.chunks[0].book, pageFrom: full.chunks[0].pageFrom, pageTo: full.chunks[0].pageTo } : null,
            whyNow: whyNow(store, q),
            reviewStatus: q.reviewStatus,
          };
          // 模拟模式不把答案交给模型（避免顺手说出去）
          if (isMock) return base;
          return { ...base, answerPoints: full?.answerPoints?.map((p) => ({ id: p.id, text: p.text, points: p.points })) ?? [], pairsWithCode: full?.pairs ?? [] };
        });
        return {
          ok: true,
          session: out.session,
          coverage: out.coverage,
          skipped: out.skipped,
          questions,
          dir: out.dir,
        };
      },
    },
    {
      name: 'quiz_record',
      description:
        '记录作答：mcq 传 answer.choice，填空配对传 answer.fills；short/long 传 score 与 pointHits。会自动推进错题排程并把无争议的 draft 题升为 verified。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['questionId'],
        properties: {
          questionId: { type: 'string' },
          sessionId: { type: 'string' },
          answer: {
            type: 'object',
            additionalProperties: true,
            properties: {
              choice: { type: 'integer' },
              fills: { type: 'array', items: { type: 'string' } },
              text: { type: 'string' },
            },
          },
          score: { type: 'number', description: '短答/长答的合计分' },
          pointHits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['pointId', 'hit'],
              properties: { pointId: { type: 'string' }, hit: { type: 'string', enum: ['hit', 'partial', 'miss'] } },
            },
          },
          errorTags: { type: 'array', items: { type: 'string', enum: ERROR_TAGS } },
          mode: { type: 'string', enum: ['first', 'review', 'transfer', 'mock'] },
          userAdjusted: { type: 'boolean', description: '用户改过分' },
          seconds: { type: 'number' },
        },
      },
      async execute(args, exec) {
        const { store } = ctxStore(exec);
        const out = recordAttempt(store, args ?? {});
        return {
          ok: true,
          passed: out.passed,
          verdictText: out.verdictText,
          scheduleNotes: out.scheduleNotes,
          items: out.items.map((i) => ({ topicId: i.topicId, stage: i.stage, dueAt: i.dueAt, mastered: Boolean(i.masteredAt), relearning: i.relearning })),
          promoted: out.promoted,
          seenState: seenState(store, args.questionId),
        };
      },
    },
    {
      name: 'quiz_stats',
      description: '统计：三条曲线（首次 / 分阶段重做 / 按考点）、错误归因、覆盖情况、到期复习数。detail=summary|coverage。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { detail: { type: 'string', enum: ['summary', 'coverage'] } },
      },
      async execute(args, exec) {
        const { store, root } = ctxStore(exec);
        if (args?.detail === 'coverage') return { ok: true, coverage: coverage(store), sources: listSources(store) };
        return {
          ok: true,
          workspace: root,
          stats: summarize(store),
          due: dueItems(store).length,
          active: activeItems(store).length,
          summary: store.summary(),
          recent: listQuestions(store).slice(-5).map((q) => ({ id: q.id, type: q.type, stem: q.stem.slice(0, 40), reviewStatus: q.reviewStatus })),
        };
      },
    },
  ];
}
