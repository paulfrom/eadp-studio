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
--   需求固定来源随确认创建，审计以确认行为准；比较输入、未覆盖项、范围和涉及输入随比较接受，审计继承父比较。
--   系统预置版本不填写业务确认人；真实初始化发起人保存在初始化接受记录中。
--
-- 状态字段一律使用 PostgreSQL 枚举类型，不用自由文本。
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

CREATE TYPE studio_confirmation_stage AS ENUM ('material','prototype');
CREATE TYPE studio_acceptance_kind AS ENUM ('user-confirmed','system-provisioned');
CREATE TYPE studio_adoption_scope AS ENUM ('material-package','prototype-package');
CREATE TYPE studio_adoption_status AS ENUM ('accepted','succeeded');

CREATE TYPE studio_entity_kind AS ENUM ('scenario','requirement','baseline','handoff');
COMMENT ON TYPE studio_entity_kind IS '资产种类';

CREATE TYPE studio_confirmation_status AS ENUM ('draft','confirmed');
COMMENT ON TYPE studio_confirmation_status IS '确认状态';

CREATE TYPE studio_task_status AS ENUM ('idle','active','aborted','completed');
COMMENT ON TYPE studio_task_status IS '任务状态';

-- 材料整理与原型生产分别占用当前资产。
CREATE TYPE studio_occupation_purpose AS ENUM ('design','prototype');
COMMENT ON TYPE studio_occupation_purpose IS '占用用途';

CREATE TYPE studio_occupation_finish AS ENUM ('aborted','completed');
COMMENT ON TYPE studio_occupation_finish IS '占用结束方式';

-- 模板使用独立项目受控配置发布，不领取材料占用或确认材料
CREATE TYPE studio_integration_scope AS ENUM ('material','prototype','template');
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
CREATE TYPE studio_comparison_result AS ENUM ('completed','failed','cancelled');
CREATE TYPE studio_comparison_coverage AS ENUM ('complete','partial');
CREATE TYPE studio_comparison_failure AS ENUM ('model-failed','timeout','permission-denied','read-failed','context-limit','relationship-unavailable','submission-failed','cancelled','internal-error');
CREATE TYPE studio_local_content_state AS ENUM ('draft','current','unknown');
CREATE TYPE studio_uncovered_reason AS ENUM ('missing','unreadable','invalid-encoding','invalid-identity','read-limit','context-limit','relationship-unavailable');
CREATE TYPE studio_finding_relation AS ENUM ('formal','potential');
CREATE TYPE studio_finding_status AS ENUM ('pending','handled','ignored');
CREATE TYPE studio_finding_action AS ENUM ('handle','ignore','remind','unremind');

-- 控制记录使用有限身份和项目相对路径，拒绝绝对路径、目录穿越及本机路径。
CREATE DOMAIN studio_control_id AS varchar(100) CHECK (length(VALUE)>0);
CREATE DOMAIN studio_relative_path AS varchar(400) CHECK (
  length(VALUE)>0 AND VALUE !~ '(^/|^[A-Za-z]:|\\|(^|/)[.]{1,2}(/|$)|//)' AND VALUE !~ '[[:cntrl:]]'
);

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
  gitlab_user_id bigint UNIQUE CHECK (gitlab_user_id > 0),
  gitlab_username text,
  gitlab_email text,
  CHECK ((gitlab_user_id IS NULL AND gitlab_username IS NULL) OR (gitlab_user_id IS NOT NULL AND gitlab_username IS NOT NULL))
);
COMMENT ON TABLE studio_users IS '后台用户与GitLab身份';
COMMENT ON COLUMN studio_users.id IS '系统用户ID';
COMMENT ON COLUMN studio_users.username IS '登录名';
COMMENT ON COLUMN studio_users.name IS '用户姓名';
COMMENT ON COLUMN studio_users.email IS '用户邮箱';
COMMENT ON COLUMN studio_users.admin IS '是否为后台管理员';
COMMENT ON COLUMN studio_users.password_salt IS '口令随机盐';
COMMENT ON COLUMN studio_users.password_hash IS '口令散列';
COMMENT ON COLUMN studio_users.gitlab_user_id IS '绑定的GitLab用户ID';
COMMENT ON COLUMN studio_users.gitlab_username IS '绑定的GitLab用户名';
COMMENT ON COLUMN studio_users.gitlab_email IS '绑定的GitLab邮箱';


-- 登录会话：仅存令牌 SHA-256，不存明文；过期时间索引供到期清理与快速判活
CREATE TABLE studio_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id bigint NOT NULL REFERENCES studio_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE studio_sessions IS '登录会话';
COMMENT ON COLUMN studio_sessions.token_hash IS '会话令牌的SHA-256散列，不保存明文令牌';
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
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  namespace_id bigint NOT NULL,
  namespace_path text NOT NULL,
  path text NOT NULL,
  name text NOT NULL,
  marker text NOT NULL UNIQUE,
  state studio_project_state NOT NULL DEFAULT 'reserved',
  gitlab_project_id bigint UNIQUE CHECK (gitlab_project_id > 0),
  repository_url text,
  stable_branch text NOT NULL DEFAULT 'main',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  recognized_head text CHECK (recognized_head ~ '^[a-f0-9]{40}$'),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),
  last_editor_account varchar(50) NOT NULL,
  last_editor_name varchar(50) NOT NULL,
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  current_baseline_id text,
  deployment_baseline_id text,
  deployment_url text,
  deployment_artifact_sha256 text CHECK (deployment_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  deployed_at timestamptz,
  UNIQUE (creator_id, key),
  UNIQUE (namespace_id, path),
  CHECK (
    (state IN ('reserved','creating') AND gitlab_project_id IS NULL AND repository_url IS NULL) OR
    (state IN ('created','assigned','ready') AND gitlab_project_id IS NOT NULL AND repository_url IS NOT NULL AND btrim(repository_url) <> '')
  ),
  CHECK ((state = 'ready' AND recognized_head IS NOT NULL) OR (state <> 'ready' AND recognized_head IS NULL))
);
COMMENT ON TABLE studio_projects IS '项目及其创建、认可版本与部署控制事实';
COMMENT ON COLUMN studio_projects.id IS '项目技术ID';
COMMENT ON COLUMN studio_projects.key IS '项目创建幂等键';
COMMENT ON COLUMN studio_projects.request_hash IS '不可变的原创建请求指纹';
COMMENT ON COLUMN studio_projects.namespace_id IS 'GitLab命名空间ID';
COMMENT ON COLUMN studio_projects.namespace_path IS 'GitLab命名空间路径';
COMMENT ON COLUMN studio_projects.path IS 'GitLab项目仓库路径名';
COMMENT ON COLUMN studio_projects.name IS '项目显示名称';
COMMENT ON COLUMN studio_projects.marker IS '建仓归属核对标记';
COMMENT ON COLUMN studio_projects.state IS '项目创建与就绪状态';
COMMENT ON COLUMN studio_projects.gitlab_project_id IS '已绑定的GitLab项目ID';
COMMENT ON COLUMN studio_projects.repository_url IS '已绑定的Git仓库地址';
COMMENT ON COLUMN studio_projects.stable_branch IS '稳定集成分支名';
COMMENT ON COLUMN studio_projects.revision IS '项目级并发修订号';
COMMENT ON COLUMN studio_projects.recognized_head IS '后台已认可的稳定分支提交';
COMMENT ON COLUMN studio_projects.creator_id IS '项目创建人用户ID';
COMMENT ON COLUMN studio_projects.creator_account IS '项目创建人账号快照';
COMMENT ON COLUMN studio_projects.creator_name IS '项目创建人姓名快照';
COMMENT ON COLUMN studio_projects.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_projects.last_editor_id IS '项目最后修改人用户ID';
COMMENT ON COLUMN studio_projects.last_editor_account IS '项目最后修改人账号快照';
COMMENT ON COLUMN studio_projects.last_editor_name IS '项目最后修改人姓名快照';
COMMENT ON COLUMN studio_projects.last_edited_date IS '记录最后修改时间';
COMMENT ON COLUMN studio_projects.current_baseline_id IS '当前已接受的原型基线ID';
COMMENT ON COLUMN studio_projects.deployment_baseline_id IS '当前部署对应的基线ID';
COMMENT ON COLUMN studio_projects.deployment_url IS '当前部署访问地址';
COMMENT ON COLUMN studio_projects.deployment_artifact_sha256 IS '当前部署产物的SHA-256';
COMMENT ON COLUMN studio_projects.deployed_at IS '当前部署完成时间';


-- 项目初始化核验接受事实与系统预置版本共同提交，响应未知时按原操作查询。
CREATE TABLE studio_project_initializations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  project_id text NOT NULL UNIQUE REFERENCES studio_projects(id),
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 100),
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  verified_at timestamptz NOT NULL DEFAULT now(),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id,id),
  UNIQUE (project_id,operation_key)
);
COMMENT ON TABLE studio_project_initializations IS '真实项目初始化核验后的接受事实，发起人不等于材料业务确认人';
COMMENT ON COLUMN studio_project_initializations.id IS '初始化接受操作ID';
COMMENT ON COLUMN studio_project_initializations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_project_initializations.operation_key IS '初始化接受幂等键';
COMMENT ON COLUMN studio_project_initializations.request_hash IS '原初始化接受请求指纹';
COMMENT ON COLUMN studio_project_initializations.commit_sha IS '已核验的实际初始化提交';
COMMENT ON COLUMN studio_project_initializations.verified_at IS '初始化固定内容核验时间';
COMMENT ON COLUMN studio_project_initializations.creator_id IS '初始化发起人用户ID';
COMMENT ON COLUMN studio_project_initializations.creator_account IS '初始化发起人账号快照';
COMMENT ON COLUMN studio_project_initializations.creator_name IS '初始化发起人姓名快照';
COMMENT ON COLUMN studio_project_initializations.created_date IS '初始化接受事实记录时间';


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
  scope studio_integration_scope NOT NULL,
  entity_id text,
  occupation_id text,
  expected_project_revision integer,
  baseline_id text,
  status studio_integration_status NOT NULL,
  source_sha text NOT NULL CHECK (source_sha ~ '^[a-f0-9]{40}$'),
  expected_head text NOT NULL CHECK (expected_head ~ '^[a-f0-9]{40}$'),
  candidate_sha text NOT NULL CHECK (candidate_sha ~ '^[a-f0-9]{40}$'),
  allowed_paths text[] NOT NULL,
  request jsonb NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),
  last_editor_account varchar(50) NOT NULL,
  last_editor_name varchar(50) NOT NULL,
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'template' AND entity_id IS NULL AND occupation_id IS NULL AND expected_project_revision IS NOT NULL) OR
         (scope <> 'template' AND entity_id IS NOT NULL AND occupation_id IS NOT NULL))
);
COMMENT ON TABLE studio_integrations IS '固定候选提交的准备、接受与中止操作';
COMMENT ON COLUMN studio_integrations.id IS '集成操作ID';
COMMENT ON COLUMN studio_integrations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_integrations.scope IS '材料、原型或模板集成范围';
COMMENT ON COLUMN studio_integrations.entity_id IS '本次集成的目标材料ID，模板集成为空';
COMMENT ON COLUMN studio_integrations.occupation_id IS '目标材料的有效占用ID，模板集成为空';
COMMENT ON COLUMN studio_integrations.expected_project_revision IS '模板发布预期的项目修订号';
COMMENT ON COLUMN studio_integrations.baseline_id IS '原型完成后形成的基线ID';
COMMENT ON COLUMN studio_integrations.status IS '集成操作状态';
COMMENT ON COLUMN studio_integrations.source_sha IS '本次集成的来源提交';
COMMENT ON COLUMN studio_integrations.expected_head IS '条件更新稳定分支时预期的原分支头';
COMMENT ON COLUMN studio_integrations.candidate_sha IS '待接受的精确候选提交';
COMMENT ON COLUMN studio_integrations.allowed_paths IS '本次候选允许修改的项目相对路径集合';
COMMENT ON COLUMN studio_integrations.request IS '结果核对所需控制协议，不保存业务材料或清单';
COMMENT ON COLUMN studio_integrations.creator_id IS '集成发起人用户ID';
COMMENT ON COLUMN studio_integrations.creator_account IS '集成发起人账号快照';
COMMENT ON COLUMN studio_integrations.creator_name IS '集成发起人姓名快照';
COMMENT ON COLUMN studio_integrations.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_integrations.last_editor_id IS '集成操作最后执行人用户ID';
COMMENT ON COLUMN studio_integrations.last_editor_account IS '集成操作最后执行人账号快照';
COMMENT ON COLUMN studio_integrations.last_editor_name IS '集成操作最后执行人姓名快照';
COMMENT ON COLUMN studio_integrations.last_edited_date IS '记录最后修改时间';

CREATE UNIQUE INDEX studio_one_prepared_integration ON studio_integrations(project_id) WHERE status = 'prepared';

-- ============================================================
-- 实体（场景 / 需求）、业务编号与关联
-- ============================================================

-- 按项目和材料类型分配编号，行锁序列化，各序列分别从 1 起
CREATE TABLE studio_project_counters (
  project_id text NOT NULL REFERENCES studio_projects(id),
  kind studio_entity_kind NOT NULL CHECK (kind IN ('scenario','requirement')),
  PRIMARY KEY (project_id,kind),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0)
);
COMMENT ON TABLE studio_project_counters IS '按项目和材料类型分配稳定编号的计数器';
COMMENT ON COLUMN studio_project_counters.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_project_counters.kind IS '编号所属材料类型，场景与需求独立计数';
COMMENT ON COLUMN studio_project_counters.next_sequence IS '本类型下一次分配的序号';


-- 场景、需求及后续阶段材料实体：
--   id 为隐藏 UUID 技术身份，文件路径按名称生成（场景/<名称>.md），界面只展示业务编号；
--   场景和需求按类型持有稳定编号，改名与修订不变，不可手改、重排或回收；
--   title/summary 入库用于目录投影，确认时随固定版本快照保存；
--   普通场景与需求分别绑定模板固定引用 {commitSha,path,sha256}；内置说明不绑定编辑模板；
--   确认状态与任务状态分列；列表默认按 last_edited_date 降序、sequence 稳定次序
CREATE TABLE studio_entities (
  project_id text NOT NULL REFERENCES studio_projects(id),
  id text NOT NULL,
  kind studio_entity_kind NOT NULL,
  sequence bigint CHECK (sequence > 0),
  code text CHECK (code = CASE kind WHEN 'scenario' THEN 'SC-' WHEN 'requirement' THEN 'REQ-' END || lpad(sequence::text, greatest(4,length(sequence::text)), '0')),
  builtin_key text CHECK (builtin_key = 'general'),
  template_id text,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  material_version integer NOT NULL DEFAULT 0 CHECK (material_version >= 0),
  confirmation_status studio_confirmation_status NOT NULL DEFAULT 'draft',
  task_status studio_task_status NOT NULL DEFAULT 'idle',
  template_ref jsonb,
  current_confirmation_id text,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),
  last_editor_account varchar(50) NOT NULL,
  last_editor_name varchar(50) NOT NULL,
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
COMMENT ON TABLE studio_entities IS '场景、需求及后续阶段材料的身份与协同目录';
COMMENT ON COLUMN studio_entities.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_entities.id IS '材料UUID技术身份，同时用于固定文件路径';
COMMENT ON COLUMN studio_entities.kind IS '材料种类';
COMMENT ON COLUMN studio_entities.sequence IS '项目与材料类型内的稳定编号序号';
COMMENT ON COLUMN studio_entities.code IS '稳定业务编号，场景为SC前缀，需求为REQ前缀';
COMMENT ON COLUMN studio_entities.builtin_key IS '系统内置场景身份，general表示项目内唯一的通用场景';
COMMENT ON COLUMN studio_entities.template_id IS '当前绑定的项目模板ID，系统内置场景为空';
COMMENT ON COLUMN studio_entities.title IS '材料目录标题';
COMMENT ON COLUMN studio_entities.summary IS '材料目录摘要';
COMMENT ON COLUMN studio_entities.revision IS '材料级并发修订号';
COMMENT ON COLUMN studio_entities.generation IS '材料占用代数，用于隔离已失效占用';
COMMENT ON COLUMN studio_entities.material_version IS '当前已接受的材料版本号';
COMMENT ON COLUMN studio_entities.confirmation_status IS '材料内容确认状态';
COMMENT ON COLUMN studio_entities.task_status IS '材料整理或原型生产任务状态';
COMMENT ON COLUMN studio_entities.template_ref IS '当前模板固定引用，包含提交、路径和内容哈希';
COMMENT ON COLUMN studio_entities.current_confirmation_id IS '当前已接受材料版本的确认记录ID';
COMMENT ON COLUMN studio_entities.creator_id IS '材料创建人用户ID';
COMMENT ON COLUMN studio_entities.creator_account IS '材料创建人账号快照';
COMMENT ON COLUMN studio_entities.creator_name IS '材料创建人姓名快照';
COMMENT ON COLUMN studio_entities.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_entities.last_editor_id IS '材料最后编辑人用户ID';
COMMENT ON COLUMN studio_entities.last_editor_account IS '材料最后编辑人账号快照';
COMMENT ON COLUMN studio_entities.last_editor_name IS '材料最后编辑人姓名快照';
COMMENT ON COLUMN studio_entities.last_edited_date IS '记录最后修改时间';

CREATE INDEX studio_entities_updated ON studio_entities(project_id, last_edited_date DESC, sequence);

-- 编号预留：先分配后记实体；同一新建 operation_key 重试返回同一编号；
-- 分配后失败不回收；预留同时确定 entity_id，但不要求业务实体已经写入
CREATE TABLE studio_entity_numbers (
  project_id text NOT NULL REFERENCES studio_projects(id),
  kind studio_entity_kind NOT NULL CHECK (kind IN ('scenario','requirement')),
  sequence bigint NOT NULL CHECK (sequence > 0),
  code text NOT NULL CHECK (code = CASE kind WHEN 'scenario' THEN 'SC-' WHEN 'requirement' THEN 'REQ-' END || lpad(sequence::text, greatest(4,length(sequence::text)), '0')),
  operation_key text NOT NULL,
  entity_id text NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, kind, sequence),
  UNIQUE (project_id, code),
  UNIQUE (project_id, operation_key),
  UNIQUE (project_id, entity_id),
  UNIQUE (project_id, entity_id, kind, sequence)
);
COMMENT ON TABLE studio_entity_numbers IS '新建材料前独立持久化的稳定编号预留，不回收编号';
COMMENT ON COLUMN studio_entity_numbers.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_entity_numbers.kind IS '预留编号所属材料类型';
COMMENT ON COLUMN studio_entity_numbers.sequence IS '项目与材料类型内已分配的序号';
COMMENT ON COLUMN studio_entity_numbers.code IS '已分配的稳定业务编号';
COMMENT ON COLUMN studio_entity_numbers.operation_key IS '新建材料操作幂等键';
COMMENT ON COLUMN studio_entity_numbers.entity_id IS '预留的材料UUID技术身份';
COMMENT ON COLUMN studio_entity_numbers.request_hash IS '原新建请求指纹';
COMMENT ON COLUMN studio_entity_numbers.creator_id IS '编号预留发起人用户ID';
COMMENT ON COLUMN studio_entity_numbers.creator_account IS '编号预留发起人账号快照';
COMMENT ON COLUMN studio_entity_numbers.creator_name IS '编号预留发起人姓名快照';
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
COMMENT ON TABLE studio_scenario_requirements IS '需求当前正式关联的场景集合';
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
  path text NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, entity_id, path),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id)
);
COMMENT ON TABLE studio_entity_files IS '材料当前关联的项目文件目录，确认清单以Git固定材料为准';
COMMENT ON COLUMN studio_entity_files.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_entity_files.entity_id IS '关联材料ID';
COMMENT ON COLUMN studio_entity_files.path IS '关联文件的项目相对路径';
COMMENT ON COLUMN studio_entity_files.creator_id IS '文件关联建立人用户ID';
COMMENT ON COLUMN studio_entity_files.creator_account IS '文件关联建立人账号快照';
COMMENT ON COLUMN studio_entity_files.creator_name IS '文件关联建立人姓名快照';
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
  purpose studio_occupation_purpose NOT NULL,
  task_id text NOT NULL,
  client_id text NOT NULL,
  expected_revision integer NOT NULL,
  input_version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  finish_status studio_occupation_finish,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),
  last_editor_account varchar(50) NOT NULL,
  last_editor_name varchar(50) NOT NULL,
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id),
  UNIQUE (project_id, entity_id, generation),
  UNIQUE (project_id, entity_id, id),
  UNIQUE (project_id, id),
  CHECK (creator_id = owner_id)
);
COMMENT ON TABLE studio_occupations IS '单材料的持久占用及结束控制事实';
COMMENT ON COLUMN studio_occupations.id IS '占用令牌ID';
COMMENT ON COLUMN studio_occupations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_occupations.entity_id IS '被占用材料ID';
COMMENT ON COLUMN studio_occupations.generation IS '本次占用代数';
COMMENT ON COLUMN studio_occupations.owner_id IS '占有人用户ID';
COMMENT ON COLUMN studio_occupations.purpose IS '材料整理或原型生产占用用途';
COMMENT ON COLUMN studio_occupations.task_id IS '持有占用的任务ID';
COMMENT ON COLUMN studio_occupations.client_id IS '持有占用的客户端ID';
COMMENT ON COLUMN studio_occupations.expected_revision IS '领取占用时绑定的材料修订号';
COMMENT ON COLUMN studio_occupations.input_version IS '领取占用时绑定的材料版本号';
COMMENT ON COLUMN studio_occupations.active IS '占用是否仍有效';
COMMENT ON COLUMN studio_occupations.finish_status IS '占用结束方式，活跃期间为空';
COMMENT ON COLUMN studio_occupations.creator_id IS '占用创建人用户ID，须与占有人一致';
COMMENT ON COLUMN studio_occupations.creator_account IS '占用创建人账号快照';
COMMENT ON COLUMN studio_occupations.creator_name IS '占用创建人姓名快照';
COMMENT ON COLUMN studio_occupations.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_occupations.last_editor_id IS '占用最后处理人用户ID';
COMMENT ON COLUMN studio_occupations.last_editor_account IS '占用最后处理人账号快照';
COMMENT ON COLUMN studio_occupations.last_editor_name IS '占用最后处理人姓名快照';
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
  occupation_id text NOT NULL,
  user_action_id text NOT NULL,
  start_hash text NOT NULL CHECK (start_hash ~ '^[a-f0-9]{64}$'),
  status studio_repair_status NOT NULL,
  rounds_used integer NOT NULL DEFAULT 0 CHECK (rounds_used BETWEEN 0 AND 3),
  termination_reason text,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),
  last_editor_account varchar(50) NOT NULL,
  last_editor_name varchar(50) NOT NULL,
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id),
  FOREIGN KEY (project_id, entity_id, occupation_id) REFERENCES studio_occupations(project_id, entity_id, id),
  UNIQUE (project_id, entity_id, id),
  UNIQUE (project_id, entity_id, user_action_id)
);
COMMENT ON TABLE studio_repair_tasks IS '真实用户授权的有限轮次修复任务';
COMMENT ON COLUMN studio_repair_tasks.id IS '修复任务ID';
COMMENT ON COLUMN studio_repair_tasks.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_repair_tasks.entity_id IS '修复目标材料ID';
COMMENT ON COLUMN studio_repair_tasks.occupation_id IS '修复任务绑定的材料占用ID';
COMMENT ON COLUMN studio_repair_tasks.user_action_id IS '启动修复的真实用户动作ID';
COMMENT ON COLUMN studio_repair_tasks.start_hash IS '修复授权开始时的材料SHA-256';
COMMENT ON COLUMN studio_repair_tasks.status IS '修复任务状态';
COMMENT ON COLUMN studio_repair_tasks.rounds_used IS '累计已使用修复轮数，暂停续接不重置';
COMMENT ON COLUMN studio_repair_tasks.termination_reason IS '任务终止原因';
COMMENT ON COLUMN studio_repair_tasks.creator_id IS '修复授权发起人用户ID';
COMMENT ON COLUMN studio_repair_tasks.creator_account IS '修复授权发起人账号快照';
COMMENT ON COLUMN studio_repair_tasks.creator_name IS '修复授权发起人姓名快照';
COMMENT ON COLUMN studio_repair_tasks.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_repair_tasks.last_editor_id IS '修复任务最后处理人用户ID';
COMMENT ON COLUMN studio_repair_tasks.last_editor_account IS '修复任务最后处理人账号快照';
COMMENT ON COLUMN studio_repair_tasks.last_editor_name IS '修复任务最后处理人姓名快照';
COMMENT ON COLUMN studio_repair_tasks.last_edited_date IS '记录最后修改时间';


-- 修复任务控制事件：保存轮次结果 hash、暂停、显式续接与终止原因；不复制本地修复现场、正文或材料清单
CREATE TABLE studio_repair_task_events (
  task_id text NOT NULL REFERENCES studio_repair_tasks(id),
  seq integer NOT NULL CHECK (seq > 0),
  type studio_repair_event_type NOT NULL,
  hash_after text CHECK (hash_after IS NULL OR hash_after ~ '^[a-f0-9]{64}$'),
  detail jsonb NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, seq)
);
COMMENT ON TABLE studio_repair_task_events IS '修复任务的轮次、暂停、续接与结束事件';
COMMENT ON COLUMN studio_repair_task_events.task_id IS '所属修复任务ID';
COMMENT ON COLUMN studio_repair_task_events.seq IS '任务内递增事件序号';
COMMENT ON COLUMN studio_repair_task_events.type IS '修复事件类型';
COMMENT ON COLUMN studio_repair_task_events.hash_after IS '本轮修复后的材料SHA-256';
COMMENT ON COLUMN studio_repair_task_events.detail IS '有限修复控制信息，不保存正文或本地修复现场';
COMMENT ON COLUMN studio_repair_task_events.creator_id IS '修复事件执行人用户ID';
COMMENT ON COLUMN studio_repair_task_events.creator_account IS '修复事件执行人账号快照';
COMMENT ON COLUMN studio_repair_task_events.creator_name IS '修复事件执行人姓名快照';
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
  version integer NOT NULL CHECK (version > 0),
  stage studio_confirmation_stage NOT NULL DEFAULT 'material',
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL,
  summary text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  path text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  acceptance_kind studio_acceptance_kind NOT NULL DEFAULT 'user-confirmed',
  method studio_confirmation_method,
  read_hash text CHECK (read_hash ~ '^[a-f0-9]{64}$'),
  repair_task_id text REFERENCES studio_repair_tasks(id),
  integration_id text REFERENCES studio_integrations(id),
  initialization_id text,
  creator_id bigint REFERENCES studio_users(id),
  creator_account varchar(50),
  creator_name varchar(50),
  created_date timestamptz NOT NULL DEFAULT now(),
  source_count integer NOT NULL DEFAULT 0 CHECK (source_count BETWEEN 0 AND 100),
  applicability studio_applicability NOT NULL DEFAULT 'applicable',
  applicability_reason text,
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
COMMENT ON TABLE studio_confirmations IS '后台已接受的不可变固定版本，区分用户确认与系统预置';
COMMENT ON COLUMN studio_confirmations.id IS '固定版本接受记录ID';
COMMENT ON COLUMN studio_confirmations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_confirmations.entity_id IS '被接受材料ID';
COMMENT ON COLUMN studio_confirmations.version IS '材料版本号，原型完成沿用其材料版本号';
COMMENT ON COLUMN studio_confirmations.stage IS '材料接受或原型完成阶段';
COMMENT ON COLUMN studio_confirmations.revision IS '接受时对应的材料修订号';
COMMENT ON COLUMN studio_confirmations.title IS '接受时的材料标题快照';
COMMENT ON COLUMN studio_confirmations.summary IS '接受时的材料摘要快照';
COMMENT ON COLUMN studio_confirmations.commit_sha IS '实际固定材料所在提交，原型阶段不替代为完成集成提交';
COMMENT ON COLUMN studio_confirmations.path IS '固定材料的项目相对路径';
COMMENT ON COLUMN studio_confirmations.sha256 IS '固定材料内容的SHA-256';
COMMENT ON COLUMN studio_confirmations.acceptance_kind IS '用户确认或系统预置的互斥接受途径';
COMMENT ON COLUMN studio_confirmations.method IS '用户普通确认或授权修复确认方式，系统预置为空';
COMMENT ON COLUMN studio_confirmations.read_hash IS '用户实际阅读版本的SHA-256，系统预置为空';
COMMENT ON COLUMN studio_confirmations.repair_task_id IS '授权修复确认对应的修复任务ID';
COMMENT ON COLUMN studio_confirmations.integration_id IS '用户确认对应的真实集成操作ID，系统预置为空';
COMMENT ON COLUMN studio_confirmations.initialization_id IS '系统预置对应的真实初始化接受操作ID';
COMMENT ON COLUMN studio_confirmations.creator_id IS '业务确认人用户ID，系统预置为空';
COMMENT ON COLUMN studio_confirmations.creator_account IS '业务确认人账号快照，系统预置为空';
COMMENT ON COLUMN studio_confirmations.creator_name IS '业务确认人姓名快照，系统预置为空';
COMMENT ON COLUMN studio_confirmations.created_date IS '固定版本接受时间，系统预置为初始化接受时间';
COMMENT ON COLUMN studio_confirmations.source_count IS '接受时封存的场景来源数量，须与来源明细数一致';
COMMENT ON COLUMN studio_confirmations.applicability IS '该固定材料版本是否适用';
COMMENT ON COLUMN studio_confirmations.applicability_reason IS '该需求固定版本不适用的明确原因';

CREATE INDEX studio_confirmations_entity ON studio_confirmations(project_id, entity_id, version DESC);

ALTER TABLE studio_entities
  ADD CONSTRAINT studio_entities_current_confirmation_fk
  FOREIGN KEY (project_id, id, current_confirmation_id) REFERENCES studio_confirmations(project_id, entity_id, id);

-- 需求确认绑定的场景固定版本：至少一个、可多个，提交时触发器强制；
-- 仅允许同项目已接受的场景确认版本，不允许无来源或未确认来源
CREATE TABLE studio_requirement_sources (
  project_id text NOT NULL,
  confirmation_id text NOT NULL,
  scenario_id text NOT NULL,
  scenario_confirmation_id text NOT NULL,
  source_stage studio_confirmation_stage NOT NULL DEFAULT 'material' CHECK (source_stage = 'material'),
  PRIMARY KEY (confirmation_id, scenario_id),
  FOREIGN KEY (project_id,confirmation_id) REFERENCES studio_confirmations(project_id,id),
  FOREIGN KEY (project_id,scenario_id,source_stage,scenario_confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,stage,id),
  CHECK (confirmation_id <> scenario_confirmation_id)
);
COMMENT ON TABLE studio_requirement_sources IS '需求固定版本接受时封存的场景来源集合，审计沿用父接受记录';
COMMENT ON COLUMN studio_requirement_sources.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_requirement_sources.confirmation_id IS '需求材料接受记录ID';
COMMENT ON COLUMN studio_requirement_sources.scenario_id IS '来源场景ID，同一次接受仅绑定一个版本';
COMMENT ON COLUMN studio_requirement_sources.scenario_confirmation_id IS '来源场景的固定材料接受记录ID';
COMMENT ON COLUMN studio_requirement_sources.source_stage IS '来源固定版本阶段，限材料阶段';



-- 前置关系绑定已接受材料版本；完成证据仅在原型生产时校验。
CREATE TABLE studio_prerequisites (
  project_id text NOT NULL,
  entity_id text NOT NULL,
  requirement_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  confirmation_id text NOT NULL,
  stage studio_confirmation_stage NOT NULL DEFAULT 'material' CHECK (stage = 'material'),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,entity_id,requirement_id),
  CHECK (entity_id <> requirement_id),
  FOREIGN KEY(project_id,requirement_id,version,stage,confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,version,stage,id),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id),
  FOREIGN KEY(project_id,requirement_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_prerequisites IS '需求当前绑定的前置需求固定材料版本，不提前要求生产完成';
COMMENT ON COLUMN studio_prerequisites.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_prerequisites.entity_id IS '设置前置关系的当前需求ID';
COMMENT ON COLUMN studio_prerequisites.requirement_id IS '前置需求ID';
COMMENT ON COLUMN studio_prerequisites.version IS '绑定的前置需求材料版本号';
COMMENT ON COLUMN studio_prerequisites.confirmation_id IS '该前置材料版本的接受记录ID';
COMMENT ON COLUMN studio_prerequisites.stage IS '前置引用阶段，限材料阶段';
COMMENT ON COLUMN studio_prerequisites.creator_id IS '前置关系建立人用户ID';
COMMENT ON COLUMN studio_prerequisites.creator_account IS '前置关系建立人账号快照';
COMMENT ON COLUMN studio_prerequisites.creator_name IS '前置关系建立人姓名快照';
COMMENT ON COLUMN studio_prerequisites.created_date IS '记录创建时间';

CREATE TABLE studio_occupation_inputs (
  project_id text NOT NULL,
  occupation_id text NOT NULL,
  requirement_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  confirmation_id text NOT NULL,
  stage studio_confirmation_stage NOT NULL DEFAULT 'prototype' CHECK (stage = 'prototype'),
  integration_sha text NOT NULL CHECK(integration_sha ~ '^[a-f0-9]{40}$'),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(occupation_id,requirement_id),
  FOREIGN KEY(project_id,occupation_id) REFERENCES studio_occupations(project_id,id),
  FOREIGN KEY(project_id,requirement_id,version,stage,confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,version,stage,id)
);
COMMENT ON TABLE studio_occupation_inputs IS '原型占用绑定的前置需求已接受完成证据';
COMMENT ON COLUMN studio_occupation_inputs.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_occupation_inputs.occupation_id IS '使用这些前置输入的原型占用ID';
COMMENT ON COLUMN studio_occupation_inputs.requirement_id IS '已完成的前置需求ID';
COMMENT ON COLUMN studio_occupation_inputs.version IS '已完成的前置需求材料版本号';
COMMENT ON COLUMN studio_occupation_inputs.confirmation_id IS '该前置需求版本的原型完成接受记录ID';
COMMENT ON COLUMN studio_occupation_inputs.stage IS '前置完成证据阶段，限原型阶段';
COMMENT ON COLUMN studio_occupation_inputs.integration_sha IS '前置需求完成基线对应的已接受集成提交';
COMMENT ON COLUMN studio_occupation_inputs.creator_id IS '输入绑定记录创建人用户ID';
COMMENT ON COLUMN studio_occupation_inputs.creator_account IS '输入绑定记录创建人账号快照';
COMMENT ON COLUMN studio_occupation_inputs.creator_name IS '输入绑定记录创建人姓名快照';
COMMENT ON COLUMN studio_occupation_inputs.created_date IS '记录创建时间';

CREATE TABLE studio_eligibility (
  project_id text NOT NULL,
  entity_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  enabled boolean NOT NULL,
  reason text NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),
  last_editor_account varchar(50) NOT NULL,
  last_editor_name varchar(50) NOT NULL,
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,entity_id,version),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_eligibility IS '固定材料版本的复用资格与停用原因';
COMMENT ON COLUMN studio_eligibility.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_eligibility.entity_id IS '复用资格所属材料ID';
COMMENT ON COLUMN studio_eligibility.version IS '复用资格所属材料版本号';
COMMENT ON COLUMN studio_eligibility.enabled IS '该固定版本是否允许新的复用采用';
COMMENT ON COLUMN studio_eligibility.reason IS '启用或停用复用资格的原因';
COMMENT ON COLUMN studio_eligibility.creator_id IS '复用资格创建人用户ID';
COMMENT ON COLUMN studio_eligibility.creator_account IS '复用资格创建人账号快照';
COMMENT ON COLUMN studio_eligibility.creator_name IS '复用资格创建人姓名快照';
COMMENT ON COLUMN studio_eligibility.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_eligibility.last_editor_id IS '复用资格最后修改人用户ID';
COMMENT ON COLUMN studio_eligibility.last_editor_account IS '复用资格最后修改人账号快照';
COMMENT ON COLUMN studio_eligibility.last_editor_name IS '复用资格最后修改人姓名快照';
COMMENT ON COLUMN studio_eligibility.last_edited_date IS '记录最后修改时间';

CREATE TABLE studio_baselines (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  version integer NOT NULL CHECK(version>0),
  commit_sha text NOT NULL CHECK(commit_sha ~ '^[a-f0-9]{40}$'),
  confirmation_id text NOT NULL UNIQUE REFERENCES studio_confirmations(id),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id),
  UNIQUE(project_id,entity_id,version),
  UNIQUE(project_id,entity_id,version,confirmation_id,commit_sha)
);
COMMENT ON TABLE studio_baselines IS '单需求原型完成后接受的固定集成基线';
COMMENT ON COLUMN studio_baselines.id IS '原型完成基线ID';
COMMENT ON COLUMN studio_baselines.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_baselines.entity_id IS '已完成的需求ID';
COMMENT ON COLUMN studio_baselines.version IS '本次原型完成对应的需求材料版本号';
COMMENT ON COLUMN studio_baselines.commit_sha IS '已接受的原型完成集成提交，可不同于材料固定提交';
COMMENT ON COLUMN studio_baselines.confirmation_id IS '本次原型完成接受记录ID';
COMMENT ON COLUMN studio_baselines.creator_id IS '原型完成提交人用户ID';
COMMENT ON COLUMN studio_baselines.creator_account IS '原型完成提交人账号快照';
COMMENT ON COLUMN studio_baselines.creator_name IS '原型完成提交人姓名快照';
COMMENT ON COLUMN studio_baselines.created_date IS '记录创建时间';

ALTER TABLE studio_occupation_inputs ADD FOREIGN KEY(project_id,requirement_id,version,confirmation_id,integration_sha)
  REFERENCES studio_baselines(project_id,entity_id,version,confirmation_id,commit_sha);
ALTER TABLE studio_projects ADD FOREIGN KEY(current_baseline_id) REFERENCES studio_baselines(id);
ALTER TABLE studio_integrations ADD FOREIGN KEY(baseline_id) REFERENCES studio_baselines(id);
CREATE TABLE studio_integration_confirmations (
  integration_id text NOT NULL REFERENCES studio_integrations(id),
  confirmation_id text NOT NULL REFERENCES studio_confirmations(id),
  PRIMARY KEY(integration_id,confirmation_id)
);
COMMENT ON TABLE studio_integration_confirmations IS '集成操作与其接受确认记录的关联';
COMMENT ON COLUMN studio_integration_confirmations.integration_id IS '所属集成操作ID';
COMMENT ON COLUMN studio_integration_confirmations.confirmation_id IS '该集成接受的确认记录ID';

CREATE TABLE studio_adoptions (
  id text PRIMARY KEY,
  source_project_id text NOT NULL,
  source_entity_id text NOT NULL,
  source_version integer NOT NULL CHECK(source_version>0),
  target_project_id text NOT NULL,
  target_entity_id text NOT NULL,
  target_task_id text NOT NULL,
  scope studio_adoption_scope NOT NULL,
  adjustment_summary text NOT NULL,
  status studio_adoption_status NOT NULL,
  target_confirmation_id text REFERENCES studio_confirmations(id),
  target_version integer CHECK(target_version>0),
  succeeded_at timestamptz,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),
  last_editor_account varchar(50) NOT NULL,
  last_editor_name varchar(50) NOT NULL,
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(source_project_id,source_entity_id) REFERENCES studio_entities(project_id,id),
  FOREIGN KEY(target_project_id,target_entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_adoptions IS '固定来源版本的复用采用受理与成功控制事实';
COMMENT ON COLUMN studio_adoptions.id IS '复用采用记录ID';
COMMENT ON COLUMN studio_adoptions.source_project_id IS '被采用来源所属项目ID';
COMMENT ON COLUMN studio_adoptions.source_entity_id IS '被采用来源材料ID';
COMMENT ON COLUMN studio_adoptions.source_version IS '被采用的固定来源版本号';
COMMENT ON COLUMN studio_adoptions.target_project_id IS '采用目标所属项目ID';
COMMENT ON COLUMN studio_adoptions.target_entity_id IS '采用目标材料ID';
COMMENT ON COLUMN studio_adoptions.target_task_id IS '执行采用的目标任务ID';
COMMENT ON COLUMN studio_adoptions.scope IS '采用材料包或原型包的范围';
COMMENT ON COLUMN studio_adoptions.adjustment_summary IS '目标采用时的有限调整说明';
COMMENT ON COLUMN studio_adoptions.status IS '采用受理或成功状态';
COMMENT ON COLUMN studio_adoptions.target_confirmation_id IS '采用成功后目标固定版本的接受记录ID';
COMMENT ON COLUMN studio_adoptions.target_version IS '采用成功后目标材料版本号';
COMMENT ON COLUMN studio_adoptions.succeeded_at IS '采用成功时间';
COMMENT ON COLUMN studio_adoptions.creator_id IS '采用发起人用户ID';
COMMENT ON COLUMN studio_adoptions.creator_account IS '采用发起人账号快照';
COMMENT ON COLUMN studio_adoptions.creator_name IS '采用发起人姓名快照';
COMMENT ON COLUMN studio_adoptions.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_adoptions.last_editor_id IS '采用记录最后处理人用户ID';
COMMENT ON COLUMN studio_adoptions.last_editor_account IS '采用记录最后处理人账号快照';
COMMENT ON COLUMN studio_adoptions.last_editor_name IS '采用记录最后处理人姓名快照';
COMMENT ON COLUMN studio_adoptions.last_edited_date IS '记录最后修改时间';

CREATE TABLE studio_handoff_receipts (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  confirmation_id text NOT NULL REFERENCES studio_confirmations(id),
  note text NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id),
  UNIQUE(project_id,entity_id,confirmation_id,creator_id)
);
COMMENT ON TABLE studio_handoff_receipts IS '用户对固定交接材料版本的收悉记录';
COMMENT ON COLUMN studio_handoff_receipts.id IS '交接收悉记录ID';
COMMENT ON COLUMN studio_handoff_receipts.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_handoff_receipts.entity_id IS '交接材料ID';
COMMENT ON COLUMN studio_handoff_receipts.confirmation_id IS '已接受的固定交接版本记录ID';
COMMENT ON COLUMN studio_handoff_receipts.note IS '收悉备注';
COMMENT ON COLUMN studio_handoff_receipts.creator_id IS '交接收悉人用户ID';
COMMENT ON COLUMN studio_handoff_receipts.creator_account IS '交接收悉人账号快照';
COMMENT ON COLUMN studio_handoff_receipts.creator_name IS '交接收悉人姓名快照';
COMMENT ON COLUMN studio_handoff_receipts.created_date IS '记录创建时间';

CREATE UNIQUE INDEX studio_one_active_repair ON studio_repair_tasks(project_id,entity_id,occupation_id) WHERE status IN ('active','paused');

-- 草稿需求也绑定已确认场景的固定版本，不只保存可变场景关联。
CREATE TABLE studio_entity_scenario_sources (
  project_id text NOT NULL,
  entity_id text NOT NULL,
  scenario_confirmation_id text NOT NULL REFERENCES studio_confirmations(id),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(project_id,entity_id,scenario_confirmation_id),
  FOREIGN KEY(project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_entity_scenario_sources IS '需求当前绑定的场景固定版本，允许在需求独立修订中显式调整';
COMMENT ON COLUMN studio_entity_scenario_sources.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_entity_scenario_sources.entity_id IS '绑定来源的需求ID';
COMMENT ON COLUMN studio_entity_scenario_sources.scenario_confirmation_id IS '当前所选场景固定材料版本的接受记录ID';
COMMENT ON COLUMN studio_entity_scenario_sources.creator_id IS '来源绑定记录创建人用户ID';
COMMENT ON COLUMN studio_entity_scenario_sources.creator_account IS '来源绑定记录创建人账号快照';
COMMENT ON COLUMN studio_entity_scenario_sources.creator_name IS '来源绑定记录创建人姓名快照';
COMMENT ON COLUMN studio_entity_scenario_sources.created_date IS '记录创建时间';


-- 复合外键保证占用、修复、确认和派生物不能跨项目或跨实体串接。
ALTER TABLE studio_integrations ADD UNIQUE(project_id,id);
ALTER TABLE studio_integrations ADD UNIQUE(project_id,entity_id,id);
ALTER TABLE studio_confirmations DROP CONSTRAINT studio_confirmations_integration_id_fkey;
ALTER TABLE studio_confirmations ADD FOREIGN KEY(project_id,entity_id,integration_id) REFERENCES studio_integrations(project_id,entity_id,id);
ALTER TABLE studio_confirmations DROP CONSTRAINT studio_confirmations_repair_task_id_fkey;
ALTER TABLE studio_confirmations ADD FOREIGN KEY(project_id,entity_id,repair_task_id) REFERENCES studio_repair_tasks(project_id,entity_id,id);
ALTER TABLE studio_baselines ADD UNIQUE(project_id,id);
ALTER TABLE studio_baselines DROP CONSTRAINT studio_baselines_confirmation_id_fkey;
ALTER TABLE studio_baselines ADD FOREIGN KEY(project_id,entity_id,confirmation_id) REFERENCES studio_confirmations(project_id,entity_id,id);
ALTER TABLE studio_projects DROP CONSTRAINT studio_projects_current_baseline_id_fkey;
ALTER TABLE studio_projects ADD FOREIGN KEY(id,current_baseline_id) REFERENCES studio_baselines(project_id,id);
ALTER TABLE studio_integrations DROP CONSTRAINT studio_integrations_baseline_id_fkey;
ALTER TABLE studio_integrations ADD FOREIGN KEY(project_id,baseline_id) REFERENCES studio_baselines(project_id,id);
ALTER TABLE studio_projects ADD FOREIGN KEY(id,deployment_baseline_id) REFERENCES studio_baselines(project_id,id);
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
  result jsonb NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, key)
);
COMMENT ON TABLE studio_operations IS '响应未知时可查询的幂等操作与有限控制结果';
COMMENT ON COLUMN studio_operations.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_operations.key IS '项目内操作幂等键';
COMMENT ON COLUMN studio_operations.action IS '操作动作名称';
COMMENT ON COLUMN studio_operations.request_hash IS '原操作请求指纹';
COMMENT ON COLUMN studio_operations.result IS '操作状态、身份、修订号及固定引用等有限控制结果';
COMMENT ON COLUMN studio_operations.creator_id IS '操作发起人用户ID';
COMMENT ON COLUMN studio_operations.creator_account IS '操作发起人账号快照';
COMMENT ON COLUMN studio_operations.creator_name IS '操作发起人姓名快照';
COMMENT ON COLUMN studio_operations.created_date IS '记录创建时间';


-- 审计日志：项目内全部接受的管理与业务动作，仅追加；data 仅记录动作标识、对象、状态与版本引用，
-- 不存正文、业务快照、质量项、待澄清项、正式依据或关联文件清单
CREATE TABLE studio_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  action text NOT NULL,
  data jsonb NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE studio_audit IS '项目内已接受动作的有限审计记录';
COMMENT ON COLUMN studio_audit.id IS '审计流水ID';
COMMENT ON COLUMN studio_audit.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_audit.action IS '被记录的管理或业务动作名称';
COMMENT ON COLUMN studio_audit.data IS '动作对象、状态与版本引用等有限控制信息';
COMMENT ON COLUMN studio_audit.creator_id IS '动作执行人用户ID';
COMMENT ON COLUMN studio_audit.creator_account IS '动作执行人账号快照';
COMMENT ON COLUMN studio_audit.creator_name IS '动作执行人姓名快照';
COMMENT ON COLUMN studio_audit.created_date IS '记录创建时间';

CREATE INDEX studio_audit_project ON studio_audit(project_id, created_date);

-- ============================================================
-- 独立一致性对比、有限输入观察与差异处理
-- ============================================================

-- 每次比较不可变；数量封存防止在已接受结果中补入新的输入或差异。
CREATE TABLE studio_consistency_comparisons (
  id studio_control_id PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  entity_id text NOT NULL,
  trigger studio_comparison_trigger NOT NULL,
  confirmation_id text,
  operation_key studio_control_id NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  result studio_comparison_result NOT NULL,
  coverage studio_comparison_coverage NOT NULL,
  failure_code studio_comparison_failure,
  summary varchar(500) NOT NULL DEFAULT '',
  input_count integer NOT NULL DEFAULT 0 CHECK (input_count BETWEEN 0 AND 100),
  uncovered_count integer NOT NULL DEFAULT 0 CHECK (uncovered_count BETWEEN 0 AND 100),
  finding_count integer NOT NULL DEFAULT 0 CHECK (finding_count BETWEEN 0 AND 100),
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
    (result='cancelled' AND failure_code IS NOT NULL AND failure_code='cancelled')),
  CHECK (coverage<>'complete' OR uncovered_count=0)
);
COMMENT ON TABLE studio_consistency_comparisons IS '本机实际输入的独立比较接受结果，不证明项目完整一致';
COMMENT ON COLUMN studio_consistency_comparisons.id IS '独立比较记录ID';
COMMENT ON COLUMN studio_consistency_comparisons.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_comparisons.entity_id IS '本次比较的目标材料ID';
COMMENT ON COLUMN studio_consistency_comparisons.trigger IS '手动发起或材料确认事件触发';
COMMENT ON COLUMN studio_consistency_comparisons.confirmation_id IS '自动触发对应的材料接受记录ID，手动比较为空';
COMMENT ON COLUMN studio_consistency_comparisons.operation_key IS '比较结果提交幂等键';
COMMENT ON COLUMN studio_consistency_comparisons.request_hash IS '原比较结果提交请求指纹';
COMMENT ON COLUMN studio_consistency_comparisons.result IS '比较执行结果，完成、失败与取消分别记录';
COMMENT ON COLUMN studio_consistency_comparisons.coverage IS '本次实际覆盖范围完整或不足';
COMMENT ON COLUMN studio_consistency_comparisons.failure_code IS '有限失败或取消码，完成结果为空';
COMMENT ON COLUMN studio_consistency_comparisons.summary IS '有限比较结果或失败摘要，不保存完整模型输出';
COMMENT ON COLUMN studio_consistency_comparisons.input_count IS '接受时封存的已读输入数量';
COMMENT ON COLUMN studio_consistency_comparisons.uncovered_count IS '接受时封存的未覆盖项数量';
COMMENT ON COLUMN studio_consistency_comparisons.finding_count IS '接受时封存的差异项数量';
COMMENT ON COLUMN studio_consistency_comparisons.creator_id IS '比较发起人用户ID';
COMMENT ON COLUMN studio_consistency_comparisons.creator_account IS '比较发起人账号快照';
COMMENT ON COLUMN studio_consistency_comparisons.creator_name IS '比较发起人姓名快照';
COMMENT ON COLUMN studio_consistency_comparisons.created_date IS '比较结果被后台接受的时间';

CREATE UNIQUE INDEX studio_one_auto_comparison ON studio_consistency_comparisons(project_id,confirmation_id) WHERE trigger='confirmation';
CREATE INDEX studio_comparisons_target ON studio_consistency_comparisons(project_id,entity_id,created_date DESC);

CREATE TABLE studio_consistency_inputs (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  entity_id text NOT NULL,
  path studio_relative_path NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  local_state studio_local_content_state NOT NULL,
  range_count integer NOT NULL DEFAULT 0 CHECK (range_count BETWEEN 0 AND 100),
  PRIMARY KEY (project_id,comparison_id,id),
  UNIQUE (project_id,comparison_id,ordinal),
  UNIQUE (project_id,comparison_id,path),
  FOREIGN KEY (project_id,comparison_id) REFERENCES studio_consistency_comparisons(project_id,id),
  FOREIGN KEY (project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_consistency_inputs IS '同次本地读取字节的身份与哈希观察，不保存正文；审计继承父比较';
COMMENT ON COLUMN studio_consistency_inputs.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_inputs.comparison_id IS '所属独立比较记录ID';
COMMENT ON COLUMN studio_consistency_inputs.id IS '本次比较内的已读输入ID';
COMMENT ON COLUMN studio_consistency_inputs.ordinal IS '比较内已读输入序号，范围为1至100';
COMMENT ON COLUMN studio_consistency_inputs.entity_id IS '实际读取的有效材料ID';
COMMENT ON COLUMN studio_consistency_inputs.path IS '实际读取文件的项目相对路径';
COMMENT ON COLUMN studio_consistency_inputs.sha256 IS '与模型实际输入同次读取字节的SHA-256';
COMMENT ON COLUMN studio_consistency_inputs.local_state IS '本地草稿、本机当前文件或状态无法核对';
COMMENT ON COLUMN studio_consistency_inputs.range_count IS '接受时封存的实际读取范围数量';

CREATE INDEX studio_consistency_inputs_entity ON studio_consistency_inputs(project_id,entity_id,comparison_id);

CREATE TABLE studio_consistency_uncovered (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  entity_id text,
  path studio_relative_path NOT NULL,
  reason studio_uncovered_reason NOT NULL,
  range_count integer NOT NULL DEFAULT 0 CHECK (range_count BETWEEN 0 AND 100),
  PRIMARY KEY (project_id,comparison_id,id),
  UNIQUE (project_id,comparison_id,ordinal),
  FOREIGN KEY (project_id,comparison_id) REFERENCES studio_consistency_comparisons(project_id,id),
  FOREIGN KEY (project_id,entity_id) REFERENCES studio_entities(project_id,id)
);
COMMENT ON TABLE studio_consistency_uncovered IS '未读取或未覆盖的定位及原因，不伪造哈希；审计继承父比较';
COMMENT ON COLUMN studio_consistency_uncovered.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_uncovered.comparison_id IS '所属独立比较记录ID';
COMMENT ON COLUMN studio_consistency_uncovered.id IS '本次比较内的未覆盖项ID';
COMMENT ON COLUMN studio_consistency_uncovered.ordinal IS '比较内未覆盖项序号，范围为1至100';
COMMENT ON COLUMN studio_consistency_uncovered.entity_id IS '可识别且属于本项目的材料ID，无法识别时为空';
COMMENT ON COLUMN studio_consistency_uncovered.path IS '未覆盖文件的项目相对路径';
COMMENT ON COLUMN studio_consistency_uncovered.reason IS '缺失、不可读、身份无效或超限等未覆盖原因';
COMMENT ON COLUMN studio_consistency_uncovered.range_count IS '接受时封存的未覆盖范围数量';


CREATE TABLE studio_consistency_findings (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  summary varchar(500) NOT NULL CHECK (btrim(summary)<>''),
  direction varchar(500),
  relation studio_finding_relation NOT NULL,
  status studio_finding_status NOT NULL DEFAULT 'pending',
  revision integer NOT NULL DEFAULT 0 CHECK (revision>=0),
  reminder boolean NOT NULL DEFAULT false,
  input_count integer NOT NULL CHECK (input_count BETWEEN 1 AND 100),
  range_count integer NOT NULL DEFAULT 0 CHECK (range_count BETWEEN 0 AND 100),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  last_editor_id bigint NOT NULL REFERENCES studio_users(id),
  last_editor_account varchar(50) NOT NULL,
  last_editor_name varchar(50) NOT NULL,
  last_edited_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,id),
  UNIQUE (project_id,comparison_id,id),
  UNIQUE (project_id,comparison_id,ordinal),
  FOREIGN KEY (project_id,comparison_id) REFERENCES studio_consistency_comparisons(project_id,id)
);
COMMENT ON TABLE studio_consistency_findings IS '独立差异及其处理状态，登记已处理不表示材料已一致';
COMMENT ON COLUMN studio_consistency_findings.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_findings.comparison_id IS '发现该差异的独立比较记录ID';
COMMENT ON COLUMN studio_consistency_findings.id IS '项目内差异项ID';
COMMENT ON COLUMN studio_consistency_findings.ordinal IS '本次比较内差异项序号，范围为1至100';
COMMENT ON COLUMN studio_consistency_findings.summary IS '有限差异问题摘要';
COMMENT ON COLUMN studio_consistency_findings.direction IS '可选修改方向建议，不代表用户已采纳';
COMMENT ON COLUMN studio_consistency_findings.relation IS '正式关系或潜在关联类型，不直接改写正式关系';
COMMENT ON COLUMN studio_consistency_findings.status IS '差异待处理、登记已处理或忽略状态';
COMMENT ON COLUMN studio_consistency_findings.revision IS '差异自身并发修订号，独立于材料修订号';
COMMENT ON COLUMN studio_consistency_findings.reminder IS '是否显示项目内提醒，独立于处理状态';
COMMENT ON COLUMN studio_consistency_findings.input_count IS '接受时封存的涉及已读输入数量';
COMMENT ON COLUMN studio_consistency_findings.range_count IS '接受时封存的差异定位范围数量';
COMMENT ON COLUMN studio_consistency_findings.creator_id IS '差异记录创建人用户ID';
COMMENT ON COLUMN studio_consistency_findings.creator_account IS '差异记录创建人账号快照';
COMMENT ON COLUMN studio_consistency_findings.creator_name IS '差异记录创建人姓名快照';
COMMENT ON COLUMN studio_consistency_findings.created_date IS '记录创建时间';
COMMENT ON COLUMN studio_consistency_findings.last_editor_id IS '差异最后处理人用户ID';
COMMENT ON COLUMN studio_consistency_findings.last_editor_account IS '差异最后处理人账号快照';
COMMENT ON COLUMN studio_consistency_findings.last_editor_name IS '差异最后处理人姓名快照';
COMMENT ON COLUMN studio_consistency_findings.last_edited_date IS '记录最后修改时间';

CREATE INDEX studio_findings_status ON studio_consistency_findings(project_id,status,reminder,created_date DESC);

CREATE TABLE studio_consistency_finding_inputs (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  finding_id studio_control_id NOT NULL,
  input_id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  PRIMARY KEY (project_id,comparison_id,finding_id,input_id),
  UNIQUE (project_id,comparison_id,finding_id,ordinal),
  FOREIGN KEY (project_id,comparison_id,finding_id) REFERENCES studio_consistency_findings(project_id,comparison_id,id),
  FOREIGN KEY (project_id,comparison_id,input_id) REFERENCES studio_consistency_inputs(project_id,comparison_id,id)
);
COMMENT ON TABLE studio_consistency_finding_inputs IS '差异涉及的同次比较已读输入集合，审计继承父比较';
COMMENT ON COLUMN studio_consistency_finding_inputs.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_finding_inputs.comparison_id IS '所属独立比较记录ID';
COMMENT ON COLUMN studio_consistency_finding_inputs.finding_id IS '所属差异项ID';
COMMENT ON COLUMN studio_consistency_finding_inputs.input_id IS '该差异涉及的同次比较已读输入ID';
COMMENT ON COLUMN studio_consistency_finding_inputs.ordinal IS '差异内涉及输入序号，范围为1至100';


CREATE TABLE studio_consistency_input_ranges (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  input_id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  start_line integer NOT NULL CHECK (start_line>0),
  end_line integer NOT NULL CHECK (end_line>=start_line),
  PRIMARY KEY (project_id,comparison_id,input_id,ordinal),
  FOREIGN KEY (project_id,comparison_id,input_id) REFERENCES studio_consistency_inputs(project_id,comparison_id,id)
);
COMMENT ON TABLE studio_consistency_input_ranges IS '已读输入的实际读取行范围，审计继承父比较';
COMMENT ON COLUMN studio_consistency_input_ranges.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_input_ranges.comparison_id IS '所属独立比较记录ID';
COMMENT ON COLUMN studio_consistency_input_ranges.input_id IS '所属已读输入ID';
COMMENT ON COLUMN studio_consistency_input_ranges.ordinal IS '该输入内读取范围序号，范围为1至100';
COMMENT ON COLUMN studio_consistency_input_ranges.start_line IS '实际读取范围起始行，行号从1开始';
COMMENT ON COLUMN studio_consistency_input_ranges.end_line IS '实际读取范围结束行，包含该行且不小于起始行';

CREATE TABLE studio_consistency_uncovered_ranges (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  uncovered_id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  start_line integer NOT NULL CHECK (start_line>0),
  end_line integer NOT NULL CHECK (end_line>=start_line),
  PRIMARY KEY (project_id,comparison_id,uncovered_id,ordinal),
  FOREIGN KEY (project_id,comparison_id,uncovered_id) REFERENCES studio_consistency_uncovered(project_id,comparison_id,id)
);
COMMENT ON TABLE studio_consistency_uncovered_ranges IS '未覆盖项的有限行范围定位，审计继承父比较';
COMMENT ON COLUMN studio_consistency_uncovered_ranges.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_uncovered_ranges.comparison_id IS '所属独立比较记录ID';
COMMENT ON COLUMN studio_consistency_uncovered_ranges.uncovered_id IS '所属未覆盖项ID';
COMMENT ON COLUMN studio_consistency_uncovered_ranges.ordinal IS '该未覆盖项内范围序号，范围为1至100';
COMMENT ON COLUMN studio_consistency_uncovered_ranges.start_line IS '未覆盖范围起始行，行号从1开始';
COMMENT ON COLUMN studio_consistency_uncovered_ranges.end_line IS '未覆盖范围结束行，包含该行且不小于起始行';

CREATE TABLE studio_consistency_finding_ranges (
  project_id text NOT NULL,
  comparison_id studio_control_id NOT NULL,
  finding_id studio_control_id NOT NULL,
  input_id studio_control_id NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 100),
  start_line integer NOT NULL CHECK (start_line>0),
  end_line integer NOT NULL CHECK (end_line>=start_line),
  PRIMARY KEY (project_id,comparison_id,finding_id,ordinal),
  FOREIGN KEY (project_id,comparison_id,finding_id,input_id) REFERENCES studio_consistency_finding_inputs(project_id,comparison_id,finding_id,input_id)
);
COMMENT ON TABLE studio_consistency_finding_ranges IS '差异在其涉及已读输入中的有限行定位，审计继承父比较';
COMMENT ON COLUMN studio_consistency_finding_ranges.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_finding_ranges.comparison_id IS '所属独立比较记录ID';
COMMENT ON COLUMN studio_consistency_finding_ranges.finding_id IS '所属差异项ID';
COMMENT ON COLUMN studio_consistency_finding_ranges.input_id IS '差异定位所指向的同次比较已读输入ID';
COMMENT ON COLUMN studio_consistency_finding_ranges.ordinal IS '差异内定位范围序号，所有涉及输入合计不超过100';
COMMENT ON COLUMN studio_consistency_finding_ranges.start_line IS '差异定位起始行，行号从1开始';
COMMENT ON COLUMN studio_consistency_finding_ranges.end_line IS '差异定位结束行，包含该行且不小于起始行';


-- 处理事件持续追加，不受每次比较的差异项数量上限影响。
CREATE TABLE studio_consistency_finding_events (
  project_id text NOT NULL,
  id studio_control_id NOT NULL,
  finding_id studio_control_id NOT NULL,
  revision integer NOT NULL CHECK (revision>0),
  operation_key studio_control_id NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  action studio_finding_action NOT NULL,
  status studio_finding_status NOT NULL,
  reminder boolean NOT NULL,
  note varchar(500) NOT NULL DEFAULT '',
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,id),
  UNIQUE (project_id,finding_id,revision),
  UNIQUE (project_id,operation_key),
  FOREIGN KEY (project_id,finding_id) REFERENCES studio_consistency_findings(project_id,id),
  CHECK ((action='handle' AND status='handled') OR (action='ignore' AND status='ignored') OR
         (action='remind' AND reminder) OR (action='unremind' AND NOT reminder))
);
COMMENT ON TABLE studio_consistency_finding_events IS '差异处理与提醒动作的幂等历史，持续追加并保留旧结论';
COMMENT ON COLUMN studio_consistency_finding_events.project_id IS '所属项目ID';
COMMENT ON COLUMN studio_consistency_finding_events.id IS '差异处理事件ID';
COMMENT ON COLUMN studio_consistency_finding_events.finding_id IS '被处理的差异项ID';
COMMENT ON COLUMN studio_consistency_finding_events.revision IS '本次动作成功后对应的差异修订号';
COMMENT ON COLUMN studio_consistency_finding_events.operation_key IS '差异处理或提醒动作幂等键';
COMMENT ON COLUMN studio_consistency_finding_events.request_hash IS '原处理请求指纹';
COMMENT ON COLUMN studio_consistency_finding_events.action IS '登记处理、忽略、提醒或取消提醒动作';
COMMENT ON COLUMN studio_consistency_finding_events.status IS '本次动作成功后的差异处理状态';
COMMENT ON COLUMN studio_consistency_finding_events.reminder IS '本次动作成功后的独立提醒标记';
COMMENT ON COLUMN studio_consistency_finding_events.note IS '有限处理说明，不保存完整材料或对比内容';
COMMENT ON COLUMN studio_consistency_finding_events.creator_id IS '差异处理人用户ID';
COMMENT ON COLUMN studio_consistency_finding_events.creator_account IS '差异处理人账号快照';
COMMENT ON COLUMN studio_consistency_finding_events.creator_name IS '差异处理人姓名快照';
COMMENT ON COLUMN studio_consistency_finding_events.created_date IS '本次差异处理或提醒动作被后台接受的时间';


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
COMMENT ON FUNCTION studio_guard_project_creation() IS '项目创建身份与生命周期守卫';
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
COMMENT ON FUNCTION studio_assert_confirmation_sources IS '校验固定确认的来源封存集合';

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
    IF NEW.stage='prototype' THEN
      IF NOT EXISTS (
        SELECT 1 FROM studio_confirmations m WHERE m.project_id=NEW.project_id AND m.entity_id=NEW.entity_id AND
          m.version=NEW.version AND m.stage='material' AND m.commit_sha=NEW.commit_sha AND m.path=NEW.path AND m.sha256=NEW.sha256
      ) THEN RAISE EXCEPTION 'prototype completion must bind its accepted material version fixed reference'; END IF;
      IF NOT EXISTS (
        SELECT 1 FROM studio_baselines b JOIN studio_integrations i ON i.id=NEW.integration_id
        WHERE b.project_id=NEW.project_id AND b.entity_id=NEW.entity_id AND b.version=NEW.version AND
          b.confirmation_id=NEW.id AND b.commit_sha=i.candidate_sha
      ) THEN RAISE EXCEPTION 'prototype completion requires its accepted integration baseline'; END IF;
    END IF;
  END IF;
  PERFORM studio_assert_confirmation_sources(NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_check_confirmation_acceptance IS '校验普通确认与系统预置的互斥接受途径';
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
  ELSIF NOT EXISTS (
    SELECT 1 FROM studio_occupations o JOIN studio_entities e ON e.project_id=o.project_id AND e.id=o.entity_id
    WHERE o.id=NEW.occupation_id AND o.purpose='prototype' AND e.kind='requirement'
  ) THEN RAISE EXCEPTION 'prototype input must bind an accepted completion and prototype occupation'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER studio_prerequisite_reference BEFORE INSERT OR UPDATE ON studio_prerequisites
  FOR EACH ROW EXECUTE FUNCTION studio_check_prerequisite_reference();
CREATE TRIGGER studio_occupation_input_reference BEFORE INSERT OR UPDATE ON studio_occupation_inputs
  FOR EACH ROW EXECUTE FUNCTION studio_check_prerequisite_reference();

-- 验证比较观察的封存集合，ordinal 唯一及范围约束同时阻止并发越限。
CREATE FUNCTION studio_assert_comparison(p_project text,p_comparison text) RETURNS void AS $$
DECLARE comparison studio_consistency_comparisons%ROWTYPE;
BEGIN
  SELECT * INTO comparison FROM studio_consistency_comparisons WHERE project_id=p_project AND id=p_comparison;
  IF NOT FOUND THEN RETURN; END IF;
  IF comparison.input_count<>(SELECT count(*) FROM studio_consistency_inputs WHERE project_id=p_project AND comparison_id=p_comparison) OR
     comparison.uncovered_count<>(SELECT count(*) FROM studio_consistency_uncovered WHERE project_id=p_project AND comparison_id=p_comparison) OR
     comparison.finding_count<>(SELECT count(*) FROM studio_consistency_findings WHERE project_id=p_project AND comparison_id=p_comparison) THEN
    RAISE EXCEPTION 'comparison sealed collection counts must match';
  END IF;
  IF EXISTS (
    SELECT 1 FROM studio_consistency_inputs i WHERE i.project_id=p_project AND i.comparison_id=p_comparison AND
      i.range_count<>(SELECT count(*) FROM studio_consistency_input_ranges r WHERE r.project_id=i.project_id AND r.comparison_id=i.comparison_id AND r.input_id=i.id)
  ) OR EXISTS (
    SELECT 1 FROM studio_consistency_uncovered u WHERE u.project_id=p_project AND u.comparison_id=p_comparison AND
      u.range_count<>(SELECT count(*) FROM studio_consistency_uncovered_ranges r WHERE r.project_id=u.project_id AND r.comparison_id=u.comparison_id AND r.uncovered_id=u.id)
  ) OR EXISTS (
    SELECT 1 FROM studio_consistency_findings f WHERE f.project_id=p_project AND f.comparison_id=p_comparison AND (
      f.input_count<>(SELECT count(*) FROM studio_consistency_finding_inputs i WHERE i.project_id=f.project_id AND i.comparison_id=f.comparison_id AND i.finding_id=f.id) OR
      f.range_count<>(SELECT count(*) FROM studio_consistency_finding_ranges r WHERE r.project_id=f.project_id AND r.comparison_id=f.comparison_id AND r.finding_id=f.id)
    )
  ) THEN RAISE EXCEPTION 'comparison input and finding location counts must match'; END IF;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_assert_comparison IS '校验已接受比较的有限输入与定位集合';
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
CREATE CONSTRAINT TRIGGER studio_input_collection AFTER INSERT ON studio_consistency_inputs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();
CREATE CONSTRAINT TRIGGER studio_uncovered_collection AFTER INSERT ON studio_consistency_uncovered
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();
CREATE CONSTRAINT TRIGGER studio_finding_collection AFTER INSERT ON studio_consistency_findings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();
CREATE CONSTRAINT TRIGGER studio_finding_input_collection AFTER INSERT ON studio_consistency_finding_inputs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();
CREATE CONSTRAINT TRIGGER studio_input_range_collection AFTER INSERT ON studio_consistency_input_ranges
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();
CREATE CONSTRAINT TRIGGER studio_uncovered_range_collection AFTER INSERT ON studio_consistency_uncovered_ranges
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();
CREATE CONSTRAINT TRIGGER studio_finding_range_collection AFTER INSERT ON studio_consistency_finding_ranges
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_comparison_collection();

CREATE TRIGGER studio_comparison_immutable BEFORE UPDATE OR DELETE ON studio_consistency_comparisons
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_input_immutable BEFORE UPDATE OR DELETE ON studio_consistency_inputs
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_uncovered_immutable BEFORE UPDATE OR DELETE ON studio_consistency_uncovered
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_finding_input_immutable BEFORE UPDATE OR DELETE ON studio_consistency_finding_inputs
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_input_range_immutable BEFORE UPDATE OR DELETE ON studio_consistency_input_ranges
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_uncovered_range_immutable BEFORE UPDATE OR DELETE ON studio_consistency_uncovered_ranges
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_finding_range_immutable BEFORE UPDATE OR DELETE ON studio_consistency_finding_ranges
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();
CREATE TRIGGER studio_finding_event_immutable BEFORE UPDATE OR DELETE ON studio_consistency_finding_events
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();

-- 差异创建为待处理；之后每次 revision 增量必须同事务带一条对应处理事件。
CREATE FUNCTION studio_guard_finding() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'pending' OR NEW.revision<>0 OR NEW.reminder THEN
      RAISE EXCEPTION 'new finding must be pending at revision zero without reminder';
    END IF;
  ELSE
    IF to_jsonb(NEW)-ARRAY['status','revision','reminder','last_editor_id','last_editor_account','last_editor_name','last_edited_date'] <>
       to_jsonb(OLD)-ARRAY['status','revision','reminder','last_editor_id','last_editor_account','last_editor_name','last_edited_date'] THEN
      RAISE EXCEPTION 'finding observation and identity are immutable';
    END IF;
    IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'finding revision must increment once'; END IF;
    NEW.last_edited_date=now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER studio_finding_guard BEFORE INSERT OR UPDATE ON studio_consistency_findings
  FOR EACH ROW EXECUTE FUNCTION studio_guard_finding();
CREATE TRIGGER studio_finding_no_delete BEFORE DELETE ON studio_consistency_findings
  FOR EACH ROW EXECUTE FUNCTION studio_forbid_mutation();

CREATE FUNCTION studio_guard_finding_event() RETURNS trigger AS $$
DECLARE finding studio_consistency_findings%ROWTYPE;
BEGIN
  SELECT * INTO finding FROM studio_consistency_findings WHERE project_id=NEW.project_id AND id=NEW.finding_id FOR UPDATE;
  IF NOT FOUND OR NEW.revision<>finding.revision OR NEW.status<>finding.status OR NEW.reminder<>finding.reminder THEN
    RAISE EXCEPTION 'finding event must match its current revision and outcome';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER studio_finding_event_guard BEFORE INSERT ON studio_consistency_finding_events
  FOR EACH ROW EXECUTE FUNCTION studio_guard_finding_event();

CREATE FUNCTION studio_check_finding_transition() RETURNS trigger AS $$
DECLARE event studio_consistency_finding_events%ROWTYPE;
BEGIN
  SELECT * INTO event FROM studio_consistency_finding_events WHERE project_id=NEW.project_id AND finding_id=NEW.id AND revision=NEW.revision;
  IF NOT FOUND OR event.status<>NEW.status OR event.reminder<>NEW.reminder OR
     event.creator_id<>NEW.last_editor_id OR event.creator_account<>NEW.last_editor_account OR event.creator_name<>NEW.last_editor_name THEN
    RAISE EXCEPTION 'finding update requires a matching treatment event in the same transaction';
  END IF;
  IF (event.action IN ('handle','ignore') AND NEW.reminder<>OLD.reminder) OR
     (event.action IN ('remind','unremind') AND NEW.status<>OLD.status) THEN
    RAISE EXCEPTION 'finding treatment and reminder are independent actions';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER studio_finding_transition AFTER UPDATE ON studio_consistency_findings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_finding_transition();

-- 前置生产输入引用的基线必须对应同一需求版本的真实完成接受与集成提交。
CREATE FUNCTION studio_check_baseline_acceptance() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM studio_confirmations c
    JOIN studio_integrations i ON i.id=c.integration_id AND i.project_id=c.project_id AND i.entity_id=c.entity_id
    JOIN studio_entities e ON e.project_id=c.project_id AND e.id=c.entity_id
    WHERE c.id=NEW.confirmation_id AND c.project_id=NEW.project_id AND c.entity_id=NEW.entity_id AND c.version=NEW.version AND
      c.stage='prototype' AND e.kind='requirement' AND i.status='accepted' AND i.scope='prototype' AND i.candidate_sha=NEW.commit_sha
  ) THEN RAISE EXCEPTION 'baseline must bind an accepted requirement completion and its integration commit'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER studio_baseline_acceptance AFTER INSERT OR UPDATE ON studio_baselines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION studio_check_baseline_acceptance();
