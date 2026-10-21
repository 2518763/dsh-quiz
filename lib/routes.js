/**
 * 客户端面板用的只读 HTTP 路由。
 *
 * 面板不需要写权限：答题与出题都走 agent 工具，面板只负责「看」——
 * 看资料库、看覆盖、看三条曲线、看到期。
 */

import { storeForRequest } from './runtime.js';
import { coverage, listSources } from './library.js';
import { summarize } from './stats.js';
import { dueItems, activeItems } from './schedule.js';
import { listQuestions } from './questions.js';

const PREFIX = '/api/quiz';

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function paramsOf(request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      if (body && typeof body === 'object') Object.assign(params, body);
    } catch {
      /* 没有 body 就只用 query */
    }
  }
  return params;
}

function guard(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch (error) {
      return json({ ok: false, reason: 'internal', message: error && error.message ? error.message : String(error) }, 500);
    }
  };
}

export function buildQuizRoutes() {
  return [
    {
      path: `${PREFIX}/state`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const { store, root } = storeForRequest(params);
        if (!store) {
          return json({
            ok: false,
            reason: 'no-workspace',
            hint: '还没有任何测验记录。先在一个项目目录里跟 AI 说「开始做测验」，入库一次后再打开这里。',
          });
        }
        return json({
          ok: true,
          workspace: root,
          summary: store.summary(),
          stats: summarize(store),
          coverage: coverage(store),
          due: dueItems(store).length,
          active: activeItems(store).length,
          sources: listSources(store).map((s) => ({
            id: s.id,
            book: s.book,
            edition: s.edition,
            type: s.type,
            status: s.status,
            chunks: s.chunkCount,
            addedAt: s.addedAt,
          })),
        });
      }),
    },
    {
      path: `${PREFIX}/questions`,
      methods: ['GET'],
      fetch: guard(async (request) => {
        const params = await paramsOf(request);
        const { store } = storeForRequest(params);
        if (!store) return json({ ok: false, reason: 'no-workspace' }, 404);
        const limit = Number(params.limit) > 0 ? Math.min(200, Number(params.limit)) : 20;
        const rows = listQuestions(store)
          .slice(-limit)
          .reverse()
          .map((q) => ({
            id: q.id,
            type: q.type,
            stem: q.stem,
            reviewStatus: q.reviewStatus,
            originType: q.originType,
            maxScore: q.maxScore,
            createdAt: q.createdAt,
          }));
        return json({ ok: true, questions: rows });
      }),
    },
  ];
}
