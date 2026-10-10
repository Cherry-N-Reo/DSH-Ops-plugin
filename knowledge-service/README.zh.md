---
description: "配置独立的 DSH Ops Markdown 知识 API、混合检索和增量同步。"
---

# DSH Ops Knowledge

[English](README.md) | 中文

## 总结

通过独立的鉴权 API 检索 Markdown 手册和操作记录。检索结合中文及技术词 BM25+、pgvector 余弦搜索、倒数排名融合和模型重排。DSH 插件可调用该服务，同时保留本地 Markdown 回退。不依赖或修改其他项目的数据库。

## 目录

- [配置与启动](#setup)
- [同步文档](#sync)
- [连接 DSH](#dsh)
- [API 与行为](#api)
- [限制与验证](#limits)

<a id="setup"></a>
## 配置与启动

需要 Python 3.11+、uv、运行 Linux 容器的 Docker Desktop，以及兼容的嵌入模型和重排模型 API 访问权限。在本目录执行以下命令，先检查并填写示例配置；不要覆盖已有的 .env。

```powershell
Copy-Item .env.example .env
# Edit .env before continuing.
./Start-Knowledge.ps1
```

填写 POSTGRES_PASSWORD，并在 RAG_DATABASE_URL 中设置一致的密码；必要时对连接 URL 中的密码进行 URL 编码。设置新的 RAG_API_TOKEN、RAG_SILICONFLOW_API_KEY 以及实际模型名称和维度。示例模型名称可以修改，不代表已确认你的账号拥有访问权限。不要提交 .env。

`RAG_API_TOKEN` 用于 DSH 访问知识服务；模型 API Key 用于调用嵌入/重排模型，两者是不同凭据。当前适配器共用一个 `RAG_MODEL_BASE_URL` 和模型 API Key，沿用已有变量名 `RAG_SILICONFLOW_API_KEY`。模型服务须支持适配器的 `/embeddings`、`/rerank` 请求与响应字段；修改 URL 不代表兼容所有提供商。尚未实现两个模型分别配置地址或 Key。

启动脚本安装锁定依赖、验证配置，优先使用 docker-compose（否则使用 docker compose），仅启动本 Compose 项目的 PostgreSQL，并在前台运行 127.0.0.1:8765 上的 API。PostgreSQL 绑定 127.0.0.1:55432，数据位于本目录的 .data/postgres。关闭 API 不会停止 PostgreSQL。数据库与 Markdown 源文件需要分别备份。

使用 Start-Knowledge.ps1 -Check 可以只验证配置而不启动服务。正式启动和真实模型 API 访问需要先填写 .env；自动集成测试使用独立临时数据库和模拟模型 HTTP 响应。

<a id="sync"></a>
## 同步文档

手册放在 ../operations/runbooks/，每次操作的独立 Markdown 文件放在 ../operations/records/。两个目录都必须存在。同步命令只读取其中的 .md 文件，不读取连接资产表。

```powershell
uv run python -m ops_knowledge.sync ../operations
# Optional foreground polling every five minutes:
uv run python -m ops_knowledge.sync ../operations --interval 300
```

命令从环境变量或本目录的 .env 读取 RAG_API_TOKEN，将源文件哈希、远端哈希、处理流程 ID 和成功同步时间保存在 ../operations/.rag-sync.json。未变化的文件不调用嵌入模型。失败文件保持待同步状态；单次同步失败时返回非零退出码。服务级连接故障会结束轮询进程，恢复后需重新启动。

重命名会生成新文档 ID。只有显式传入 --prune 才会删除远端文档；删除范围仅限此清单以前跟踪的文件，任何文档失败都会阻止删除。源目录缺失会中止同步。不要通过删除清单解决报错，因为它定义了远端删除范围。进程崩溃可能留下 .lock 文件；确认没有同步进程运行后才能删除该锁。

同步把手册标为 `unverified`。对于版本化操作记录，元数据头中的 `success`、`failure`、`uncertain` 分别映射为 `verified`、`failed`、`unverified`；记录元数据损坏时该文件同步失败并阻止清理。历史成功不代表批准新命令。插件在回车后创建临时记录，再根据已核实的终端输出更新；不会把记录自动提升为已审核手册。向嵌入和重排 API 发送前，应人工检查每份 Markdown 是否含敏感内容。

<a id="dsh"></a>
## 连接 DSH

在 DSH「插件」→ `dsh-sre-webshell` → `sre-webshell` →「配置」中设置 RAG API 地址和超时，并把此服务 `.env` 中的 `RAG_API_TOKEN` 值存入独立的令牌输入框。DSH 凭据引用名默认为 `DSH_RAG_API_TOKEN`；启动脚本不再自动读取此服务的 `.env`。已有 YAML 配置仍作为初始值生效，例如：

```yaml
- id: sre-webshell
  config:
    ragUrl: http://127.0.0.1:8765
    ragTokenEnv: DSH_RAG_API_TOKEN
    ragTimeoutMs: 65000
```

修改插件源码后，用 ../Build.ps1 重新构建并重启 DSH；在页面保存 RAG 连接配置后，下次检索即可生效。ragUrl 为空时保留纯本地检索。runbook_search 返回本地和远端片段，按路径去重时本地优先。本地搜索是有界、不区分大小写的子串匹配，不是混合检索。API 故障会返回本地结果并明确提示，不会授权绕过命令策略。

远程连接必须使用 HTTPS；仅回环地址允许明文 HTTP。请求不跟随重定向。服务的每个端点都需要 bearer token。所有检索结果始终是非可信数据，并通过现有工具结果日志持久化。

<a id="api"></a>
## API 与行为

| 方法/路径 | 行为 |
|---|---|
| GET /health | 数据库连通性、文档数量及处理流程 ID；不探测模型健康 |
| GET /v1/documents | 文档 ID、内容哈希和处理流程 ID |
| POST /v1/documents | 按 id、path、title、text、kind、status 更新；嵌入全部完成后原子替换 |
| DELETE /v1/documents/{id} | 幂等删除单篇文档及其分块 |
| POST /v1/search | query、可选 limit（1–20）、可选 kind（manual/record） |

服务返回片段及来源路径、章节、行号、文档哈希、状态和排序方式。模型配置和分块参数共同生成处理流程指纹。修改这些配置后，不兼容的旧文档会被排除，直到重新同步。嵌入更新失败时保留原文档。

搜索嵌入失败时回退到 BM25+；重排失败时回退到融合排名，两者均明确返回降级提示。不使用图数据库或独立关键词搜索集群。PostgreSQL 执行精确向量搜索；每次查询从筛选后的语料重新建立 BM25+，受 RAG_MAX_CORPUS_CHUNKS 限制。

常见密码/token 赋值、bearer 字符串、私钥块和 URL 凭据会在入库及调用模型前脱敏。这是尽力识别，不保证识别任意秘密。同步前请审查源文档：脱敏后的文本会发送给配置的模型服务，本地原始 Markdown 不会被重写或清洗。

<a id="limits"></a>
## 限制与验证

此版本面向小规模单用户语料，不是多租户生产平台。没有图谱检索、PDF/Word 解析、管理界面、自动操作总结或审核手册发布流程。按字符窗口分块可能截断代码块；使用检索命令前仍需核对原手册并进行正常操作检查。默认每块 1600 字符、重叠 200 字符，每路召回 30 个候选，重排最多 40 个候选。

```powershell
uv sync --frozen
uv run pytest --run-db -q
uv run ruff check ops_knowledge tests
```

集成测试创建唯一命名的临时 pgvector 容器和数据库，使用系统分配的回环端口，完成后清理自身资源。测试覆盖鉴权、真实数据库读写、更新失败保留、删除、混合检索、降级、处理流程变更和同步清单。模型 API 响应为模拟数据；真实模型效果和访问权限仍需部署时验证。

协议参考：[重排接口协议示例](https://docs.siliconflow.cn/docs/api/rerank-post)、[pgvector](https://github.com/pgvector/pgvector)、[rank-bm25](https://github.com/dorianbrown/rank_bm25)。

### 开发备注

没有其他部署假设。
