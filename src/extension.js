'use strict';

/**
 * pink_mcp_bridge — PinK 插件
 *
 * 把当前 Cocos 项目的 cocos-cli MCP 服务暴露给 ZCode / Codex：
 *  1. 面板：环境选择（勾选注入对象）+ 端口设置 + 注入 / 卸载
 *  2. 注入幂等：已存在则对比端口与路径，只在有差异时更新并提示变化
 *  3. PinK 打开 Cocos 项目时自动拉起服务；已注入但漂移的配置自动修正（卸载后不复活）
 */

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const SERVER_NAME = 'pink_mcp_bridge';
const BRIDGE_REL = path.join('scripts', 'bridge.mjs');
const BRIDGE_CONF_FILE = '.pink-bridge.json';

// 试验性开关：写入 PinK 的 User settings（Global），重启 PinK 后完全生效。
// PinK 内嵌引擎的 MCP endpoint（cocosHostMcp）当前版本已被官方硬编码禁用，
// 这里的 MCP 开关额外关闭 chat 侧的 MCP 发现与 GitHub MCP server。
const EXP_MCP_KEYS = [
    'chat.mcp.discovery.enabled',
    'github.copilot.chat.githubMcpServer.enabled',
];
// PinK 的 agents = agentHost 宿主里的 Claude Code SDK / Codex SDK runtime（copilot-chat 只是 chat UI）。
// agentHost 进程本身由 PinK 主进程无条件 fork，插件关不掉；这里的开关阻止 agent runtime 注册。
const EXP_AGENT_KEYS = [
    'chat.agentHost.enabled',
    'chat.agentHost.claudeAgent.enabled',
    'chat.agentHost.codexAgent.enabled',
    'chat.agent.enabled',
];

function activate(context) {
    const out = vscode.window.createOutputChannel('pink-mcp-bridge');
    context.subscriptions.push(out);
    const log = (msg) => out.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);

    const bridgePath = path.join(__dirname, '..', BRIDGE_REL);

    // ---------- 基础工具 ----------

    /** 找当前工作区里的 Cocos 项目目录（package.json 带 cocos/pink 字段）。 */
    function detectProjectDir() {
        const folders = vscode.workspace.workspaceFolders ?? [];
        for (const folder of folders) {
            try {
                const pkg = JSON.parse(fs.readFileSync(path.join(folder.uri.fsPath, 'package.json'), 'utf8'));
                if (pkg && (pkg.cocos || pkg.pink)) return folder.uri.fsPath;
            } catch { /* 没有 package.json 就跳过 */ }
        }
        return undefined;
    }

    function getConfig() {
        return vscode.workspace.getConfiguration('pinkMcpBridge');
    }

    function getPort(projectDir) {
        // 工作区级配置优先（面板里改端口写到 workspace 作用域，实现每项目一端口）
        const cfg = getConfig();
        const scoped = projectDir
            ? vscode.workspace.getConfiguration('pinkMcpBridge', vscode.Uri.file(projectDir))
            : cfg;
        return scoped.get('port', cfg.get('port', 9630));
    }

    /** 探测可用的 node 绝对路径；找不到返回 undefined。 */
    function detectNodePath() {
        const configured = getConfig().get('nodePath', '').trim();
        if (configured && fs.existsSync(configured)) return configured;

        try {
            const r = spawnSync('which', ['node'], { encoding: 'utf8', timeout: 3000 });
            const p = (r.stdout || '').trim();
            if (p && fs.existsSync(p)) return p;
        } catch { /* PATH 里没有 node，走下面的候选 */ }

        const home = os.homedir();
        const candidates = [];
        try {
            const nvmDir = path.join(home, '.nvm', 'versions', 'node');
            const versions = fs.readdirSync(nvmDir)
                .filter((v) => /^v\d/.test(v))
                .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const v of versions) candidates.push(path.join(nvmDir, v, 'bin', 'node'));
        } catch { /* 没有 nvm */ }
        candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
        return candidates.find((p) => fs.existsSync(p));
    }

    /**
     * 客户端（ZCode/Codex）拉起 bridge 的运行时：优先系统 node；找不到时完全内置兜底——
     * 用 PinK 自带 Electron 以 ELECTRON_RUN_AS_NODE 跑 bridge，不依赖外部任何 CLI。
     */
    function detectClientRunner() {
        const node = detectNodePath();
        if (node) return { command: node, env: {}, label: node };
        let electron;
        if (process.platform === 'darwin') electron = '/Applications/PinK.app/Contents/MacOS/PinK';
        if (electron && fs.existsSync(electron)) {
            return { command: electron, env: { ELECTRON_RUN_AS_NODE: '1' }, label: `${electron} (ELECTRON_RUN_AS_NODE)` };
        }
        return undefined;
    }

    /** 给 bridge 子进程用的运行时：优先真 node，兜底 Electron 的 ELECTRON_RUN_AS_NODE。 */
    function makeRunner() {
        const node = detectNodePath();
        if (node) return { command: node, env: process.env, label: node };
        return {
            command: process.execPath,
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            label: `${process.execPath} (ELECTRON_RUN_AS_NODE)`,
        };
    }

    function isPortOpen(port, timeoutMs = 600) {
        return new Promise((resolve) => {
            const socket = net.connect({ host: '127.0.0.1', port });
            const done = (open) => { socket.destroy(); resolve(open); };
            socket.setTimeout(timeoutMs);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false));
            socket.once('error', () => done(false));
        });
    }

    // ---------- 试验性开关（写 PinK User settings，重启完全生效） ----------

    function readExperimental() {
        const cfg = vscode.workspace.getConfiguration();
        return {
            killMcp: cfg.get('chat.mcp.discovery.enabled', true) === false,
            killAgents: cfg.get('chat.agentHost.enabled', true) === false
                && cfg.get('chat.agentHost.claudeAgent.enabled', true) === false,
        };
    }

    async function applyExperimental(updates) {
        // updates 只包含本次实际改动的组（killMcp / killAgents 二选一或都有）；
        // 未提及的组不动——否则勾 A 会把 B 的设置误删（互斥 bug）。
        const cfg = vscode.workspace.getConfiguration();
        // 勾选 = 写 false；取消勾选 = 删除覆盖（恢复 PinK 默认值）
        if (updates.killMcp !== undefined) {
            for (const key of EXP_MCP_KEYS) {
                await cfg.update(key, updates.killMcp ? false : undefined, vscode.ConfigurationTarget.Global);
            }
        }
        if (updates.killAgents !== undefined) {
            for (const key of EXP_AGENT_KEYS) {
                await cfg.update(key, updates.killAgents ? false : undefined, vscode.ConfigurationTarget.Global);
            }
        }
    }

    // ---------- 期望配置构造 ----------

    function buildArgs(port, projectDir, includeProject) {
        const args = [bridgePath, '--port', String(port)];
        if (includeProject && projectDir) args.push('--project', projectDir);
        return args;
    }

    function zcodeEntry(port, projectDir, runner) {
        return {
            type: 'stdio',
            command: runner.command,
            args: buildArgs(port, projectDir, true),
            env: runner.env,
        };
    }

    function expectedCodexSection(port, projectDir, runner, includeProject) {
        const args = buildArgs(port, projectDir, includeProject)
            .map((a) => JSON.stringify(a))
            .join(', ');
        const envEntries = Object.entries(runner.env || {});
        const envLine = envEntries.length
            ? `env = { ${envEntries.map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')} }`
            : null;
        return [
            `[mcp_servers.${SERVER_NAME}]`,
            `command = ${JSON.stringify(runner.command)}`,
            `args = [${args}]`,
            ...(envLine ? [envLine] : []),
            'startup_timeout_sec = 120',
            '',
        ].join('\n');
    }

    // ---------- 已注入状态读取 ----------

    function portOfArgs(args) {
        if (!Array.isArray(args)) return null;
        const i = args.indexOf('--port');
        if (i >= 0 && args[i + 1]) {
            const p = Number(args[i + 1]);
            if (Number.isInteger(p)) return p;
        }
        return null;
    }

    const CODEX_SECTION_HEAD = new RegExp(`^\\[mcp_servers\\.(?:"${SERVER_NAME}"|${SERVER_NAME})\\]\\s*$`);

    function findCodexSection(lines) {
        for (let i = 0; i < lines.length; i++) {
            if (CODEX_SECTION_HEAD.test(lines[i])) {
                let end = i + 1;
                while (end < lines.length && !lines[end].startsWith('[')) end++;
                return { start: i, end };
            }
        }
        return undefined;
    }

    function codexSectionPort(sectionLines) {
        for (const line of sectionLines) {
            const m = line.match(/--port['"]?\s*,\s*['"]?(\d+)/);
            if (m) return Number(m[1]);
        }
        return null;
    }

    function codexConfigFile(projectDir, scope) {
        return scope === 'global'
            ? path.join(os.homedir(), '.codex', 'config.toml')
            : path.join(projectDir, '.codex', 'config.toml');
    }

    /**
     * 读取各环境当前注入状态。
     * matches: 与当前期望（端口/运行时/bridge 路径）是否完全一致
     */
    function readInjectedState(projectDir, runner, codexScope) {
        const expectedPort = getPort(projectDir);
        const state = {};

        // ZCode
        try {
            const doc = JSON.parse(fs.readFileSync(path.join(projectDir, '.zcode', 'config.json'), 'utf8'));
            const entry = doc?.mcp?.servers?.[SERVER_NAME];
            if (entry) {
                state.zcode = {
                    injected: true,
                    port: portOfArgs(entry.args),
                    matches: JSON.stringify(entry) === JSON.stringify(zcodeEntry(expectedPort, projectDir, runner)),
                };
            } else {
                state.zcode = { injected: false, port: null, matches: false };
            }
        } catch {
            state.zcode = { injected: false, port: null, matches: false };
        }

        // Codex
        const codexFile = codexConfigFile(projectDir, codexScope);
        try {
            const lines = fs.readFileSync(codexFile, 'utf8').split('\n');
            const found = findCodexSection(lines);
            if (found) {
                const sectionLines = lines.slice(found.start, found.end);
                state.codex = {
                    injected: true,
                    port: codexSectionPort(sectionLines),
                    matches: sectionLines.join('\n').trimEnd() === expectedCodexSection(expectedPort, projectDir, runner, codexScope !== 'global').trimEnd(),
                };
            } else {
                state.codex = { injected: false, port: null, matches: false };
            }
        } catch {
            state.codex = { injected: false, port: null, matches: false };
        }
        return state;
    }

    // ---------- 配置写入 ----------

    function upsertCodexConfig(file, sectionText) {
        const existed = fs.existsSync(file);
        const original = existed ? fs.readFileSync(file, 'utf8') : '';
        const lines = original ? original.split('\n') : [];
        while (lines.length && lines[lines.length - 1] === '') lines.pop();

        const found = findCodexSection(lines);
        const incoming = sectionText.trimEnd().split('\n');
        const next = found
            ? [...lines.slice(0, found.start), ...incoming, ...lines.slice(found.end)]
            : [...lines, ...incoming];
        const updated = next.join('\n') + '\n';
        if (updated === original) return { changed: false };

        if (existed) fs.copyFileSync(file, file + '.pink-bridge.bak');
        else fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, updated);
        return { changed: true };
    }

    function removeCodexSection(file) {
        if (!fs.existsSync(file)) return false;
        const lines = fs.readFileSync(file, 'utf8').split('\n');
        const found = findCodexSection(lines);
        if (!found) return false;
        fs.copyFileSync(file, file + '.pink-bridge.bak');
        fs.writeFileSync(file, [...lines.slice(0, found.start), ...lines.slice(found.end)].join('\n'));
        return true;
    }

    function readZcodeEntry(projectDir) {
        try {
            const doc = JSON.parse(fs.readFileSync(path.join(projectDir, '.zcode', 'config.json'), 'utf8'));
            return doc?.mcp?.servers?.[SERVER_NAME];
        } catch {
            return undefined;
        }
    }

    function writeZcodeEntry(projectDir, entry) {
        const file = path.join(projectDir, '.zcode', 'config.json');
        let doc = {};
        if (fs.existsSync(file)) {
            try {
                doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (err) {
                throw new Error(`.zcode/config.json 解析失败，请手工修复后重试: ${err.message}`);
            }
        }
        doc.mcp = doc.mcp && typeof doc.mcp === 'object' ? doc.mcp : {};
        doc.mcp.servers = doc.mcp.servers && typeof doc.mcp.servers === 'object' ? doc.mcp.servers : {};
        doc.mcp.servers[SERVER_NAME] = entry;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
        return file;
    }

    function writeBridgeConf(projectDir, port, cliPath) {
        // 项目内配置文件：Codex 全局配置模式（args 不带端口/项目）时 bridge 从这里读端口与引擎路径
        const file = path.join(projectDir, BRIDGE_CONF_FILE);
        let conf = {};
        try { conf = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 新建 */ }
        const next = { ...conf, port };
        if (cliPath) next.cliPath = cliPath;
        if (JSON.stringify(next) === JSON.stringify(conf)) return;
        fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    }

    /**
     * 解析 cocos-cli 引擎根目录（优先级从高到低）：
     *  1. 设置 pinkMcpBridge.cliPath（手动指定）
     *  2. PinK 官方接口 pink.engineManager.resolveEngine —— 引擎管理器为当前项目解析的引擎，
     *     PinK 自己启动 Cocos Host 用的同一份解析结果
     *  3. 项目 .pink-bridge.json 里上次解析的缓存
     * （bridge 侧还有最后的兜底：cocos-default 约定目录扫描）
     */
    async function resolveCliPath(projectDir) {
        const configured = getConfig().get('cliPath', '').trim();
        if (configured && fs.existsSync(path.join(configured, 'dist', 'cli.js'))) {
            return { path: configured, source: '设置 pinkMcpBridge.cliPath' };
        }
        try {
            const r = await vscode.commands.executeCommand('pink.engineManager.resolveEngine');
            const p = r && typeof r === 'object' ? r.path : r;
            if (typeof p === 'string' && p && fs.existsSync(path.join(p, 'dist', 'cli.js'))) {
                return { path: p, source: 'PinK 引擎管理器接口' };
            }
            log(`PinK resolveEngine 返回不可用: ${JSON.stringify(r)}`);
        } catch (err) {
            log(`PinK resolveEngine 调用失败（改走约定扫描）: ${err?.message ?? err}`);
        }
        try {
            const conf = JSON.parse(fs.readFileSync(path.join(projectDir, BRIDGE_CONF_FILE), 'utf8'));
            if (conf.cliPath && fs.existsSync(path.join(conf.cliPath, 'dist', 'cli.js'))) {
                return { path: conf.cliPath, source: '项目 .pink-bridge.json 缓存' };
            }
        } catch { /* 没有缓存 */ }
        return undefined;
    }

    /**
     * 幂等注入：对比现有配置，只在有差异时写入。
     * @returns {Promise<{changed: bool, portChanged: null|{from,to}, zcode: {action}, codex: {action}}>}
     */
    async function injectConfigs(targets, opts) {
        const { port, projectDir, runner, codexScope } = opts;
        const current = readInjectedState(projectDir, runner, codexScope);
        const result = { changed: false, portChanged: null, zcode: {}, codex: {} };

        // 端口变化检测（目标环境里已注入的旧端口）
        const oldPorts = [
            ...(targets.zcode && current.zcode.injected && current.zcode.port && current.zcode.port !== port ? [current.zcode.port] : []),
            ...(targets.codex && current.codex.injected && current.codex.port && current.codex.port !== port ? [current.codex.port] : []),
        ];
        if (oldPorts.length) result.portChanged = { from: oldPorts[0], to: port };

        if (targets.zcode) {
            const expected = zcodeEntry(port, projectDir, runner);
            const actual = readZcodeEntry(projectDir);
            if (JSON.stringify(actual) !== JSON.stringify(expected)) {
                writeZcodeEntry(projectDir, expected);
                result.changed = true;
                result.zcode.action = actual ? 'updated' : 'injected';
            } else {
                result.zcode.action = 'unchanged';
            }
        }
        if (targets.codex) {
            const file = codexConfigFile(projectDir, codexScope);
            const r = upsertCodexConfig(file, expectedCodexSection(port, projectDir, runner, codexScope !== 'global'));
            result.codex.file = file;
            if (r.changed) {
                result.changed = true;
                result.codex.action = current.codex.injected ? 'updated' : 'injected';
            } else {
                result.codex.action = 'unchanged';
            }
        }
        if (targets.zcode || targets.codex) {
            const cli = await resolveCliPath(projectDir).catch(() => undefined);
            writeBridgeConf(projectDir, port, cli?.path);
        }
        return result;
    }

    function removeConfigs(targets, opts) {
        const results = {};
        if (targets.zcode) {
            const file = path.join(opts.projectDir, '.zcode', 'config.json');
            try {
                const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (doc?.mcp?.servers?.[SERVER_NAME]) {
                    delete doc.mcp.servers[SERVER_NAME];
                    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
                    results.zcode = file;
                }
            } catch { /* 没有/解析失败就跳过 */ }
        }
        if (targets.codex) {
            // 项目级和全局都尝试清理，避免切 scope 后残留
            for (const scope of ['project', 'global']) {
                if (removeCodexSection(codexConfigFile(opts.projectDir, scope))) results.codex = 'codex';
            }
        }
        try { fs.rmSync(path.join(opts.projectDir, BRIDGE_CONF_FILE), { force: true }); } catch { /* 忽略 */ }
        return results;
    }

    /**
     * 自愈（激活时）：只修正「已注入但有漂移」的配置（插件升级换目录、改端口后自动跟上）。
     * 不存在的配置不自动注入——尊重用户卸载意图，注入由面板手动触发。
     */
    function selfHealConfigs(projectDir) {
        if (!getConfig().get('autoSyncConfigs', true)) return;
        const runner = detectClientRunner();
        if (!runner) { log('自愈跳过：未找到 node，也未找到 PinK Electron'); return; }
        const codexScope = getConfig().get('codexScope', 'project');
        try {
            const state = readInjectedState(projectDir, runner, codexScope);
            const needZ = state.zcode.injected && !state.zcode.matches;
            const needC = state.codex.injected && !state.codex.matches;
            if (!needZ && !needC) return;
            const port = getPort(projectDir);
            injectConfigs({ zcode: needZ, codex: needC }, { port, projectDir, runner, codexScope });
            log(`配置已自愈: zcode=${needZ} codex=${needC} (端口 ${port})`);
        } catch (err) {
            log(`配置自愈失败: ${err?.message ?? err}`);
        }
    }

    // ---------- 服务生命周期 ----------

    let lastEnsure = undefined; // 'ok' | 'failed' | 'starting' | undefined

    function ensureServer(projectDir) {
        const dir = projectDir ?? detectProjectDir();
        if (!dir) {
            vscode.window.showWarningMessage('pink_mcp_bridge：当前工作区不是 Cocos 项目（package.json 缺 cocos/pink 字段）。');
            return;
        }
        const runner = makeRunner();
        const port = getPort(dir);
        log(`ensure: ${runner.label} ${bridgePath} --ensure-only --port ${port} --project ${dir}`);
        (async () => {
            // 先用 PinK 引擎管理器接口解析引擎路径，作为 --cli 传给 bridge（bridge 内还有约定扫描兜底）
            let cliPath;
            try {
                const cli = await resolveCliPath(dir);
                cliPath = cli?.path;
            } catch (err) {
                log(`引擎解析失败（bridge 将自行兜底）: ${err?.message ?? err}`);
            }
            const args = [bridgePath, '--ensure-only', '--port', String(port), '--project', dir];
            if (cliPath) args.push('--cli', cliPath);
            const child = spawn(runner.command, args, {
                cwd: dir,
                env: runner.env,
                stdio: 'ignore',
            });
            child.on('exit', (code) => {
                lastEnsure = code === 0 ? 'ok' : 'failed';
                if (code !== 0) log(`ensure 退出码 ${code}，详见 ${path.join(dir, 'temp', 'logs', 'pink-mcp-bridge.log')}`);
                updateStatusBar();
                refreshPanel();
            });
        })();
        lastEnsure = 'starting';
        updateStatusBar();
    }

    function stopServer(projectDir) {
        const dir = projectDir ?? detectProjectDir();
        if (!dir) return;
        const pidFile = path.join(dir, 'temp', 'pink-mcp-bridge.pid');
        try {
            const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
            if (Number.isInteger(pid) && pid > 0) {
                process.kill(pid, 'SIGTERM');
                log(`已向服务进程 ${pid} 发送 SIGTERM`);
                vscode.window.showInformationMessage(`pink_mcp_bridge：已停止服务进程 ${pid}。`);
            }
            fs.rmSync(pidFile, { force: true });
        } catch (err) {
            if (err?.code === 'ESRCH') {
                log('pid 文件里的进程已不存在，清理 pid 文件');
                try { fs.rmSync(pidFile, { force: true }); } catch { /* 忽略 */ }
            } else {
                log(`停止失败: ${err?.message ?? err}`);
                vscode.window.showErrorMessage(`pink_mcp_bridge：停止失败 ${err?.message ?? err}`);
            }
        }
        updateStatusBar();
        refreshPanel();
    }

    // ---------- 状态栏 ----------

    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    context.subscriptions.push(statusItem);
    statusItem.command = 'pinkMcpBridge.openPanel';

    async function updateStatusBar() {
        const dir = detectProjectDir();
        if (!dir) {
            statusItem.hide();
            return;
        }
        const port = getPort(dir);
        const running = await isPortOpen(port);
        statusItem.text = running
            ? `$(radio-tower) bridge:${port}`
            : '$(circle-slash) bridge:off';
        statusItem.tooltip = running
            ? `pink_mcp_bridge 服务运行中 (端口 ${port})，点击打开配置面板`
            : `pink_mcp_bridge 服务未运行 (端口 ${port})，点击打开配置面板`;
        statusItem.show();
    }

    const pollTimer = setInterval(updateStatusBar, 5000);
    context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

    // ---------- Webview 面板（独立窗口 + 活动栏视图双入口） ----------

    let panel = undefined;
    let sidebarView = undefined;

    function refreshPanel() {
        if (!panel && !sidebarView) return;
        const dir = detectProjectDir();
        const port = dir ? getPort(dir) : getPort(undefined);
        (async () => {
            let envState = { zcode: { injected: false, matches: false, port: null }, codex: { injected: false, matches: false, port: null } };
            const runner = detectClientRunner();
            if (dir && runner) {
                envState = readInjectedState(dir, runner, getConfig().get('codexScope', 'project'));
            }
            const running = dir ? await isPortOpen(port) : false;
            const payload = {
                type: 'state',
                projectDir: dir,
                port,
                running,
                ensure: lastEnsure,
                runnerLabel: runner ? runner.label : null,
                codexScope: getConfig().get('codexScope', 'project'),
                zcode: envState.zcode,
                codex: envState.codex,
                experimental: readExperimental(),
            };
            for (const target of [panel?.webview, sidebarView?.webview]) {
                target?.postMessage(payload);
            }
        })();
    }

    function handlePanelMessage(msg) {
        const dir = detectProjectDir();
        (async () => {
            try {
                if (msg.type === 'apply') {
                    if (!dir) throw new Error('当前工作区不是 Cocos 项目');
                    if (!msg.zcode && !msg.codex) throw new Error('请至少勾选一个要注入的环境');
                    const port = Number(msg.port);
                    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`非法端口: ${msg.port}`);
                    const runner = detectClientRunner();
                    if (!runner) throw new Error('既没找到 node，也没找到 PinK 自带 Electron；请在设置 pinkMcpBridge.nodePath 里手动指定 node 路径');
                    const codexScope = getConfig().get('codexScope', 'project');

                    const r = await injectConfigs({ zcode: !!msg.zcode, codex: !!msg.codex }, { port, projectDir: dir, runner, codexScope });
                    await getConfig().update('port', port, vscode.ConfigurationTarget.WorkspaceFolder);

                    if (r.portChanged) stopServer(dir); // 端口变化：旧服务停掉，下面 ensure 到新端口
                    ensureServer(dir);

                    const label = { injected: '已注入', updated: '已更新', unchanged: '无变化' };
                    const parts = [];
                    if (msg.zcode) parts.push(`ZCode ${label[r.zcode.action]}`);
                    if (msg.codex) parts.push(`Codex ${label[r.codex.action]}`);
                    const portNote = r.portChanged
                        ? `，端口 ${r.portChanged.from} → ${r.portChanged.to}（服务已切换）`
                        : `（端口 ${port}）`;
                    vscode.window.showInformationMessage(`pink_mcp_bridge：${parts.join('；')}${portNote}`);
                } else if (msg.type === 'ensure') {
                    ensureServer(dir);
                    vscode.window.showInformationMessage('pink_mcp_bridge：正在确保服务运行，稍候查看状态。');
                } else if (msg.type === 'stop') {
                    stopServer(dir);
                } else if (msg.type === 'remove') {
                    if (!dir) throw new Error('当前工作区不是 Cocos 项目');
                    if (!msg.zcode && !msg.codex) throw new Error('请至少勾选一个要卸载的环境');
                    const done = removeConfigs({ zcode: !!msg.zcode, codex: !!msg.codex }, { projectDir: dir });
                    const list = Object.keys(done).join('、') || '无匹配条目';
                    vscode.window.showInformationMessage(`pink_mcp_bridge：已卸载 ${list}${Object.keys(done).length ? '（服务未停止，可手动停止）' : ''}。`);
                } else if (msg.type === 'setExperimental') {
                    // 只提交本次实际改动的组；另一组保持现状（两个开关互相独立）
                    const updates = {};
                    if (msg.killMcp !== undefined) updates.killMcp = !!msg.killMcp;
                    if (msg.killAgents !== undefined) updates.killAgents = !!msg.killAgents;
                    await applyExperimental(updates);
                    const parts = [];
                    if (updates.killMcp !== undefined) parts.push(`内置 MCP ${updates.killMcp ? '已禁用' : '已恢复默认'}`);
                    if (updates.killAgents !== undefined) parts.push(`agents ${updates.killAgents ? '已禁用' : '已恢复默认'}`);
                    vscode.window.showInformationMessage(`pink_mcp_bridge（试验性）：${parts.join('；')}，已写入 PinK 设置。完全重启 PinK 后生效。`);
                } else if (msg.type === 'refresh') {
                    refreshPanel();
                    return;
                }
            } catch (err) {
                vscode.window.showErrorMessage(`pink_mcp_bridge：${err?.message ?? err}`);
            }
            refreshPanel();
        })();
    }

    function openPanel() {
        if (panel) {
            panel.reveal(vscode.ViewColumn.Active);
            refreshPanel();
            return;
        }
        panel = vscode.window.createWebviewPanel(
            'pinkMcpBridgePanel',
            'pink_mcp_bridge',
            vscode.ViewColumn.Active,
            { enableScripts: true },
        );
        panel.webview.html = buildPanelHtml();
        panel.onDidDispose(() => { panel = undefined; }, undefined, context.subscriptions);
        panel.webview.onDidReceiveMessage(handlePanelMessage, undefined, context.subscriptions);
        refreshPanel();
    }

    // 活动栏视图（左侧图标常驻入口）
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('pinkMcpBridge.panelView', {
            resolveWebviewView(view) {
                sidebarView = view;
                view.webview.options = { enableScripts: true };
                view.webview.html = buildPanelHtml();
                view.webview.onDidReceiveMessage(handlePanelMessage, undefined, context.subscriptions);
                // 注意：PinK 的 WebviewView 没有 onDidChangeViewState（上游 API 在 fork 中不可用），
                // 不能绑定它；状态刷新依赖页面加载后的 post('refresh') 主动拉取。
                if (typeof view.onDidDispose === 'function') {
                    view.onDidDispose(() => { if (sidebarView === view) sidebarView = undefined; }, undefined, context.subscriptions);
                }
                refreshPanel();
            },
        }, { webviewOptions: { retainContextWhenHidden: true } }),
    );

    function buildPanelHtml() {
        return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .card-title { display: flex; justify-content: space-between; align-items: center; font-weight: 600; font-size: 13px; margin-bottom: 12px; }
  .count { font-weight: 400; opacity: 0.7; font-size: 12px; }
  .env-row { display: flex; gap: 12px; flex-wrap: wrap; }
  .env-card {
    display: inline-flex; align-items: center; gap: 10px; cursor: pointer;
    border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 16px;
    background: var(--vscode-input-background);
  }
  .env-card input { width: 15px; height: 15px; accent-color: var(--vscode-focusBorder); }
  .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .dot.ok { background: var(--vscode-testing-iconPassed, #73c991); }
  .dot.drift { background: var(--vscode-editorWarning-foreground, #cca700); }
  .dot.off { background: var(--vscode-descriptionForeground); opacity: 0.5; }
  .row { margin: 8px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  input[type="number"] {
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border); border-radius: 3px; padding: 4px 8px; width: 90px;
  }
  button {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; border-radius: 3px; padding: 6px 16px; cursor: pointer;
  }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  #status { font-size: 12px; line-height: 1.9; opacity: 0.9; white-space: pre-wrap; }
  .ok-t { color: var(--vscode-testing-iconPassed, #73c991); }
  .bad-t { color: var(--vscode-errorForeground); }
  .hint { opacity: 0.7; font-size: 11px; }
</style>
</head>
<body>
  <div class="card">
    <div class="card-title"><span>环境选择</span><span class="count" id="count">已选 0 个环境</span></div>
    <div class="env-row">
      <label class="env-card"><input type="checkbox" id="zcode"><span id="dot-zcode" class="dot off"></span>ZCode</label>
      <label class="env-card"><input type="checkbox" id="codex"><span id="dot-codex" class="dot off"></span>Codex</label>
    </div>
    <div class="hint" style="margin-top:10px">● 绿=已注入一致　● 黄=已注入有差异（注入时更新）　● 灰=未注入</div>
  </div>
  <div class="card">
    <div class="card-title"><span>注入</span></div>
    <div class="row">
      端口 <input type="number" id="port" min="1" max="65535">
      <button id="apply">注入</button>
      <button class="secondary" id="remove">卸载</button>
    </div>
    <div class="row">
      <button class="secondary" id="ensure">启动服务</button>
      <button class="secondary" id="stop">停止服务</button>
    </div>
    <div class="hint">注入 = 把 pink_mcp_bridge 写入所选环境的 MCP 配置；已存在时对比端口/路径，有差异才更新。改端口会自动切换服务。</div>
  </div>
  <div class="card">
    <div class="card-title"><span>试验性功能</span><span class="hint">写入 PinK 设置 · 完全重启 PinK 后生效</span></div>
    <div class="env-row">
      <label class="env-card"><input type="checkbox" id="kill-mcp"><span class="dot off" id="dot-exp-mcp"></span>禁止内置 MCP 服务</label>
      <label class="env-card"><input type="checkbox" id="kill-agents"><span class="dot off" id="dot-exp-agents"></span>禁止 agents</label>
    </div>
    <div class="hint" style="margin-top:10px">MCP：关闭 chat 的 MCP 服务器发现与 GitHub MCP server（内嵌引擎的 MCP endpoint 本就被 PinK 禁用）。agents：关闭 agentHost 的 Claude/Codex agent runtime 与 chat agent 模式；agentHost 宿主进程由 PinK 主进程启动，插件无法阻止它存在。</div>
  </div>
  <div class="card">
    <div class="card-title"><span>状态</span></div>
    <div id="status">加载中…</div>
  </div>
<script>
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  function post(type, extra) { vscode.postMessage({ type, ...extra }); }
  function updateCount() {
    const n = ['zcode', 'codex'].filter((e) => $(e).checked).length;
    $('count').textContent = '已选 ' + n + ' 个环境';
  }
  ['zcode', 'codex'].forEach((e) => { $(e).addEventListener('change', updateCount); });
  $('apply').onclick = () => post('apply', { zcode: $('zcode').checked, codex: $('codex').checked, port: Number($('port').value) });
  $('remove').onclick = () => post('remove', { zcode: $('zcode').checked, codex: $('codex').checked });
  $('ensure').onclick = () => post('ensure');
  $('stop').onclick = () => post('stop');
  $('kill-mcp').addEventListener('change', () => {
    post('setExperimental', { killMcp: $('kill-mcp').checked });
  });
  $('kill-agents').addEventListener('change', () => {
    post('setExperimental', { killAgents: $('kill-agents').checked });
  });
  window.addEventListener('message', (e) => {
    const s = e.data;
    if (s.type !== 'state') return;
    if (Number($('port').value) !== s.port) $('port').value = s.port;
    $('dot-zcode').className = dotClassFromState(s.zcode);
    $('dot-codex').className = dotClassFromState(s.codex);
    // 勾选框跟随实际注入状态（用户要求的"根据实际情况选择"）
    $('zcode').checked = !!s.zcode.injected;
    $('codex').checked = !!s.codex.injected;
    updateCount();
    const lines = [];
    lines.push(s.projectDir
        ? '项目: ' + s.projectDir
        : '<span class="bad-t">当前工作区不是 Cocos 项目（package.json 缺 cocos/pink 字段）</span>');
    if (s.projectDir) {
      lines.push(s.running
          ? '<span class="ok-t">● 服务运行中 (端口 ' + s.port + ')</span>'
          : '<span class="bad-t">○ 服务未运行 (端口 ' + s.port + ')</span>'
              + (s.ensure === 'failed' ? ' <span class="bad-t">—— 最近一次拉起失败，查看输出面板 pink-mcp-bridge</span>' : ' —— 用 ZCode/Codex 打开本项目时自动拉起'));
      const zp = s.zcode.injected ? (s.zcode.matches ? '已注入 ✓' : '已注入(有差异,端口' + s.zcode.port + ')') : '未注入';
      const cp = s.codex.injected ? (s.codex.matches ? '已注入 ✓' : '已注入(有差异,端口' + s.codex.port + ')') : '未注入';
      lines.push('ZCode: ' + zp + '　|　Codex(' + (s.codexScope === 'global' ? '全局' : '项目级') + '): ' + cp);
    }
    lines.push('运行时: ' + (s.runnerLabel || '<span class="bad-t">未找到 node / PinK Electron，请设置 pinkMcpBridge.nodePath</span>'));
    if (s.experimental) {
      $('kill-mcp').checked = s.experimental.killMcp;
      $('kill-agents').checked = s.experimental.killAgents;
      $('dot-exp-mcp').className = s.experimental.killMcp ? 'dot drift' : 'dot off';
      $('dot-exp-agents').className = s.experimental.killAgents ? 'dot drift' : 'dot off';
    }
    $('status').innerHTML = lines.join('\\n');
  });
  function dotClassFromState(s) {
    if (!s.injected) return 'dot off';
    return s.matches ? 'dot ok' : 'dot drift';
  }
  post('refresh');
</script>
</body>
</html>`;
    }

    // ---------- 命令注册 ----------

    context.subscriptions.push(
        vscode.commands.registerCommand('pinkMcpBridge.openPanel', openPanel),
        vscode.commands.registerCommand('pinkMcpBridge.ensureServer', () => ensureServer()),
        vscode.commands.registerCommand('pinkMcpBridge.stopServer', () => stopServer()),
        vscode.commands.registerCommand('pinkMcpBridge.applyConfigs', () => openPanel()),
        vscode.commands.registerCommand('pinkMcpBridge.removeConfigs', () => {
            const dir = detectProjectDir();
            if (!dir) { vscode.window.showWarningMessage('pink_mcp_bridge：当前工作区不是 Cocos 项目。'); return; }
            const done = removeConfigs({ zcode: true, codex: true }, { projectDir: dir });
            vscode.window.showInformationMessage(`pink_mcp_bridge：已卸载（${Object.keys(done).join('、') || '无匹配条目'}）。`);
            refreshPanel();
        }),
    );

    // ---------- 激活流程 ----------

    const projectDir = detectProjectDir();
    if (projectDir) {
        log(`Cocos 项目: ${projectDir}`);
        selfHealConfigs(projectDir);
        if (getConfig().get('autoEnsure', true)) {
            ensureServer(projectDir);
        }
        updateStatusBar();
    } else {
        log('当前工作区没有 Cocos 项目，插件待命');
    }

    // 项目切换（添加/移除 workspace folder）时重新检查
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        const dir = detectProjectDir();
        if (dir && getConfig().get('autoEnsure', true)) ensureServer(dir);
        updateStatusBar();
    }));
}

function deactivate() {}

module.exports = { activate, deactivate };
