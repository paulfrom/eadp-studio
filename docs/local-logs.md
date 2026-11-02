# 本地日志

Studio Host 的操作与协同 HTTP 请求事件保存在 `%APPDATA%\eadp-studio\studio\studio.sqlite` 的 `local_activity` 表；配置 `stateDirectory` 时使用 `<stateDirectory>\studio.sqlite`。每条事件在 `event` 列中保存 JSON，包含 UTC 时间、进程号、开始／结束、操作名、关联 ID、状态及耗时。HTTP 请求保留方法、服务 origin 和 pathname，不保留查询参数；命令中的协同请求通过 `parentId` 关联。

可通过 SQLite 只读连接查询最近事件：

```sql
SELECT event FROM local_activity ORDER BY id DESC LIMIT 100;
SELECT event FROM local_activity
WHERE json_extract(event, '$.area') = 'command'
ORDER BY id DESC LIMIT 100;
```

覆盖工作台／设置通过 `studio.command` 发出的操作，以及协同 transport 的请求（含登录与身份查询）。HTTP 结束事件表示响应头已返回，耗时不包括后续响应正文读取和业务解析。原生会话、模型请求、目录选择器、进度轮询、前端未到达 Host 的失败不在此日志范围内。它不是桌面完整录制或服务端请求日志。

不记录命令参数、请求／响应正文、请求头、密码、令牌或原始错误消息；失败仅保留状态、错误类型及符合格式的错误代码。业务失败以命令返回的错误代码定位。

日志追加与淘汰在同一事务中完成，按事件 JSON 的 UTF-8 字节数合计保留不超过 20 MiB，超出时从最老事件开始删除；这不表示整个数据库物理文件不超过 20 MiB。SQLite 复用释放页。写入失败只向 Host 控制台警告一次，不阻断业务操作。进程被强制终止时可能只有开始事件。旧 `logs/activity.jsonl*` 文件保留为只读历史，不自动导入或继续轮转。

原型检查／预览的步骤诊断保存在所选项目 `.eadp\users\<用户ID>\studio.sqlite` 的 `local_records` 表，记录键为 `prototype-checks/<检查身份哈希>`；其 stdout、stderr 各最多 65,536 字符。业务审计仍保存在协同后端 PostgreSQL 的 `studio_audit` 表。
