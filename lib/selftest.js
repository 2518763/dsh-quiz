/**
 * 自检：一条龙跑完「导入 → 建考点 → 出题（含出处校验）→ 组卷 → 作答 → 排程 → 统计」。
 * 用法：node index.js --selftest
 * 只写临时目录，不碰任何真实工作区。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from './store.js';
import { importSource, ensureTopic, coverage } from './library.js';
import { addQuestion, getQuestion } from './questions.js';
import { composeSession } from './compose.js';
import { recordAttempt } from './attempts.js';
import { summarize } from './stats.js';
import { dueItems } from './schedule.js';

const SAMPLE = `---
book: 自检用经济课本
edition: 测试版
pages: 1-10
---

## 1.1 稀少性（p.1）

慾望無限而資源有限，這稱為稀少性。

## 1.2 機會成本（p.3）

在所放棄的選擇中，價值最高的一項稱為機會成本。
`;

export function runSelftest() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-quiz-selftest-'));
  const checks = [];
  const check = (name, fn) => {
    try {
      fn();
      checks.push({ name, ok: true });
    } catch (error) {
      checks.push({ name, ok: false, message: error && error.message ? error.message : String(error) });
    }
  };

  try {
    const store = openStore(root);
    let sourceId = null;
    let topicId = null;
    let questionId = null;
    let sessionId = null;

    check('导入资料并切段', () => {
      const out = importSource(store, { raw: SAMPLE, book: '自检用经济课本', type: 'textbook' });
      sourceId = out.source.id;
      if (out.chunkCount < 2) throw new Error(`切段数不对：${out.chunkCount}`);
    });

    check('建考点', () => {
      topicId = ensureTopic(store, '機會成本', ['opportunity cost']).id;
      if (!topicId) throw new Error('考点未创建');
    });

    check('出题（带出处校验）', () => {
      const chunks = store.read('chunks').chunks;
      const chunk = chunks.find((c) => c.text.includes('機會成本'));
      if (!chunk) throw new Error('找不到含「機會成本」的段落');
      const out = addQuestion(store, {
        type: 'mcq',
        stem: '在所放棄的選擇中價值最高的一項稱為什麼？',
        chunkIds: [chunk.id],
        topicIds: [topicId],
        options: ['機會成本', '稀少性', '分工', '競爭'],
        answerIndex: 0,
        maxScore: 2,
        answerPoints: [{ text: '機會成本的定義', points: 2, evidenceChunkId: chunk.id, quote: '在所放棄的選擇中，價值最高的一項稱為機會成本' }],
      });
      questionId = out.question.id;
    });

    check('无源引文必须被拒绝', () => {
      const chunk = store.read('chunks').chunks[0];
      let rejected = false;
      try {
        addQuestion(store, {
          type: 'short',
          stem: '测试',
          chunkIds: [chunk.id],
          topicIds: [topicId],
          answerPoints: [{ text: '瞎编的要点', evidenceChunkId: chunk.id, quote: '这句原文根本不存在' }],
        });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error('无源引文竟然入库了');
    });

    check('组卷', () => {
      const out = composeSession(store, { count: 5 });
      sessionId = out.session.id;
      if (out.questions.length === 0) throw new Error('组不出题');
      if (!out.coverage.topicsText) throw new Error('没有覆盖说明');
    });

    check('答错 → 排程到明天，阶段 1', () => {
      const out = recordAttempt(store, { questionId, sessionId, answer: { choice: 1 } });
      if (out.passed) throw new Error('答错了却判通过');
      const item = out.items[0];
      if (item.stage !== 1) throw new Error(`阶段不对：${item.stage}`);
      if (!item.dueAt) throw new Error('没有下次到期时间');
      const days = (new Date(item.dueAt) - Date.now()) / 86400000;
      if (days < 0.5 || days > 1.5) throw new Error(`到期时间不在 1 天后：${item.dueAt}`);
    });

    check('draft 题在无争议批改后升 verified', () => {
      const q = getQuestion(store, questionId);
      if (q.reviewStatus !== 'verified') throw new Error(`审核状态还是 ${q.reviewStatus}`);
    });

    check('统计不把失败藏起来', () => {
      const stats = summarize(store);
      if (stats.byTopic.length === 0) throw new Error('按考点统计为空');
      if (stats.byTopic[0].total <= 0) throw new Error('考点分母为 0');
    });

    check('覆盖面板可用', () => {
      const cov = coverage(store);
      if (cov.totalChunks === 0) throw new Error('可出题段落为 0');
    });

    check('空资料被拒绝', () => {
      let rejected = false;
      try {
        importSource(store, { raw: '   ', book: '空书' });
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error('空资料竟然导入成功');
    });
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* 清不掉临时目录不算失败 */
    }
  }

  const failed = checks.filter((c) => !c.ok);
  for (const c of checks) console.log(`${c.ok ? '✔' : '✖'} ${c.name}${c.ok ? '' : ` —— ${c.message}`}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`);
  return failed.length === 0;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  runSelftest();
}
