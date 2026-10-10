---
description: "本地构建、真实 DSH 组合测试的证据与非生产 WebShell 验收边界。"
kind: "reference"
---

# 本地验收记录

## 桌面迁移验收

桌面目标版本为 `0.2.0-rc.2.20261008.1`，基于官方 `0.2.0-rc.2`。Host 与 Client TypeScript 聚合编译和工作区打包通过，桌面主进程及新插件 Host/Client 构建通过。`vitest run --config .runtime/desktop-migration/vitest.config.ts` 验证 guest 通道、打包参数和更新策略，共 44 项通过。Node `--test` 的 Desktop 驱动、强制审批、guest 登录、直接写读与登录回归分别通过；构建后设置页渲染与离线限制 2 项检查通过。主进程采用独立浏览器句柄类型，不把系统 HWND 当作浏览器目标。

Electron 44 隔离测试使用复制的运行时、自有 userData 和仅监听随机回环端口的 xterm 6 模拟 WebShell。应用窗口未显示、目标 webview 隐藏时，页面内文本事件收到中文及标点，单次 Enter、WebSocket 输出、guest 截图和无系统前台窗口条件通过。测试未连接生产服务器。此前直接 Chromium 输入在隐藏页面中为空，已改为 xterm 页面内文本事件；系统剪贴板未使用。

离线无签名应用打包与最终随包运行时检查通过，完整原生权限与插件确认联调、真实 Apollo 与云控制台仍需验收。旧 CLI 插件构建通过；先前全量 `Test.ps1` 为 130 项中 129 项通过、1 项真实 Windows 只读身份检查失败，未把它记为全部通过。正式安装目录及 Desktop profile 未修改。当前范围与配置见[桌面说明](DESKTOP.zh.md)。

桌面插件包 `dsh-sre-webshell-0.2.0-rc.2.20261008.1.tgz` 已在 `.runtime/desktop-migration/artifacts` 生成，包含双语桌面说明和验收记录，不包含真实连接、运行数据或 `.env`。应用打包记录 `2026-10-08T16-17-20.666Z-QcdlCs` 为成功；免安装程序位于桌面源码的 `.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked`。最终随包检查验证终端、文件工具、DOCX/XLSX/PPTX 转 PDF 及技能发现。实际应用 metadata 的版本为 `0.2.0-rc.2.20261008.1`，`dshLocalOffline` 为 true，没有强制更新配置或更新 feed。

操作员已同意微软 SDK 许可证。微软 NuGet SDK 包 `Microsoft.Windows.SDK.CPP` 和 x86 链接库的 `10.0.26100.7705` 已在当前目录 `.runtime/desktop-migration/windows-sdk` 准备完成。显式工作区 SDK 配置通过安装辅助 DLL 及四个原生验收程序的编译，安装进度回归程序运行通过；无效版本和缺失目录在编译前被拒绝。没有修改系统 SDK、正式应用或正式 profile。`desktop/Start-Desktop.ps1 -CheckOnly` 检查本地启动路径，未启动完整 GUI，也未在隔离 Desktop profile 安装插件；真实 Browser、设置保存及审批联调仍需执行。

## 结论

2026-09-18，本地 MVP 构建和自动化验收通过。插件已通过官方 CLI 安装到独立 `sre` profile，桌面控制、破坏性操作和凭证注入默认关闭。本记录不构成生产环境认证，也不代表设计文档中的全部功能已实现。

## 已验证

### 2026-09-30 托管浏览器输入与读取

插件默认改为 `browserMode: managed`，使用 Playwright 所属的持久化 Chromium profile；页面内 xterm `input()` 或唯一辅助输入框负责写入和单次回车，WebSocket/xterm/DOM 负责文本读取，页面截图兜底。插件没有向系统前台窗口发送按键；旧 Windows 原生模式仅作为显式可选配置保留。本机 `sre` profile 已改为托管模式，`browserDebugUrl` 清空；更改须重启 DSH 才生效。

本机 Edge 的隔离测试页验证：目标之外的标签处于前台时，输入仍落在所属终端；普通 xterm 辅助输入框也能收到输入与回车；xterm 缓冲区标记读取、原始读取、后台截图、临时图片清理和目标导航后的拒绝通过。`Build.ps1` 和 `Test.ps1` 通过，114 项测试、0 失败、0 跳过。双语 README 配对检查通过；`pnpm run test:docs` 为 19 项通过、1 项失败，失败仍是原有 `dependency-pins.json:2` Git commit hash 引用规则，未改动依赖固定记录或门禁。Linux 启动脚本仅做静态审查：本机 WSL 不可用，尚未在 Linux 实机运行。真实 Apollo WebShell 的托管模式也尚未验收，未对远端发送测试命令。

### 浏览器文本输出与云终端兼容路径

2026-09-20，插件构建与全量无密钥验收通过。输出采集在命令输入前连接配置的回环 Chromium DevTools 端口，严格匹配一个完整标签页 URL，监听根页面与递归附加 iframe 的 WebSocket 接收帧，并依次尝试 WebSocket 文本、页面中可发现的 xterm 缓冲区和终端 DOM。一次 `terminal_collect` 内按配置探测三次；只有唯一且完整的命令标记记录才作为结果返回，否则自动回退截图，且不重新提交命令。

自动化测试覆盖原始文本、常见 JSON 文本字段、UTF-8 base64 二进制帧、ANSI 清理、跨帧标记、xterm/DOM 后备、有界不完整探测、重复同 URL 标签页拒绝、替换采集连接关闭、直接文本完成时不产生输出截图，以及来源/哈希审计。调试目标 URL、WebSocket URL 和 token 不写入审计；直接输出正文作为普通 DSH 工具结果保留在会话历史。Chrome/Edge 调试端口只允许回环 HTTP origin，README 要求非默认专用浏览器 profile。

当前 Apollo WebShell 的静态前端确认使用文本 WebSocket 并将消息直接交给 xterm；操作员此前提供的 `ls` 标记输出仍是该真实目标的执行证据。阿里云 Workbench 官方资料确认 CLI 依赖 WebSocket 后端，因此纳入通用 CDP 兼容路径；腾讯云 OrcaTerm 作为浏览器终端采用同一通用探测，但其私有帧协议未获得公开认证。HTML5 VNC/RDP 保持视觉截图路径。阿里云、腾讯云真实账号页面、跨域 iframe、重连和厂商二进制封装仍需分别实测，不宣称已经通过平台认证。

### 当前版本 README 与操作员实测

2026-09-19，操作员提供终端输出，确认原生 WebShell 输入的 `ls` 包装命令已执行并返回匹配结束标记及 `rc=0`。此证据确认该环境的只读命令执行，不认证全部云平台、输入法、模型转录或破坏性动作。README 已改为面向仓库读者的双语说明书，公开示例只使用保留示例域名，不包含真实目标 URL、目录列表、连接密码或会话 token。

README 的 `plugin --profile sre add 'link:./sre-webshell'` 已通过官方构建 CLI 在隔离的 `DSH_HOME` 中执行，生成 base 加插件的 bundle 列表；安装说明明确要求保留依赖并加入 Web 应用 bundle。`Build.ps1` 和 `Test.ps1` 通过，73 项测试、0 失败、0 跳过。源码发布不含 DSH 本体、便携运行时、生成文件、连接记录或机器专属配置记录。

发布前 `pnpm run lint` 通过，`pnpm run test:docs` 为 19 项通过、1 项失败，完整 `pnpm run doc-sync` 为 39 项通过、2 项失败。两项既有失败仍是依赖固定版本记录的 commit hash 引用规则与 Windows 网站测试的符号链接 `EPERM`，未关闭检查规则。独立发布仓库中的 63 个暂存文件经隐私/生成文件排除、凭据特征检查、中英文摘要及第三方脚本字节哈希核对，`git diff --cached --check` 通过。

### 视觉流程审计拒绝修复

2026-09-18 的真实运行审计显示：绑定审批 `allowed-once`，`ls` 判为 R0，进入 `attempt` 和截图 `allowed` 后失败，未记录任何 `input-attempt`。视觉截图写入的 `terminal-evidence` 不在审计阶段白名单；后续输入的 `attempts`、`mode` 字段及输入验证、helper 失败、视觉输出、环境探测阶段也未登记。数组替身的测试没有执行审计校验。新增真实审计流程测试在修复前复现 `Audit phase is not allowed`，修复后通过；测试使用模拟桌面，不发送真实鼠标、键盘或远端命令。

审计接受六个视觉流程阶段、零至三次整数尝试计数，以及 `unicode`/`keyboard` 两种模式，仍拒绝未知字段、阶段、模式、越界计数和明文命令。真实写入测试覆盖普通命令、两阶段破坏性审批及环境复核、完整哈希链、拒绝后继续追加，以及新实例回读已记录的视觉元数据。`Build.ps1` 和 `Test.ps1` 通过，73 项测试、0 失败、0 跳过。既有审计文件和配置未删除或重写；实际 WebShell 输入仍待重启后的实测。

本次 `pnpm run lint` 通过；最后增加的基线阶段断言经插件范围 lint 和两个审计/视觉流程测试文件复核，9 项通过。`pnpm run test:docs` 为 19 项通过、1 项失败；`pnpm run doc-sync` 为 39 项通过、2 项失败。失败仍为依赖固定版本文件的 commit hash 引用规则和 Windows 网站测试的符号链接 `EPERM`，没有新增文档检查失败。中英文配对、配置 YAML 快照与变更文件空白检查通过。

### HTML5 终端视觉输入与三次兜底

当前输入路径优先 Windows Unicode 数据包，最多三次；每次返回截图，由主模型通过 `terminal_input_check` 核对实际可编辑命令行。三次均明确为空才允许一次实体按键尝试；完整准确回显后单独发送一次 Enter。普通命令输入和输出读取不再依赖拖选、右键菜单或剪贴板；`terminal_scroll` 保留滚轮。实体输入核对 US 英文布局、关闭可取得的 IME，并处理 Shift/ASCII 标点和 Caps Lock；非 ASCII 不支持实体兜底。目标为 HTML5 SSH/Cloud Shell、服务/Pod 终端和 HTML5 VNC，不宣称阿里云/腾讯云逐平台兼容性已认证。

`Build.ps1` 与 `Test.ps1` 通过，71 项测试、0 失败、0 跳过。新增测试覆盖空闲基线、三次空回显后兜底、部分/重复/全角输入拒绝、IME 候选框拒绝、helper 超时后完整回显不重打、helper 失败后空回显不重试、单次观察 ID、Enter 失败不重发、会话隔离和元数据审计。原生 C# 代码在 PowerShell 5.1 下编译，并验证 x64 `SendInput` 结构为 40 字节；编译测试不操作桌面。分阶段执行器测试确认普通输出与两阶段破坏性审批均不读取/写入剪贴板。真实构建 CLI 的 keyless 持久会话验证新增工具参数、工具说明与禁用结果。

`pnpm run lint` 通过；最后的输入锁定提示变更经插件范围 lint 和 71 项验收复核。`pnpm run test:docs` 初次为 18 项通过、2 项失败，其中 README 到本地配置记录的中英文链接差异已修复。随后完整 `pnpm run doc-sync` 为 39 项通过、2 项失败，中英文配对通过；剩余失败为 `sre-webshell/dependency-pins.json:2` 的原始 commit hash 引用规则，以及 `scripts/project-doc-site.spec.ts` 创建 Windows 文件符号链接时的 `EPERM`。依赖固定版本记录保留，未修改全仓检查规则或绕过符号链接测试。本地配置记录不属于官方普通文档配对范围，使用仓库 Markdown 配对辅助函数核对结构、链接、物理行数和代码，并核对 YAML 与实际 profile patch 完全一致后更新侧车摘要。

单独的内置浏览器测试在当前 xterm.js 页面输入并执行 `ls`，截图确认目录列表与返回提示符。测试期间输入调用超时，但再次观测发现命令已完整输入，因此未重打；回车只发送一次。这证明浏览器输入通道可用，不证明本次 Windows Unicode/实体驱动、输入法处理或完整 DSH 模型循环已在真实目标通过验收。原生输入、软换行核对、云平台、iframe/分屏、VNC、DPI 与多显示器仍需分别实测。历史章节保留当时测试范围，不代表当前普通命令仍采用剪贴板。

### 初始 MVP 验证

- `Build.ps1`：严格 TypeScript 编译通过。
- `Test.ps1`：38 项测试通过，0 失败、0 跳过。
- 命令策略：未知命令、解释器包装、危险选项和 SQL 客户端拒绝；规范化参数使用字面量引用。
- 执行器：双阶段审批、最终确认后远端用户/cwd 复核、窗口变化、过期绑定、审计失败和不确定执行状态均有拒绝测试。
- 采集器：唯一命令标记、多页准确重叠、有界恢复、不完整结果和实际滚动距离恢复测试通过。
- 知识与审计：路径逃逸、受限检索、元数据白名单、串行写入和哈希链篡改检测测试通过。
- Windows：桥接脚本解析、取消与资源生命周期测试通过；真实前台窗口身份读取仅做只读检查。未对用户桌面执行测试性鼠标输入。
- 官方 DSH：测试启动真实构建后的 CLI，加载插件并验证资产/手册返回值与持久会话记录。仅 LLM 使用测试替身。
- 独立安全 guard：真实 DSH Full Access 环境下，即使其他策略尝试放行，通用 Shell 写文件请求仍被拒绝，目标文件未创建。
- 官方 Web profile：真实启动、未认证请求拒绝、带令牌的认证跳转与 Cookie 后页面返回 200。测试退出时关闭自有进程。
- 中英文 README：官方指定文档配对检查通过。

## 尚需真实目标验收

### 2026-09-18 自动聚焦与截图补充

插件构建与 45 项自动化测试通过。新增测试覆盖操作员免审批截图授权、缺少目标拒绝、审计失败拒绝、自动聚焦的绑定身份复核、目标变化与取消，以及 PowerShell 5.1 的 UTF-8 输入和 ASCII bridge 源码约束。

真实 Chrome 检查先选中同一窗口的另一个标签页，再由驱动自动选回配置的完整 WebShell URL，确认窗口身份不变，完成 2560×1539 的窗口范围截图并删除自有原始图片。优化后的单次聚焦与截图检查耗时约 3.8 秒。未执行远端命令，未验证模型图片传递、终端绑定、复制粘贴或 Kubernetes 输出。当前 profile 开启自动聚焦与免审批截图，破坏性操作和凭证注入仍关闭；bundle 默认仍关闭桌面控制和免审批截图。

尚未完成新原生输入路径的非生产 WebShell 验收，因此仍需验证模型截图识别、Unicode/实体按键、`pwd` 执行、长命令回显核对、多页视觉读取、滚轮、DPI 与多显示器。可选凭证菜单的视觉定位、隐藏输入和真实破坏性操作审批也未验收。

DSH 审批策略为 `never` 或审批服务不可用时，插件拒绝需要确认的操作，不会绕过审批。执行器的双阶段审批测试不等于上述策略下已经存在可用的人工审批 UI。

首轮真实验收仅应执行 `pwd` 和有限行无害输出。破坏性操作与凭证注入应继续关闭，直到各自流程经过单独人工确认。

## MVP 范围

### 本地账号、密码、名称与备注

构建与 51 项测试通过。两类连接记录支持自定义 `name` 与网络 `notes`，Web 系统与 SSH 账号均可记录 `username` 和本地明文 `password`。连接列表返回密码是否配置，不返回正文；损坏 JSON 的诊断也不暴露原始文件文本。独立虚构连接 fixture 的真实 CLI 持久会话测试确认 Web/SSH 密码正文均未进入日志。Git 忽略检查与 npm 打包 dry-run 确认实际 `operations/connections.json` 不会默认提交或打包。密码没有加密，插件设置编辑页、自动登录和 SSH 执行尚未实现。

### 可选连接记录与直接绑定

构建与 50 项测试通过。直接 WebShell 绑定无需资产登记或连接记录，并通过执行器测试验证只读节点查询不读取资产清单。真实构建 CLI 的持久工具结果验证 `connection_list`、免登记标志、SSH 执行未支持标志及 `terminal_bind` 的可选资产参数。JSON 解析测试覆盖 WebShell/SSH 元数据、缺失文件、重复 ID、错误端口与明文凭证拒绝。此轮没有执行真实远端命令；SSH 直连执行尚未实现。

`pnpm run lint` 通过。完整 `doc-sync` 为 39 项通过、2 项失败：依赖固定版本文件中的原始 commit hash 不符合文档引用检查；网站测试创建 Windows 文件符号链接时遇到 `EPERM`。README 配对、链接、配置快照与侧车摘要检查通过。官方产物重建期间一次组合测试遇到文件替换失败；重建结束后的最终 `Test.ps1` 为 50 项通过，0 失败、0 跳过。未修改全局规则来隐藏上述失败。

终端 profile 由人工维护；交互式 Pager 需要人工处理；不支持 SQL、SSH 或 WinRM 传输。标定结果会落盘，但重新绑定不自动复用。审计不提供加密或轮转；DSH 历史可能保存工具参数、输出和图片。窗口身份检查不认证远端服务器，进程级锁不能阻止外部输入。

本次验收仅覆盖新增插件，没有执行或宣称整个 DSH 仓库的完整测试、发布检查或生产部署验证。运行方法与开关见 [中文使用说明](README.zh.md)。

## 2026-09-24 凭据、登录、记录与 RAG 状态验收

`Build.ps1` 通过；使用项目自带 Node 22 运行 `Test.ps1`，100 项通过、0 失败、0 跳过。覆盖 DPAPI CurrentUser 往返与目标熵、错误用户和损坏密文拒绝、明文迁移失败时原文件保留、模型可见连接列表不含账号、CDP 登录唯一目标/同源表单/MFA/重定向/一次提交、运维记录先 `uncertain` 后按精确标记和退出码更新，以及真实构建 DSH CLI 的组合测试。知识服务 `uv run pytest --run-db -q` 为 23 项通过、1 条 Starlette/httpx 弃用警告；`uv run ruff check ops_knowledge tests` 通过。

本轮未调用真实 WebShell 登录、远端命令或外部硅基流动 API；登录与记录生命周期采用本地替身测试。`webshell_login` 只支持已打开的精确 URL、回环 CDP、唯一同源 HTML5 表单，不支持 SSO/MFA/验证码或跳转后的页面。插件不自动迁移真实连接文件，不自动启动 RAG 同步；原有明文文件、备份和历史需操作员自行处理。规则脱敏不能保证发现任意秘密，记录入库前仍须人工检查。SSH 执行未实现。

## 2026-10-10 原版 Desktop 插件接入

原版 `0.2.0-rc.2` 使用随包 CLI 安装工作区构建的 Ops 插件；官方插件清单返回 `enabled: true`、`fiberPhase: active`，已鉴权桥接状态返回 HTTP 200、`live: true`、`pending: 0`。浏览器 Client 通过原生 Connection 的精确 Fetch 路由轮询，不占用 API Gateway 的拦截器，不增加 Electron main 自动化 IPC，也不开放 CDP。安装目录的可执行文件与 `app.asar` SHA-256 和安装前一致。原版 profile 配置已备份；DSH2 未修改。连接与运维记录仍引用工作区原路径，未复制凭据或 `.env`。

严格 TypeScript 和 Client bundle 构建通过。20 项聚焦测试通过，覆盖单次领取/开始/完成、取消后的过期结果拒绝、离线 Client、卸载清理、RPC 关联与畸形请求拒绝、页面内 Unicode 输入与单次回车、会话隔离、导航失效、HTML5 登录拒绝和敏感操作确认；1 项构建后 RAG 配置页渲染测试通过。隔离 Electron 44 实测使用已发行 guest 安全配置和构建后的 Host 驱动、Client 适配器，通过十项检查：后台 Unicode、单次回车、WebSocket 文本读取、编辑器焦点保持、无 main 自动化 IPC、截图临时显示和恢复、通用 xterm 输入及导航过期拒绝。

实际远端 WebShell 命令、阿里云/腾讯云控制台、跨域 frame、VNC/RDP、RAG 在线保存与敏感操作 GUI 尚未在原版完成验收。包管理器仍报告原版核心包位于应用运行时而非 profile 的 peer dependency 提示；未通过安装第二套核心包绕过提示。本轮没有执行整个仓库的完整测试或发布检查。

### 发送后审计回归

新增真实审计写入器与 Operator 组合测试在修复前复现 `Audit phase is not allowed`，发送完成后因 `submitted` 阶段未被接纳而中断。审计阶段列表补齐后，23 项聚焦测试通过；组合测试确认一次回车、提交阶段落盘、WebSocket 文本完成标记和退出码采集、绑定不确定状态解除、审计哈希链完整及输出正文不进入审计。未知阶段、明文、损坏哈希链和不确定输入重发仍被拒绝。此轮未向真实 WebShell 发送命令，也未补建历史失败操作的记录。
