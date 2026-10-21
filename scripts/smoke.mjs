/**
 * 冒烟测试：不连真 host，模拟 agent 调用插件的 6 个工具，走完一整轮。
 * 用法：node scripts/smoke.mjs
 * 只写临时目录。
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'quiz-home-'));

const { apply } = await import('../index.js');

const tools = new Map();
const routes = [];
apply(
  {
    tools: { register: (t) => tools.set(t.name, t) },
    connection: { fetch: { register: (r) => routes.push(r) } },
    logger: { info() {}, warn() {}, error() {} },
  },
  {},
);

const root = mkdtempSync(join(tmpdir(), 'quiz-ws-'));
const exec = { agent: { session: { header: { cwd: root } } } };
const demo = join(here, '..', 'examples', 'demo-econ-ch01.md');

const call = async (name, args) => {
  const tool = tools.get(name);
  if (!tool) throw new Error(`没有工具 ${name}`);
  return tool.execute(args, exec);
};

try {
  console.log('工具数：', tools.size, '路由数：', routes.length);

  const imported = await call('quiz_import', { book: '示范用经济课本', file: demo, type: 'textbook' });
  console.log('导入：', imported.book, `${imported.chunks} 段`);

  const t1 = await call('quiz_topics', { action: 'ensure', name: '機會成本', aliases: ['opportunity cost'] });
  const t2 = await call('quiz_topics', { action: 'ensure', name: '稀少性' });
  console.log('考点：', t1.topic.name, t2.topic.name);

  // 从 chunk 里找原文，用来做 quote
  const { openStore } = await import('../lib/store.js');
  const store = openStore(root);
  const chunk = store.read('chunks').chunks.find((c) => c.text.includes('機會成本'));
  const chunk2 = store.read('chunks').chunks.find((c) => c.text.includes('稀少性'));
  if (!chunk || !chunk2) throw new Error('切段里找不到关键词，示例文件被改了？');

  const q1 = await call('quiz_add_question', {
    type: 'mcq',
    stem: '在所放棄的選擇中價值最高的一項稱為什麼？',
    chunkIds: [chunk.id],
    topicNames: ['機會成本'],
    options: ['機會成本', '稀少性', '分工', '競爭'],
    answerIndex: 0,
    maxScore: 2,
    originType: 'official',
    answerPoints: [{ text: '機會成本的定義', points: 2, evidenceChunkId: chunk.id, quote: '價值最高的一項，稱為機會成本' }],
  });
  console.log('出题：', q1.questionId, q1.reviewStatus);

  const q2 = await call('quiz_add_question', {
    type: 'matching_fill',
    stem: '把正確代號填入空格：A 稀少性　B 機會成本　C 分工',
    chunkIds: [chunk.id, chunk2.id],
    topicNames: ['機會成本', '稀少性'],
    maxScore: 4,
    pairs: [
      { prompt: '資源相對於慾望而言不足，稱為 ___。', code: 'A' },
      { prompt: '所放棄的選擇中價值最高的一項，稱為 ___。', code: 'B' },
    ],
    originType: 'official',
    answerPoints: [
      { text: '稀少性定義', points: 2, evidenceChunkId: chunk2.id, quote: '資源相對於慾望而言永遠不足' },
      { text: '機會成本定義', points: 2, evidenceChunkId: chunk.id, quote: '價值最高的一項，稱為機會成本' },
    ],
  });
  console.log('出题：', q2.questionId, q2.reviewStatus);

  const paper = await call('quiz_start', { count: 5, mode: 'practice' });
  console.log('组卷：', paper.questions.length, '题 | 覆盖：', paper.coverage.topicsText, '|', paper.coverage.booksText, 'p.' + paper.coverage.pagesText);
  if (paper.skipped.length) console.log('跳过说明：', paper.skipped.map((s) => s.reason).join(' / '));

  const rec1 = await call('quiz_record', { questionId: q1.questionId, sessionId: paper.session.id, answer: { choice: 1 } });
  console.log('答错：', rec1.verdictText, '|', rec1.scheduleNotes.join(' '));

  const rec2 = await call('quiz_record', { questionId: q2.questionId, sessionId: paper.session.id, answer: { fills: ['A', 'B'] } });
  console.log('配对全对：', rec2.verdictText);

  const stats = await call('quiz_stats', { detail: 'summary' });
  console.log('统计：首次', stats.stats.first.rate + '%', '| 考点项', stats.stats.byTopic.length, '| 到期', stats.due);

  const cov = await call('quiz_stats', { detail: 'coverage' });
  console.log('覆盖：未出题考点', cov.coverage.uncoveredTopics, '| 未出题段落', cov.coverage.uncoveredChunks, '/', cov.coverage.totalChunks);

  // 无源引文必须被拒
  let rejected = false;
  try {
    await call('quiz_add_question', {
      type: 'short',
      stem: '编造的题',
      chunkIds: [chunk.id],
      topicNames: ['機會成本'],
      answerPoints: [{ text: '编造要点', evidenceChunkId: chunk.id, quote: '这句原文根本不存在' }],
    });
  } catch (error) {
    rejected = true;
    console.log('无源引文被拒：', String(error.message).split('\n')[0]);
  }
  if (!rejected) throw new Error('无源引文竟然入库了！这是 P0 缺陷');

  console.log('\n冒烟测试通过。数据目录：', join(root, '.dsh-quiz'), '存在 =', existsSync(join(root, '.dsh-quiz')));
} finally {
  rmSync(root, { recursive: true, force: true });
  rmSync(process.env.DSH_HOME, { recursive: true, force: true });
}
