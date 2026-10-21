/**
 * 运行时装配：把「工作区 → Store 实例」缓存起来，并记住最近用过的那个工作区。
 *
 * 为什么要记：工具（agent 调用）能拿到会话 cwd，但客户端的 HTTP 请求拿不到。
 * 面板要读统计时，就靠这个指针找回到最近活跃的工作区 —— 只存路径，不存数据。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openStore } from './store.js';

const cache = new Map();

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function pointerFile() {
  return join(dshHome(), 'quiz', 'last-workspace.json');
}

export function rememberWorkspace(root) {
  try {
    const file = pointerFile();
    mkdirSync(join(dshHome(), 'quiz'), { recursive: true });
    writeFileSync(file, JSON.stringify({ root, at: new Date().toISOString() }, null, 2), 'utf8');
  } catch {
    /* 记不住不致命：面板退化成「先跑一次测验再看」 */
  }
}

export function lastWorkspace() {
  try {
    const file = pointerFile();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return typeof parsed.root === 'string' && parsed.root ? parsed.root : null;
  } catch {
    return null;
  }
}

/** 会话 cwd（工具上下文里唯一可靠的「工作区」来源）。 */
export function workspaceOf(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null;
}

/** 按工作区取 Store（带缓存；工作区被删也能自愈重开）。 */
export function storeFor(root) {
  if (!root) throw new Error('无法确定工作区（会话没有 cwd）。请在某个项目目录里发起会话。');
  if (!cache.has(root)) cache.set(root, openStore(root));
  const store = cache.get(root);
  store.ensure();
  if (root) rememberWorkspace(root);
  return store;
}

export function clearCache() {
  cache.clear();
}

/** 客户端用的：按查询参数或最近指针找 Store。 */
export function storeForRequest(query = {}) {
  const root = (typeof query.workspace === 'string' && query.workspace) || lastWorkspace();
  if (!root) return { store: null, root: null };
  return { store: storeFor(root), root };
}
