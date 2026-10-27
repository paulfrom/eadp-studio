-- 场景与需求协同：后台数据库物理模型
-- PostgreSQL 新库一次执行；业务材料与完整业务清单以 Git 固定版本为权威。
-- 本模型整体替代旧 schema（旧 jsonb 薄壳设计废弃，不留兼容层与迁移路径），按新库一次执行；PostgreSQL 15+。
--
-- 字段权威原则：
--   参与唯一性、约束、筛选、排序、投影的字段一律为关系列（编号、状态、占用、时间、人员）；
--   质量项、待澄清项、正式依据与关联文件清单随 Git 固定材料版本保存并校验，后台不保存业务快照副本。
--   草稿正文、AI 会话、建议批次、资料读取记录均在桌面 Host 本地，不进入本库。
--
-- 审计字段约定（统一基类字段）：
--   可变业务表携带完整八字段：creator_id / creator_account / creator_name / created_date /
--   last_editor_id / last_editor_account / last_editor_name / last_edited_date；
--   不可变与仅追加的记录表携带创建四字段（creator_* / created_date）。
--   *_id 关联 studio_users(id)（本系统用户身份为 bigint，替代基类中的 36 位字符串）；
--   account/name 为冗余快照，用户改名不影响历史展示。创建时 last_editor_* 与 creator_* 相同；
--   实体的 last_edited_date 由触发器在每次更新时维护，last_editor_* 由应用写入。
--   studio_users / studio_sessions / studio_project_counters 为基础设施表，不带审计字段；
--   需求固定来源随确认创建，审计以确认行为准；冲突摘要与涉及材料随对比接受，审计继承父对比。
--   系统预置版本不填写业务确认人；真实初始化发起人保存在初始化接受记录中。
--
-- 状态字段一律使用 PostgreSQL 枚举类型，不用自由文本。
--
-- 注释约定：每个 COMMENT 只写不超过 10 个字的标签，供数据库内省与目录展示；
--   字段与表的完整说明写在紧邻的 -- 注释里，COMMENT 不承载长句。
--
-- 模板：文件为用户工程 .template/<模板ID>.md，由桌面客户端写入替换并随 Git 提交共享；
--   后台不保存模板内容、清单与默认项，不建模板注册表；材料绑定记录为实体上的固定引用。
--
-- 灾难恢复：更换电脑后，场景/需求正文、模板与正式依据文件经 Git 远程仓库恢复，
--   编号、确认、占用、关联与目录投影经后台数据恢复；仅桌面本地过程数据
--   （AI 会话、建议批次、资料读取记录、本地保存队列）不随恢复，按设计可丢弃。
--
-- 编号分配在业务事务之前独立提交，行锁保证项目内原子递增；失败允许空号且原操作保留原编号：
--   INSERT INTO studio_project_counters(project_id,kind) VALUES ($1,$2) ON CONFLICT (project_id,kind) DO NOTHING;
--   UPDATE studio_project_counters SET next_sequence = next_sequence + 1
--     WHERE project_id = $1 AND kind = $2 RETURNING next_sequence - 1 AS sequence;
--   -- 先查 studio_entity_numbers：同一 operation_key 命中即返回原编号，不重新分配。
--   INSERT INTO studio_entity_numbers(project_id, kind, sequence, code, operation_key) VALUES (...);
--
-- 固定版本接受事务（integration complete，单事务提交，约束触发器 INITIALLY DEFERRED 在提交时校验）：
--   1. 条件更新项目认可头 recognized_head = candidate_sha；
--   2. 核验 Git 固定材料版本中的质量项、待澄清项、依据和关联文件，写入 studio_confirmations
--      （标题、摘要、固定引用、确认方式、适用性及不适用原因），不复制材料正文与清单；
--   3. 需求确认写入 studio_requirement_sources（≥1 个同项目已确认场景版本，触发器强制）；
--   4. 更新实体 current_confirmation_id / material_version / confirmation_status，结束当前材料占用；
--   5. studio_integrations 置 accepted；任一失败整体回滚，结果未知时按 studio_operations 幂等键核对。

-- ============================================================
-- 枚举类型：全部状态字段的唯一权威定义
-- ============================================================

CREATE TYPE studio_confirmation_stage AS ENUM ('material');
CREATE TYPE studio_acceptance_kind AS ENUM ('user-confirmed','system-provisioned');
CREATE TYPE studio_adoption_scope AS ENUM ('material-package');
CREATE TYPE studio_adoption_status AS ENUM ('accepted','succeeded');

CREATE TYPE studio_entity_kind AS ENUM ('scenario','requirement','baseline','handoff');
COMMENT ON TYPE studio_entity_kind IS '资产种类';

CREATE TYPE studio_confirmation_status AS ENUM ('draft','confirmed');
COMMENT ON TYPE studio_confirmation_status IS '确认状态';

CREATE TYPE studio_task_status AS ENUM ('idle','active','aborted','completed');
COMMENT ON TYPE studio_task_status IS '任务状态';

-- 材料整理与原型生产分别占用当前资产。
CREATE TYPE studio_occupation_purpose AS ENUM ('design');
COMMENT ON TYPE studio_occupation_purpose IS '占用用途';

CREATE TYPE studio_occupation_finish AS ENUM ('aborted','completed');
COMMENT ON TYPE studio_occupation_finish IS '占用结束方式';

-- 模板使用独立项目受控配置发布，不领取材料占用或确认材料
CREATE TYPE studio_integration_scope AS ENUM ('material','template');
COMMENT ON TYPE studio_integration_scope IS '集成范围';

CREATE TYPE studio_integration_status AS ENUM ('prepared','accepted','aborted');
COMMENT ON TYPE studio_integration_status IS '集成状态';

-- normal 普通确认（对应用户阅读版本）；repair 授权修复确认（须关联修复任务）
CREATE TYPE studio_confirmation_method AS ENUM ('normal','repair');
COMMENT ON TYPE studio_confirmation_method IS '确认方式';

-- paused 表示缺业务答案暂停、等待显式续接；terminated 不可自动恢复
CREATE TYPE studio_repair_status AS ENUM ('active','paused','completed','terminated');
COMMENT ON TYPE studio_repair_status IS '修复状态';

CREATE TYPE studio_repair_event_type AS ENUM ('round','pause','resume','terminate','complete');
COMMENT ON TYPE studio_repair_event_type IS '修复事件类型';

CREATE TYPE studio_applicability AS ENUM ('applicable','not-applicable');
COMMENT ON TYPE studio_applicability IS '固定版本适用性';

CREATE TYPE studio_project_state AS ENUM ('reserved','creating','created','assigned','ready');
COMMENT ON TYPE studio_project_state IS '项目生命周期';

CREATE TYPE studio_comparison_trigger AS ENUM ('manual','confirmation');
COMMENT ON TYPE studio_comparison_trigger IS '触发途径';

CREATE TYPE studio_comparison_result AS ENUM ('completed','failed','cancelled');
COMMENT ON TYPE studio_comparison_result IS '对比结果';

CREATE TYPE studio_comparison_coverage AS ENUM ('complete','partial');
COMMENT ON TYPE studio_comparison_coverage IS '覆盖范围';

CREATE TYPE studio_comparison_failure AS ENUM ('model-failed','timeout','permission-denied','read-failed','context-limit','relationship-unavailable','submission-failed','cancelled','internal-error');
COMMENT ON TYPE studio_comparison_failure IS '失败码';

CREATE TYPE studio_status_trigger AS ENUM ('occupation-start','save','pre-confirmation');
COMMENT ON TYPE studio_status_trigger IS '状态记录动作';

-- formal 沿正式关系发现，potential 为项目内发现的潜在关联
CREATE TYPE studio_conflict_relation AS ENUM ('formal','potential');
COMMENT ON TYPE studio_conflict_relation IS '关系类型';

-- 一致性控制记录使用有限长度的客户端标识。
CREATE DOMAIN studio_control_id AS varchar(100) CHECK (length(VALUE)>0);

-- ============================================================
-- 身份与会话
-- ============================================================

-- 后台用户：单用户部署，id 固定为 1；GitLab 身份与用户名成对出现，用于项目权限校验
CREATE TABLE studio_users (
  id bigint PRIMARY KEY CHECK (id = 1),
  username text NOT NULL UNIQUE,
  name text NOT NULL,
  email text NOT NULL,
  admin boolean NOT NULL,
  password_salt text NOT NULL CHECK (password_salt ~ '^[a-f0-9]{32}$'),
  password_hash text NOT NULL CHECK (password_hash ~ '^[a-f0-9]{128}$'),
  gitlab_user_id bigint UNIQUE CHECK (gitlab_user_id > 0),  -- 绑定的GitLab用户ID
  gitlab_username text,  -- 绑定的GitLab用户名
  gitlab_email text,  -- 绑定的GitLab邮箱
  CHECK ((gitlab_user_id IS NULL AND gitlab_username IS NULL) OR (gitlab_user_id IS NOT NULL AND gitlab_username IS NOT NULL))
);
COMMENT ON TABLE studio_users IS '后台用户';
COMMENT ON COLUMN studio_users.id IS '系统用户ID';
COMMENT ON COLUMN studio_users.username IS '登录名';
COMMENT ON COLUMN studio_users.name IS '用户姓名';
COMMENT ON COLUMN studio_users.email IS '用户邮箱';
COMMENT ON COLUMN studio_users.admin IS '是否为后台管理员';
COMMENT ON COLUMN studio_users.password_salt IS '口令随机盐';
COMMENT ON COLUMN studio_users.password_hash IS '口令散列';
COMMENT ON COLUMN studio_users.gitlab_user_id IS 'GitLab用户ID';
COMMENT ON COLUMN studio_users.gitlab_username IS 'GitLab用户名';
COMMENT ON COLUMN studio_users.gitlab_email IS 'GitLab邮箱';


-- 登录会话：仅存令牌 SHA-256，不存明文；过期时间索引供到期清理与快速判活
CREATE TABLE studio_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),  -- 会话令牌的SHA-256散列，不保存明文令牌
  user_id bigint NOT NULL REFERENCES studio_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE studio_sessions IS '登录会话';
COMMENT ON COLUMN studio_sessions.token_hash IS '令牌散列';
COMMENT ON COLUMN studio_sessions.user_id IS '登录用户ID';
COMMENT ON COLUMN studio_sessions.expires_at IS '会话到期时间';
COMMENT ON COLUMN studio_sessions.created_at IS '会话创建时间';

CREATE INDEX studio_sessions_expiry ON studio_sessions(expires_at);

-- ============================================================
-- 项目
-- ============================================================

-- 项目从幂等预留开始保存，同一 (creator_id,key) 重试返回同一项目；创建失败从 state 恢复核对。
-- reserved 预留 → creating 建仓中 → created 已核验远端仓库 → assigned 已分配创建者 → ready 初始化核验完成。
-- 创建请求指纹永久对应原请求，项目改名不重算指纹；path、namespace 与 marker 保留用于建仓结果未知时核对。
-- ready 前禁止业务操作；绑定后命名空间或仓库地址不一致即拒绝操作；revision 为项目级并发基准。
CREATE TABLE studio_projects (
  id text PRIMARY KEY,
  key text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),  -- 不可变的原创建请求指纹
  namespace_id bigint NOT NULL,  -- GitLab命名空间ID
  namespace_path text NOT NULL,  -- GitLab命名空间路径
  path text NOT NULL,  -- GitLab项目仓库路径名
  name text NOT NULL,
  marker text NOT NULL UNIQUE,
  state studio_project_state NOT NULL DEFAULT 'reserved',
  gitlab_project_id bigint UNIQUE CHECK (gitlab_project_id > 0),  -- 已绑定的GitLab项目ID
  repository_url text,  -- 已绑定的Git仓库地址
  stable_branch text NOT NULL DEFAULT 'main',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  recognized_head text CHECK (recognized_head ~ '^[a-f0-9]{40}$'),  -- 后台已认可的稳定分支提交
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),  -- 项目最后修改人用户ID
  last_editor_account varchar(50) NOT NULL,  -- 项目最后修改人账号快照
  last_editor_name varchar(50) NOT NULL,  -- 项目最后修改人姓名快照
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  deployment_baseline_id text,  -- 当前部署对应的基线ID
  deployment_url text,
  deployment_artifact_sha256 text CHECK (deployment_artifact_sha256 ~ '^[a-f0-9]{64}$'),  -- 当前部署产物的SHA-256
  deployed_at timestamptz,
  UNIQUE (creator_id, key),
  UNIQUE (namespace_id, path),
  CHECK (
    (state IN ('reserved','creating') AND gitlab_project_id IS NULL AND repository_url IS NULL) OR
    (state IN ('created','assigned','ready') AND gitlab_project_id IS NOT NULL AND repository_url IS NOT NULL AND btrim(repository_url) <> '')
  ),
  CHECK ((state = 'ready' AND recognized_head IS NOT NULL) OR (state <> 'ready' AND recognized_head IS NULL))
);
COMMENT ON TABLE studio_projects IS '项目控制事实';
COMMENT ON COLUMN studio_projects.id IS '项目技术ID';
COMMENT ON COLUMN studio_projects.key IS '项目创建幂等键';
COMMENT ON COLUMN studio_projects.request_hash IS '请求指纹';
COMMENT ON COLUMN studio_projects.namespace_id IS '命名空间ID';
COMMENT ON COLUMN studio_projects.namespace_path IS '命名空间路径';
COMMENT ON COLUMN studio_projects.path IS '仓库路径名';
COMMENT ON COLUMN studio_projects.name IS '项目显示名称';
COMMENT ON COLUMN studio_projects.marker IS '建仓归属核对标记';
COMMENT ON COLUMN studio_projects.state IS '项目创建与就绪状态';
COMMENT ON COLUMN studio_projects.gitlab_project_id IS 'GitLab项目ID';
COMMENT ON COLUMN studio_projects.repository_url IS '仓库地址';
COMMENT ON COLUMN studio_projects.stable_branch IS '稳定集成分支名';
COMMENT ON COLUMN studio_projects.revision IS '项目级并发修订号';
COMMENT ON COLUMN studio_projects.recognized_head IS '认可分支头';
COMMENT ON COLUMN studio_projects.creator_id IS '项目创建人用户ID';
COMMENT ON COLUMN studio_projects.creator_account IS '项目创建人账号快照';
COMMENT ON COLUMN studio_projects.creator_name IS '项目创建人姓名快照';
COMMENT ON COLUMN studio_projects.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_projects.last_editor_id IS '最后修改人ID';
COMMENT ON COLUMN studio_projects.last_editor_account IS '最后修改人账号';
COMMENT ON COLUMN studio_projects.last_editor_name IS '最后修改人姓名';
COMMENT ON COLUMN studio_projects.last_edited_date IS '记录最后修改时间';
COMMENT ON COLUMN studio_projects.deployment_baseline_id IS '部署基线ID';
COMMENT ON COLUMN studio_projects.deployment_url IS '当前部署访问地址';
COMMENT ON COLUMN studio_projects.deployment_artifact_sha256 IS '部署产物散列';
COMMENT ON COLUMN studio_projects.deployed_at IS '当前部署完成时间';


-- 项目初始化核验接受事实与系统预置版本共同提交，响应未知时按原操作查询。
-- 真实项目初始化核验后的接受事实，发起人不等于材料业务确认人
CREATE TABLE studio_project_initializations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  project_id text NOT NULL UNIQUE REFERENCES studio_projects(id),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 100),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),  -- 已核验的实际初始化提交
  verified_at timestamptz NOT NULL DEFAULT now(),  -- 初始化固定内容核验时间
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),  -- 初始化接受事实记录时间
  UNIQUE (project_id,id),
  UNIQUE (project_id,operation_key)
);
COMMENT ON TABLE studio_project_initializations IS '初始化接受事实';
COMMENT ON COLUMN studio_project_initializations.id IS '初始化接受操作ID';
COMMENT ON COLUMN studio_project_initializations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_project_initializations.operation_key IS '初始化接受幂等键';
COMMENT ON COLUMN studio_project_initializations.request_hash IS '原初始化接受请求指纹';
COMMENT ON COLUMN studio_project_initializations.commit_sha IS '核验提交';
COMMENT ON COLUMN studio_project_initializations.verified_at IS '核验时间';
COMMENT ON COLUMN studio_project_initializations.creator_id IS '初始化发起人用户ID';
COMMENT ON COLUMN studio_project_initializations.creator_account IS '初始化发起人账号快照';
COMMENT ON COLUMN studio_project_initializations.creator_name IS '初始化发起人姓名快照';
COMMENT ON COLUMN studio_project_initializations.created_date IS '接受记录时间';


-- ============================================================
-- 集成（准备候选 → 条件更新远端头 → 完成接受）
-- ============================================================

-- 每项目至多一条 prepared（部分唯一索引）；模板独立构造受控候选提交，
-- allowed_paths 可声明 .template/ 与 project.assets.json，完整 diff 不得越界；
-- request 仅保存结果未知时核对所需的控制协议字段（幂等键、修订号、固定引用、确认方式、
-- 适用性与来源版本等）；不得携带正文、metadata、质量项、待澄清项、evidence 或 files 清单。
CREATE TABLE studio_integrations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  scope studio_integration_scope NOT NULL,  -- 材料、原型或模板集成范围
  entity_id text,  -- 本次集成的目标材料ID，模板集成为空
  occupation_id text,  -- 目标材料的有效占用ID，模板集成为空
  expected_project_revision integer,  -- 模板发布预期的项目修订号
  status studio_integration_status NOT NULL,
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  expected_head text NOT NULL CHECK (expected_head ~ '^[a-f0-9]{40}$'),  -- 条件更新稳定分支时预期的原分支头
  candidate_sha text NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
  allowed_paths text[] NOT NULL,  -- 本次候选允许修改的项目相对路径集合
  request jsonb NOT NULL,  -- 结果核对所需控制协议，不保存业务材料或清单
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),  -- 集成操作最后执行人用户ID
  last_editor_account varchar(50) NOT NULL,  -- 集成操作最后执行人账号快照
  last_editor_name varchar(50) NOT NULL,  -- 集成操作最后执行人姓名快照
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'template' AND entity_id IS NULL AND occupation_id IS NULL AND expected_project_revision IS NOT NULL) OR
         (scope <> 'template' AND entity_id IS NOT NULL AND occupation_id IS NOT NULL))
);
COMMENT ON TABLE studio_integrations IS '集成操作';
COMMENT ON COLUMN studio_integrations.id IS '集成操作ID';
COMMENT ON COLUMN studio_integrations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_integrations.scope IS '集成范围';
COMMENT ON COLUMN studio_integrations.entity_id IS '目标材料ID';
COMMENT ON COLUMN studio_integrations.occupation_id IS '占用ID';
COMMENT ON COLUMN studio_integrations.expected_project_revision IS '预期修订号';
COMMENT ON COLUMN studio_integrations.status IS '集成操作状态';
COMMENT ON COLUMN studio_integrations.source_sha IS '本次集成的来源提交';
COMMENT ON COLUMN studio_integrations.expected_head IS '预期分支头';
COMMENT ON COLUMN studio_integrations.candidate_sha IS '待接受的精确候选提交';
COMMENT ON COLUMN studio_integrations.allowed_paths IS '允许路径';
COMMENT ON COLUMN studio_integrations.request IS '控制请求';
COMMENT ON COLUMN studio_integrations.creator_id IS '集成发起人用户ID';
COMMENT ON COLUMN studio_integrations.creator_account IS '集成发起人账号快照';
COMMENT ON COLUMN studio_integrations.creator_name IS '集成发起人姓名快照';
COMMENT ON COLUMN studio_integrations.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_integrations.last_editor_id IS '最后执行人ID';
COMMENT ON COLUMN studio_integrations.last_editor_account IS '最后执行人账号';
COMMENT ON COLUMN studio_integrations.last_editor_name IS '最后执行人姓名';
COMMENT ON COLUMN studio_integrations.last_edited_date IS '记录最后修改时间';

CREATE UNIQUE INDEX studio_one_prepared_integration ON studio_integrations(project_id) WHERE status = 'prepared';

-- ============================================================
-- 实体（场景 / 需求）、业务编号与关联
-- ============================================================

-- 按项目和材料类型分配编号，行锁序列化，各序列分别从 1 起
CREATE TABLE studio_project_counters (
  project_id text NOT NULL REFERENCES studio_projects(id),
  kind studio_entity_kind NOT NULL CHECK (kind IN ('scenario','requirement')),  -- 编号所属材料类型，场景与需求独立计数
  PRIMARY KEY (project_id,kind),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0)  -- 本类型下一次分配的序号
);
COMMENT ON TABLE studio_project_counters IS '编号计数器';
COMMENT ON COLUMN studio_project_counters.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_project_counters.kind IS '材料类型';
COMMENT ON COLUMN studio_project_counters.next_sequence IS '下一序号';


-- 场景、需求及后续阶段材料实体：
--   id 为隐藏 UUID 技术身份，文件路径按名称生成（场景/<名称>.md），界面只展示业务编号；
--   场景和需求按类型持有稳定编号，改名与修订不变，不可手改、重排或回收；
--   title/summary 入库用于目录投影，确认时随固定版本快照保存；
--   普通场景与需求分别绑定模板固定引用 {commitSha,path,sha256}；内置说明不绑定编辑模板；
--   确认状态与任务状态分列；列表默认按 last_edited_date 降序、sequence 稳定次序
CREATE TABLE studio_entities (
  project_id text NOT NULL REFERENCES studio_projects(id),
  id text NOT NULL,  -- 材料UUID技术身份，同时用于固定文件路径
  kind studio_entity_kind NOT NULL,
  sequence bigint CHECK (sequence > 0),  -- 项目与材料类型内的稳定编号序号
  code text CHECK (code = CASE kind WHEN 'scenario' THEN 'SC-' WHEN 'requirement' THEN 'REQ-' END || lpad(sequence::text, greatest(4,length(sequence::text)), '0')),  -- 稳定业务编号，场景为SC前缀，需求为REQ前缀
  builtin_key text CHECK (builtin_key = 'general'),  -- 系统内置场景身份，general表示项目内唯一的通用场景
  template_id text,  -- 当前绑定的项目模板ID，系统内置场景为空
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),  -- 材料占用代数，用于隔离已失效占用
  material_version integer NOT NULL DEFAULT 0 CHECK (material_version >= 0),  -- 当前已接受的材料版本号
  confirmation_status studio_confirmation_status NOT NULL DEFAULT 'draft',
  task_status studio_task_status NOT NULL DEFAULT 'idle',  -- 材料整理或原型生产任务状态
  template_ref jsonb,  -- 当前模板固定引用，包含提交、路径和内容哈希
  current_confirmation_id text,  -- 当前已接受材料版本的确认记录ID
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),  -- 材料最后编辑人用户ID
  last_editor_account varchar(50) NOT NULL,  -- 材料最后编辑人账号快照
  last_editor_name varchar(50) NOT NULL,  -- 材料最后编辑人姓名快照
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, id),
  UNIQUE (project_id, kind, sequence),
  UNIQUE (project_id, code),
  UNIQUE (project_id, builtin_key),
  CHECK (builtin_key IS NULL OR kind = 'scenario'),
  CHECK ((kind IN ('scenario','requirement') AND sequence IS NOT NULL AND code IS NOT NULL) OR
         (kind NOT IN ('scenario','requirement') AND sequence IS NULL AND code IS NULL)),
  CHECK ((kind IN ('scenario','requirement') AND builtin_key IS NULL AND template_id IS NOT NULL AND template_ref IS NOT NULL) OR
         ((kind NOT IN ('scenario','requirement') OR builtin_key IS NOT NULL) AND template_id IS NULL AND template_ref IS NULL)),
  CHECK (template_ref IS NULL OR (jsonb_typeof(template_ref) = 'object' AND template_ref ?& ARRAY['commitSha','path','sha256'] AND
    template_ref - ARRAY['commitSha','path','sha256'] = '{}'::jsonb AND
    jsonb_typeof(template_ref->'commitSha') = 'string' AND (template_ref->>'commitSha') ~ '^[a-f0-9]{40}$' AND
    jsonb_typeof(template_ref->'path') = 'string' AND template_ref->>'path' = '.template/' || template_id || '.md' AND
    jsonb_typeof(template_ref->'sha256') = 'string' AND (template_ref->>'sha256') ~ '^[a-f0-9]{64}$'))
);
COMMENT ON TABLE studio_entities IS '材料目录';
COMMENT ON COLUMN studio_entities.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_entities.id IS '材料UUID';
COMMENT ON COLUMN studio_entities.kind IS '材料种类';
COMMENT ON COLUMN studio_entities.sequence IS '稳定序号';
COMMENT ON COLUMN studio_entities.code IS '业务编号';
COMMENT ON COLUMN studio_entities.builtin_key IS '内置标识';
COMMENT ON COLUMN studio_entities.template_id IS '模板ID';
COMMENT ON COLUMN studio_entities.title IS '材料目录标题';
COMMENT ON COLUMN studio_entities.summary IS '材料目录摘要';
COMMENT ON COLUMN studio_entities.revision IS '材料级并发修订号';
COMMENT ON COLUMN studio_entities.generation IS '占用代数';
COMMENT ON COLUMN studio_entities.material_version IS '材料版本号';
COMMENT ON COLUMN studio_entities.confirmation_status IS '材料内容确认状态';
COMMENT ON COLUMN studio_entities.task_status IS '任务状态';
COMMENT ON COLUMN studio_entities.template_ref IS '模板引用';
COMMENT ON COLUMN studio_entities.current_confirmation_id IS '确认记录ID';
COMMENT ON COLUMN studio_entities.creator_id IS '材料创建人用户ID';
COMMENT ON COLUMN studio_entities.creator_account IS '材料创建人账号快照';
COMMENT ON COLUMN studio_entities.creator_name IS '材料创建人姓名快照';
COMMENT ON COLUMN studio_entities.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_entities.last_editor_id IS '最后编辑人ID';
COMMENT ON COLUMN studio_entities.last_editor_account IS '最后编辑人账号';
COMMENT ON COLUMN studio_entities.last_editor_name IS '最后编辑人姓名';
COMMENT ON COLUMN studio_entities.last_edited_date IS '记录最后修改时间';

CREATE INDEX studio_entities_updated ON studio_entities(project_id, last_edited_date DESC, sequence);

-- 编号预留：先分配后记实体；同一新建 operation_key 重试返回同一编号；
-- 分配后失败不回收；预留同时确定 entity_id，但不要求业务实体已经写入
CREATE TABLE studio_entity_numbers (
  project_id text NOT NULL REFERENCES studio_projects(id),
  kind studio_entity_kind NOT NULL CHECK (kind IN ('scenario','requirement')),
  sequence bigint NOT NULL CHECK (sequence > 0),  -- 项目与材料类型内已分配的序号
  code text NOT NULL CHECK (code = CASE kind WHEN 'scenario' THEN 'SC-' WHEN 'requirement' THEN 'REQ-' END || lpad(sequence::text, greatest(4,length(sequence::text)), '0')),
  operation_key text NOT NULL,
  entity_id text NOT NULL,  -- 预留的材料UUID技术身份
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  creator_id bigint NOT NULL REFERENCES studio_users(id),  -- 编号预留发起人用户ID
  creator_account varchar(50) NOT NULL,  -- 编号预留发起人账号快照
  creator_name varchar(50) NOT NULL,  -- 编号预留发起人姓名快照
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kind, sequence),
  UNIQUE (project_id, code),
  UNIQUE (project_id, operation_key),
  UNIQUE (project_id, entity_id),
  UNIQUE (project_id, entity_id, kind, sequence)
);
COMMENT ON TABLE studio_entity_numbers IS '编号预留';
COMMENT ON COLUMN studio_entity_numbers.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_entity_numbers.kind IS '预留编号所属材料类型';
COMMENT ON COLUMN studio_entity_numbers.sequence IS '已分配序号';
COMMENT ON COLUMN studio_entity_numbers.code IS '已分配的稳定业务编号';
COMMENT ON COLUMN studio_entity_numbers.operation_key IS '新建材料操作幂等键';
COMMENT ON COLUMN studio_entity_numbers.entity_id IS '预留身份ID';
COMMENT ON COLUMN studio_entity_numbers.request_hash IS '原新建请求指纹';
COMMENT ON COLUMN studio_entity_numbers.creator_id IS '预留发起人ID';
COMMENT ON COLUMN studio_entity_numbers.creator_account IS '发起人账号';
COMMENT ON COLUMN studio_entity_numbers.creator_name IS '发起人姓名';
COMMENT ON COLUMN studio_entity_numbers.created_date IS '记录创建时间';


ALTER TABLE studio_entities
  ADD CONSTRAINT studio_entities_number_fk
  FOREIGN KEY (project_id, id, kind, sequence) REFERENCES studio_entity_numbers(project_id, entity_id, kind, sequence);

-- 场景与需求的当前关联（草稿态，可随整理调整）；
-- 确认时绑定的各场景固定版本见 studio_requirement_sources
CREATE TABLE studio_scenario_requirements (
  project_id text NOT NULL,
  scenario_id text NOT NULL,
  requirement_id text NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, scenario_id, requirement_id),
  FOREIGN KEY (project_id, scenario_id) REFERENCES studio_entities(project_id, id),
  FOREIGN KEY (project_id, requirement_id) REFERENCES studio_entities(project_id, id)
);
COMMENT ON TABLE studio_scenario_requirements IS '需求场景关联';
COMMENT ON COLUMN studio_scenario_requirements.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_scenario_requirements.scenario_id IS '关联场景ID';
COMMENT ON COLUMN studio_scenario_requirements.requirement_id IS '关联需求ID';
COMMENT ON COLUMN studio_scenario_requirements.creator_id IS '关系建立人用户ID';
COMMENT ON COLUMN studio_scenario_requirements.creator_account IS '关系建立人账号快照';
COMMENT ON COLUMN studio_scenario_requirements.creator_name IS '关系建立人姓名快照';
COMMENT ON COLUMN studio_scenario_requirements.created_date IS '记录创建时间';


-- 实体当前关联的用户工程文件（草稿态，可随整理调整）；确认清单保存在 Git 固定 MD 或同提交清单中
CREATE TABLE studio_entity_files (
  project_id text NOT NULL,
  entity_id text NOT NULL,
  path text NOT NULL,  -- 关联文件的项目相对路径
  creator_id bigint NOT NULL REFERENCES studio_users(id),  -- 文件关联建立人用户ID
  creator_account varchar(50) NOT NULL,  -- 文件关联建立人账号快照
  creator_name varchar(50) NOT NULL,  -- 文件关联建立人姓名快照
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, entity_id, path),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id)
);
COMMENT ON TABLE studio_entity_files IS '材料关联文件';
COMMENT ON COLUMN studio_entity_files.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_entity_files.entity_id IS '关联材料ID';
COMMENT ON COLUMN studio_entity_files.path IS '项目相对路径';
COMMENT ON COLUMN studio_entity_files.creator_id IS '关联建立人ID';
COMMENT ON COLUMN studio_entity_files.creator_account IS '建立人账号';
COMMENT ON COLUMN studio_entity_files.creator_name IS '建立人姓名';
COMMENT ON COLUMN studio_entity_files.created_date IS '记录创建时间';


-- ============================================================
-- 单材料设计占用
-- ============================================================

-- 设计占用：同一实体至多一条活跃占用（部分唯一索引）；只读查看已确认版不领取占用；
-- creator 即占有人（CHECK 强制一致），last_editor 记录释放/完成操作者（管理员强制释放时不同）；
CREATE TABLE studio_occupations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  owner_id bigint NOT NULL REFERENCES studio_users(id),
  purpose studio_occupation_purpose NOT NULL,  -- 材料整理或原型生产占用用途
  task_id text NOT NULL,
  client_id text NOT NULL,
  expected_revision integer NOT NULL,  -- 领取占用时绑定的材料修订号
  input_version integer NOT NULL,  -- 领取占用时绑定的材料版本号
  active boolean NOT NULL DEFAULT true,
  finish_status studio_occupation_finish,  -- 占用结束方式，活跃期间为空
  creator_id bigint NOT NULL REFERENCES studio_users(id),  -- 占用创建人用户ID，须与占有人一致
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),  -- 占用最后处理人用户ID
  last_editor_account varchar(50) NOT NULL,  -- 占用最后处理人账号快照
  last_editor_name varchar(50) NOT NULL,  -- 占用最后处理人姓名快照
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id),
  UNIQUE (project_id, entity_id, generation),
  UNIQUE (project_id, entity_id, id),
  UNIQUE (project_id, id),
  CHECK (creator_id = owner_id)
);
COMMENT ON TABLE studio_occupations IS '材料占用';
COMMENT ON COLUMN studio_occupations.id IS '占用令牌ID';
COMMENT ON COLUMN studio_occupations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_occupations.entity_id IS '被占用材料ID';
COMMENT ON COLUMN studio_occupations.generation IS '本次占用代数';
COMMENT ON COLUMN studio_occupations.owner_id IS '占有人用户ID';
COMMENT ON COLUMN studio_occupations.purpose IS '占用用途';
COMMENT ON COLUMN studio_occupations.task_id IS '持有占用的任务ID';
COMMENT ON COLUMN studio_occupations.client_id IS '持有占用的客户端ID';
COMMENT ON COLUMN studio_occupations.expected_revision IS '占用时修订号';
COMMENT ON COLUMN studio_occupations.input_version IS '占用时版本号';
COMMENT ON COLUMN studio_occupations.active IS '占用是否仍有效';
COMMENT ON COLUMN studio_occupations.finish_status IS '结束方式';
COMMENT ON COLUMN studio_occupations.creator_id IS '创建人ID';
COMMENT ON COLUMN studio_occupations.creator_account IS '占用创建人账号快照';
COMMENT ON COLUMN studio_occupations.creator_name IS '占用创建人姓名快照';
COMMENT ON COLUMN studio_occupations.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_occupations.last_editor_id IS '最后处理人ID';
COMMENT ON COLUMN studio_occupations.last_editor_account IS '最后处理人账号';
COMMENT ON COLUMN studio_occupations.last_editor_name IS '最后处理人姓名';
COMMENT ON COLUMN studio_occupations.last_edited_date IS '记录最后修改时间';

CREATE UNIQUE INDEX studio_one_active_occupation ON studio_occupations(project_id, entity_id) WHERE active;

ALTER TABLE studio_integrations
  ADD CONSTRAINT studio_integrations_occupation_fk
  FOREIGN KEY (project_id, entity_id, occupation_id) REFERENCES studio_occupations(project_id, entity_id, id);

-- ============================================================
-- 授权修复任务
-- ============================================================

-- “AI 修复并确认”授权任务：rounds_used 累计轮数总额度 3 轮，暂停/补答续接不重置；
-- 终止任务不可由普通聊天或补答自动恢复；最终版本 hash 以接受的确认行为准
CREATE TABLE studio_repair_tasks (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  occupation_id text NOT NULL,  -- 修复任务绑定的材料占用ID
  user_action_id text NOT NULL,  -- 启动修复的真实用户动作ID
  start_hash text NOT NULL CHECK (start_hash ~ '^[a-f0-9]{64}$'),  -- 修复授权开始时的材料SHA-256
  status studio_repair_status NOT NULL,
  rounds_used integer NOT NULL DEFAULT 0 CHECK (rounds_used BETWEEN 0 AND 3),  -- 累计已使用修复轮数，暂停续接不重置
  termination_reason text,
  creator_id bigint NOT NULL REFERENCES studio_users(id),  -- 修复授权发起人用户ID
  creator_account varchar(50) NOT NULL,  -- 修复授权发起人账号快照
  creator_name varchar(50) NOT NULL,  -- 修复授权发起人姓名快照
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),  -- 修复任务最后处理人用户ID
  last_editor_account varchar(50) NOT NULL,  -- 修复任务最后处理人账号快照
  last_editor_name varchar(50) NOT NULL,  -- 修复任务最后处理人姓名快照
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id),
  FOREIGN KEY (project_id, entity_id, occupation_id) REFERENCES studio_occupations(project_id, entity_id, id),
  UNIQUE (project_id, entity_id, id),
  UNIQUE (project_id, entity_id, user_action_id)
);
COMMENT ON TABLE studio_repair_tasks IS '修复任务';
COMMENT ON COLUMN studio_repair_tasks.id IS '修复任务ID';
COMMENT ON COLUMN studio_repair_tasks.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_repair_tasks.entity_id IS '修复目标材料ID';
COMMENT ON COLUMN studio_repair_tasks.occupation_id IS '绑定占用ID';
COMMENT ON COLUMN studio_repair_tasks.user_action_id IS '用户动作ID';
COMMENT ON COLUMN studio_repair_tasks.start_hash IS '起始散列';
COMMENT ON COLUMN studio_repair_tasks.status IS '修复任务状态';
COMMENT ON COLUMN studio_repair_tasks.rounds_used IS '已用轮数';
COMMENT ON COLUMN studio_repair_tasks.termination_reason IS '任务终止原因';
COMMENT ON COLUMN studio_repair_tasks.creator_id IS '发起人ID';
COMMENT ON COLUMN studio_repair_tasks.creator_account IS '发起人账号';
COMMENT ON COLUMN studio_repair_tasks.creator_name IS '发起人姓名';
COMMENT ON COLUMN studio_repair_tasks.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_repair_tasks.last_editor_id IS '最后处理人ID';
COMMENT ON COLUMN studio_repair_tasks.last_editor_account IS '最后处理人账号';
COMMENT ON COLUMN studio_repair_tasks.last_editor_name IS '最后处理人姓名';
COMMENT ON COLUMN studio_repair_tasks.last_edited_date IS '记录最后修改时间';


-- 修复任务控制事件：保存轮次结果 hash、暂停、显式续接与终止原因；不复制本地修复现场、正文或材料清单
CREATE TABLE studio_repair_task_events (
  task_id text NOT NULL REFERENCES studio_repair_tasks(id),
  seq integer NOT NULL CHECK (seq > 0),
  type studio_repair_event_type NOT NULL,
  hash_after text CHECK (hash_after IS NULL OR hash_after ~ '^[a-f0-9]{64}$'),  -- 本轮修复后的材料SHA-256
  detail jsonb NOT NULL,  -- 有限修复控制信息，不保存正文或本地修复现场
  creator_id bigint NOT NULL REFERENCES studio_users(id),  -- 修复事件执行人用户ID
  creator_account varchar(50) NOT NULL,  -- 修复事件执行人账号快照
  creator_name varchar(50) NOT NULL,  -- 修复事件执行人姓名快照
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, seq)
);
COMMENT ON TABLE studio_repair_task_events IS '修复任务事件';
COMMENT ON COLUMN studio_repair_task_events.task_id IS '所属修复任务ID';
COMMENT ON COLUMN studio_repair_task_events.seq IS '任务内递增事件序号';
COMMENT ON COLUMN studio_repair_task_events.type IS '修复事件类型';
COMMENT ON COLUMN studio_repair_task_events.hash_after IS '本轮后散列';
COMMENT ON COLUMN studio_repair_task_events.detail IS '控制细节';
COMMENT ON COLUMN studio_repair_task_events.creator_id IS '执行人ID';
COMMENT ON COLUMN studio_repair_task_events.creator_account IS '执行人账号';
COMMENT ON COLUMN studio_repair_task_events.creator_name IS '执行人姓名';
COMMENT ON COLUMN studio_repair_task_events.created_date IS '记录创建时间';


-- ============================================================
-- 固定版本确认与需求来源
-- ============================================================

-- 被项目接受的固定材料版本：任何内容改动须形成新版本，行不可变；
-- 用户确认的 creator_* 为确认人，read_hash 绑定实际阅读版本；repair 必须关联修复任务。
-- 系统预置仅关联真实初始化接受事实，不填造用户确认字段。
CREATE TABLE studio_confirmations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),  -- 材料版本号，原型完成沿用其材料版本号
  stage studio_confirmation_stage NOT NULL DEFAULT 'material',  -- 材料接受或原型完成阶段
  revision integer NOT NULL CHECK (revision > 0),  -- 接受时对应的材料修订号
  title text NOT NULL,
  summary text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),  -- 实际固定材料所在提交，原型阶段不替代为完成集成提交
  path text NOT NULL,  -- 固定材料的项目相对路径
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),  -- 固定材料内容的SHA-256
  acceptance_kind studio_acceptance_kind NOT NULL DEFAULT 'user-confirmed',  -- 用户确认或系统预置的互斥接受途径
  method studio_confirmation_method,  -- 用户普通确认或授权修复确认方式，系统预置为空
  read_hash text CHECK (read_hash ~ '^[a-f0-9]{64}$'),  -- 用户实际阅读版本的SHA-256，系统预置为空
  repair_task_id text REFERENCES studio_repair_tasks(id),  -- 授权修复确认对应的修复任务ID
  integration_id text REFERENCES studio_integrations(id),  -- 用户确认对应的真实集成操作ID，系统预置为空
  initialization_id text,  -- 系统预置对应的真实初始化接受操作ID
  creator_id bigint REFERENCES studio_users(id),  -- 业务确认人用户ID，系统预置为空
  creator_account varchar(50),  -- 业务确认人账号快照，系统预置为空
  creator_name varchar(50),  -- 业务确认人姓名快照，系统预置为空
  created_date timestamptz NOT NULL DEFAULT now(),  -- 固定版本接受时间，系统预置为初始化接受时间
  source_count integer NOT NULL DEFAULT 0 CHECK (source_count BETWEEN 0 AND 100),  -- 接受时封存的场景来源数量，须与来源明细数一致
  applicability studio_applicability NOT NULL DEFAULT 'applicable',  -- 该固定材料版本是否适用
  applicability_reason text,  -- 该需求固定版本不适用的明确原因
  UNIQUE (project_id, id),
  UNIQUE (project_id, entity_id, id),
  UNIQUE (project_id, entity_id, version, stage),
  UNIQUE (project_id, entity_id, version, stage, id),
  UNIQUE (project_id, entity_id, stage, id),
  UNIQUE (initialization_id),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id),
  FOREIGN KEY (project_id,initialization_id) REFERENCES studio_project_initializations(project_id,id),
  CHECK (
    (acceptance_kind = 'user-confirmed' AND method IS NOT NULL AND read_hash IS NOT NULL AND read_hash = sha256 AND
      integration_id IS NOT NULL AND initialization_id IS NULL AND creator_id IS NOT NULL AND creator_account IS NOT NULL AND creator_name IS NOT NULL AND
      ((method = 'repair') = (repair_task_id IS NOT NULL))) OR
    (acceptance_kind = 'system-provisioned' AND stage = 'material' AND version = 1 AND method IS NULL AND read_hash IS NULL AND
      repair_task_id IS NULL AND integration_id IS NULL AND initialization_id IS NOT NULL AND
      creator_id IS NULL AND creator_account IS NULL AND creator_name IS NULL)
  ),
  CHECK (
    (applicability = 'applicable' AND applicability_reason IS NULL) OR
    (applicability = 'not-applicable' AND applicability_reason IS NOT NULL AND btrim(applicability_reason) <> '')
  )
);
COMMENT ON TABLE studio_confirmations IS '固定版本接受';
COMMENT ON COLUMN studio_confirmations.id IS '固定版本接受记录ID';
COMMENT ON COLUMN studio_confirmations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_confirmations.entity_id IS '被接受材料ID';
COMMENT ON COLUMN studio_confirmations.version IS '版本号';
COMMENT ON COLUMN studio_confirmations.stage IS '接受阶段';
COMMENT ON COLUMN studio_confirmations.revision IS '对应修订号';
COMMENT ON COLUMN studio_confirmations.title IS '接受时的材料标题快照';
COMMENT ON COLUMN studio_confirmations.summary IS '接受时的材料摘要快照';
COMMENT ON COLUMN studio_confirmations.commit_sha IS '固定提交';
COMMENT ON COLUMN studio_confirmations.path IS '相对路径';
COMMENT ON COLUMN studio_confirmations.sha256 IS '内容散列';
COMMENT ON COLUMN studio_confirmations.acceptance_kind IS '接受途径';
COMMENT ON COLUMN studio_confirmations.method IS '确认方式';
COMMENT ON COLUMN studio_confirmations.read_hash IS '阅读散列';
COMMENT ON COLUMN studio_confirmations.repair_task_id IS '修复任务ID';
COMMENT ON COLUMN studio_confirmations.integration_id IS '集成操作ID';
COMMENT ON COLUMN studio_confirmations.initialization_id IS '初始化ID';
COMMENT ON COLUMN studio_confirmations.creator_id IS '确认人ID';
COMMENT ON COLUMN studio_confirmations.creator_account IS '确认人账号';
COMMENT ON COLUMN studio_confirmations.creator_name IS '确认人姓名';
COMMENT ON COLUMN studio_confirmations.created_date IS '接受时间';
COMMENT ON COLUMN studio_confirmations.source_count IS '来源数量';
COMMENT ON COLUMN studio_confirmations.applicability IS '是否适用';
COMMENT ON COLUMN studio_confirmations.applicability_reason IS '不适用原因';

CREATE INDEX studio_confirmations_entity ON studio_confirmations(project_id, entity_id, version DESC);

ALTER TABLE studio_entities
  ADD CONSTRAINT studio_entities_current_confirmation_fk
  FOREIGN KEY (project_id, id, current_confirmation_id) REFERENCES studio_confirmations(project_id, entity_id, id);

-- 需求确认绑定的场景固定版本：至少一个、可多个，提交时触发器强制；
-- 仅允许同项目已接受的场景确认版本，不允许无来源或未确认来源
CREATE TABLE studio_requirement_sources (
  project_id text NOT NULL,
  confirmation_id text NOT NULL,
  scenario_id text NOT NULL,  -- 来源场景ID，同一次接受仅绑定一个版本
  scenario_confirmation_id text NOT NULL,  -- 来源场景的固定材料接受记录ID
  source_stage studio_confirmation_stage NOT NULL DEFAULT 'material' CHECK (source_stage = 'material'),  -- 来源固定版本阶段，限材料阶段
  PRIMARY KEY (confirmation_id, scenario_id),
  FOREIGN KEY (project_id,confirmation_id) REFERENCES studio_confirmations(project_id,id),
  FOREIGN KEY (project_id,scenario_id,source_stage,scenario_confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,stage,id),
  CHECK (confirmation_id <> scenario_confirmation_id)
);
COMMENT ON TABLE studio_requirement_sources IS '需求来源集合';
COMMENT ON COLUMN studio_requirement_sources.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_requirement_sources.confirmation_id IS '需求材料接受记录ID';
COMMENT ON COLUMN studio_requirement_sources.scenario_id IS '来源场景ID';
COMMENT ON COLUMN studio_requirement_sources.scenario_confirmation_id IS '来源确认ID';
COMMENT ON COLUMN studio_requirement_sources.source_stage IS '来源阶段';



-- 前置关系绑定已接受材料版本；完成证据仅在原型生产时校验。
CREATE TABLE studio_prerequisites (
  project_id text NOT NULL,
  entity_id text NOT NULL,  -- 设置前置关系的当前需求ID
  requirement_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),  -- 绑定的前置需求材料版本号
  confirmation_id text NOT NULL,  -- 该前置材料版本的接受记录ID
  stage studio_confirmation_stage NOT NULL DEFAULT 'material' CHECK (stage = 'material'),  -- 前置引用阶段，限材料阶段
  creator_id bigint NOT NULL REFERENCES studio_users(id),  -- 前置关系建立人用户ID
  creator_account varchar(50) NOT NULL,  -- 前置关系建立人账号快照
  creator_name varchar(50) NOT NULL,  -- 前置关系建立人姓名快照
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,entity_id,requirement_id),
  CHECK (entity_id <> requirement_id),
  FOREIGN KEY(project_id,requirement_id,version,stage,confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,version,stage,id),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id),
  FOREIGN KEY(project_id,requirement_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_prerequisites IS '前置需求关系';
COMMENT ON COLUMN studio_prerequisites.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_prerequisites.entity_id IS '当前需求ID';
COMMENT ON COLUMN studio_prerequisites.requirement_id IS '前置需求ID';
COMMENT ON COLUMN studio_prerequisites.version IS '前置版本号';
COMMENT ON COLUMN studio_prerequisites.confirmation_id IS '前置确认ID';
COMMENT ON COLUMN studio_prerequisites.stage IS '引用阶段';
COMMENT ON COLUMN studio_prerequisites.creator_id IS '建立人ID';
COMMENT ON COLUMN studio_prerequisites.creator_account IS '建立人账号';
COMMENT ON COLUMN studio_prerequisites.creator_name IS '建立人姓名';
COMMENT ON COLUMN studio_prerequisites.created_date IS '记录创建时间';

-- 固定材料版本的复用资格与停用原因
CREATE TABLE studio_eligibility (
  project_id text NOT NULL,
  entity_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),  -- 复用资格所属材料版本号
  enabled boolean NOT NULL,  -- 该固定版本是否允许新的复用采用
  reason text NOT NULL,  -- 启用或停用复用资格的原因
  creator_id bigint NOT NULL REFERENCES studio_users(id),  -- 复用资格创建人用户ID
  creator_account varchar(50) NOT NULL,  -- 复用资格创建人账号快照
  creator_name varchar(50) NOT NULL,  -- 复用资格创建人姓名快照
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),  -- 复用资格最后修改人用户ID
  last_editor_account varchar(50) NOT NULL,  -- 复用资格最后修改人账号快照
  last_editor_name varchar(50) NOT NULL,  -- 复用资格最后修改人姓名快照
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,entity_id,version),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_eligibility IS '复用资格';
COMMENT ON COLUMN studio_eligibility.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_eligibility.entity_id IS '复用资格所属材料ID';
COMMENT ON COLUMN studio_eligibility.version IS '资格版本号';
COMMENT ON COLUMN studio_eligibility.enabled IS '是否可用';
COMMENT ON COLUMN studio_eligibility.reason IS '资格原因';
COMMENT ON COLUMN studio_eligibility.creator_id IS '资格创建人ID';
COMMENT ON COLUMN studio_eligibility.creator_account IS '创建人账号';
COMMENT ON COLUMN studio_eligibility.creator_name IS '创建人姓名';
COMMENT ON COLUMN studio_eligibility.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_eligibility.last_editor_id IS '最后修改人ID';
COMMENT ON COLUMN studio_eligibility.last_editor_account IS '最后修改人账号';
COMMENT ON COLUMN studio_eligibility.last_editor_name IS '最后修改人姓名';
COMMENT ON COLUMN studio_eligibility.last_edited_date IS '记录最后修改时间';

-- 集成操作与其接受确认记录的关联
CREATE TABLE studio_integration_confirmations (
  integration_id text NOT NULL REFERENCES studio_integrations(id),
  confirmation_id text NOT NULL REFERENCES studio_confirmations(id),  -- 该集成接受的确认记录ID
  PRIMARY KEY(integration_id,confirmation_id)
);
COMMENT ON TABLE studio_integration_confirmations IS '集成确认关联';
COMMENT ON COLUMN studio_integration_confirmations.integration_id IS '所属集成操作ID';
COMMENT ON COLUMN studio_integration_confirmations.confirmation_id IS '确认记录ID';

-- 固定来源版本的复用采用受理与成功控制事实
CREATE TABLE studio_adoptions (
  id text PRIMARY KEY,
  source_project_id text NOT NULL,  -- 被采用来源所属项目ID
  source_entity_id text NOT NULL,
  source_version integer NOT NULL CHECK(source_version>0),  -- 被采用的固定来源版本号
  target_project_id text NOT NULL,
  target_entity_id text NOT NULL,
  target_task_id text NOT NULL,  -- 执行采用的目标任务ID
  scope studio_adoption_scope NOT NULL,  -- 采用材料包或原型包的范围
  adjustment_summary text NOT NULL,  -- 目标采用时的有限调整说明
  status studio_adoption_status NOT NULL,
  target_confirmation_id text REFERENCES studio_confirmations(id),  -- 采用成功后目标固定版本的接受记录ID
  target_version integer CHECK(target_version>0),  -- 采用成功后目标材料版本号
  succeeded_at timestamptz,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),  -- 采用记录最后处理人用户ID
  last_editor_account varchar(50) NOT NULL,  -- 采用记录最后处理人账号快照
  last_editor_name varchar(50) NOT NULL,  -- 采用记录最后处理人姓名快照
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(source_project_id,source_entity_id) REFERENCES studio_entities(project_id,id),
  FOREIGN KEY(target_project_id,target_entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_adoptions IS '复用采用记录';
COMMENT ON COLUMN studio_adoptions.id IS '复用采用记录ID';
COMMENT ON COLUMN studio_adoptions.source_project_id IS '来源项目ID';
COMMENT ON COLUMN studio_adoptions.source_entity_id IS '被采用来源材料ID';
COMMENT ON COLUMN studio_adoptions.source_version IS '来源版本号';
COMMENT ON COLUMN studio_adoptions.target_project_id IS '采用目标所属项目ID';
COMMENT ON COLUMN studio_adoptions.target_entity_id IS '采用目标材料ID';
COMMENT ON COLUMN studio_adoptions.target_task_id IS '目标任务ID';
COMMENT ON COLUMN studio_adoptions.scope IS '采用范围';
COMMENT ON COLUMN studio_adoptions.adjustment_summary IS '调整说明';
COMMENT ON COLUMN studio_adoptions.status IS '采用受理或成功状态';
COMMENT ON COLUMN studio_adoptions.target_confirmation_id IS '目标确认ID';
COMMENT ON COLUMN studio_adoptions.target_version IS '目标版本号';
COMMENT ON COLUMN studio_adoptions.succeeded_at IS '采用成功时间';
COMMENT ON COLUMN studio_adoptions.creator_id IS '采用发起人用户ID';
COMMENT ON COLUMN studio_adoptions.creator_account IS '采用发起人账号快照';
COMMENT ON COLUMN studio_adoptions.creator_name IS '采用发起人姓名快照';
COMMENT ON COLUMN studio_adoptions.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_adoptions.last_editor_id IS '最后处理人ID';
COMMENT ON COLUMN studio_adoptions.last_editor_account IS '最后处理人账号';
COMMENT ON COLUMN studio_adoptions.last_editor_name IS '最后处理人姓名';
COMMENT ON COLUMN studio_adoptions.last_edited_date IS '记录最后修改时间';

-- 用户对固定交接材料版本的收悉记录
CREATE TABLE studio_handoff_receipts (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  confirmation_id text NOT NULL REFERENCES studio_confirmations(id),  -- 已接受的固定交接版本记录ID
  note text NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id),
  UNIQUE(project_id,entity_id,confirmation_id,creator_id)
);
COMMENT ON TABLE studio_handoff_receipts IS '交接收悉';
COMMENT ON COLUMN studio_handoff_receipts.id IS '交接收悉记录ID';
COMMENT ON COLUMN studio_handoff_receipts.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_handoff_receipts.entity_id IS '交接材料ID';
COMMENT ON COLUMN studio_handoff_receipts.confirmation_id IS '交接版本ID';
COMMENT ON COLUMN studio_handoff_receipts.note IS '收悉备注';
COMMENT ON COLUMN studio_handoff_receipts.creator_id IS '交接收悉人用户ID';
COMMENT ON COLUMN studio_handoff_receipts.creator_account IS '交接收悉人账号快照';
COMMENT ON COLUMN studio_handoff_receipts.creator_name IS '交接收悉人姓名快照';
COMMENT ON COLUMN studio_handoff_receipts.created_date IS '记录创建时间';

CREATE UNIQUE INDEX studio_one_active_repair ON studio_repair_tasks(project_id,entity_id,occupation_id) WHERE status IN ('active','paused');

-- 草稿需求也绑定已确认场景的固定版本，不只保存可变场景关联。
-- 需求当前绑定的场景固定版本，允许在需求独立修订中显式调整
CREATE TABLE studio_entity_scenario_sources (
  project_id text NOT NULL,
  entity_id text NOT NULL,
  scenario_confirmation_id text NOT NULL REFERENCES studio_confirmations(id),  -- 当前所选场景固定材料版本的接受记录ID
  creator_id bigint NOT NULL REFERENCES studio_users(id),  -- 来源绑定记录创建人用户ID
  creator_account varchar(50) NOT NULL,  -- 来源绑定记录创建人账号快照
  creator_name varchar(50) NOT NULL,  -- 来源绑定记录创建人姓名快照
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,entity_id,scenario_confirmation_id),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_entity_scenario_sources IS '需求来源绑定';
COMMENT ON COLUMN studio_entity_scenario_sources.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_entity_scenario_sources.entity_id IS '绑定来源的需求ID';
COMMENT ON COLUMN studio_entity_scenario_sources.scenario_confirmation_id IS '场景确认ID';
COMMENT ON COLUMN studio_entity_scenario_sources.creator_id IS '绑定创建人ID';
COMMENT ON COLUMN studio_entity_scenario_sources.creator_account IS '创建人账号';
COMMENT ON COLUMN studio_entity_scenario_sources.creator_name IS '创建人姓名';
COMMENT ON COLUMN studio_entity_scenario_sources.created_date IS '记录创建时间';


-- 复合外键保证占用、修复、确认和派生物不能跨项目或跨实体串接。
ALTER TABLE studio_integrations ADD UNIQUE(project_id,id);
ALTER TABLE studio_integrations ADD UNIQUE(project_id,entity_id,id);
ALTER TABLE studio_confirmations DROP CONSTRAINT studio_confirmations_integration_id_fkey;
ALTER TABLE studio_confirmations ADD FOREIGN KEY(project_id,entity_id,integration_id) REFERENCES studio_integrations(project_id,entity_id,id);
ALTER TABLE studio_confirmations DROP CONSTRAINT studio_confirmations_repair_task_id_fkey;
ALTER TABLE studio_confirmations ADD FOREIGN KEY(project_id,entity_id,repair_task_id) REFERENCES studio_repair_tasks(project_id,entity_id,id);
ALTER TABLE studio_handoff_receipts DROP CONSTRAINT studio_handoff_receipts_confirmation_id_fkey;
ALTER TABLE studio_handoff_receipts ADD FOREIGN KEY(project_id,entity_id,confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,id);
ALTER TABLE studio_adoptions DROP CONSTRAINT studio_adoptions_target_confirmation_id_fkey;
ALTER TABLE studio_adoptions ADD FOREIGN KEY(target_project_id,target_entity_id,target_confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,id);

-- ============================================================
-- 幂等操作与审计
-- ============================================================

-- 幂等操作记录：结果未知时先按 (project_id,key) 核对原操作，不盲目判失败或重复创建；
-- result 仅保存操作状态、实体标识、修订号与固定版本引用等控制结果，不复制正文、业务快照或材料清单
CREATE TABLE studio_operations (
  project_id text NOT NULL REFERENCES studio_projects(id),
  key text NOT NULL,
  action text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,  -- 操作状态、身份、修订号及固定引用等有限控制结果
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, key)
);
COMMENT ON TABLE studio_operations IS '幂等操作';
COMMENT ON COLUMN studio_operations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_operations.key IS '项目内操作幂等键';
COMMENT ON COLUMN studio_operations.action IS '操作动作名称';
COMMENT ON COLUMN studio_operations.request_hash IS '原操作请求指纹';
COMMENT ON COLUMN studio_operations.result IS '控制结果';
COMMENT ON COLUMN studio_operations.creator_id IS '操作发起人用户ID';
COMMENT ON COLUMN studio_operations.creator_account IS '操作发起人账号快照';
COMMENT ON COLUMN studio_operations.creator_name IS '操作发起人姓名快照';
COMMENT ON COLUMN studio_operations.created_date IS '记录创建时间';


-- 审计日志：项目内全部接受的管理与业务动作，仅追加；data 仅记录动作标识、对象、状态与版本引用，
-- 不存正文、业务快照、质量项、待澄清项、正式依据或关联文件清单
CREATE TABLE studio_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  action text NOT NULL,  -- 被记录的管理或业务动作名称
  data jsonb NOT NULL,  -- 动作对象、状态与版本引用等有限控制信息
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE studio_audit IS '审计记录';
COMMENT ON COLUMN studio_audit.id IS '审计流水ID';
COMMENT ON COLUMN studio_audit.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_audit.action IS '动作名称';
COMMENT ON COLUMN studio_audit.data IS '控制信息';
COMMENT ON COLUMN studio_audit.creator_id IS '动作执行人用户ID';
COMMENT ON COLUMN studio_audit.creator_account IS '动作执行人账号快照';
COMMENT ON COLUMN studio_audit.creator_name IS '动作执行人姓名快照';
COMMENT ON COLUMN studio_audit.created_date IS '记录创建时间';

CREATE INDEX studio_audit_project ON studio_audit(project_id, created_date);

-- ============================================================
-- 独立一致性对比：客户端发起的一次快照
-- ============================================================

-- 每次对比一行不可变记录：目标材料、触发途径、执行结果、覆盖范围与冲突数量封存。
-- 结论由记录自身派生，不保存“是否已解决”：completed 且 complete 且冲突为零才算通过；
-- 冲突的实际解决在用户客户端完成，下一轮对比重新生成自己的冲突清单。
CREATE TABLE studio_consistency_comparisons (
  id studio_control_id PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  entity_id text NOT NULL,  -- 本次对比的目标材料，提醒落在这个材料上
  trigger studio_comparison_trigger NOT NULL,
  confirmation_id text,
  operation_key studio_control_id NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result studio_comparison_result NOT NULL,
  coverage studio_comparison_coverage NOT NULL,
  failure_code studio_comparison_failure,
  summary varchar(500) NOT NULL DEFAULT '',
  conflict_count integer NOT NULL DEFAULT 0 CHECK (conflict_count BETWEEN 0 AND 100),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,id),
  UNIQUE (project_id,operation_key),
  FOREIGN KEY (project_id,entity_id) REFERENCES studio_entities(project_id,id),
  FOREIGN KEY (project_id,entity_id,confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,id),
  CHECK ((trigger='manual' AND confirmation_id IS NULL) OR (trigger='confirmation' AND confirmation_id IS NOT NULL)),
  CHECK ((result='completed' AND failure_code IS NULL) OR
    (result='failed' AND failure_code IS NOT NULL AND failure_code<>'cancelled' AND btrim(summary)<>'') OR
    (result='cancelled' AND failure_code IS NOT NULL AND failure_code='cancelled'))
);
COMMENT ON TABLE studio_consistency_comparisons IS '一致性对比';
COMMENT ON COLUMN studio_consistency_comparisons.id IS '对比记录ID';
COMMENT ON COLUMN studio_consistency_comparisons.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_comparisons.entity_id IS '目标材料ID';
COMMENT ON COLUMN studio_consistency_comparisons.trigger IS '触发途径';
COMMENT ON COLUMN studio_consistency_comparisons.confirmation_id IS '确认记录ID';
COMMENT ON COLUMN studio_consistency_comparisons.operation_key IS '对比幂等键';
COMMENT ON COLUMN studio_consistency_comparisons.request_hash IS '请求指纹';
COMMENT ON COLUMN studio_consistency_comparisons.result IS '对比结果';
COMMENT ON COLUMN studio_consistency_comparisons.coverage IS '覆盖范围';
COMMENT ON COLUMN studio_consistency_comparisons.failure_code IS '失败码';
COMMENT ON COLUMN studio_consistency_comparisons.summary IS '结果摘要';
COMMENT ON COLUMN studio_consistency_comparisons.conflict_count IS '冲突数量';
COMMENT ON COLUMN studio_consistency_comparisons.creator_id IS '发起人ID';
COMMENT ON COLUMN studio_consistency_comparisons.creator_account IS '发起人账号';
COMMENT ON COLUMN studio_consistency_comparisons.creator_name IS '发起人姓名';
COMMENT ON COLUMN studio_consistency_comparisons.created_date IS '对比时间';

-- 每个确认事件至多一条自动对比；用户重试另建记录，不覆盖旧结论。
CREATE UNIQUE INDEX studio_one_auto_comparison ON studio_consistency_comparisons(project_id,confirmation_id) WHERE trigger='confirmation';
CREATE INDEX studio_comparisons_target ON studio_consistency_comparisons(project_id,entity_id,created_date DESC);

-- 冲突只保留摘要、关系类型和涉及材料，不保存处理状态、提醒或处理历史。
CREATE TABLE studio_consistency_conflicts (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  summary varchar(500) NOT NULL CHECK (btrim(summary)<>''),
  relation studio_conflict_relation NOT NULL,
  entity_count integer NOT NULL CHECK (entity_count BETWEEN 1 AND 100),
  PRIMARY KEY (project_id,comparison_id,id),
  UNIQUE (project_id,comparison_id,ordinal),
  FOREIGN KEY (project_id,comparison_id) REFERENCES studio_consistency_comparisons(project_id,id)
);
COMMENT ON TABLE studio_consistency_conflicts IS '对比冲突';
COMMENT ON COLUMN studio_consistency_conflicts.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_conflicts.comparison_id IS '所属对比ID';
COMMENT ON COLUMN studio_consistency_conflicts.id IS '冲突项ID';
COMMENT ON COLUMN studio_consistency_conflicts.ordinal IS '冲突序号';
COMMENT ON COLUMN studio_consistency_conflicts.summary IS '冲突摘要';
COMMENT ON COLUMN studio_consistency_conflicts.relation IS '关系类型';
COMMENT ON COLUMN studio_consistency_conflicts.entity_count IS '涉及材料数';

-- 冲突涉及的其他材料，说明这条冲突发生在哪两个材料之间。
CREATE TABLE studio_consistency_conflict_entities (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  conflict_id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  entity_id text NOT NULL,
  PRIMARY KEY (project_id,comparison_id,conflict_id,entity_id),
  UNIQUE (project_id,comparison_id,conflict_id,ordinal),
  FOREIGN KEY (project_id,comparison_id,conflict_id) REFERENCES studio_consistency_conflicts(project_id,comparison_id,id),
  FOREIGN KEY (project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_consistency_conflict_entities IS '冲突涉及材料';
COMMENT ON COLUMN studio_consistency_conflict_entities.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_conflict_entities.comparison_id IS '所属对比ID';
COMMENT ON COLUMN studio_consistency_conflict_entities.conflict_id IS '所属冲突ID';
COMMENT ON COLUMN studio_consistency_conflict_entities.ordinal IS '材料序号';
COMMENT ON COLUMN studio_consistency_conflict_entities.entity_id IS '涉及材料ID';

-- 本地材料 git 状态：仅追加记录，摘要不超 500 字，不含材料正文。
CREATE TABLE studio_material_status_reports (
  id studio_control_id PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  entity_id text NOT NULL,
  trigger studio_status_trigger NOT NULL,
  base_head text NOT NULL CHECK (base_head ~ '^[a-f0-9]{40}$'),
  worktree_head text NOT NULL CHECK (worktree_head ~ '^[a-f0-9]{40}$'),
  changed_path_count integer NOT NULL CHECK (changed_path_count BETWEEN 0 AND 3000),
  summary varchar(500) NOT NULL DEFAULT '',
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,id),
  FOREIGN KEY (project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_material_status_reports IS '材料状态记录';
COMMENT ON COLUMN studio_material_status_reports.id IS '状态记录ID';
COMMENT ON COLUMN studio_material_status_reports.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_material_status_reports.entity_id IS '目标材料ID';
COMMENT ON COLUMN studio_material_status_reports.trigger IS '触发途径';
COMMENT ON COLUMN studio_material_status_reports.base_head IS '基线提交';
COMMENT ON COLUMN studio_material_status_reports.worktree_head IS '工作区提交';
COMMENT ON COLUMN studio_material_status_reports.changed_path_count IS '变更文件数';
COMMENT ON COLUMN studio_material_status_reports.summary IS '状态摘要';
COMMENT ON COLUMN studio_material_status_reports.creator_id IS '发起人ID';
COMMENT ON COLUMN studio_material_status_reports.creator_account IS '发起人账号';
COMMENT ON COLUMN studio_material_status_reports.creator_name IS '发起人姓名';
COMMENT ON COLUMN studio_material_status_reports.created_date IS '记录时间';
CREATE INDEX studio_status_reports_target ON studio_material_status_reports(project_id,entity_id,created_date DESC);

-- ============================================================
-- 不变量触发器
-- ============================================================

-- 固定记录不可变：确认、需求来源、编号预留不允许更新或删除
CREATE FUNCTION studio_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable fixed records', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_forbid_mutation() IS '禁止改动固定记录';

CREATE TRIGGER studio_confirmations_immutable BEFORE UPDATE OR DELETE ON studio_confirmations
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_requirement_sources_immutable BEFORE UPDATE OR DELETE ON studio_requirement_sources
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();

-- 项目原创建请求身份不可变，生命周期仅前进；改名不改变请求指纹。
CREATE FUNCTION studio_guard_project_creation() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.creator_id <> OLD.creator_id OR NEW.creator_account <> OLD.creator_account OR NEW.creator_name <> OLD.creator_name OR NEW.created_date <> OLD.created_date OR NEW.key <> OLD.key OR
     NEW.request_hash <> OLD.request_hash OR NEW.marker <> OLD.marker OR
     NEW.namespace_id <> OLD.namespace_id OR NEW.namespace_path <> OLD.namespace_path OR NEW.path <> OLD.path THEN
    RAISE EXCEPTION 'project creation identity and original request fingerprint are immutable';
  END IF;
  IF NEW.state < OLD.state THEN
    RAISE EXCEPTION 'project lifecycle cannot move backwards';
  END IF;
  IF OLD.gitlab_project_id IS NOT NULL AND
     (NEW.gitlab_project_id IS DISTINCT FROM OLD.gitlab_project_id OR NEW.repository_url IS DISTINCT FROM OLD.repository_url) THEN
    RAISE EXCEPTION 'project repository binding is immutable';
  END IF;
  NEW.last_edited_date = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_guard_project_creation() IS '项目创建守卫';
CREATE TRIGGER studio_projects_guard BEFORE UPDATE ON studio_projects
  FOR EACH ROW EXECUTE FUNCTION studio_guard_project_creation();

-- 编号预留的身份、编号、请求及创建人不可改、不可删
CREATE FUNCTION studio_guard_entity_number() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id <> OLD.project_id OR NEW.entity_id <> OLD.entity_id OR NEW.kind <> OLD.kind OR NEW.sequence <> OLD.sequence OR NEW.code <> OLD.code OR NEW.operation_key IS DISTINCT FROM OLD.operation_key OR NEW.request_hash <> OLD.request_hash OR NEW.creator_id <> OLD.creator_id OR NEW.creator_account <> OLD.creator_account OR NEW.creator_name <> OLD.creator_name OR NEW.created_date <> OLD.created_date THEN
    RAISE EXCEPTION 'allocated entity numbers cannot be modified, reordered or recycled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_guard_entity_number() IS '编号预留守卫';
CREATE TRIGGER studio_entity_numbers_guard BEFORE UPDATE ON studio_entity_numbers
  FOR EACH ROW EXECUTE FUNCTION studio_guard_entity_number();
CREATE TRIGGER studio_entity_numbers_no_delete BEFORE DELETE ON studio_entity_numbers
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();

-- 实体技术身份与业务编号不可变（改名与修订保持不变）；其余更新自动维护 last_edited_date
CREATE FUNCTION studio_guard_entity_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id <> OLD.project_id OR NEW.id <> OLD.id OR NEW.sequence IS DISTINCT FROM OLD.sequence OR NEW.code IS DISTINCT FROM OLD.code OR NEW.kind <> OLD.kind OR NEW.builtin_key IS DISTINCT FROM OLD.builtin_key OR NEW.creator_id <> OLD.creator_id OR NEW.creator_account <> OLD.creator_account OR NEW.creator_name <> OLD.creator_name OR NEW.created_date <> OLD.created_date THEN
    RAISE EXCEPTION 'entity identity, kind, sequence and code are immutable';
  END IF;
  NEW.last_edited_date = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_guard_entity_identity() IS '实体身份守卫';
CREATE TRIGGER studio_entities_guard BEFORE UPDATE ON studio_entities
  FOR EACH ROW EXECUTE FUNCTION studio_guard_entity_identity();

-- 确认来源在接受时封存；固定父记录的数量与不可变子记录共同防止事后追加。
CREATE FUNCTION studio_assert_confirmation_sources(p_confirmation text) RETURNS void AS $$
DECLARE
  accepted studio_confirmations%ROWTYPE;
  entity_kind studio_entity_kind;
  actual_count integer;
BEGIN
  SELECT * INTO accepted FROM studio_confirmations WHERE id=p_confirmation;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT kind INTO entity_kind FROM studio_entities WHERE project_id=accepted.project_id AND id=accepted.entity_id;
  SELECT count(*) INTO actual_count FROM studio_requirement_sources WHERE confirmation_id=p_confirmation;
  IF entity_kind='requirement' AND accepted.stage='material' THEN
    IF accepted.source_count=0 OR actual_count<>accepted.source_count THEN
      RAISE EXCEPTION 'requirement confirmation requires at least one confirmed scenario source and its sealed source_count must match';
    END IF;
  ELSIF accepted.source_count<>0 OR actual_count<>0 THEN
    RAISE EXCEPTION 'only requirement material confirmations may have scenario sources';
  END IF;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_assert_confirmation_sources IS '来源封存校验';

-- 校验普通确认与系统预置的互斥接受途径
CREATE FUNCTION studio_check_confirmation_acceptance() RETURNS trigger AS $$
DECLARE
  entity studio_entities%ROWTYPE;
BEGIN
  SELECT * INTO entity FROM studio_entities WHERE project_id=NEW.project_id AND id=NEW.entity_id;
  IF entity.kind='scenario' AND NEW.applicability<>'applicable' THEN
    RAISE EXCEPTION 'scenario confirmation must be applicable';
  END IF;
  IF NEW.acceptance_kind='system-provisioned' THEN
    IF entity.builtin_key IS DISTINCT FROM 'general' OR NOT EXISTS (
      SELECT 1 FROM studio_project_initializations i
      WHERE i.id=NEW.initialization_id AND i.project_id=NEW.project_id AND i.commit_sha=NEW.commit_sha
    ) THEN RAISE EXCEPTION 'system provisioning requires the general scenario and its real initialization commit'; END IF;
  ELSE
    IF entity.builtin_key IS NOT NULL THEN RAISE EXCEPTION 'built-in scenarios cannot be user-confirmed'; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM studio_integrations i
      WHERE i.id=NEW.integration_id AND i.project_id=NEW.project_id AND i.entity_id=NEW.entity_id AND
        i.status='accepted' AND (NEW.stage<>'material' OR i.candidate_sha=NEW.commit_sha) AND i.scope::text=NEW.stage::text
    ) THEN RAISE EXCEPTION 'confirmation requires its own accepted integration and material candidate commit'; END IF;

  END IF;
  PERFORM studio_assert_confirmation_sources(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_check_confirmation_acceptance IS '接受途径校验';
CREATE CONSTRAINT TRIGGER studio_confirmation_acceptance
  AFTER INSERT ON studio_confirmations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION studio_check_confirmation_acceptance();

-- 草稿需求与确认需求一致，必须始终具有至少一个同项目的已确认场景固定来源。
-- 关系可在同事务内分步写入，提交时才检查最终来源集合，保持当前关系与固定引用原子更新。
CREATE FUNCTION studio_assert_draft_requirement_sources(p_project text, p_entity text) RETURNS void AS $$
DECLARE
  entity_kind studio_entity_kind;
BEGIN
  SELECT kind INTO entity_kind FROM studio_entities WHERE project_id=p_project AND id=p_entity;
  IF NOT FOUND THEN RETURN; END IF;
  IF entity_kind <> 'requirement' THEN
    IF EXISTS(SELECT 1 FROM studio_entity_scenario_sources WHERE project_id=p_project AND entity_id=p_entity) OR
       EXISTS(SELECT 1 FROM studio_scenario_requirements WHERE project_id=p_project AND requirement_id=p_entity) THEN
      RAISE EXCEPTION 'only requirements may have scenario sources';
    END IF;
    RETURN;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM studio_entity_scenario_sources WHERE project_id=p_project AND entity_id=p_entity) THEN
    RAISE EXCEPTION 'draft requirement % requires at least one confirmed scenario source', p_entity;
  END IF;
  IF EXISTS(
    SELECT 1 FROM studio_entity_scenario_sources s
    JOIN studio_confirmations f ON f.id=s.scenario_confirmation_id
    JOIN studio_entities e ON e.project_id=f.project_id AND e.id=f.entity_id
    WHERE s.project_id=p_project AND s.entity_id=p_entity AND
      (f.project_id<>p_project OR e.kind<>'scenario' OR f.stage<>'material')
  ) THEN
    RAISE EXCEPTION 'draft requirement sources must be fixed scenario material versions of the same project';
  END IF;
  IF (SELECT count(*)<>count(DISTINCT f.entity_id) FROM studio_entity_scenario_sources s
      JOIN studio_confirmations f ON f.id=s.scenario_confirmation_id WHERE s.project_id=p_project AND s.entity_id=p_entity) THEN
    RAISE EXCEPTION 'a draft requirement must bind one fixed version per scenario';
  END IF;
  IF EXISTS(
    SELECT 1 FROM studio_scenario_requirements r WHERE r.project_id=p_project AND r.requirement_id=p_entity AND
      NOT EXISTS(SELECT 1 FROM studio_entity_scenario_sources s JOIN studio_confirmations f ON f.id=s.scenario_confirmation_id
        WHERE s.project_id=p_project AND s.entity_id=p_entity AND f.entity_id=r.scenario_id)
  ) OR EXISTS(
    SELECT 1 FROM studio_entity_scenario_sources s JOIN studio_confirmations f ON f.id=s.scenario_confirmation_id
    WHERE s.project_id=p_project AND s.entity_id=p_entity AND NOT EXISTS(
      SELECT 1 FROM studio_scenario_requirements r WHERE r.project_id=p_project AND r.requirement_id=p_entity AND r.scenario_id=f.entity_id)
  ) THEN
    RAISE EXCEPTION 'draft requirement scenario relations must match its fixed sources';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION studio_check_draft_requirement_sources() RETURNS trigger AS $$
DECLARE
  old_project text;
  old_entity text;
  new_project text;
  new_entity text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_project=OLD.project_id;
    IF TG_TABLE_NAME='studio_entities' THEN old_entity=OLD.id;
    ELSIF TG_TABLE_NAME='studio_scenario_requirements' THEN old_entity=OLD.requirement_id;
    ELSE old_entity=OLD.entity_id; END IF;
    PERFORM studio_assert_draft_requirement_sources(old_project,old_entity);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_project=NEW.project_id;
    IF TG_TABLE_NAME='studio_entities' THEN new_entity=NEW.id;
    ELSIF TG_TABLE_NAME='studio_scenario_requirements' THEN new_entity=NEW.requirement_id;
    ELSE new_entity=NEW.entity_id; END IF;
    IF TG_OP='INSERT' OR new_project IS DISTINCT FROM old_project OR new_entity IS DISTINCT FROM old_entity THEN
      PERFORM studio_assert_draft_requirement_sources(new_project,new_entity);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER studio_draft_sources_entity AFTER INSERT OR UPDATE ON studio_entities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_draft_requirement_sources();
CREATE CONSTRAINT TRIGGER studio_draft_sources_binding AFTER INSERT OR UPDATE OR DELETE ON studio_entity_scenario_sources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_draft_requirement_sources();
CREATE CONSTRAINT TRIGGER studio_draft_sources_relation AFTER INSERT OR UPDATE OR DELETE ON studio_scenario_requirements
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_draft_requirement_sources();

-- 来源目标必须为同项目真实场景材料版本；数量检查阻止接受后追加。
CREATE FUNCTION studio_check_fixed_scenario_source() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM studio_confirmations r
    JOIN studio_entities re ON re.project_id=r.project_id AND re.id=r.entity_id
    JOIN studio_confirmations sc ON sc.id=NEW.scenario_confirmation_id
    JOIN studio_entities se ON se.project_id=sc.project_id AND se.id=sc.entity_id
    WHERE r.id=NEW.confirmation_id AND r.project_id=NEW.project_id AND sc.project_id=NEW.project_id AND
      sc.entity_id=NEW.scenario_id AND re.kind='requirement' AND r.stage='material' AND se.kind='scenario' AND sc.stage='material'
  ) THEN RAISE EXCEPTION 'requirement sources must be confirmed scenario material versions of the same project'; END IF;
  PERFORM studio_assert_confirmation_sources(NEW.confirmation_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER studio_fixed_scenario_source AFTER INSERT ON studio_requirement_sources
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_fixed_scenario_source();

-- 初始化接受只能从已分配项目开始；提交时同时存在就绪项目、固定系统版本与目录投影。
CREATE FUNCTION studio_guard_initialization() RETURNS trigger AS $$
DECLARE project_state studio_project_state;
BEGIN
  SELECT state INTO project_state FROM studio_projects WHERE id=NEW.project_id FOR UPDATE;
  IF project_state<>'assigned' THEN RAISE EXCEPTION 'initialization acceptance requires an assigned project'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER studio_initialization_guard BEFORE INSERT ON studio_project_initializations
  FOR EACH ROW EXECUTE FUNCTION studio_guard_initialization();
CREATE TRIGGER studio_initialization_immutable BEFORE UPDATE OR DELETE ON studio_project_initializations
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();

CREATE FUNCTION studio_assert_project_initialized(p_project text, p_initial_head text DEFAULT NULL) RETURNS void AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM studio_projects p
    JOIN studio_project_initializations i ON i.project_id=p.id
    JOIN studio_entities e ON e.project_id=p.id AND e.builtin_key='general' AND e.kind='scenario'
    JOIN studio_confirmations c ON c.id=e.current_confirmation_id AND c.project_id=p.id AND c.entity_id=e.id
    WHERE p.id=p_project AND p.state='ready' AND e.confirmation_status='confirmed' AND e.material_version=1 AND
      c.version=1 AND c.stage='material' AND c.acceptance_kind='system-provisioned' AND c.initialization_id=i.id AND
      c.commit_sha=i.commit_sha AND (p_initial_head IS NULL OR (p.recognized_head=p_initial_head AND i.commit_sha=p_initial_head))
  ) THEN RAISE EXCEPTION 'ready project requires its accepted initialization and immutable general scenario version'; END IF;
END;
$$ LANGUAGE plpgsql;
CREATE FUNCTION studio_check_initialization_acceptance() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME='studio_project_initializations' THEN
    PERFORM studio_assert_project_initialized(NEW.project_id,NEW.commit_sha);
  ELSIF NEW.state='ready' THEN
    IF TG_OP='INSERT' THEN
      PERFORM studio_assert_project_initialized(NEW.id,NEW.recognized_head);
    ELSIF OLD.state<>'ready' THEN
      PERFORM studio_assert_project_initialized(NEW.id,NEW.recognized_head);
    ELSE
      PERFORM studio_assert_project_initialized(NEW.id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER studio_initialization_acceptance AFTER INSERT ON studio_project_initializations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_initialization_acceptance();
CREATE CONSTRAINT TRIGGER studio_project_ready_acceptance AFTER INSERT OR UPDATE ON studio_projects
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_initialization_acceptance();

CREATE FUNCTION studio_guard_builtin_entity() RETURNS trigger AS $$
BEGIN
  IF OLD.builtin_key IS NOT NULL AND EXISTS (SELECT 1 FROM studio_projects WHERE id=OLD.project_id AND state='ready') THEN
    RAISE EXCEPTION 'system built-in scenario is immutable';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER studio_builtin_entity_guard BEFORE UPDATE OR DELETE ON studio_entities
  FOR EACH ROW EXECUTE FUNCTION studio_guard_builtin_entity();

CREATE FUNCTION studio_guard_builtin_control() RETURNS trigger AS $$
DECLARE target_project text; target_entity text;
BEGIN
  IF TG_TABLE_NAME='studio_adoptions' THEN target_project=NEW.source_project_id; target_entity=NEW.source_entity_id;
  ELSE target_project=NEW.project_id; target_entity=NEW.entity_id; END IF;
  IF EXISTS (SELECT 1 FROM studio_entities WHERE project_id=target_project AND id=target_entity AND builtin_key IS NOT NULL) THEN
    IF TG_TABLE_NAME='studio_eligibility' THEN
      IF NEW.enabled THEN RAISE EXCEPTION 'built-in scenario cannot be reused'; END IF;
    ELSE
      RAISE EXCEPTION 'built-in scenario cannot be occupied, repaired or reused';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER studio_builtin_occupation_guard BEFORE INSERT OR UPDATE ON studio_occupations
  FOR EACH ROW EXECUTE FUNCTION studio_guard_builtin_control();
CREATE TRIGGER studio_builtin_repair_guard BEFORE INSERT OR UPDATE ON studio_repair_tasks
  FOR EACH ROW EXECUTE FUNCTION studio_guard_builtin_control();
CREATE TRIGGER studio_builtin_eligibility_guard BEFORE INSERT OR UPDATE ON studio_eligibility
  FOR EACH ROW EXECUTE FUNCTION studio_guard_builtin_control();
CREATE TRIGGER studio_builtin_adoption_guard BEFORE INSERT OR UPDATE ON studio_adoptions
  FOR EACH ROW EXECUTE FUNCTION studio_guard_builtin_control();

-- 前置材料关系只约束真实版本；完成证据在原型认领与完成时由服务事务核验。
CREATE FUNCTION studio_check_prerequisite_reference() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM studio_entities WHERE project_id=NEW.project_id AND id=NEW.requirement_id AND kind='requirement') THEN
    RAISE EXCEPTION 'prerequisite must reference a requirement in the same project';
  END IF;
  IF TG_TABLE_NAME='studio_prerequisites' THEN
    IF NOT EXISTS (SELECT 1 FROM studio_entities WHERE project_id=NEW.project_id AND id=NEW.entity_id AND kind='requirement') THEN
      RAISE EXCEPTION 'only requirements may define prerequisite relations';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER studio_prerequisite_reference BEFORE INSERT OR UPDATE ON studio_prerequisites
  FOR EACH ROW EXECUTE FUNCTION studio_check_prerequisite_reference();

-- 冲突及涉及材料数量随对比封存，接受后不能再补。
CREATE FUNCTION studio_assert_comparison(p_project text,p_comparison text) RETURNS void AS $$
DECLARE comparison studio_consistency_comparisons%ROWTYPE;
BEGIN
  SELECT * INTO comparison FROM studio_consistency_comparisons WHERE project_id=p_project AND id=p_comparison;
  IF NOT FOUND THEN RETURN; END IF;
  IF comparison.conflict_count<>(SELECT count(*) FROM studio_consistency_conflicts WHERE project_id=p_project AND comparison_id=p_comparison) THEN
    RAISE EXCEPTION 'comparison conflict count must match';
  END IF;
  IF EXISTS (
    SELECT 1 FROM studio_consistency_conflicts c WHERE c.project_id=p_project AND c.comparison_id=p_comparison AND
      c.entity_count<>(SELECT count(*) FROM studio_consistency_conflict_entities e WHERE e.project_id=c.project_id AND e.comparison_id=c.comparison_id AND e.conflict_id=c.id)
  ) THEN RAISE EXCEPTION 'conflict entity count must match'; END IF;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_assert_comparison IS '校验冲突封存数量';
CREATE FUNCTION studio_check_comparison_collection() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME='studio_consistency_comparisons' THEN
    PERFORM studio_assert_comparison(NEW.project_id,NEW.id);
  ELSE
    PERFORM studio_assert_comparison(NEW.project_id,NEW.comparison_id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER studio_comparison_collection AFTER INSERT ON studio_consistency_comparisons
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();
CREATE CONSTRAINT TRIGGER studio_conflict_collection AFTER INSERT ON studio_consistency_conflicts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();
CREATE CONSTRAINT TRIGGER studio_conflict_entity_collection AFTER INSERT ON studio_consistency_conflict_entities
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();

-- 对比、冲突及涉及材料都是不可变快照。
CREATE TRIGGER studio_comparison_immutable BEFORE UPDATE OR DELETE ON studio_consistency_comparisons
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_conflict_immutable BEFORE UPDATE OR DELETE ON studio_consistency_conflicts
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_conflict_entity_immutable BEFORE UPDATE OR DELETE ON studio_consistency_conflict_entities
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();

CREATE TRIGGER studio_status_report_immutable BEFORE UPDATE OR DELETE ON studio_material_status_reports
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();

-- 项目原型身份与独立事项。材料占用和原型开发权使用不同的代次与生命周期。
CREATE TABLE studio_prototypes (
  id text PRIMARY KEY,
  project_id text NOT NULL UNIQUE REFERENCES studio_projects(id),
  current_baseline_id text,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  created_date timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,id)
);
CREATE TABLE studio_prototype_tasks (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  prototype_id text NOT NULL,
  owner_id bigint NOT NULL REFERENCES studio_users(id),
  client_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  status text NOT NULL CHECK (status IN ('active','cancelled','released','accepted')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  branch text NOT NULL,
  start_head text NOT NULL CHECK (start_head ~ '^[a-f0-9]{40}$'),
  source_base_head text NOT NULL CHECK (source_base_head ~ '^[a-f0-9]{40}$'),
  write_scope text[] NOT NULL,
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
  claims_digest text NOT NULL CHECK (claims_digest ~ '^[a-f0-9]{64}$'),
  instruction jsonb NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,prototype_id) REFERENCES studio_prototypes(project_id,id),
  UNIQUE (project_id,id), UNIQUE (project_id,branch)
);
CREATE TABLE studio_prototype_development_claims (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  task_id text NOT NULL,
  requirement_id text NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  active boolean NOT NULL DEFAULT true,
  ended_reason text,
  created_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,task_id) REFERENCES studio_prototype_tasks(project_id,id),
  FOREIGN KEY (project_id,requirement_id) REFERENCES studio_entities(project_id,id),
  UNIQUE (project_id,task_id,requirement_id), UNIQUE (project_id,requirement_id,generation)
);
CREATE UNIQUE INDEX studio_one_active_prototype_requirement_claim
  ON studio_prototype_development_claims(project_id,requirement_id) WHERE active;
CREATE TABLE studio_prototype_task_references (
  project_id text NOT NULL,
  task_id text NOT NULL,
  requirement_id text NOT NULL,
  PRIMARY KEY (project_id,task_id,requirement_id),
  FOREIGN KEY (project_id,task_id) REFERENCES studio_prototype_tasks(project_id,id),
  FOREIGN KEY (project_id,requirement_id) REFERENCES studio_entities(project_id,id)
);

CREATE TABLE studio_prototype_integrations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  prototype_id text NOT NULL,
  task_id text NOT NULL,
  owner_id bigint NOT NULL REFERENCES studio_users(id),
  status text NOT NULL CHECK (status IN ('prepared','accepted','aborted')),
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  expected_head text NOT NULL CHECK (expected_head ~ '^[a-f0-9]{40}$'),
  candidate_sha text NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
  request jsonb NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,prototype_id) REFERENCES studio_prototypes(project_id,id),
  FOREIGN KEY (project_id,task_id) REFERENCES studio_prototype_tasks(project_id,id),
  UNIQUE (project_id,id)
);
CREATE UNIQUE INDEX studio_one_prepared_prototype_integration ON studio_prototype_integrations(project_id) WHERE status='prepared';
CREATE TABLE studio_prototype_acceptances (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  prototype_id text NOT NULL,
  task_id text NOT NULL UNIQUE,
  integration_id text NOT NULL UNIQUE,
  confirmation_id text NOT NULL,
  source_sha text NOT NULL,
  candidate_sha text NOT NULL,
  confirmed_by bigint NOT NULL REFERENCES studio_users(id),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,prototype_id) REFERENCES studio_prototypes(project_id,id),
  FOREIGN KEY (project_id,task_id) REFERENCES studio_prototype_tasks(project_id,id),
  FOREIGN KEY (project_id,integration_id) REFERENCES studio_prototype_integrations(project_id,id),
  UNIQUE(project_id,id)
);
CREATE TABLE studio_prototype_baselines (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  prototype_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  acceptance_id text NOT NULL UNIQUE,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  FOREIGN KEY (project_id,prototype_id) REFERENCES studio_prototypes(project_id,id),
  FOREIGN KEY (project_id,acceptance_id) REFERENCES studio_prototype_acceptances(project_id,id),
  UNIQUE(project_id,id), UNIQUE(prototype_id,sequence)
);
CREATE TABLE studio_prototype_acceptance_requirements (
  project_id text NOT NULL, acceptance_id text NOT NULL, requirement_id text NOT NULL,
  PRIMARY KEY(project_id,acceptance_id,requirement_id),
  FOREIGN KEY(project_id,acceptance_id) REFERENCES studio_prototype_acceptances(project_id,id),
  FOREIGN KEY(project_id,requirement_id) REFERENCES studio_entities(project_id,id)
);
CREATE TABLE studio_prototype_baseline_requirements (
  project_id text NOT NULL, baseline_id text NOT NULL, requirement_id text NOT NULL,
  PRIMARY KEY(project_id,baseline_id,requirement_id),
  FOREIGN KEY(project_id,baseline_id) REFERENCES studio_prototype_baselines(project_id,id),
  FOREIGN KEY(project_id,requirement_id) REFERENCES studio_entities(project_id,id)
);
ALTER TABLE studio_prototypes ADD FOREIGN KEY(project_id,current_baseline_id) REFERENCES studio_prototype_baselines(project_id,id);
ALTER TABLE studio_projects ADD FOREIGN KEY(id,deployment_baseline_id) REFERENCES studio_prototype_baselines(project_id,id);
CREATE TABLE studio_prototype_adoptions (
  id text PRIMARY KEY,
  source_project_id text NOT NULL,
  source_baseline_id text NOT NULL,
  target_project_id text NOT NULL,
  target_task_id text NOT NULL,
  adjustment_summary text NOT NULL,
  status studio_adoption_status NOT NULL,
  target_baseline_id text,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  created_date timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz,
  FOREIGN KEY(source_project_id,source_baseline_id) REFERENCES studio_prototype_baselines(project_id,id),
  FOREIGN KEY(target_project_id,target_task_id) REFERENCES studio_prototype_tasks(project_id,id),
  FOREIGN KEY(target_project_id,target_baseline_id) REFERENCES studio_prototype_baselines(project_id,id)
);
