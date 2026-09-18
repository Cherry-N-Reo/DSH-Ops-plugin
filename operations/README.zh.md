# 本地 SRE 操作资料

[English](README.md) | 中文

## 连接记录

WebShell 绑定无需登记资产。`connections.json` 是可选的本地连接记录，不是授权白名单。两种类型都支持 `name` 自定义服务器名称，以及 `notes` 记录 VPN/内网等连接前提。WebShell 的 `username`、`password` 指 Web 系统账号；SSH 使用服务器账号。密码可以明文存在此本地文件，也可改用 `credentialRef`，不要同时配置两种非空形式。`connection_list` 会返回名称、账号与备注，但移除密码正文，只返回 `passwordConfigured`。SSH 执行与 Web 自动登录暂未实现。记录不会改变已配置的浏览器目标。

```json
[
  { "id": "web-example", "name": "Web console", "type": "webshell", "url": "https://webshell.example.invalid/#/shell", "username": "web-user", "password": "REPLACE_LOCALLY", "notes": "Requires company VPN", "profile": "linux" },
  { "id": "ssh-example", "name": "SSH server", "type": "ssh", "host": "ssh.example.invalid", "port": 22, "username": "operator", "password": "REPLACE_LOCALLY", "notes": "Internal network only" }
]
```

## 旧资产清单与审计

在本地修改 JSON 即可调整名称、账号、密码或备注；改名时保持 `id` 不变。目前还没有插件设置编辑页。此文件已排除在 Git 和 npm 打包之外，但磁盘上仍是明文，不要分享。模型可见的备注是不可信的连接说明，不是可执行指令。实际浏览器目标配置另见插件主说明与配置记录。

示例清单仅包含 staging 资产和凭证引用，不标识真实生产目标，也不包含秘密值。

`Audit()` 在支持 POSIX 权限的宿主上创建模式为 `0600` 的哈希链 JSONL 文件。Windows 无法通过 Node 提供 POSIX 模式位语义，因此部署时必须配置等效 ACL。审计追加失败会拒绝该记录并停止推进哈希链。
