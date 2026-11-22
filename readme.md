# pink_mcp_bridge

PinK 插件：把当前 Cocos 项目的 cocos-cli MCP 服务桥接给 **ZCode** 和 **Codex**，让它们打开项目时自动获得 Cocos 场景/资源/构建等 MCP 工具（104 个，与 PinK 内置能力同源）。

## 背景

PinK 编辑器内嵌的 MCP endpoint 当前版本被官方禁用（`[CocosHostMcp] Built-in MCP endpoint is disabled`，9527/mcp 返回 404，且带窗口级租约 token 排他），外部 AI 工具无法直连。

但 PinK 官方引擎自带的 cocos-cli 与 PinK 内嵌能力同源，支持独立 MCP 服务。本插件管理这个服务，并把它写进 ZCode / Codex 的 MCP 配置。

## 架构

```
ZCode / Codex（stdio 配置）
      │  node bridge.mjs [--port N] [--project P]
      ▼
bridge.mjs
  ├─ ensure：探测端口 → 没有就 spawn cocos-cli start-mcp-server（detached，随项目存活）
  ├─ 校验：initialize（serverInfo.name === 'cocos-cli'）+ assets-query-asset-info（归属本项目）
  └─ stdio ↔ http://127.0.0.1:N/mcp 转发
      ▼
cocos-cli MCP 服务
  ├─ 运行时自动选择：node 或 PinK 自带 Electron（官方引擎原生模块按 Electron ABI 编译，
  │   普通 node 载不动 → ABI 探针后自动切换 ELECTRON_RUN_AS_NODE + 垫片修正 commander argv）
  └─ 端口来源：--port 参数 > 项目 .pink-bridge.json > 默认 9630
```

## 面板

三个入口：
1. **活动栏**：左侧图标栏的 PinkMcpBridge 图标（常驻，点开即面板）
2. **状态栏**：右下角 `bridge:9630` / `bridge:off`
3. 命令面板：`pink_mcp_bridge：打开配置面板`

（顶部菜单栏（查看/窗口等）是 VSCode 硬编码的，扩展无法往里加条目，所以用活动栏做常驻入口。）

面板功能：

- **环境选择**：勾选 ZCode / Codex（每个环境一个状态圆点：绿=已注入一致、黄=已注入有差异、灰=未注入）
- **端口**：输入端口后点「注入」；端口写入工作区级设置 + 项目 `.pink-bridge.json`
- **注入**：幂等——已存在则对比端口/bridge 路径，完全一致提示"无变化"，有差异更新并提示"端口 X → Y"，服务自动切换到新端口
- **卸载**：从所选环境移除 pink_mcp_bridge 条目（服务不自动停，可手动停止）
- **启动/停止服务**
- **试验性功能**：禁止内置 MCP 服务 / 禁止 agents（详见下文）

## CLI 来源（不依赖外部工具）

| 组件 | 来源 |
| --- | --- |
| cocos-cli（MCP 服务本体） | **PinK 内置**：`~/Library/Application Support/cocos-default/cocos-<版本>/`（PinK 自己下载管理的官方引擎，按项目 cocos.version 匹配） |
| 跑引擎的 node 运行时 | **PinK 自带 Electron**（`ELECTRON_RUN_AS_NODE`）：官方引擎原生模块按 Electron ABI 编译，ABI 探针自动选择 |
| bridge 转发进程的 node | 优先系统 node；**找不到时兜底 PinK 自带 Electron**（完全内置，不依赖外部 CLI） |

唯一的可选外部依赖是系统 node（更轻量）；没有 node 时整条链路仍然全部走 PinK 自带二进制。

## 安装（PinK 插件即 VS Code 扩展）

把整个目录拷到（目录名必须带版本号）：

```
~/.pink/extensions/local.pink-mcp-bridge-0.1.0/
```

完全重启 PinK（注意任务栏图标）。开发期改动后重新拷贝再重启。

## 使用流程

1. PinK 打开 Cocos 项目 → 插件自动拉起服务（默认端口 9630，`autoEnsure` 可关），状态栏显示状态
2. 面板里勾选 ZCode / Codex → 点「注入」→ 配置写入：
   - ZCode：`<项目>/.zcode/config.json` → `mcp.servers.pink_mcp_bridge`（stdio）
   - Codex：默认项目级 `<项目>/.codex/config.toml` → `[mcp_servers.pink_mcp_bridge]`；若 Codex 不认项目级配置，把设置 `pinkMcpBridge.codexScope` 切成 `global`（bridge 会从工作目录自动识别项目，端口读项目 `.pink-bridge.json`）
3. 用 ZCode / Codex 打开本项目 → MCP 面板出现 `pink_mcp_bridge`，工具即可用

### 设置项

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `pinkMcpBridge.port` | 9630 | 服务端口；面板里改会写到工作区级（每项目一端口） |
| `pinkMcpBridge.cliPath` | 自动 | cocos-cli 根目录；默认按项目 cocos.version 匹配 `~/Library/Application Support/cocos-default/` |
| `pinkMcpBridge.nodePath` | 自动 | node 绝对路径；自动探测 which → nvm → Homebrew |
| `pinkMcpBridge.codexScope` | project | Codex 配置写项目级还是全局 |
| `pinkMcpBridge.autoEnsure` | true | PinK 打开项目时自动拉起服务 |
| `pinkMcpBridge.autoSyncConfigs` | true | 激活时自愈：**只修正已注入但有漂移的配置**（升级/改端口自动跟上；手动卸载后不会被复活） |

## 多项目并存

每个项目一个端口（面板里分别为 TestA 设 9630、TestB 设 9631）。同一端口只能服务一个项目：bridge 会校验端口上服务的项目归属，属于别的项目时明确报错"端口 X 被另一个项目占用，请换端口"。

## 试验性功能（面板里勾选，写入 PinK 设置，完全重启 PinK 后生效）

- **禁止内置 MCP 服务**：写入 `chat.mcp.discovery.enabled=false`、`github.copilot.chat.githubMcpServer.enabled=false`，关闭 chat 侧的 MCP 服务器发现与 GitHub MCP server。（PinK 内嵌引擎的 MCP endpoint 本就被官方硬编码禁用，此开关防未来版本启用。）
- **禁止 agents**：写入 `chat.agentHost.enabled=false`、`chat.agentHost.claudeAgent.enabled=false`、`chat.agentHost.codexAgent.enabled=false`、`chat.agent.enabled=false`，关闭 agentHost 里的 Claude Code SDK / Codex SDK agent runtime 与 chat agent 模式。注意：agentHost 宿主进程由 PinK 主进程无条件启动，插件无法阻止进程存在，只能关掉里面的 agent runtime；copilot-chat 扩展（chat UI）也会继续激活。

取消勾选 = 删除对应设置覆盖，恢复 PinK 默认值。

## 构建与安装（.vsix 安装包）

```bash
./scripts/build.sh              # 构建 pink-mcp-bridge-<版本>.vsix
./scripts/build.sh --install    # 构建并用 PinK CLI 直接安装
```

等价命令：`npx --yes @vscode/vsce package --no-dependencies --allow-missing-repository`，安装：
`/Applications/PinK.app/Contents/Resources/app/bin/code --install-extension pink-mcp-bridge-<版本>.vsix --force`。
安装后完全重启 PinK。卸载：`bin/code --uninstall-extension local.pink-mcp-bridge`。

## 注意

- 与项目里已有的其它 MCP 条目互不影响，可并存。
- 非 Cocos 项目里 bridge 会打印诊断退出，该 server 显示不可用属正常现象（Codex 全局配置模式下）。
- Codex Desktop 可能覆盖 `~/.codex/config.toml`（openai/codex#36465）；写前备份 `config.toml.pink-bridge.bak`。
- 插件升级后目录名变化（带版本号），自愈机制会在下次激活时把已注入配置里的 bridge 路径更新为新目录。
- 诊断日志：`<项目>/temp/logs/pink-mcp-bridge.log`；服务日志：`<项目>/temp/logs/pink-mcp-bridge-server.log`。

## 开发

```
src/extension.js                     插件主体（面板、注入/卸载、self-heal、试验性开关）
scripts/bridge.mjs                   stdio↔HTTP 桥 + 服务托管 + 运行时探测
scripts/bridge-electron-wrapper.cjs  Electron-as-node 的 argv 垫片
scripts/build.sh                     构建与安装
media/bridge.svg                     活动栏图标
```

`TestA/`、`TestB/` 是本机实验项目，不入库。给 AI 编码代理的指南（架构决策与已知坑）见 [AGENTS.md](AGENTS.md)。
