import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../index.js';

/**
 * 这个测试不连真 host，只验「装配层」：
 * 导出面齐不齐、工具与路由能不能注册、每个工具的手册字段是否完整。
 * 真机上的坑（inject 写成对象会 pending、没导 name 会全静默失败）都在这层防。
 */

function fakeCtx() {
  const tools = [];
  const routes = [];
  return {
    tools: { register: (t) => tools.push(t) },
    connection: { fetch: { register: (r) => routes.push(r) } },
    logger: { info() {}, warn() {}, error() {} },
    toolsList: tools,
    routesList: routes,
  };
}

test('导出面正确', () => {
  assert.equal(name, 'quiz');
  assert.ok(Array.isArray(inject), 'inject 必须是数组');
  assert.deepEqual([...inject].sort(), ['connection', 'tools']);
  assert.equal(typeof apply, 'function');
});

test('注册 6 个工具、2 条路由', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  assert.equal(ctx.toolsList.length, 6);
  assert.equal(ctx.routesList.length, 2);
  for (const route of ctx.routesList) {
    assert.ok(route.path.startsWith('/api/quiz/'));
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
});

test('每个工具都有完整手册字段', () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const names = new Set();
  for (const tool of ctx.toolsList) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.parameters && tool.parameters.type === 'object');
    assert.equal(typeof tool.execute, 'function');
    assert.ok(!names.has(tool.name), `工具重名：${tool.name}`);
    names.add(tool.name);
  }
  assert.deepEqual([...names].sort(), ['quiz_add_question', 'quiz_import', 'quiz_record', 'quiz_start', 'quiz_stats', 'quiz_topics']);
});

test('工具调用缺少工作区时给出人话错误', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const tool = ctx.toolsList.find((t) => t.name === 'quiz_stats');
  await assert.rejects(() => tool.execute({}, {}), /工作区/);
});
