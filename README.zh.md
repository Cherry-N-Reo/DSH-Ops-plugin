---
description: "在原版 DeepSeek Harness 桌面应用中操作 WebShell，支持后台输入、文本采集、审批及可选 RAG 服务。"
kind: "package-bundle"
---

<a id="ops-title"></a>
# DSH Ops Plugin

[English](README.md) | 中文

<a id="ops-headline"></a>
# 让Deepseek替你面对烦人的WebShell运维

已支持 DeepSeek Harness 桌面版。

<a id="ops-summary"></a>
## 概述

通过自然语言请求，在原版 DeepSeek Harness 桌面应用中操作 WebShell，无需重编译应用。插件在后台 Browser 标签中输入和读取，普通命令只提交一次，默认等待十秒后读取。独立写/读工具支持交互命令和长等待。优先采集 WebSocket/xterm/DOM 文本，截图兜底。敏感命令须确认。本地 Markdown 记录和可选的 pgvector/BM25/rerank API 支持知识检索。本项目是 Ops 运维助手，不是完整 SRE 平台。

<a id="ops-contents"></a>
## 目录

可选的 [Markdown 知识服务](knowledge-service/README.zh.md)：独立 pgvector 存储、BM25/向量检索、重排和增量同步。

无需重编译应用的原版桌面接入见桌面说明：[English](DESKTOP.md) | [中文](DESKTOP.zh.md)。根目录 CLI 包与桌面变体分别构建。

连接、登录、运维记录与 RAG 的完整范围见[英文需求](REQUIREMENTS.md) / [中文需求](REQUIREMENTS.zh.md)和[英文设计](DESIGN.md) / [中文设计](DESIGN.zh.md)。两份文档区分当前能力与待实现工作。

- [DSH Ops Plugin](#ops-title)
- [让Deepseek替你面对烦人的WebShell运维](#ops-headline)
  - [概述](#ops-summary)
  - [目录](#ops-contents)
  - [能力与运行要求](#requirements)
  - [安装与启动](#use-this-package)
    - [原版桌面应用：推荐](#ops-desktop-install)
    - [旧 CLI 源码目录](#ops-cli-install)
  - [配置](#configuration)
    - [在插件页面配置 RAG](#ops-rag-settings)
  - [日常使用与恢复](#usage)
  - [连接与隐私](#records)
  - [实现说明](#understand-the-implementation)
  - [模型体验](#model-experience)
  - [已知限制与未实现功能](#known-limitations-and-deferred-work)
    - [开发备注](#ops-dev-note)

-----

<a id="requirements"></a>
## 能力与运行要求

桌面插件版本为 `0.2.0-rc.2.20261010.13`，适配官方 DSH `0.2.0-rc.2`。内部包名为 `dsh-sre-webshell`，插件 ID 为 `sre-webshell`；桌面版使用 `desktop` profile。根目录保留旧 CLI 版本 `0.1.0` 和 `sre` profile。

桌面接入只支持原版应用中的插件。桌面说明：[English](DESKTOP.md) | [中文](DESKTOP.zh.md)。

| 能力 | 当前行为 |
|---|---|
| WebShell | 原版桌面应用的内置 Browser；旧 CLI 可使用托管 Chromium 或可选的 Windows 原生标签模式 |
| 输入 | 页面内终端输入后发送一次回车；桌面文本操作不要求活动标签或系统前台焦点 |
| 输入保护 | 输入或回车结果不确定时禁止继续写入，须人工检查并重新绑定；不会自动重打 |
| 输入法/标点 | 托管输入使用浏览器 Unicode 事件，不依赖主机输入法；Windows 原生模式保留布局/输入法检查 |
| 输出 | 常规运行默认等待 10 秒；可选优先读取 WebSocket/xterm/DOM 文本，再用截图和滚轮兜底；独立读取支持长等待 |
| 策略 | 有限 POSIX 诊断与经审批的变更；破坏性动作需单独开启 |
| 记录 | 可选的 DPAPI 保护 WebShell/SSH 书签和 runbook；已提交操作先写临时 Markdown 记录，再更新已核实结局；不提供 SSH 执行 |
| 审计 | 元数据哈希链，包含已确认发送的 `submitted` 阶段；远端完成须有输出标记与退出码，不能只凭发送成功判断 |

桌面版要求官方 DSH `0.2.0-rc.2`、已在内置 Browser 登录的 WebShell 和远端 POSIX Shell。文本输入/读取不需要 DevTools 端口、外部 Chrome 或系统键盘模拟。截图兜底需要支持图片的模型。Client 适配器无法读取跨域 frame 或任意不可访问的 WebSocket；云控制台须另行验收。插件不控制 Codex 内置浏览器。

旧 CLI 脚本适配 DSH `0.1.6-alpha.2`，要求父目录已有构建后的 DSH 源码目录，以及 `.runtime/node-v22.23.2-win-x64/node.exe` 便携 Node `22.23.2`。托管 CLI 还需要 Chrome/Edge 和首次登录的图形会话；原生模式仍仅支持 Windows。peer 版本见 [package.json](package.json) 和 [desktop/package.json](desktop/package.json)。本项目不是发布到 npm、可任意位置安装的包。

Linux 上使用 DSH 支持范围内的系统 Node 和 `bash sre-webshell/Build.sh`；把本地 `sre` profile 改成 Linux 路径，再运行 `bash sre-webshell/Start-SRE.sh`。Shell 启动脚本要求 profile 已安装，若设置了 `DSH_HOME` 则使用该目录。脚本不会安装 Chrome/Edge 或 DSH。

-----

<a id="use-this-package"></a>
## 安装与启动

<a id="ops-desktop-install"></a>
### 原版桌面应用：推荐

按桌面说明操作：[English](DESKTOP.md) | [中文](DESKTOP.zh.md)。只构建 `desktop/` 插件变体，完全退出 DSH，使用随包的官方 CLI 将插件压缩包安装到 `desktop` profile，再重开 DSH。启用插件并配置目标 URL 和本地数据路径，不替换应用可执行文件或 `app.asar`。在 DSH Browser 中打开目标 WebShell 并登录；常规 run/write/read 自动绑定唯一匹配标签。

RAG 可选：在插件设置页配置接口地址、超时和 token 引用，独立配置知识服务。嵌入/重排模型的 API Key 必须留在私有 `.env`；见[知识服务说明](knowledge-service/README.zh.md)。没有服务时，本地 runbook 仍可使用。

<a id="ops-cli-install"></a>
### 旧 CLI 源码目录

先按 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的官方说明安装并构建 DSH。将本仓库内容放在 DSH 根目录下名为 `sre-webshell` 的目录中：

```text
DSH/
  apps/cli/lib/bin.js
  node_modules/
  .runtime/node-v22.23.2-win-x64/node.exe
  sre-webshell/
    package.json
    Build.ps1
    Start-SRE.ps1
    src/
    operations/
```

加载层含有 `D:/Program Files/DSH/sre-webshell` 路径。安装位置不同时，修改 `cordis.patch.yml` 和 `local.patch.yml` 中的技能、operations/runtime 和本地构建入口路径。保留 bundle 的 `name: dsh-sre-webshell`。在 DSH 根目录构建并测试：

```powershell
& './sre-webshell/Build.ps1'
& './sre-webshell/Test.ps1'
```

构建会连接 workspace 依赖并生成 `lib/`，不安装或构建 DSH 本体。父目录依赖、便携运行时和构建后的 CLI 必须已经存在。仓库不提交生成文件和依赖。
构建同时生成 Web 插件设置页的 `lib/client.js`；安装或升级后须重启 DSH 才能加载新的浏览器端配置入口。

使用官方 CLI 将本地 bundle 安装到独立 profile：

```powershell
$env:Path = (Join-Path (Get-Location) '.runtime/node-v22.23.2-win-x64') + ';' + $env:Path
$env:COREPACK_HOME = Join-Path (Get-Location) '.runtime/corepack'
$env:DSH_HOME = Join-Path (Get-Location) '.dsh-home'
& './.runtime/node-v22.23.2-win-x64/node.exe' './apps/cli/lib/bin.js' plugin --profile sre add 'link:./sre-webshell'
```

在 `.dsh-home/profiles/sre/package.json` 中，将 `dsh.profile.bundles` 设置为以下有序列表。保留已有依赖和其他字段，代码只展示 bundle 选择。通过 `plugin add` 初始化的自定义 profile 含 base，不自动带上 Web 应用。

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-sre-webshell"
      ]
    }
  }
}
```

添加下文的操作员 patch，然后在 DSH 根目录启动：

```powershell
& './sre-webshell/Start-SRE.ps1'
```

使用 `-NoOpen` 可避免自动打开 DSH 页面。保持 PowerShell 运行，本地 DSH URL 中的 token 是秘密。profile 不存在时，脚本使用 Web 模板加 `local.patch.yml`，桌面控制仍默认关闭。此兜底不替代明确的安装/配置。本 profile 应与通用助手分开。

根目录包适用于旧 CLI；`desktop/` 提供 DSH `0.2.0-rc.2` 的桌面变体。原版 Desktop 通过插件 Client 桥接实现内置 Browser 后台操作，无需重编译主进程。Desktop 独立管理 `desktop` profile，不继承 `sre` profile。移植清单、配置与验收范围见[桌面版说明](DESKTOP.md)（可切换中文）。

-----

<a id="configuration"></a>
## 配置

默认采用托管模式：不需要手动启动调试浏览器，也不要配置 `browserDebugUrl`。插件在 `runtimeDir/managed-browser-profile` 下启动并保留独立 profile；调用 `webshell_open` 或 `terminal_observe`，在新窗口人工登录一次，然后观察并绑定。Linux 下须把以下 Windows 路径改为实际安装路径。下面的手动 DevTools 启动只适用于 Windows 可选的 `browserMode: native`；[Chrome 136 及更新版本](https://developer.chrome.com/blog/remote-debugging-port)要求其使用非默认 `--user-data-dir`。

```powershell
& 'C:/Program Files/Google/Chrome/Application/chrome.exe' --remote-debugging-port=9222 --user-data-dir='D:/Program Files/DSH/sre-webshell/.runtime/chrome-profile'
# Or: & 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' --remote-debugging-port=9222 --user-data-dir='D:/Program Files/DSH/sre-webshell/.runtime/edge-profile'
```

修改 `.dsh-home/profiles/sre/cordis.patch.yml`，它是顶层 YAML 数组。替换目录及目标完整 URL（包括 fragment/query），保留无关配置行。示例开启托管浏览器、直接文本采集与截图兜底，不开启破坏性动作或凭据注入：

```yaml
- id: sre-webshell
  config:
    operationsDir: 'D:/Program Files/DSH/sre-webshell/operations'
    runtimeDir: 'D:/Program Files/DSH/sre-webshell/.runtime'
    enabled: true
    targetUrl: 'https://webshell.example.invalid/#/shell'
    browserMode: managed
    autoScreenshot: true
    directReadDelayMs: 10000
    inputAttempts: 3
    typingIntervalMs: 8
    maxWheelTicks: 20
    allowCritical: false
    allowCredentialInjection: false
- id: permission
  config:
    defaultPreset: sre-full-access
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      sre-full-access:
        sandbox: danger-full-access
        approval: ask
```

| 设置 | 默认值与含义 |
|---|---|
| `enabled` | `false`；启用 WebShell 工具及独立工具白名单 |
| `targetUrl` | 空；WebShell 完整 URL，托管模式必填 |
| `browserMode` | `managed`；`native` 选择旧的 Windows 前台驱动 |
| `managedBrowserChannel` / `managedBrowserExecutablePath` | 空；Windows 自动选 Edge、Linux 自动选 Chrome，或显式指定浏览器 |
| `managedUserDataDir` | 空；默认为 `runtimeDir/managed-browser-profile`，保留登录状态 |
| `browserDebugUrl` | 空；仅原生模式可选的回环 Chromium DevTools 文本源；与托管模式互斥 |
| `browserDebugTimeoutMs` | `3000`；查找目标并连接 DevTools 的有界超时 |
| `textOutputAttempts` | `3`；一次普通读取内直接探测多少次后回退截图 |
| `textOutputPollMs` | `200`；直接探测之间的等待时间，限制为 0–2000 ms |
| `textOutputMaxChars` | `262144`；每个候选终端流最多保留的字符数 |
| `directReadDelayMs` | `10000`；`terminal_run` 发送回车后等待一次读取的毫秒数，范围 0–60000 |
| `autoScreenshot` | `false`；窗口截图、DSH 附件存储与模型传输不逐张审批 |
| `inputAttempts` | `3`；仅供旧破坏性动作输入流程使用；普通命令只进行一次页面内或原生 Unicode 输入 |
| `typingIntervalMs` | `8`；仅 Windows 原生驱动使用，每个字符/UTF-16 单元间隔，整数 0–1000 ms |
| `maxWheelTicks` | `20`；滚轮 tick 绝对上限，正数向上、负数向下 |
| `connectionsFile` | `operationsDir/connections.json`；可选书签 JSON |
| `recordMaxOutputChars` / `recordMaxDocumentBytes` | `12000` / `32768`；运维记录中输出片段字符数与 Markdown 总字节数上限 |
| `defaultTerminalProfile` | `linux`；直接绑定使用的终端 profile |
| `allowCritical` | `false`；单独开启破坏性动作与两阶段审批 |
| `allowCredentialInjection` | `false`；单独开启受保护提示中的凭据注入 |

<a id="ops-rag-settings"></a>
### 在插件页面配置 RAG

打开 DSH 的「插件」→ `dsh-sre-webshell` → `sre-webshell` →「配置」。这里可修改 `ragUrl`、`ragTimeoutMs` 和 `ragTokenEnv`（页面标为 RAG API 地址、检索超时、令牌引用名）。保存后，下次 `runbook_search` 即使用新值；无需手改 `cordis.patch.yml` 或重启。`ragUrl` 留空会只使用本地 Markdown。令牌有独立的密码输入框，保存到 DSH 凭据存储，不会写进设置文件；将知识服务 `knowledge-service/.env` 里的 `RAG_API_TOKEN` 值复制到这里一次，默认引用名为 `DSH_RAG_API_TOKEN`。令牌不会回显。

旧版 `Start-SRE.ps1`/`Start-SRE.sh` 会从知识服务 `.env` 自动注入 `DSH_RAG_API_TOKEN`；现在不再注入，以便在设置页更新令牌。若你自己仍在启动环境中设置该变量，它会优先于 DSH 存储，令牌输入框会显示为环境来源且不可编辑。要用页面管理令牌，请移除该环境变量后重启 DSH。未配置令牌或知识服务未运行时，本地手册搜索仍可用，RAG 部分返回明确提示。知识服务自身的数据库、嵌入/重排模型、API Key 和同步配置仍在 `knowledge-service/.env`，此页面不负责启动或配置该独立服务；详见[知识服务说明](knowledge-service/README.zh.md)。

保存的偏好选中其他预设时，请在 DSH 会话菜单显式选择 `sre-full-access`。完整文件权限与审批是两回事：`approval: never` 拒绝显式审批请求，不代表全部批准。绑定仍需确认，自动截图不授予命令/凭据审批。helper 默认超时 25 秒，绑定默认有效期 120 秒。

代码变更后重新构建，Ctrl+C 停止 DSH 并重启；profile YAML 变更后也要停止并重启。上面的 RAG 设置页保存对下一次检索立即生效。托管模式会在 DSH 停止时关闭所属浏览器，但保留 profile 供下次复用；不要用其他浏览器进程同时打开这个 profile。新建测试对话可避免旧说明干扰；只刷新页面不会重新加载插件。

-----

<a id="usage"></a>
## 日常使用与恢复

托管模式下调用 `webshell_open` 或 `terminal_observe` 打开目标 URL，在所属浏览器人工登录，然后观察并绑定。此后浏览器输入、文本读取和页面截图在其他窗口或标签处于前台时也能执行。原生模式使用已有 Chrome/Edge 标签；只有该模式能通过回环 CDP 使用旧的 `webshell_login`。之后可请求“在配置的 WebShell 执行 `pwd`”“用 `ls` 列出文件”或“用 `kubectl get nodes -o wide` 查看 Kubernetes 节点”。Kubernetes 要求远端已有可用 `kubectl` 和访问权限，插件不负责提供。

绑定确认会显示目标 URL 和浏览器标题；请确认终端处于空闲提示符且可编辑行为空。不要求登记资产。`terminal_run` 输入一次、发送一次回车，默认等待 10 秒后在同一次调用中返回输出。长等待或连续输入几条命令时，可多次调用 `terminal_write`，再调用 `terminal_read`。输入或回车结果不确定时，须人工检查并重新绑定，插件不会自动清空或重打部分输入。普通命令输入/输出无需拖选、右键复制或剪贴板。

命令包含唯一 `DSH_BEGIN_…` / `DSH_END_… rc=…` 标记，区分真正执行输出与输入回显。`rc=0` 表示包装命令返回成功，不代表整个部署健康。托管模式从所属页面探测 WebSocket 接收帧、xterm 缓冲区和终端 DOM；完整且唯一的标记记录可省去截图。探测不完整时回退浏览器页面截图，不激活系统窗口。原生模式的输入或截图兜底仍可能要求目标标签在前台。读取兜底绝不重新提交命令。标记不保证视觉转录逐字节准确。

绑定过期、窗口大小、zoom/字体、资产或目标/焦点变更后，重新观察/绑定。部分输入、分页器、受保护提示或不确定结果应先人工检查并处理，再确认 `terminal_bind` 恢复。不要盲目重跑已提交命令。`terminal_read` 只读取输出，不重新提交；仅有截图时无法证明退出状态。

| 现象 | 检查方向 |
|---|---|
| 桌面控制禁用 | 操作员 patch 的 `enabled: true`，进程已重启，profile 正确 |
| 找不到目标或不匹配 | 托管浏览器登录/跳转及完整 URL；原生模式再检查标签页、辅助功能和前台权限 |
| 审批被拒或不可用 | 预设允许询问，DSH 审批界面可用 |
| 输入不确定或部分回显 | 实际可编辑行、可见性、输入法候选框和焦点；处理后恢复 |
| 输入 helper 失败 | 查看固定的焦点、键盘布局或输入法错误码；恢复或重试前先检查终端 |
| 浏览器文本不可用 | 托管模式检查所属页面和受支持的 xterm/DOM 输出；原生模式检查可选 DevTools 端点或使用截图兜底 |
| 无法选中目标 | 仅原生模式：检查能否选中精确的 Chrome/Edge 标签 |
| 通用 `failed closed` | 本地审计最后阶段；不能仅凭文本认定审批/资产问题 |
| 直接绑定后资产查找失败 | 临时绑定元数据不是登记资产；直接绑定不要求查资产 |

-----

<a id="records"></a>
## 连接与隐私

可选本地 `operations/connections.json` 保存 WebShell URL、自定名称和网络备注；SSH 记录保存主机/端口、名称和备注。交互式连接管理工具创建、编辑 Windows DPAPI CurrentUser 保护的账号/密码，并显式迁移旧明文。模型可见列表既不含账号也不含密文。旧明文须迁移后才能用于 `webshell_login`；插件不会自动迁移真实文件。SSH 执行和设置界面仍不可用。命令与 JSON 示例见双语[连接文件说明](operations/README.zh.md)。

传统资产登记仅用于可选服务/凭据元数据。`operations/inventory/terminal-profiles.yaml` 指定 POSIX、`input: unicode_then_keyboard`、`output: visual` 和分页提示。runbook/示例技能是非可信建议，不是授权。

不要提交真实书签、API key、`.env`、截图、日志、浏览器 profile 或 DSH 历史。托管 profile 在本地保存浏览器 cookie/会话数据，插件不加密它；须限制文件访问，不要纳入备份或 Git。DPAPI 书签保护和凭据管理流程仍只支持 Windows。截图可能含敏感输出，会保存为 DSH 附件并发送给所选模型。直接终端文本会作为普通 DSH 工具结果返回，因此同样保留在 DSH 历史。元数据审计只保存来源标识和输出哈希，不保存 WebSocket URL、bearer token 或输出正文。已提交操作会在 `operations/records/` 生成 Markdown；生成记录已从 Git 和打包中排除，但仍含脱敏命令/输出片段，规则脱敏无法识别所有秘密，送往 RAG 前须人工审查。临时原始截图在附件接纳后移除，存储 ACL 和保留策略需自行设置。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部说明</summary>

可安装 bundle 通过 [cordis.patch.yml](cordis.patch.yml) 添加一个 Cordis 插件，使用 DSH 的配置、工具注册、依赖注入、审批和附件 API，不改变智能体循环。启用后，白名单阻止通用执行/文件修改和其他传输路径绕过策略。

解析器支持有限 POSIX 命令和一个管道，逐词按字面量引用。未知命令、替换表达式、任意解释器包装和 SQL 客户端会被拒绝。通配符按字面量处理，不展开。本插件不是无限制命令执行器，支持范围见 [policy.ts](src/policy.ts)。

托管输入调用可发现 xterm 实例的 `input()`，或通过页面内键盘事件操作唯一的 xterm 辅助输入框；不直接向远端 WebSocket 写命令。托管驱动从所属页面读取 CDP WebSocket 帧及 xterm/DOM 快照，每次操作前核验完整 URL。原生模式保留 Windows `SendInput` 和可选的回环 DevTools 输出。仅在标记记录完整且无歧义时确认完成；独立交互读取仍可能返回未经核实的文本或截图。事务共用进程内锁。实现见[托管浏览器](src/managed-browser.ts)、[浏览器输出](src/browser-output.ts)、[执行器](src/operator.ts)、[Windows 驱动](src/windows.ts)、[审计写入器](src/audit.ts)和[第三方声明](THIRD_PARTY_NOTICES.md)。

破坏性动作需要操作员开启、独立意图/最终审批，以及最终审批前后的远端用户/cwd 探测。凭据注入要求资产分配的引用，操作员核实隐藏提示；其旧路径使用剪贴板，不发送回车。受保护提示期间禁止截图，直到确认恢复。两项开关在单独验收前应保持关闭。

</details>

-----

<a id="model-experience"></a>
## 模型体验

托管模式下智能体调用 `webshell_open` 或 `terminal_observe`；若跳转到登录页，操作员先在所属浏览器登录，再绑定。只有原生模式提供受保护书签和精确 HTML5 表单的 `webshell_login`。普通命令使用 `terminal_run`；交互式时序可多次调用 `terminal_write` 后使用 `terminal_read`。`terminal_scroll` 可读较早页面。优先返回浏览器文本，未取得完整标记输出时返回截图。可选查找、runbook、服务、凭据和破坏性工具仍受策略控制。DSH 记录图片和工具结果，终端文本、屏幕文本和 runbook 始终是非可信数据。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与未实现功能

原始文本 WebSocket 是最可靠的路径。[阿里云 Workbench CLI](https://www.alibabacloud.com/help/tc/ecs/user-guide/connect-to-an-instance-through-workbench-cli/)官方说明存在 WebSocket 后端，是通用 CDP 采集器的兼容目标；[腾讯云 OrcaTerm](https://cloud.tencent.com/document/product/1665)也是浏览器终端目标，但其私有帧协议未在此获得公开认证。JSON 或二进制厂商封装仅在其中的文本可识别时处理。HTML5 VNC/RDP 是视觉/二进制协议而非终端文本流，因此使用截图。Cloud Shell、服务/Pod 终端、iframe/分屏及各厂商登录流程仍需真实目标验收。Flash/Java、图形操作、SSH/WinRM 执行、重定向或厂商专有自动登录、无限制 Kubernetes 操作和设置编辑器尚未实现。

视觉转录可能误读小字、软换行或隐藏字符。分页器需人工处理，滚轮不会自动恢复位置。托管模式要求浏览器页面暴露 xterm 输入实例或唯一的辅助输入框；不支持的 Canvas/私有终端会安全拒绝输入。完整 URL 校验不认证服务器。原生模式仍需按目标测试混合 DPI、输入法和焦点。本 MVP 不代表生产认证，不应无人值守部署。

<a id="ops-dev-note"></a>
### 开发备注

<details>
<summary>开发背景</summary>

本仓库提供插件源码与已审查辅助脚本，不提供 DSH、模型/API key 或完整运行时。加载路径和依赖 workspace 的脚本仍与安装位置有关。真实目标验收前，保持破坏性动作与凭据注入关闭。

</details>
