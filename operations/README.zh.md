# 本地 SRE 操作资料

[English](README.md) | 中文

## 连接记录

WebShell 绑定无需登记资产。`connections.json` 是可选的本地连接记录，不是授权白名单。两种类型都支持 `name` 自定义服务器名称，以及 `notes` 记录 VPN/内网等连接前提。Windows DPAPI CurrentUser 把账号和密码一起加密为 `protectedAuth`；`connection_list` 不返回账号、密码或密文。旧的明文 `username`/`password` 字段只供显式迁移读取，不能用于自动登录。SSH 执行尚未实现。书签不会改变已配置的浏览器目标。

```json
[
  { "id": "web-example", "name": "Web console", "type": "webshell", "url": "https://webshell.example.invalid/#/shell", "notes": "Requires company VPN", "profile": "linux" },
  { "id": "ssh-example", "name": "SSH server", "type": "ssh", "host": "ssh.example.invalid", "port": 22, "credentialRef": "SSH_ACCOUNT", "notes": "Internal network only" }
]
```

在 `sre-webshell` 目录的交互式 PowerShell 中，创建、编辑受保护的本地凭据或迁移已有明文文件：

```powershell
& '../.runtime/node-v22.23.2-win-x64/node.exe' --import ../node_modules/tsx/dist/loader.mjs scripts/credential-manager.ts migrate
& '../.runtime/node-v22.23.2-win-x64/node.exe' --import ../node_modules/tsx/dist/loader.mjs scripts/credential-manager.ts add-webshell
& '../.runtime/node-v22.23.2-win-x64/node.exe' --import ../node_modules/tsx/dist/loader.mjs scripts/credential-manager.ts edit
```

管理工具会校验并验证整份候选文件，再在同目录原子替换；它不删除可能仍含明文的旧备份和历史。解密须使用同一个 Windows 用户。应给连接文件、浏览器调试端口和备份设置合适的 ACL。`webshell_login` 要求精确配置的 URL 和回环 CDP 端点，只处理已打开标签页中明确的同源 HTML5 表单，不处理 SSO/MFA/验证码。`credentialRef` 仍是外部引用，不是 DPAPI 密文。

## 旧资产清单与审计

用管理工具编辑受保护连接字段；不要手动修改密文，也不要在未重新加密时更换受保护记录的目标。改名时保持 `id` 不变。目前还没有插件设置编辑页。此文件已排除在 Git 和 npm 打包之外，但迁移前可能仍含旧明文，不要分享。模型可见的备注是不可信的连接说明，不是可执行指令。实际浏览器目标配置另见插件主说明与配置记录。

示例清单仅包含 staging 资产和凭证引用，不标识真实生产目标，也不包含秘密值。

`Audit()` 在支持 POSIX 权限的宿主上创建模式为 `0600` 的哈希链 JSONL 文件。Windows 无法通过 Node 提供 POSIX 模式位语义，因此部署时必须配置等效 ACL。审计追加失败会拒绝该记录并停止推进哈希链。
