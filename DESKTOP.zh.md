---
description: "原版桌面的 Client 浏览器桥接、配置与验收范围。"
kind: "reference"
---

# DSH Ops 桌面版

[English](DESKTOP.md) | 中文

## 概述

桌面插件面向官方 `0.2.0-rc.2`，不重编译应用。配置 `browserMode: desktop` 与 `desktopTransport: client`，Host 工具通过已鉴权的 Connection RPC 连接 Client，由 Client 操作保活的 Browser webview。重编译的 DSH2 应用已放弃，不再作为支持的安装方式或传输通道。

## 移植清单

| 部分 | 桌面实现 | 验收范围 |
|---|---|---|
| WebShell 传输 | 按归一化 URL 选择已打开的 Browser 标签；终端 API 或页面内 xterm 文本事件和回车，不改变系统前台焦点。 | 原版 Desktop 加载插件并报告 Client 在线；隔离 Electron 44 / xterm 6 输入读取实测通过。真实 WebShell 命令尚未验收。 |
| 输出读取 | 给可访问的 Vue WebSocket 挂页面内监听器，读取可访问 frame 的 xterm/DOM；截图兜底临时显示目标标签。 | Client 模式不能检查跨域 frame 或任意不可访问的 WebSocket；真实云控制台须另行验收。 |
| 绑定 | 常规 run/write/read/scroll 自动绑定唯一配置标签，结果展示标题和 URL。 | 导航使句柄失效；重复目标与并发会话占用会拒绝。 |
| 权限 | 沿用 DSH 原生权限；敏感操作独立提问，必须明确选择“允许本次”，不受访问 preset 自动放行。 | 桌面模式无全局工具白名单；取消或没有答复服务时阻止敏感执行。 |
| 连接记录 | 应用安装目录外的操作员 JSON；现有 Windows DPAPI 凭据仍绑定 Windows 用户。 | 不自动复制凭据、会话或迁移明文。 |
| 登录 | Client 桥接复用窄范围 HTML5 表单适配器；验证表单并明确确认后才解密凭据。 | 未知表单、跳转及 MFA/SSO/验证码需人工处理，不自动重试提交。 |
| RAG 设置 | Config 派生的 volatile RAG 字段和带版本校验的插件表单；只填凭据引用，不填明文 token。 | Host/Client 构建和构建后页面渲染检查通过；在线保存与重载仍需联调。 |
| 知识闭环 | 独立 pgvector/BM25/rerank API 与 Markdown 运维记录，不嵌入 Desktop。 | RAG 部署、同步调度及检索质量须单独验收。 |
| SSH | 保留连接元数据。 | 未实现 SSH 命令传输。 |

## 浏览器归属

先在 Desktop 的 Browser 中打开目标 WebShell 并登录。插件不接管外部浏览器窗口。URL 比较会排序普通查询和 hash 路由参数，但保留来源、路径及参数值。目标须唯一，只能由一个插件会话占用。关闭标签、导航离开或 Client 替换使绑定失效。释放自动化不关闭用户标签。文本操作不改变 Sidebar 选择；截图兜底选中目标页后恢复原标签和输入焦点，不切换系统窗口。

`terminal_run` 输入一条命令、发送一次回车，等待 `directReadDelayMs`（默认十秒）后读取。`terminal_write` 发送一次且不等待，可以连续调用；`terminal_read` 只读取，不输入、不回车。已领取的 RPC 任务和不确定输入绝不自动重发。不收集 WebSocket URL、请求头和 token；终端输出可能包含敏感内容，会进入所属工具结果。

输入适配器确认回车后，审计记录 `submitted`；这不表示远端已完成。完整标记与退出码确认采集结果。审计或采集失败均不允许自动重发。安装新插件不会补完此前失败的工具调用，也不会补建其缺失的运维记录。

Browser 在隐藏时保活，但存储 partition 只存在于当前应用进程，不跨退出保存，不能期待永久保留登录 cookie。远程页面仍禁用 Node 和 preload，也不开放调试监听端口。

通用 xterm 输入使用页面内携带 Unicode 文本的 `ClipboardEvent`，随后发送一次页面内 Enter 事件；不读取或修改系统剪贴板。隐藏页面可能忽略 Chromium `Input.insertText`，所以 Desktop 驱动不把它作为通用终端写入路径。未知终端事件处理器和 HTML5 VNC/RDP 仍需独立适配；桌面模式不启用无人值守的系统键盘兜底。

## 配置与构建

旧 CLI 包保留在插件根目录。桌面变体的 manifest、补丁、Client 页面和隔离构建脚本位于 `desktop/`。桌面补丁只插入 `sre-webshell`，不修改默认 skill 根目录，不安装全局排他工具策略。默认禁用，目标 URL 留空。

在 Desktop profile 补丁中配置 `enabled`、`targetUrl`、`operationsDir` 和 `runtimeDir`。复用本地数据时显式填写已有运维资料及连接路径，不把加密凭据搬到其他 Windows 账号。插件 RAG 页面修改 `ragUrl`、`ragTokenEnv`、`ragTimeoutMs`；RAG API token 存在对应名称的 DSH 原生凭据中。知识服务的嵌入/重排模型 API Key 仍留在私有 `.env`，不放进插件包。

插件隔离构建脚本为 `desktop/Build.ps1`，只暂存源码、包元数据与说明，不复制连接、运行数据或 `.env`。原版接入只构建插件。完全退出 Desktop 后，使用随包的 `dsh plugin --profile desktop add <package.tgz>` 安装，再重开应用。安装目录的可执行文件与 `app.asar` 保持不变。默认 bundle 禁用，需在 profile 补丁启用并填写精确目标 URL。

## 原版应用验收

官方 `0.2.0-rc.2` 加载插件 `0.2.0-rc.2.20261010.13`，通过 `/api/ops-browser/` 下已鉴权的精确 Fetch 路由通信；桥接状态返回 `live: true`。可执行文件及 `app.asar` 的 SHA-256 与安装前基线一致。这只验证插件启用与 Client 轮询，不代表修复后的远端 WebShell 命令、在线 RAG 保存或敏感操作界面已验收。

在原版应用的 Browser 打开 WebShell，手动登录，再要求通过 `terminal_run` 执行一次只读 `ls`，无需单独 observe/bind。连接记录和运维文档留在配置指向的工作区路径。破坏性操作与凭据注入保持关闭，直到单独验收。适配器依赖已发行 Sidebar 的 webview 标记；应用升级后需要检查兼容性。

## 验收范围

发送回归测试使用真实哈希链审计器和操作员文本路径：一次回车、接受 `submitted` 记录、完整 WebSocket 标记和退出码零。23 项针对性测试通过，插件 Host/Client 构建通过。原版应用已验证安装和 Client 在线心跳；修复后的远端命令执行仍需人工验收。验收日志中的历史打包证据不是安装指南。

单测证据见 [ACCEPTANCE.md](ACCEPTANCE.md)。发行前还要检查 Desktop Host 编译、插件 Client 编译、打包后 Browser 输入/读取/截图、原生权限、敏感操作强制确认、导航失效及监听器清理。隔离测试页通过不代表阿里云、腾讯云或生产 WebShell 已验收。
