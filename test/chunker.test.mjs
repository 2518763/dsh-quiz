import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkMarkdown, parseFrontmatter, parsePages, DEFAULT_MAX_CHARS } from '../lib/chunker.js';

const SAMPLE = `---
book: 經濟學 中四上
edition: 2024 版
type: textbook
pages: 12-34
---

## 1.1 稀少性與選擇（p.12）

慾望無限而資源有限。

## 1.2 機會成本（p.18）

在所放棄的選擇中價值最高的一項。

### 1.2.1 計算例（p.19）

阿明揀溫書，放棄打機與睡覺，機會成本是打機。
`;

test('frontmatter 解析', () => {
  const { meta, body } = parseFrontmatter(SAMPLE);
  assert.equal(meta.book, '經濟學 中四上');
  assert.equal(meta.pages, '12-34');
  assert.ok(body.startsWith('## 1.1'));
});

test('页码范围解析', () => {
  assert.deepEqual(parsePages('## 1.1 稀少性（p.12）'), { from: 12, to: 12 });
  assert.deepEqual(parsePages('## 1.2（p.18-21）'), { from: 18, to: 21 });
  assert.deepEqual(parsePages('12-34'), { from: 12, to: 34 });
  assert.deepEqual(parsePages('沒有頁碼'), { from: null, to: null });
});

test('按 ## 切段，标题留在正文里', () => {
  const { chunks } = chunkMarkdown({ raw: SAMPLE, sourceId: 's1' });
  assert.equal(chunks.length, 2, '两个 ## 小节 → 两段（### 归入父段）');
  assert.ok(chunks[0].text.includes('1.1 稀少性與選擇'));
  assert.ok(chunks[0].text.includes('慾望無限'));
  assert.equal(chunks[0].pageFrom, 12);
  assert.equal(chunks[1].pageFrom, 18);
  assert.equal(chunks[1].parentHeading, '經濟學 中四上');
  assert.equal(chunks[0].order, 0);
  assert.equal(chunks[1].order, 1);
});

test('超长小节按段落再切，每片都带标题', () => {
  const para = '這是一段很長很長的原文，用來測試切段。'.repeat(40);
  const raw = `## 長節（p.5）\n\n${para}\n\n${para}\n\n${para}\n`;
  const { chunks } = chunkMarkdown({ raw, sourceId: 's2', maxChars: 600 });
  assert.ok(chunks.length > 1, '应当被切开');
  for (const c of chunks) {
    assert.ok(c.text.length <= 600 + 40, '单片不超过上限太多');
    assert.ok(c.text.includes('長節'), '每片都保住标题');
  }
});

test('没有 frontmatter 也能切', () => {
  const { chunks } = chunkMarkdown({ raw: '## 甲\n\n內容一。\n\n## 乙\n\n內容二。\n', sourceId: 's3' });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].parentHeading, '');
});

test('默认上限是 1200', () => {
  assert.equal(DEFAULT_MAX_CHARS, 1200);
});
