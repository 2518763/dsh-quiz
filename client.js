/**
 * dsh-quiz · Client 半边：设置页里的「测验」一页（只读面板）。
 *
 * 三条自我约束（跟 dsh-memory-board 学来的、被真机打回过的）：
 *   ① 只依赖 react 与主题令牌，不 import 任何 Harness Client 包 —— 那些接口会变；
 *   ② 渲染一律软失败：拿不到数据就显示一句人话，不白屏；
 *   ③ 面板不写数据：答题/出题走 agent 工具，这里只负责看。
 */

window.__ModuleLoader__.load({
  id: 'dsh-quiz',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useState } = React;

    const API = '/api/quiz/state';
    const CARD = {
      border: '1px solid var(--dsw-alias-border, #d9d9d9)',
      borderRadius: 10,
      padding: '12px 14px',
      marginBottom: 12,
      background: 'var(--dsw-alias-bg-container, #fff)',
    };
    const NUM = { fontSize: 22, fontWeight: 600, lineHeight: 1.3 };
    const MUTED = { color: 'var(--dsw-alias-text-secondary, #666)', fontSize: 12 };

    function fmtRate(rate) {
      if (rate === null || rate === undefined) return '—';
      return `${rate}%`;
    }

    function Card({ title, children }) {
      return h('div', { style: CARD }, h('div', { style: { fontWeight: 600, marginBottom: 8 } }, title), children);
    }

    function StatCell({ label, value, hint }) {
      return h(
        'div',
        { style: { minWidth: 96 } },
        h('div', { style: MUTED }, label),
        h('div', { style: NUM }, value),
        hint ? h('div', { style: MUTED }, hint) : null,
      );
    }

    function QuizPanel() {
      const [state, setState] = useState({ loading: true, data: null, error: null });

      const load = useCallback(async () => {
        try {
          const res = await fetch(API, { headers: { accept: 'application/json' } });
          const data = await res.json();
          setState({ loading: false, data, error: null });
        } catch (error) {
          setState({ loading: false, data: null, error: error && error.message ? error.message : String(error) });
        }
      }, []);

      useEffect(() => {
        load();
      }, [load]);

      if (state.loading) return h('div', { style: { padding: 16 } }, '读取中……');

      if (state.error) {
        return h('div', { style: { padding: 16 } }, `读不到测验数据：${state.error}`);
      }

      const data = state.data ?? {};
      if (!data.ok) {
        return h(
          'div',
          { style: { padding: 16 } },
          h('div', { style: { fontWeight: 600, marginBottom: 8 } }, '还没有测验记录'),
          h('div', { style: MUTED }, data.hint ?? '先在一个项目里开始做测验，数据会出现在这里。'),
        );
      }

      const summary = data.summary ?? {};
      const stats = data.stats ?? {};
      const coverage = data.coverage ?? {};

      return h(
        'div',
        { style: { padding: 4 } },
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
          h('div', { style: { fontWeight: 700, fontSize: 15 } }, '做题回炉'),
          h(
            'button',
            { onClick: load, style: { cursor: 'pointer', padding: '4px 10px', borderRadius: 6 } },
            '刷新',
          ),
        ),
        h(
          'div',
          { style: { ...MUTED, marginBottom: 12 } },
          `工作区：${data.workspace ?? '（未知）'}`,
        ),
        h(
          Card,
          { title: '库存' },
          h(
            'div',
            { style: { display: 'flex', gap: 24, flexWrap: 'wrap' } },
            h(StatCell, { label: '资料', value: summary.sources ?? 0 }),
            h(StatCell, { label: '段落', value: summary.chunks ?? 0 }),
            h(StatCell, { label: '题目', value: summary.questions ?? 0 }),
            h(StatCell, { label: '作答', value: summary.attempts ?? 0 }),
            h(StatCell, { label: '到期', value: data.due ?? 0, hint: `${data.active ?? 0} 个考点在池` }),
          ),
        ),
        h(
          Card,
          { title: '首次作答正确率' },
          h(
            'div',
            { style: { display: 'flex', gap: 24, flexWrap: 'wrap' } },
            h(StatCell, {
              label: '首次',
              value: fmtRate(stats.first?.rate),
              hint: `${stats.first?.passed ?? 0}/${stats.first?.total ?? 0}`,
            }),
          ),
        ),
        h(
          Card,
          { title: '分阶段重做' },
          h(
            'div',
            { style: { display: 'flex', gap: 24, flexWrap: 'wrap' } },
            [['stage1', '第 1 天原题'], ['stage2', '第 3 天变式'], ['stage3', '第 14 天混合']].map(([key, label]) =>
              h(StatCell, {
                key,
                label,
                value: fmtRate(stats.review?.[key]?.rate),
                hint: `${stats.review?.[key]?.passed ?? 0}/${stats.review?.[key]?.total ?? 0}`,
              }),
            ),
          ),
        ),
        h(
          Card,
          { title: '按考点' },
          (stats.byTopic ?? []).length === 0
            ? h('div', { style: MUTED }, '还没有数据。')
            : h(
                'table',
                { style: { width: '100%', borderCollapse: 'collapse', fontSize: 13 } },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    ['考点', '题量', '正确率', '上次错'].map((t) =>
                      h('th', { key: t, style: { textAlign: 'left', padding: '4px 6px', ...MUTED } }, t),
                    ),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  (stats.byTopic ?? []).map((row) =>
                    h(
                      'tr',
                      { key: row.topicId },
                      h('td', { style: { padding: '4px 6px' } }, row.name),
                      h('td', { style: { padding: '4px 6px' } }, Math.round(row.total * 100) / 100),
                      h('td', { style: { padding: '4px 6px' } }, fmtRate(row.rate)),
                      h('td', { style: { padding: '4px 6px', ...MUTED } }, row.lastWrongAt ? row.lastWrongAt.slice(5, 10) : '—'),
                    ),
                  ),
                ),
              ),
        ),
        h(
          Card,
          { title: '覆盖' },
          h('div', null, `未出题的考点：${(coverage.uncoveredTopics ?? []).join('、') || '（无）'}`),
          h('div', { style: { ...MUTED, marginTop: 4 } }, `还有 ${coverage.uncoveredChunks ?? 0} 段原文没出过题（共 ${coverage.totalChunks ?? 0} 段）。`),
        ),
        h(
          Card,
          { title: '资料库' },
          (data.sources ?? []).length === 0
            ? h('div', { style: MUTED }, '还没有资料。让 AI 帮你导入一章课本。')
            : h(
                'ul',
                { style: { margin: 0, paddingLeft: 18 } },
                (data.sources ?? []).map((s) =>
                  h('li', { key: s.id, style: { marginBottom: 4 } }, `${s.book}${s.edition ? `（${s.edition}）` : ''} · ${s.chunks} 段 · ${s.status}`),
                ),
              ),
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({ name: 'settings.section', id: 'quiz', order: 130, label: '测验' }, QuizPanel),
        );
      },
    };
  },
});
