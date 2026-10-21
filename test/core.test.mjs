import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore } from '../lib/store.js';
import { importSource, ensureTopic } from '../lib/library.js';
import { addQuestion, getQuestion } from '../lib/questions.js';
import { recordAttempt } from '../lib/attempts.js';
import { summarize } from '../lib/stats.js';
import { composeSession } from '../lib/compose.js';
import { dueItems } from '../lib/schedule.js';

const RAW = `---
book: 测试书
pages: 1-9
---

## 稀少性（p.1）

慾望無限而資源有限，稱為稀少性。

## 機會成本（p.3）

在所放棄的選擇中價值最高的一項，稱為機會成本。
`;

function withStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'quiz-test-'));
  try {
    return fn(openStore(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function seed(store) {
  const { source } = importSource(store, { raw: RAW, book: '测试书' });
  const topic = ensureTopic(store, '機會成本');
  const chunk = store.read('chunks').chunks.find((c) => c.text.includes('機會成本'));
  return { source, topic, chunk };
}

function makeQuestion(store, { topic, chunk, stem = '机会成本是什么？', answerIndex = 0 }) {
  const out = addQuestion(store, {
    type: 'mcq',
    stem,
    chunkIds: [chunk.id],
    topicIds: [topic.id],
    options: ['在所放棄的選擇中價值最高的一項', '資源有限', '分工', '競爭'],
    answerIndex,
    maxScore: 2,
    originType: 'official',
    reviewStatus: 'verified',
    answerPoints: [{ text: '機會成本定義', points: 2, evidenceChunkId: chunk.id, quote: '價值最高的一項，稱為機會成本' }],
  });
  return out.question;
}

test('出题必须绑考点', () => {
  withStore((store) => {
    const { chunk } = seed(store);
    assert.throws(
      () =>
        addQuestion(store, {
          type: 'mcq',
          stem: 'x',
          chunkIds: [chunk.id],
          topicIds: [],
          options: ['a', 'b'],
          answerIndex: 0,
          answerPoints: [{ text: 't', evidenceChunkId: chunk.id, quote: '稱為機會成本' }],
        }),
      /至少绑定一个考点/,
    );
  });
});

test('答错进 1 天排程；原题在 stage2 不算掌握证据', () => {
  withStore((store) => {
    const { topic, chunk } = seed(store);
    const q = makeQuestion(store, { topic, chunk });

    const first = recordAttempt(store, { questionId: q.id, answer: { choice: 1 } });
    assert.equal(first.passed, false);
    assert.equal(first.items[0].stage, 1);
    assert.equal(dueItems(store).length, 0, '刚错的题今天不重复出现，明天才到期');

    // stage1 原题做对 → 进 stage2
    const second = recordAttempt(store, { questionId: q.id, answer: { choice: 0 } });
    assert.equal(second.passed, true);
    assert.equal(second.items[0].stage, 2);

    // stage2 还是原题 → 不算证据，停在 stage2
    const third = recordAttempt(store, { questionId: q.id, answer: { choice: 0 } });
    assert.equal(third.items[0].stage, 2, '原题不能当变式证据');
    assert.ok(third.scheduleNotes.some((n) => n.includes('原题')));
  });
});

test('变式 + 混合都过才 mastered', () => {
  withStore((store) => {
    const { topic, chunk } = seed(store);
    const q1 = makeQuestion(store, { topic, chunk, stem: '原题' });
    const q2 = makeQuestion(store, { topic, chunk, stem: '变式题' });
    const q3 = makeQuestion(store, { topic, chunk, stem: '混合题' });

    recordAttempt(store, { questionId: q1.id, answer: { choice: 1 } }); // 错
    recordAttempt(store, { questionId: q1.id, answer: { choice: 0 } }); // stage1 过 → stage2
    recordAttempt(store, { questionId: q2.id, answer: { choice: 0 } }); // 变式过 → stage3
    const last = recordAttempt(store, { questionId: q3.id, answer: { choice: 0 } }); // 混合过
    assert.ok(last.items[0].masteredAt, '变式与混合都过应 mastered');
    assert.equal(last.items[0].stage, 3);
  });
});

test('连续两次失败转重新学习', () => {
  withStore((store) => {
    const { topic, chunk } = seed(store);
    const q = makeQuestion(store, { topic, chunk });
    recordAttempt(store, { questionId: q.id, answer: { choice: 1 } });
    const second = recordAttempt(store, { questionId: q.id, answer: { choice: 1 } });
    assert.equal(second.items[0].relearning, true);
    assert.ok(second.scheduleNotes.some((n) => n.includes('重新学习') || n.includes('原文')));
  });
});

test('首次正确率只算没见过答案的那一次', () => {
  withStore((store) => {
    const { topic, chunk } = seed(store);
    const q = makeQuestion(store, { topic, chunk });
    recordAttempt(store, { questionId: q.id, answer: { choice: 0 } });
    recordAttempt(store, { questionId: q.id, answer: { choice: 0 } });
    const stats = summarize(store);
    assert.equal(stats.first.total, 1, '第二次不能算首次');
    assert.equal(stats.first.passed, 1);
    assert.equal(stats.first.rate, 100);
  });
});

test('按考点统计：权重分摊，不重复计数', () => {
  withStore((store) => {
    const { topic, chunk } = seed(store);
    const q = makeQuestion(store, { topic, chunk });
    recordAttempt(store, { questionId: q.id, answer: { choice: 1 } });
    const stats = summarize(store);
    const row = stats.byTopic.find((r) => r.topicId === topic.id);
    assert.equal(row.total, 1);
    assert.equal(row.passed, 0);
  });
});

test('模拟模式只出 official/verified，练习模式可出 draft', () => {
  withStore((store) => {
    const { topic, chunk } = seed(store);
    // draft 题
    addQuestion(store, {
      type: 'mcq',
      stem: '草稿题',
      chunkIds: [chunk.id],
      topicIds: [topic.id],
      options: ['a', 'b'],
      answerIndex: 0,
      answerPoints: [{ text: 't', points: 1, evidenceChunkId: chunk.id, quote: '稱為機會成本' }],
    });
    const mock = composeSession(store, { count: 5, mode: 'mock' });
    assert.equal(mock.questions.length, 0, '模拟模式不该出 draft');
    const practice = composeSession(store, { count: 5, mode: 'practice' });
    assert.equal(practice.questions.length, 1, '练习模式可以出 draft');
  });
});

test('组卷会说明覆盖范围与跳过原因', () => {
  withStore((store) => {
    const { topic, chunk } = seed(store);
    makeQuestion(store, { topic, chunk });
    const out = composeSession(store, { count: 10 });
    assert.ok(out.coverage.topicsText.includes('機會成本'));
    assert.ok(out.skipped.length >= 1, '题不够时要说明，不能假装满了');
  });
});

test('getQuestion 带出处页码', () => {
  withStore((store) => {
    const { topic, chunk } = seed(store);
    const q = makeQuestion(store, { topic, chunk });
    const full = getQuestion(store, q.id);
    assert.equal(full.chunks[0].book, '测试书');
    assert.equal(full.chunks[0].pageFrom, 3);
  });
});
