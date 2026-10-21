/**
 * 本地存储：一个工作区一个目录，每个域一个 JSON 文件。
 *
 * 为什么不用 SQLite：
 *   v1 的目标是「零依赖、可直接装、能随时备份」。JSON 文件可以直接扔进网盘/仓库，
 *   出问题用记事本就能看。等数据量真的大到卡了，再迁 SQLite —— 接口已经按「读写整表」设计，
 *   迁移时只换这一层。
 *
 * 写盘规矩：先写临时文件再 rename，避免写一半断电留下半截 JSON。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { nowIso } from './util.js';

export const DATA_DIR_NAME = '.dsh-quiz';

/** 每个域对应一个文件，全部是 { <域>: [...] } 或对象。 */
const FILES = {
  meta: 'meta.json',
  sources: 'sources.json',
  chunks: 'chunks.json',
  topics: 'topics.json',
  questions: 'questions.json',
  attempts: 'attempts.json',
  schedule: 'schedule.json',
  sessions: 'sessions.json',
};

const EMPTY = {
  meta: { version: 1, createdAt: null, updatedAt: null },
  sources: { sources: [] },
  chunks: { chunks: [] },
  topics: { topics: [] },
  questions: { questions: [], questionTopics: [], questionChunks: [], answerPoints: [] },
  attempts: { attempts: [] },
  schedule: { items: [] },
  sessions: { sessions: [] },
};

export class Store {
  /** @param {string} root 工作区根目录（会话 cwd） */
  constructor(root) {
    this.dir = join(root, DATA_DIR_NAME);
    this.cache = new Map();
  }

  /** 目录不在就建。建不了就直接抛，让调用方报错，不静默降级。 */
  ensure() {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    const metaPath = join(this.dir, FILES.meta);
    if (!existsSync(metaPath)) {
      this.write('meta', { version: 1, createdAt: nowIso(), updatedAt: nowIso() });
    }
    return this.dir;
  }

  pathOf(domain) {
    const file = FILES[domain];
    if (!file) throw new Error(`未知数据域：${domain}`);
    return join(this.dir, file);
  }

  /** 读一个域；文件不在或坏了就返回空骨架（坏文件另存 .corrupt 备份）。 */
  read(domain) {
    if (this.cache.has(domain)) return this.cache.get(domain);
    const file = this.pathOf(domain);
    const empty = structuredClone(EMPTY[domain]);
    if (!existsSync(file)) {
      this.cache.set(domain, empty);
      return empty;
    }
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      this.cache.set(domain, parsed);
      return parsed;
    } catch (error) {
      const backup = `${file}.corrupt-${Date.now()}`;
      try {
        writeFileSync(backup, readFileSync(file));
      } catch {
        /* 备份失败也要继续，至少不覆盖 */
      }
      this.cache.set(domain, empty);
      return empty;
    }
  }

  write(domain, value) {
    const file = this.pathOf(domain);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    renameSync(tmp, file);
    this.cache.set(domain, value);
    if (domain !== 'meta') {
      const meta = this.read('meta');
      meta.updatedAt = nowIso();
      this.write('meta', meta);
    }
    return value;
  }

  /** 一次事务式修改：读 → 改 → 写。fn 返回 undefined 时用原对象。 */
  update(domain, fn) {
    const current = structuredClone(this.read(domain));
    const next = fn(current) ?? current;
    return this.write(domain, next);
  }

  /** 概览：给面板和工具用的一句话状态。 */
  summary() {
    const sources = this.read('sources').sources;
    const chunks = this.read('chunks').chunks;
    const topics = this.read('topics').topics;
    const questions = this.read('questions').questions;
    const attempts = this.read('attempts').attempts;
    return {
      dir: this.dir,
      sources: sources.length,
      chunks: chunks.length,
      topics: topics.length,
      questions: questions.length,
      attempts: attempts.length,
      updatedAt: this.read('meta').updatedAt,
    };
  }

  /** 列目录下已有的资料文件，给「导入」用。 */
  listSourceFiles() {
    const dir = join(this.dir, 'sources');
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!statSync(full).isDirectory()) out.push(full);
    }
    return out;
  }
}

export function openStore(root) {
  const store = new Store(root);
  store.ensure();
  return store;
}

export { FILES };
