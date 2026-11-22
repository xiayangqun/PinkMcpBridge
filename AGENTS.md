# AGENTS.md — AI 编码代理指南

本文件给在这个仓库里工作的 AI 编码代理（Claude Code / Codex / ZCode 等）提供项目背景、约定与已知坑。

## 项目定位

PinK（VSCode fork）插件 `pink_mcp_bridge`：把当前 Cocos 项目的 cocos-cli MCP 服务桥接给 ZCode / Codex。

- **为什么存在**：PinK 内嵌的 MCP endpoint 当前版本被官方硬编码禁用（`cocosHost.pink.js` 里 `[CocosHostMcp] Built-in MCP endpoint is disabled`，9527/mcp 返回 404，且带窗口级租约 token 排他），外部 AI 工具连不上。
- **实现方式**：插件管理一个**独立的** `cocos-cli start-mcp-server` 进程（与 PinK 内嵌能力同源），并以 stdio↔HTTP 桥暴露给两个客户端。

## 目录结构

```
package.json                      扩展清单（viewsContainers/commands/configuration）
src/extension.js                  插件主体：面板（活动栏+独立窗口双入口）、注入/卸载、
                                  self-heal、服务生命周期、试验性开关
scripts/bridge.mjs                核心：stdio↔HTTP 转发 + ensure 服务 + 引擎/运行时探测
scripts/bridge-electron-wrapper.cjs  Electron-as-node 跑 cli.js 的 argv 垫片（必须）
scripts/build.sh                  构建 .vsix + 可选 --install（PinK CLI）
media/bridge.svg                  活动栏图标
TestA/ TestB/                     本机实验项目（.gitignore 已排除，不要提交、不要动其他项目）
```

## 构建与安装

```bash
./scripts/build.sh              # 构建 pink-mcp-bridge-<版本>.vsix
./scripts/build.sh --install    # 构建并用 PinK CLI 安装（/Applications/PinK.app/.../bin/code --install-extension）
```

安装后必须**完全重启 PinK**（任务栏图标退出才算）。卸载：`bin/code --uninstall-extension local.pink-mcp-bridge`。

## 已知坑（改代码前必读，全部实测踩过）

### 1. 官方引擎原生模块按 Electron ABI 编译

PinK 官方引擎（`~/Library/Application Support/cocos-default/cocos-<版本>/`）的 `node_modules/gl/build/Release/webgl.node` 按 **Electron 42 ABI（MODULE_VERSION 146）**编译，系统 node（127）载不动 → `start-mcp-server` 直接失败。

对策：`bridge.mjs` 的 `pickRunner()` 用 gl 模块探针自动选运行时——node 探针失败则切 PinK 自带 Electron（`ELECTRON_RUN_AS_NODE=1`）。

### 2. Electron-as-node 下 commander 的 argv 坑

`process.versions.electron` 在 ELECTRON_RUN_AS_NODE 下**仍然存在**，commander 检测到会切 `from:'electron'` 模式（argv 从 index 1 解析），导致 `unknown command '<cli.js>'`。

对策：**任何** Electron 运行时跑 `cli.js` 都必须经过 `bridge-electron-wrapper.cjs`（删 `process.versions.electron` + 修正 argv 为 node 惯例）。`spawnServer()` 的 `needsWrapper` 判断覆盖两种情况：runner 是 Electron，或 bridge 自身跑在 Electron 上（`BRIDGE_ON_ELECTRON`）。

### 3. PinK fork 移除/改动了部分 VSCode API

`WebviewView.onDidChangeViewState` 在 PinK 1.127 **不是函数**，绑定它会让 `resolveWebviewView` 抛 TypeError → "还原视图时出错" + 面板状态永不刷新。对 fork API 一律 `typeof` 防御后再用。状态刷新依赖页面自身的 `post('refresh')` 主动拉取，不要依赖事件推送。

### 4. cocos-cli 端口占用会静默顺延

`ServerService.getAvailablePort()` 在端口被占时 +1 重试。bridge 启动后必须做 **drift 检测**（从服务日志匹配实际端口）+ **归属校验**（`initialize` 确认 `serverInfo.name==='cocos-cli'`，`assets-query-asset-info db://assets` 确认 file 字段属于本项目），否则会误连别的项目/别的服务。

### 5. self-heal 语义：只修漂移，不复活卸载

`extension.js` 的 `selfHealConfigs()` 只更新「已注入但有差异」的配置（插件升级换目录、改端口）。**不存在的配置绝不自动注入**——否则用户在面板卸载后，下次激活又被写回。新注入只能由面板手动触发。

### 6. 面板是"活动栏视图 + 独立窗口"双入口

`refreshPanel()` 必须同时推 `panel?.webview` 和 `sidebarView?.webview`，且守卫是 `if (!panel && !sidebarView) return`。侧边栏 webview 加载完成后会主动 `post('refresh')`，插件收到后推一次状态——这个拉取是状态更新的主通道，别删。

### 7. commander 子命令注册在 `dist/commands/mcp-server.js`

服务启动命令是 `start-mcp-server -j <project> -p <port>`（不是 `mcp-server`）。引擎路径解析优先级见 `resolveCliRoot()`：`--cli` > `.pink-bridge.json` 的 cliPath（插件经 PinK 接口解析后缓存）> 项目 cocos.version 匹配 > cocos-default 扫描。

## 测试约定

- **只在 `TestA/`、`TestB/` 上做实验**（用户创建的测试工程）；绝不读写其他 Cocos 项目。
- 手动验证 bridge：`node scripts/bridge.mjs --ensure-only --port 9630 --project <TestA 绝对路径>`（exit 0 = 服务就绪）。
- 转发测试：stdin 灌 `initialize` + `tools/call`，stdout 应回 JSON-RPC（工具约 104 个）。
- 诊断日志：`<项目>/temp/logs/pink-mcp-bridge.log`（bridge trace）、`pink-mcp-bridge-server.log`（服务）。
- 多会话并发首启有目录锁（`temp/.pink-bridge-start.lock`），trace 里 `waited-for-other` 是正常行为。

## 配置文件格式速查

**ZCode**（项目级 `<项目>/.zcode/config.json`）：

```json
{ "mcp": { "servers": { "pink_mcp_bridge": {
    "type": "stdio",
    "command": "<node 或 PinK Electron>",
    "args": ["<bridge.mjs>", "--port", "9630", "--project", "<项目>"],
    "env": {}
} } } }
```

**Codex 项目级**（`<项目>/.codex/config.toml`）：

```toml
[mcp_servers.pink_mcp_bridge]
command = "..."
args = ["...", "--port", "9630", "--project", "..."]
startup_timeout_sec = 120
```

**Codex 全局**（`~/.codex/config.toml`，`pinkMcpBridge.codexScope=global` 时）：args 不带 `--project`/`--port`，bridge 从 cwd 探测项目、从项目 `.pink-bridge.json` 读端口与 cliPath。

**`.pink-bridge.json`**（项目内，插件写入）：`{ "port": 9631, "cliPath": "..." }`。

## 试验性开关

面板里两个勾选写 PinK 的 User settings（Global）：

- 禁止内置 MCP：`chat.mcp.discovery.enabled=false`、`github.copilot.chat.githubMcpServer.enabled=false`
- 禁止 agents：`chat.agentHost.enabled=false`、`chat.agentHost.claudeAgent.enabled=false`、`chat.agentHost.codexAgent.enabled=false`、`chat.agent.enabled=false`

注意：PinK 的 agentHost 里跑的是 **Claude Agent SDK（@anthropic-ai/claude-agent-sdk）与 OpenAI Codex 二进制（@openai/codex）** 的 runtime；宿主进程由 PinK 主进程无条件 fork，开关只能关掉 runtime。取消勾选 = 删除覆盖恢复默认。两个开关**互相独立**——`applyExperimental(updates)` 只处理传入的组，绝不能把未提及的组当 false 处理（历史 bug）。
