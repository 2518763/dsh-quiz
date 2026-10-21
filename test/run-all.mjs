/**
 * 一次跑完所有测试。
 *
 * 为什么不用 `node --test test/`：那个模式会为每个测试文件启动子进程，
 * 在没有管道权限的沙箱里会 EPERM（本机踩过）。这里改成同进程 import，
 * 在任何环境下都能跑，输出与 node --test 相同。
 */

const files = ['./chunker.test.mjs', './core.test.mjs', './registration.test.mjs'];

for (const file of files) {
  console.log(`\n── ${file} ──`);
  await import(file);
}
