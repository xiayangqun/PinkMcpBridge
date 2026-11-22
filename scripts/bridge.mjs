#!/usr/bin/env node
/**
 * pink_mcp_bridge — stdio ↔ HTTP 桥 + cocos-cli MCP 服务托管
 *
 * 由 ZCode / Codex 的 stdio MCP 配置拉起（command = node, args = [bridge.mjs, ...]），
 * 也可被 PinK 插件以 --ensure-only 方式调用（只确保服务在跑，不转发）。
 *
 * 行为：
 *   1. 定位项目（--project 优先，缺省从 cwd 探测 package.json 里的 cocos/pink 字段）。
 *   2. 确保端口上有「本项目」的 cocos-cli MCP 服务：没有就拉起，是别的服务/项目则明确报错。
 *   3. --ensure-only 到此为止退出 0；否则进入 stdio↔HTTP 转发循环。
 *
 * 诊断一律走 stderr；stdout 只输出 MCP JSON-RPC 消息（换行分隔）。
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Electron 垫片：与 bridge.mjs 同目录 */
const WRAPPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bridge-electron-wrapper.cjs');

/** bridge 自身是否跑在 Electron（系统没有 node 时的兜底：ELECTRON_RUN_AS_NODE 跑 PinK 自带 Electron）。
 * 此时 process.execPath 是 Electron 二进制，spawn cli.js 同样要走垫片修正 argv。 */
const BRIDGE_ON_ELECTRON = !!process.versions.electron;

// ---------- 参数 ----------

function parseArgs(argv) {
    const out = {};
    const flags = new Set(['ensure-only']);
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        if (flags.has(key)) { out[key] = true; continue; }
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
        else out[key] = '';
    }
    return out;
}

const ARGS = parseArgs(process.argv.slice(2));
const WAIT_SECONDS = Number(ARGS.wait || '120');
const ENSURE_ONLY = !!ARGS['ensure-only'];

/** PinK 自带 Electron：官方引擎的原生模块按它的 ABI 编译，普通 node 载不动时用它跑（ELECTRON_RUN_AS_NODE）。 */
function findElectronBin() {
    if (ARGS.electron) return ARGS.electron;
    if (process.env.PINK_ELECTRON_PATH) return process.env.PINK_ELECTRON_PATH;
    if (process.platform === 'darwin') return '/Applications/PinK.app/Contents/MacOS/PinK';
    return undefined;
}

// ---------- 项目定位 ----------

// ---------- 项目定位 ----------

/** cwd 是否为 Cocos 项目（package.json 带 cocos/pink 字段），返回项目根或 null。 */
function detectProjectFromCwd(startDir) {
    let dir = path.resolve(startDir);
    for (let i = 0; i < 4 && dir !== path.dirname(dir); i++) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
            if (pkg && (pkg.cocos || pkg.pink)) return dir;
        } catch { /* 没有 package.json 或解析失败，继续向上 */ }
        dir = path.dirname(dir);
    }
    return null;
}

const PROJECT_DIR = ARGS.project
    ? path.resolve(ARGS.project)
    : detectProjectFromCwd(process.cwd());

if (!PROJECT_DIR) {
    console.error('[pink-bridge] 未定位到 Cocos 项目：请传入 --project <路径>，或在 Cocos 项目目录里启动。');
    process.exit(2);
}

/** 项目内配置文件（插件面板写入）：Codex 全局配置模式下的端口与引擎路径来源。 */
function readBridgeConf() {
    try {
        return JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, '.pink-bridge.json'), 'utf8')) || {};
    } catch {
        return {};
    }
}

function readProjectPort() {
    const p = Number(readBridgeConf()?.port);
    if (Number.isInteger(p) && p >= 1 && p <= 65535) return p;
    return undefined;
}

const PORT = Number(ARGS.port || readProjectPort() || process.env.PINK_BRIDGE_PORT || 9630);

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    console.error(`[pink-bridge] 非法端口: ${ARGS.port}`);
    process.exit(1);
}

const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;

const TEMP_DIR = path.join(PROJECT_DIR, 'temp');
const SERVER_LOG = path.join(TEMP_DIR, 'logs', 'pink-mcp-bridge-server.log');
const BRIDGE_LOG = path.join(TEMP_DIR, 'logs', 'pink-mcp-bridge.log');
const PID_FILE = path.join(TEMP_DIR, 'pink-mcp-bridge.pid');
const LOCK_DIR = path.join(TEMP_DIR, '.pink-bridge-start.lock');

/** 追加运行记录，便于事后确认 hook/bridge 是否真的被触发。 */
function trace(outcome, detail) {
    try {
        fs.mkdirSync(path.dirname(BRIDGE_LOG), { recursive: true });
        fs.appendFileSync(
            BRIDGE_LOG,
            `${new Date().toISOString()} outcome=${outcome} port=${PORT} pid=${process.pid} ${detail ?? ''}\n`,
        );
    } catch { /* 诊断日志写不进去不应影响主流程 */ }
}

const log = (msg) => process.stderr.write(`[pink-bridge] ${msg}\n`);

// ---------- cocos-cli 路径解析 ----------

function looksLikeCliRoot(dir) {
    return fs.existsSync(path.join(dir, 'dist', 'cli.js'))
        && fs.existsSync(path.join(dir, 'dist', 'commands', 'mcp-server.js'));
}

/** 官方引擎根目录（macOS：~/Library/Application Support/cocos-default）。 */
function engineBaseDirs() {
    const home = os.homedir();
    const dirs = [];
    if (process.platform === 'darwin') {
        dirs.push(path.join(home, 'Library', 'Application Support', 'cocos-default'));
    }
    if (process.env.PINK_ENGINE_BASE) dirs.unshift(process.env.PINK_ENGINE_BASE);
    return dirs.filter((d) => fs.existsSync(d));
}

/**
 * 解析 cocos-cli 根目录。
 * 优先级：--cli 参数 > 项目 .pink-bridge.json 缓存的 cliPath（插件经 PinK 引擎接口解析所得）
 *        > 项目 package.json 的 cocos.version 精确匹配 > 版本目录里最新者。
 */
function resolveCliRoot(cliArg) {
    if (cliArg) {
        const root = path.resolve(cliArg);
        if (looksLikeCliRoot(root)) return root;
        log(`--cli 指定的目录不像 cocos-cli（缺 dist/cli.js 或 dist/commands/mcp-server.js）: ${root}`);
        process.exit(3);
    }
    const cached = readBridgeConf()?.cliPath;
    if (cached) {
        const root = path.resolve(cached);
        if (looksLikeCliRoot(root)) return root;
        log(`.pink-bridge.json 缓存的 cliPath 已失效，重新探测: ${root}`);
    }
    let projectVersion;
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
        projectVersion = pkg?.cocos?.version ?? pkg?.pink?.version;
    } catch { /* 读不到就用兜底 */ }

    for (const base of engineBaseDirs()) {
        const ordered = fs.readdirSync(base)
            .filter((name) => name.startsWith('cocos-'))
            .sort((a, b) => {
                if (projectVersion) {
                    const av = a === `cocos-${projectVersion}` ? -1 : 0;
                    const bv = b === `cocos-${projectVersion}` ? -1 : 0;
                    if (av !== bv) return av - bv;
                }
                return b.localeCompare(a); // 其余按名字倒序，近似"最新优先"
            });
        for (const name of ordered) {
            const root = path.join(base, name);
            if (looksLikeCliRoot(root)) return root;
        }
    }
    return undefined;
}

// ---------- 端口与服务探测 ----------

/** 端口是否有进程在监听（只看 TCP，不依赖 lsof 输出格式）。 */
function isPortOpen(port, timeoutMs = 800) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const done = (open) => { socket.destroy(); resolve(open); };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function rpc(method, params, timeoutMs = 6000) {
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

/** 路径比较先解析软链：外部卷和 /tmp 都可能有符号链接，直接比字符串会误判。 */
function samePath(a, b) {
    const real = (p) => {
        const abs = path.resolve(p);
        let cur = abs;
        const tail = [];
        while (true) {
            try {
                return path.join(fs.realpathSync.native(cur), ...tail);
            } catch {
                const parent = path.dirname(cur);
                if (parent === cur) return abs;
                tail.unshift(path.basename(cur));
                cur = parent;
            }
        }
    };
    return real(a) === real(b);
}

/**
 * 探测端口上的服务是否为本项目的 cocos-cli MCP。
 * @returns {'ours' | 'other-project' | 'not-mcp' | 'unreachable'}
 */
async function inspect() {
    if (!(await isPortOpen(PORT))) return 'unreachable';
    let init;
    try {
        init = await rpc('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'pink-mcp-bridge', version: '0.1.0' },
        });
    } catch {
        return 'not-mcp';
    }
    if (init?.result?.serverInfo?.name !== 'cocos-cli') return 'not-mcp';

    try {
        const out = await rpc('tools/call', {
            name: 'assets-query-asset-info',
            arguments: { urlOrUUIDOrPath: 'db://assets' },
        });
        const file = out?.result?.structuredContent?.result?.data?.file;
        if (typeof file !== 'string') return 'not-mcp';
        return samePath(file, path.join(PROJECT_DIR, 'assets')) ? 'ours' : 'other-project';
    } catch {
        return 'not-mcp';
    }
}

// ---------- 服务托管 ----------

function readPid() {
    try {
        const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}

function acquireLock() {
    try {
        fs.mkdirSync(LOCK_DIR, { recursive: false });
        fs.writeFileSync(path.join(LOCK_DIR, 'owner'), String(process.pid));
        return true;
    } catch {
        // 陈旧锁：超过 3 分钟视为上一个拉起者已死
        try {
            if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs > 180_000) {
                fs.rmSync(LOCK_DIR, { recursive: true, force: true });
                return acquireLock();
            }
        } catch { /* 锁已消失，稍后重查 */ }
        return false;
    }
}

function releaseLock() {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

/** CLI 的 getAvailablePort 会在端口被占时静默顺延，从日志识别出来并报错。 */
function detectPortDrift() {
    try {
        const tail = fs.readFileSync(SERVER_LOG, 'utf8').slice(-4000);
        const patterns = [
            /Server is running on:\s*http:\/\/[^:]+:(\d+)\/mcp/g,
            /服务器已启动:\s*http:\/\/[^:]+:(\d+)/g,
        ];
        for (const re of patterns) {
            const m = [...tail.matchAll(re)].pop();
            if (m && Number(m[1]) !== PORT) return Number(m[1]);
        }
    } catch { /* 日志还没生成 */ }
    return undefined;
}

function spawnServer(cliRoot) {
    const runner = pickRunner(cliRoot);
    const cliJs = path.join(cliRoot, 'dist', 'cli.js');
    fs.mkdirSync(path.dirname(SERVER_LOG), { recursive: true });
    const out = fs.openSync(SERVER_LOG, 'a');
    // Electron 运行时要经过垫片：去掉 versions.electron 并修正 argv，否则 commander 会把
    // cli.js 路径当成命令名（"unknown command '<cli.js>'"）。bridge 自身跑在 Electron 上时同理。
    const needsWrapper = runner.kind === 'electron' || (runner.kind === 'node' && BRIDGE_ON_ELECTRON);
    const runnerArgs = needsWrapper
        ? [WRAPPER_PATH, cliJs]
        : [cliJs];
    const child = spawn(
        runner.command,
        [...runnerArgs, 'start-mcp-server', '--project', PROJECT_DIR, '--port', String(PORT)],
        { cwd: cliRoot, detached: true, stdio: ['ignore', out, out], env: runner.env },
    );
    child.unref();
    if (child.pid) fs.writeFileSync(PID_FILE, String(child.pid));
    log(`已拉起 cocos-cli MCP 服务 PID ${child.pid}（运行时: ${runner.label}）`);
    log(`命令行: ${runner.command} ${runnerArgs.join(' ')} start-mcp-server --project ${PROJECT_DIR} --port ${PORT}`);
    return child.pid;
}

/**
 * 选择能加载该 cli 原生模块的运行时：
 * 官方引擎的 node_modules 按 PinK 内嵌 Electron 的 ABI 重编，普通 node 会报 NODE_MODULE_VERSION 错；
 * 用 PinK 的 Electron 以 ELECTRON_RUN_AS_NODE 跑则 ABI 一致。探针直接 require gl 原生模块验证。
 */
function pickRunner(cliRoot) {
    const nodeRunner = { kind: 'node', command: process.execPath, env: process.env, label: `node (${process.execPath})` };
    const glModule = path.join(cliRoot, 'node_modules', 'gl', 'build', 'Release', 'webgl.node');
    if (!fs.existsSync(glModule)) return nodeRunner; // 没有原生模块可探，直接用 node

    const probe = (command, env) => spawnSync(command, ['-e', 'require(process.argv[1])', glModule], {
        env,
        timeout: 15_000,
        encoding: 'utf8',
    });

    if (probe(process.execPath, process.env).status === 0) return nodeRunner;

    const electronBin = findElectronBin();
    if (electronBin && fs.existsSync(electronBin)) {
        const electronEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
        if (probe(electronBin, electronEnv).status === 0) {
            return { kind: 'electron', command: electronBin, env: electronEnv, label: `PinK Electron (ELECTRON_RUN_AS_NODE: ${electronBin})` };
        }
        log(`Electron 运行时探针也失败（${electronBin}），回退 node（服务可能启动失败，查看日志）`);
    } else {
        log(`该 cli 的原生模块与 node ABI 不兼容，且未找到 PinK Electron（可用 --electron 指定）`);
    }
    return nodeRunner;
}

async function waitReady(deadlineMs) {
    while (Date.now() < deadlineMs) {
        if (await isPortOpen(PORT)) {
            const state = await inspect();
            if (state === 'ours') return true;
            if (state === 'other-project') throw new Error(`端口 ${PORT} 上的服务属于另一个项目，拒绝使用，请换端口`);
        }
        const drift = detectPortDrift();
        if (drift !== undefined) {
            throw new Error(`端口 ${PORT} 被占用，服务实际起在 ${drift}。请改端口或释放 ${PORT}`);
        }
        await sleep(1000);
    }
    return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 确保端口上是本项目的 cocos-cli MCP；成功返回 true。 */
async function ensureServer() {
    const state = await inspect();
    if (state === 'ours') {
        log(`服务已在运行 (端口 ${PORT}, PID ${readPid() ?? '未知'})`);
        trace('already-running', `serverPid=${readPid() ?? 'unknown'}`);
        return true;
    }
    if (state === 'other-project') {
        log(`端口 ${PORT} 被另一个项目的 cocos-cli MCP 占用，请换端口`);
        trace('port-other-project');
        return false;
    }
    if (state === 'not-mcp') {
        log(`端口 ${PORT} 已被非 cocos-cli 的服务占用，拒绝启动。请换端口`);
        trace('port-not-mcp');
        return false;
    }

    if (!acquireLock()) {
        log('另一个进程正在拉起服务，等待它就绪...');
        const ok = await waitReady(Date.now() + WAIT_SECONDS * 1000);
        if (!ok) { log('等待超时'); trace('wait-timeout'); return false; }
        trace('waited-for-other');
        return true;
    }

    try {
        const recheck = await inspect();
        if (recheck === 'ours') { trace('already-running-after-lock'); return true; }
        if (recheck !== 'unreachable') { log(`端口 ${PORT} 状态异常: ${recheck}`); trace(`lock-recheck-${recheck}`); return false; }

        const cliRoot = resolveCliRoot(ARGS.cli);
        if (!cliRoot) {
            log('未找到可用的 cocos-cli（~/Library/Application Support/cocos-default/ 下没有带 dist/cli.js 的版本），可用 --cli 指定');
            trace('cli-not-found');
            return false;
        }
        log(`使用 cocos-cli: ${cliRoot}`);

        spawnServer(cliRoot);
        const ok = await waitReady(Date.now() + WAIT_SECONDS * 1000);
        if (!ok) { log(`服务在 ${WAIT_SECONDS}s 内未就绪，查看日志: ${SERVER_LOG}`); trace('start-timeout'); return false; }
        log(`服务已就绪: ${ENDPOINT}`);
        trace('started');
        return true;
    } finally {
        releaseLock();
    }
}

// ---------- stdio ↔ HTTP 转发 ----------

/** 转发一条 JSON-RPC 消息；返回是否成功投递。 */
async function forwardMessage(message) {
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
    };
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
    });

    // 服务端对通知类消息可能回 202 无内容
    if (res.status === 202 || res.status === 204) return true;

    const contentType = res.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
        // SSE：逐行解析 data: 事件，每条完整 JSON 转发给客户端
        // res.body 是 web ReadableStream，readline 不能直接用，手工按行缓冲
        const decoder = new TextDecoder();
        let buffer = '';
        const emit = (line) => {
            if (!line.startsWith('data:')) return;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') return;
            process.stdout.write(payload + '\n');
        };
        for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                emit(buffer.slice(0, idx).replace(/\r$/, ''));
                buffer = buffer.slice(idx + 1);
            }
        }
        if (buffer) emit(buffer);
        return true;
    }

    const text = await res.text();
    if (text) process.stdout.write(text.trim() + '\n');
    return true;
}

function replyError(id, code, message) {
    if (id === undefined || id === null) return; // 通知没有 id，无从回错
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function runForwarding() {
    // 带外先校验一次服务可用，避免客户端 initialize 无人应答
    const ok = await ensureServer();
    if (!ok) {
        // 仍然进入转发循环：请求会以 ECONNREFUSED 报错返回给客户端，
        // 客户端界面上显示 server 不可用，而不是静默挂起。
        log('服务未就绪，转发循环将以错误应答（检查上方诊断或日志）');
    }

    const rl = readline.createInterface({
        input: process.stdin,
        terminal: false,
        crlfDelay: Infinity,
    });

    const pending = new Set();
    rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        let message;
        try {
            message = JSON.parse(text);
        } catch {
            log(`忽略非 JSON 输入行: ${text.slice(0, 80)}`);
            return;
        }
        const task = forwardMessage(message).catch((err) => {
            const reason = err?.cause?.code === 'ECONNREFUSED'
                ? `MCP 服务未运行 (端口 ${PORT})`
                : (err?.message ?? String(err));
            log(`转发失败: ${reason}`);
            replyError(message.id, -32000, `pink_mcp_bridge: ${reason}`);
        });
        pending.add(task);
        task.finally(() => pending.delete(task));
    });

    rl.on('close', async () => {
        // 等在途请求落地再退出，避免管道输入关闭抢在响应返回前
        await Promise.allSettled([...pending]);
        trace('stdin-closed');
        process.exit(0);
    });
}

// ---------- main ----------

try {
    if (ENSURE_ONLY) {
        const ok = await ensureServer();
        trace(ok ? 'ensure-ok' : 'ensure-failed');
        process.exit(ok ? 0 : 1);
    } else {
        await runForwarding();
    }
} catch (error) {
    log(error instanceof Error ? error.stack ?? error.message : String(error));
    trace('fatal', error instanceof Error ? error.message : String(error));
    process.exit(1);
}
