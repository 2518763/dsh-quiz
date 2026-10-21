/**
 * dsh-quiz · Host 半边（薄装配层）。
 *
 * 只做三件事：声明 name/inject、注册 agent 工具、注册面板只读路由。
 * 业务逻辑全在 lib/ 下，且都是纯函数 + Store，方便 node --test 直接测。
 *
 * 两条被真机打回过、必须记着的规矩（照 dsh-memory-board 的经验）：
 *   ① 必须导出 name 与 inject，否则 ctx.tools / ctx.connection 拿不到，注册全静默失败；
 *   ② inject 必须是数组，写成 { required: [...] } 会卡在 pending。
 */

import { buildQuizTools } from './lib/tools.js';
import { buildQuizRoutes } from './lib/routes.js';

export const name = 'quiz';
export const inject = ['tools', 'connection'];

function apply(ctx, config = {}) {
  const log = (msg) => {
    try {
      ctx.logger?.info?.(`dsh-quiz: ${msg}`);
    } catch {
      /* 没有 logger 也要活 */
    }
  };

  // 1. agent 工具
  let tools = 0;
  for (const tool of buildQuizTools()) {
    try {
      ctx.tools.register(tool);
      tools += 1;
    } catch (error) {
      log(`工具注册失败 ${tool.name}：${error && error.message ? error.message : String(error)}`);
    }
  }

  // 2. 面板路由（只读）
  let routes = 0;
  for (const route of buildQuizRoutes()) {
    try {
      ctx.connection.fetch.register({
        path: route.path,
        methods: route.methods,
        requestBody: 'buffered',
        fetch: route.fetch,
      });
      routes += 1;
    } catch (error) {
      log(`路由注册失败 ${route.path}：${error && error.message ? error.message : String(error)}`);
    }
  }

  log(`已注册 ${tools} 个工具、${routes} 条路由`);
}

// 独立跑自检：node index.js --selftest（cordis 不会调 apply，逻辑必须写在模块层可测）
if (process.argv.includes('--selftest')) {
  const { runSelftest } = await import('./lib/selftest.js');
  process.exitCode = runSelftest() ? 0 : 1;
}

export { apply };
