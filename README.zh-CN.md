<div align="center">

# GAIM

**G**oogle **AI M**ode for every agent，读作 “game”。

*给你的 Agent 一位研究伙伴，在搜索这场 game 中获得 gain。*

[![npm](https://img.shields.io/npm/v/googaim?color=2563eb)](https://www.npmjs.com/package/googaim)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-7c3aed.svg)](LICENSE)

[English](README.md) | 简体中文

</div>

![GAIM 把 Coding Agent 连接到 Google AI Mode，并返回结构化答案、来源和可复用的会话 ID。](assets/gaim-demo.webp)

GAIM 是连接本地 Agent 与 Google AI Mode 的浏览器桥接运行时。唯一的本地核心负责专用系统 Chrome 配置、会话状态和并发；CLI、MCP 与 ACP 只是同一核心外面的轻量适配器。

> GAIM 是非官方社区项目，与 Google 没有关联，也未获得 Google 认可。它不会绕过登录、账号或地区资格、验证码及其他人工验证。

## 把这段话交给你的 Coding Agent

```text
使用 Node.js 22 或更高版本，全局安装 npm 包 `googaim`。不要下载 Playwright、Puppeteer Chromium、Chrome for Testing 或任何其他浏览器；只能使用电脑上已安装的系统 Google Chrome。运行 `gaim doctor`，再按照当前 Agent 官方支持的配置方式，把 `gaim mcp` 注册为本地 stdio MCP 服务。如果需要重启或重新加载才能看到新工具，请明确告诉我。当专用浏览器配置尚未登录时，引导我运行 `gaim login`。在 `gaim_status`、一次真实联网检索，以及复用同一 `conversation_id` 的追问都成功之前，不要宣称安装完成。如果下方兼容性表没有把当前平台或 Agent 标记为已验证，请如实说明，不要猜测。不要把 GAIM 暴露到公网，也不要削弱浏览器沙箱。
```

安装包名是 `googaim`，安装后提供的命令仍是简洁的 `gaim`。

## 它是什么

- **Core**：唯一拥有 Chrome、会话状态、持久化与并发控制的运行时。
- **Daemon**：承载 Core 的本地单例进程。
- **CLI**：供人直接操作 Core 的命令行适配器。
- **MCP**：让 Coding Agent 把 GAIM 当作工具使用的适配器。
- **ACP**：让支持 ACP 的宿主把 GAIM 当作子 Agent 使用的适配器。

GAIM 本身不是一个拥有独立模型和自主规划能力的 Agent，也不是生成项目模板的 scaffold。它是一座本地桥梁：把 Google AI Mode 的人类网页交互，转换为 Agent 可以稳定调用的多轮研究接口。

## 三个稳定操作

- `gaim_turn`：用自然语言提问。不传 `conversation_id` 时创建隔离的新会话；复用返回的 ID 时继续同一条 Google AI Mode 对话。
- `gaim_history`：读取某个会话最近的记录，不触发搜索。
- `gaim_status`：报告 Chrome 连通性、登录或可用状态、队列深度和最近一次错误。

每个正常 turn 都要求 AI Mode 重新联网搜索。GAIM 等待回答块出现复制、分享等完成操作，要求观察到新的 Google 搜索请求，并至少解析出一个外部来源；证据不足时返回错误，不会把答案伪装成已搜索结果。来源属于整段对话的近似参考，不是逐句引用。

## 当前兼容性

只有在真实完成“干净安装 → 人工登录 → 状态检查 → 联网首问 → 同会话追问”后，平台或宿主才会被标记为已验证。

| 目标 | 当前证据 |
|---|---|
| Linux / WSL + 系统 Chrome | 已通过真实 Google AI Mode 首问与追问 |
| Windows 原生 | 只有实现与单元测试，尚未完成真实浏览器验证 |
| macOS | 只有实现与单元测试，尚未完成真实浏览器验证 |
| CLI | 已在 Linux / WSL 完成端到端验证 |
| 通用本地 stdio MCP | 协议测试通过，具体宿主验证待完成 |
| 通用 ACP | 协议测试通过，具体宿主验证待完成 |
| Codex、Claude Code、OpenCode、Pi、Hermes | 安装方案与逐宿主验证待完成 |
| DevSpace | 当前不能注册具名 GAIM provider；需要上游开放通用外部 ACP 接口 |

远程服务器、没有图形登录路径的容器，以及公网部署，不属于首个版本的支持承诺。

## 本地 MCP 配置

大多数本地 MCP 客户端接受以下结构：

```json
{
  "mcpServers": {
    "gaim": {
      "command": "gaim",
      "args": ["mcp"]
    }
  }
}
```

如果桌面应用找不到 shell 中的 `gaim`，可运行 `gaim init`，使用它输出的绝对路径配置。

## ACP

```bash
gaim acp
```

每个 ACP session 默认创建独立 GAIM 会话，后续 prompt 会留在同一对话。支持：

- `/new`：下一条消息创建新会话。
- `/join <conversation_id>`：主动加入已有共享会话。
- `/history`：读取当前会话记录。
- `/status`：检查可用状态。

只有支持具名外部 Agent 的 ACP 宿主才能直接注册 `gaim init` 输出的命令。当前 DevSpace 尚未开放这一通用入口。

## CLI 与真实自测

```bash
gaim turn "What changed in the latest stable Node.js release?"
gaim turn "Expand the most important change" --conversation <FIRST_TURN_ID>
npm run e2e -- "first question" "follow-up question"
```

首次命令会自动启动很小的本地 daemon。一个会话内部严格串行，不同会话可在有界上限内并行。专用 Chrome 配置和会话状态默认保存在 `~/.local/share/gaim/`。

有效会话标签页会保留以便追问。运行 `gaim stop` 可关闭 GAIM 拥有的 Chrome 并释放内存。

## 首次登录

```bash
gaim login
```

该命令会在运行 GAIM 的同一台电脑上，用系统 Chrome 打开专用配置。请直接在窗口中完成登录或人工验证，关闭窗口后再运行：

```bash
gaim status
```

明确错误状态包括 `NOT_LOGGED_IN`、`AI_MODE_UNAVAILABLE` 和 `HUMAN_VERIFICATION`。GAIM 不会尝试绕过这些限制。

## 配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `GAIM_CHROME` | 自动检测 | 已安装的系统 Google Chrome 可执行文件 |
| `GAIM_USER_DATA_DIR` | `~/.local/share/gaim/chrome-profile` | 专用持久化 Google 配置 |
| `GAIM_STATE_DIR` | `~/.local/share/gaim` | 会话状态 |
| `GAIM_CDP_PORT` | `9224` | 仅环回地址可用的 Chrome DevTools 端口 |
| `GAIM_GENERATION_TIMEOUT_MS` | `15000` | 回答生成等待上限 |
| `GAIM_BROWSER_IDLE_MS` | `60000` | 无会话标签页时关闭 Chrome 的空闲时间；`0` 表示禁用 |
| `GAIM_MAX_PARALLEL` | `3` | 同时搜索的会话上限 |
| `GAIM_MIN_SOURCES` | `1` | 每次搜索所需的最少外部来源数 |
| `GAIM_NO_SANDBOX` | 未设置 | 只有宿主明确要求时才设为 `1` |

选择器和可见标签集中在 `core.mjs` 顶部。GAIM 优先使用 role、ARIA 属性和可见文本，不依赖动态 class 名。

## 设计边界

- **本地优先**：使用用户私有 Unix socket 或 Windows named pipe，再通过 stdio 适配；没有公网 HTTP 服务和 OAuth 配置。
- **唯一 Owner**：只有 Core 接触 Chrome 和会话状态。
- **显式共享**：只有调用者主动复用 `conversation_id` 时，多个 Agent 才进入同一会话。
- **有界并发**：同一会话一次只运行一个 turn，全局并行数有硬上限。
- **有界失败**：所有等待都有超时，错误码明确，不绕过验证码。
- **小型安装**：只依赖 Node.js、ACP SDK 和 Zod；没有 Playwright、Puppeteer、内置浏览器或浏览器下载脚本。

## 仓库结构

| 文件 | 职责 |
|---|---|
| `core.mjs`、`daemon.mjs`、`client.mjs`、`paths.mjs` | Chrome、会话、持久化、队列和本地单例 |
| `gaim.mjs` | 面向人的 CLI |
| `gaim-mcp.mjs`、`gaim-acp.mjs` | 同一核心外面的 MCP 与 ACP 适配器 |
| `meta.mjs` | 从唯一来源读取共享包元数据 |
| `skills/gaim/` | 支持 Agent Skills 的可移植说明 |
| `core.test.mjs`、`platform.test.mjs`、`protocol.test.mjs`、`e2e.mjs` | 单元、协议和真实浏览器验证 |
| `package.json`、`package-lock.json` | 可复现安装与发布边界 |
| `README.md`、`README.zh-CN.md`、`LICENSE` | 英文说明、中文说明和许可 |

## 开发验证

```bash
npm install
npm test
npm pack --dry-run
npm run e2e
```

自动测试覆盖会话隔离、显式共享、说话者身份、幂等请求、未知会话、单会话串行、跨会话有界并行、MCP/ACP 协议和唯一浏览器 Owner。真实端到端测试使用系统 Chrome，先提问一次，再在同一 `conversation_id` 中追问。

欢迎提交选择器更新、问题报告和 pull request。

## License

MIT，见 [LICENSE](LICENSE)。
