---
description: "配置并使用基于 DeepSeek Harness 的 Windows WebShell 视觉运维，了解连接记录与命令审批。"
kind: "package-bundle"
---

# DSH Ops Plugin

[English](README.md) | 中文

# 让Deepseek替你面对烦人的WebShell运维

## 概述

通过自然语言请求，让 DeepSeek Harness（DSH）操作已登录的浏览器 WebShell。智能体选中配置的标签页，看截图、输入命令，核对回显后才按回车。普通输入和输出读取无需剪贴板。命令策略、审批和元数据审计约束运维操作。本 Windows 源码版本是 Ops 运维助手，不是独立应用，也不是完整的 SRE 平台。

## 目录

- [能力与运行要求](#requirements)
- [安装与启动](#use-this-package)
- [配置](#configuration)
- [日常使用与恢复](#usage)
- [连接与隐私](#records)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与未实现功能](#known-limitations-and-deferred-work)

-----

<a id="requirements"></a>
## 能力与运行要求

版本 `0.1.0` 保留内部包名 `dsh-sre-webshell`、插件 ID `sre-webshell` 和 profile `sre`。对外项目名称不改变已有配置名称。

| 能力 | 当前行为 |
|---|---|
| 已登录的 WebShell | 按完整 URL 选中已有原生 Chrome/Edge 标签页；不自动登录或导航 |
| 输入 | 最多三次 Unicode 尝试，每次截图；确认仍为空才允许一次实体按键兜底 |
| 输入保护 | 完整准确回显后单独发送回车；部分、遮挡或不确定输入禁止重打 |
| 输入法/标点 | 核验 US 英文布局，关闭可取得的输入法上下文；ASCII 兜底处理 Shift/Caps Lock |
| 输出 | 智能体看截图，保留滚轮及唯一完成/退出状态标记 |
| 策略 | 有限 POSIX 诊断与经审批的变更；破坏性动作需单独开启 |
| 记录 | 可选 WebShell/SSH 书签和 runbook；SSH 记录不提供 SSH 执行 |
| 审计 | 元数据哈希链；审计文件不保存明文命令/输出正文 |

要求：Windows 10/11 交互式桌面，原生 Chrome/Edge 的地址栏/标签页可被辅助功能访问，远端 POSIX Shell，以及支持图片输入的 DSH 智能体。模型/API 凭据配置在 DSH 中，不放入连接书签。Codex 内置浏览器不是原生 Chrome/Edge 控制目标。

本源码快照适配 DSH `0.1.6-alpha.2`。脚本要求父目录已有构建后的 DSH 源码目录，以及 `.runtime/node-v22.23.2-win-x64/node.exe` 便携 Node `22.23.2`。DSH 的 Node 范围为 `^22.19.0 || >=24.0.0`，但这些脚本选择上述固定运行时。peer 版本见 [package.json](package.json)。本项目不是发布到 npm、可任意位置安装的包。

-----

<a id="use-this-package"></a>
## 安装与启动

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

-----

<a id="configuration"></a>
## 配置

修改 `.dsh-home/profiles/sre/cordis.patch.yml`，它是顶层 YAML 数组。替换目录及已有标签页的完整 URL（包括 fragment/query），保留无关配置行。示例开启桌面控制和截图授权，不开启破坏性动作或凭据注入：

```yaml
- id: sre-webshell
  config:
    operationsDir: 'D:/Program Files/DSH/sre-webshell/operations'
    runtimeDir: 'D:/Program Files/DSH/sre-webshell/.runtime'
    enabled: true
    targetUrl: 'https://webshell.example.invalid/#/shell'
    autoScreenshot: true
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
| `enabled` | `false`；启用桌面工具及独立工具白名单 |
| `targetUrl` | 空；已有原生浏览器完整 URL，自动截图必填 |
| `autoScreenshot` | `false`；窗口截图、DSH 附件存储与模型传输不逐张审批 |
| `inputAttempts` | `3`；整数 1–3 次 Unicode 尝试，确认仍为空后一次兜底 |
| `typingIntervalMs` | `8`；每个字符/UTF-16 单元间隔，整数 0–1000 ms |
| `maxWheelTicks` | `20`；滚轮 tick 绝对上限，正数向上、负数向下 |
| `connectionsFile` | `operationsDir/connections.json`；可选书签 JSON |
| `defaultTerminalProfile` | `linux`；直接绑定使用的终端 profile |
| `allowCritical` | `false`；单独开启破坏性动作与两阶段审批 |
| `allowCredentialInjection` | `false`；单独开启受保护提示中的凭据注入 |

保存的偏好选中其他预设时，请在 DSH 会话菜单显式选择 `sre-full-access`。完整文件权限与审批是两回事：`approval: never` 拒绝显式审批请求，不代表全部批准。绑定仍需确认，自动截图不授予命令/凭据审批。helper 默认超时 25 秒，绑定默认有效期 120 秒。

代码变更后重新构建，Ctrl+C 停止 DSH 并重启；配置变更后也要停止并重启。PowerShell 和已登录的 WebShell 可以保留。新建测试对话可避免旧说明干扰；只刷新页面不会重新加载插件。

-----

<a id="usage"></a>
## 日常使用与恢复

先人工打开并登录配置的 WebShell。可请求“在配置的 WebShell 执行 `pwd`”“用 `ls` 列出文件”或“用 `kubectl get nodes -o wide` 查看 Kubernetes 节点”。Kubernetes 要求远端已有可用 `kubectl` 和访问权限，插件不负责提供。

智能体观察标签页，请你确认终端区域，不要求登记资产。它检查空闲空行，输入并读取每次截图，完整核对实际回显后才单独发送一次回车。只有确认仍为空才推进有限尝试。部分或不确定输入不允许自动清空/补打/兜底。实体兜底仅支持可打印 ASCII。普通命令输入/输出无需拖选、右键复制或剪贴板。

命令包含唯一 `DSH_BEGIN_…` / `DSH_END_… rc=…` 标记，区分真正执行输出与输入回显。`rc=0` 表示包装命令返回成功，不代表整个部署健康。智能体通过滚轮截图读取长输出，报告匹配标记以完成采集。标记不保证转录逐字节准确。

绑定过期、窗口大小、zoom/字体、资产或目标/焦点变更后，重新观察/绑定。部分输入、分页器、受保护提示或不确定结果应先人工检查并处理，再确认 `terminal_bind` 恢复。不要盲目重跑已提交命令。`terminal_collect` 只观察待核对输入/已有输出，不重新提交。

| 现象 | 检查方向 |
|---|---|
| 桌面控制禁用 | 操作员 patch 的 `enabled: true`，进程已重启，profile 正确 |
| 找不到目标或不匹配 | 原生标签页、完整 URL、辅助功能和前台权限 |
| 审批被拒或不可用 | 预设允许询问，DSH 审批界面可用 |
| 输入不确定或部分回显 | 实际可编辑行、可见性、输入法候选框和焦点；处理后恢复 |
| 通用 `failed closed` | 本地审计最后阶段；不能仅凭文本认定审批/资产问题 |
| 直接绑定后资产查找失败 | 临时绑定元数据不是登记资产；直接绑定不要求查资产 |

-----

<a id="records"></a>
## 连接与隐私

可选本地 `operations/connections.json` 保存 WebShell URL、自定名称、Web 系统账号/密码和网络备注；SSH 记录主机/端口、服务器账号/密码、名称和备注。直接编辑文件，尚无设置编辑器。支持本地明文密码或凭据引用，模型可见列表去掉密码正文。SSH 执行和自动 Web 登录尚未实现。JSON 示例见双语[连接文件说明](operations/README.zh.md)。

传统资产登记仅用于可选服务/凭据元数据。`operations/inventory/terminal-profiles.yaml` 指定 POSIX、`input: unicode_then_keyboard`、`output: visual` 和分页提示。runbook/示例技能是非可信建议，不是授权。

不要提交真实书签、API key、`.env`、截图、日志或 DSH 历史。明文记录不加密。截图可能含敏感输出，会保存为 DSH 附件并发送给所选模型。元数据审计不保存命令/输出正文，但 DSH 历史保留工具参数/结果/图片。临时原始截图在附件接纳后移除，存储 ACL 和保留策略需自行设置。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现内部说明</summary>

可安装 bundle 通过 [cordis.patch.yml](cordis.patch.yml) 添加一个 Cordis 插件，使用 DSH 的配置、工具注册、依赖注入、审批和附件 API，不改变智能体循环。启用后，白名单阻止通用执行/文件修改和其他传输路径绕过策略。

解析器支持有限 POSIX 命令和一个管道，逐词按字面量引用。未知命令、替换表达式、任意解释器包装和 SQL 客户端会被拒绝。通配符按字面量处理，不展开。本插件不是无限制命令执行器，支持范围见 [policy.ts](src/policy.ts)。

输入采用 Windows `SendInput(KEYEVENTF_UNICODE)`，不是 DOM 赋值、终端私有 JavaScript 或直连 WebSocket。实体兜底支持可打印 ASCII。驱动重新验证 URL/窗口身份，桌面操作共用进程内锁。截图和单次 ID 驱动核对。审计接受有界元数据，包括零至三次尝试计数和 Unicode/实体键盘模式。实现见[输入流程](src/input.ts)、[执行器](src/operator.ts)、[Windows 驱动](src/windows.ts)、[审计写入器](src/audit.ts)和[第三方声明](THIRD_PARTY_NOTICES.md)。

破坏性动作需要操作员开启、独立意图/最终审批，以及最终审批前后的远端用户/cwd 探测。凭据注入要求资产分配的引用，操作员核实隐藏提示；其旧路径使用剪贴板，不发送回车。受保护提示期间禁止截图，直到确认恢复。两项开关在单独验收前应保持关闭。

</details>

-----

<a id="model-experience"></a>
## 模型体验

智能体观察/绑定，以 `terminal_execute` 准备命令，以 `terminal_input_check` 核对实际回显，用 `terminal_collect` 读取结果，用 `terminal_scroll` 滚动。可选查找、runbook、服务、凭据和破坏性工具仍受策略控制。支持图片的主模型直接看截图，普通命令不需要第二个视觉 provider 或人工转录。DSH 记录图片和工具结果，屏幕文本和 runbook 始终是非可信数据。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与未实现功能

操作员于 2026-09-19 报告原生 WebShell 成功执行 `ls`，结束标记为 `rc=0`。73 项无密钥测试覆盖策略、有界输入、禁止重打、审批、真实审计持久化、原生代码编译和构建后的 DSH 组合，不认证所有终端/浏览器/模型。证据与早期检查见 [ACCEPTANCE.md](ACCEPTANCE.md)。

HTML5 SSH/Cloud Shell、服务/Pod 终端、iframe/分屏和 HTML5 VNC 是兼容性目标，不是认证适配器。阿里云 Workbench/Cloud Shell 和腾讯云 OrcaTerm/VNC 需分别验收。Flash/Java、图形操作、SSH/WinRM 执行、自动登录、无限制 Kubernetes 操作和设置编辑器尚未实现。无需浏览器调试端口。

视觉转录可能误读小字、软换行或隐藏字符。分页器需人工处理，滚轮不会自动恢复位置。混合 DPI/多显示器、延迟回显和输入法行为需按目标实测。URL/窗口校验不认证服务器，不能区分相同 URL 的重复标签页。进程内锁无法阻止校验/输入之间的外部焦点变化。本 MVP 不代表生产认证，不应无人值守部署。

### 开发备注

<details>
<summary>开发背景</summary>

本仓库提供插件源码与已审查辅助脚本，不提供 DSH、模型/API key 或完整运行时。加载路径和依赖 workspace 的脚本仍与安装位置有关。真实目标验收前，保持破坏性动作与凭据注入关闭。

</details>
