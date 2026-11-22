'use strict';

/**
 * Electron-as-node 启动 cocos-cli 的垫片。
 *
 * PinK 自带 Electron 以 ELECTRON_RUN_AS_NODE 运行时，process.versions.electron 仍然存在，
 * commander 会因此切换到 electron 模式解析 argv（从 argv[1] 开始，把 cli.js 路径当成命令名，
 * 报 "unknown command '<cli.js>'"）。此垫片：
 *   1. 删掉 process.versions.electron，让 commander 走 node 模式；
 *   2. 把 argv 修正为 [运行时, cli.js, ...用户参数]，等效于 node cli.js ...；
 *   3. require cli.js 执行。
 *
 * 用法：PinK(ELECTRON_RUN_AS_NODE) wrapper.cjs <cli.js> <命令> [参数...]
 */

const cliJs = process.argv[2];
if (!cliJs) {
    console.error('[pink-bridge-wrapper] 缺少 cli.js 路径参数');
    process.exit(1);
}

try {
    delete process.versions.electron;
} catch { /* versions 若不可修改，忽略（此时 commander 可能仍走 electron 模式） */ }

// argv[0]=运行时, argv[1]=wrapper, argv[2]=cli.js, argv[3+]=用户参数
// 修正成 node 惯例: argv[0]=运行时, argv[1]=cli.js, argv[2+]=用户参数
process.argv = [process.argv[0], cliJs].concat(process.argv.slice(3));

require(cliJs);
