-- 阶段一项目场景：协同后台数据库物理模型
-- 依据 docs/design/scenarios/01-scenarios.md（2026-10-20 确认并同日修订）。
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
--   需求来源明细随确认创建，审计信息以确认行为准。
--
-- 状态字段一律使用 PostgreSQL 枚举类型，不用自由文本。
--
-- 模板：文件为用户工程 .template/<模板ID>.md，由桌面客户端写入替换并随 Git 提交共享；
--   后台不保存模板内容、清单与默认项，不建模板注册表；场景绑定记录为实体上的固定引用。
--
-- 灾难恢复：更换电脑后，场景/需求正文、模板与正式依据文件经 Git 远程仓库恢复，
--   编号、确认、占用、关联与目录投影经后台数据恢复；仅桌面本地过程数据
--   （AI 会话、建议批次、资料读取记录、本地保存队列）不随恢复，按设计可丢弃。
--
-- 编号分配（新建事务内执行，行锁保证项目内原子递增；已分配序号不回收，失败允许空号）：
--   INSERT INTO studio_project_counters(project_id) VALUES ($1) ON CONFLICT (project_id) DO NOTHING;
--   UPDATE studio_project_counters SET next_sequence = next_sequence + 1
--     WHERE project_id = $1 RETURNING next_sequence - 1 AS sequence;
--   -- 先查 studio_entity_numbers：同一 operation_key 命中即返回原编号，不重新分配。
--   INSERT INTO studio_entity_numbers(project_id, sequence, code, operation_key) VALUES (...);
--
-- 固定版本接受事务（integration complete，单事务提交，约束触发器 INITIALLY DEFERRED 在提交时校验）：
--   1. 条件更新项目认可头 recognized_head = candidate_sha；
--   2. 核验 Git 固定材料版本中的质量项、待澄清项、依据和关联文件，写入 studio_confirmations
--      （标题、摘要、固定引用、确认方式、适用性及不适用原因），不复制材料正文与清单；
--   3. 需求确认写入 studio_requirement_sources（≥1 个同项目已确认场景版本，触发器强制）；
--   4. 更新实体 current_confirmation_id / material_version / confirmation_status，结束占用与批次冻结；
--   5. studio_integrations 置 accepted；任一失败整体回滚，结果未知时按 studio_operations 幂等键核对。

-- ============================================================
-- 枚举类型：全部状态字段的唯一权威定义
-- ============================================================

CREATE TYPE studio_entity_kind AS ENUM ('scenario','requirement');
COMMENT ON TYPE studio_entity_kind IS '资产种类';

CREATE TYPE studio_confirmation_status AS ENUM ('draft','confirmed');
COMMENT ON TYPE studio_confirmation_status IS '确认状态';

CREATE TYPE studio_task_status AS ENUM ('idle','active','aborted','completed');
COMMENT ON TYPE studio_task_status IS '任务状态';

-- design 普通整理；scenario-batch 显式修订批次（冻结关联需求、同批确认）
CREATE TYPE studio_occupation_purpose AS ENUM ('design','scenario-batch');
COMMENT ON TYPE studio_occupation_purpose IS '占用用途';

CREATE TYPE studio_occupation_finish AS ENUM ('aborted','completed');
COMMENT ON TYPE studio_occupation_finish IS '占用结束方式';

-- 模板变更不作为独立范围，随材料或批次候选一并提交接受
CREATE TYPE studio_integration_scope AS ENUM ('material','scenario-batch');
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
COMMENT ON TABLE studio_users IS '后台用户';
COMMENT ON COLUMN studio_users.username IS '登录名';
COMMENT ON COLUMN studio_users.admin IS '后台管理员';
COMMENT ON COLUMN studio_users.password_salt IS '口令盐';
COMMENT ON COLUMN studio_users.password_hash IS '口令散列';
COMMENT ON COLUMN studio_users.gitlab_user_id IS 'GitLab用户ID';

-- 登录会话：仅存令牌 SHA-256，不存明文；过期时间索引供到期清理与快速判活
CREATE TABLE studio_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  user_id bigint NOT NULL REFERENCES studio_users(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX studio_sessions_expiry ON studio_sessions(expires_at);
COMMENT ON TABLE studio_sessions IS '登录会话';
COMMENT ON COLUMN studio_sessions.expires_at IS '过期时间';

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
  UNIQUE (creator_id, key),
  UNIQUE (namespace_id, path),
  CHECK (
    (state IN ('reserved','creating') AND gitlab_project_id IS NULL AND repository_url IS NULL) OR
    (state IN ('created','assigned','ready') AND gitlab_project_id IS NOT NULL AND repository_url IS NOT NULL AND btrim(repository_url) <> '')
  ),
  CHECK ((state = 'ready' AND recognized_head IS NOT NULL) OR (state <> 'ready' AND recognized_head IS NULL))
);
COMMENT ON TABLE studio_projects IS '项目';
COMMENT ON COLUMN studio_projects.key IS '创建幂等键';
COMMENT ON COLUMN studio_projects.request_hash IS '不可变的原创建请求指纹';
COMMENT ON COLUMN studio_projects.marker IS '建仓归属标记';
COMMENT ON COLUMN studio_projects.state IS '项目生命周期';
COMMENT ON COLUMN studio_projects.gitlab_project_id IS 'GitLab项目ID';
COMMENT ON COLUMN studio_projects.stable_branch IS '稳定分支';
COMMENT ON COLUMN studio_projects.revision IS '项目修订号';
COMMENT ON COLUMN studio_projects.recognized_head IS '认可分支头';

-- ============================================================
-- 集成（准备候选 → 条件更新远端头 → 完成接受）
-- ============================================================

-- 每项目至多一条 prepared（部分唯一索引）；模板改动随候选一并提交，
-- allowed_paths 可声明 .template/ 与 project.assets.json，完整 diff 不得越界；
-- request 仅保存结果未知时核对所需的控制协议字段（幂等键、修订号、固定引用、确认方式、
-- 适用性与来源版本等）；不得携带正文、metadata、质量项、待澄清项、evidence 或 files 清单。
CREATE TABLE studio_integrations (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES studio_projects(id),
  scope studio_integration_scope NOT NULL,
  entity_id text NOT NULL,
  occupation_id text NOT NULL,
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
  last_edited_date timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX studio_one_prepared_integration ON studio_integrations(project_id) WHERE status = 'prepared';
COMMENT ON TABLE studio_integrations IS '集成操作';
COMMENT ON COLUMN studio_integrations.entity_id IS '目标实体';
COMMENT ON COLUMN studio_integrations.occupation_id IS '关联占用';
COMMENT ON COLUMN studio_integrations.expected_head IS '预期分支头';
COMMENT ON COLUMN studio_integrations.candidate_sha IS '候选提交';
COMMENT ON COLUMN studio_integrations.allowed_paths IS '路径白名单';
COMMENT ON COLUMN studio_integrations.request IS '控制协议快照，不保存业务材料及清单';

-- ============================================================
-- 实体（场景 / 需求）、业务编号与关联
-- ============================================================

-- 每项目编号计数器：分配以行锁序列化，项目内原子递增，不同项目各自从 1 起
CREATE TABLE studio_project_counters (
  project_id text PRIMARY KEY REFERENCES studio_projects(id),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0)
);
COMMENT ON TABLE studio_project_counters IS '编号计数器';
COMMENT ON COLUMN studio_project_counters.next_sequence IS '下一序号';

-- 场景与需求实体：
--   id 为隐藏 UUID 技术身份，决定文件路径（场景/<id>.md），界面只展示业务编号；
--   sequence/code 项目内唯一，改名与修订不变，不可手改、重排或回收；
--   title/summary 入库用于目录投影，确认时随固定版本快照保存；
--   template_ref 为场景绑定的模板固定引用 {commitSha,path,sha256}，仅场景持有，需求不得持有；
--   确认状态与任务状态分列；列表默认按 last_edited_date 降序、sequence 稳定次序
CREATE TABLE studio_entities (
  project_id text NOT NULL REFERENCES studio_projects(id),
  id text NOT NULL,
  kind studio_entity_kind NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  code text NOT NULL CHECK (code = 'SC-' || lpad(sequence::text, 4, '0')),
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  material_version integer NOT NULL DEFAULT 0 CHECK (material_version >= 0),
  confirmation_status studio_confirmation_status NOT NULL DEFAULT 'draft',
  task_status studio_task_status NOT NULL DEFAULT 'idle',
  association_revision integer NOT NULL DEFAULT 0 CHECK (association_revision >= 0),
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
  UNIQUE (project_id, sequence),
  UNIQUE (project_id, code),
  CHECK ((kind = 'scenario') = (template_ref IS NOT NULL))
);
CREATE INDEX studio_entities_updated ON studio_entities(project_id, last_edited_date DESC, sequence);
COMMENT ON TABLE studio_entities IS '场景与需求';
COMMENT ON COLUMN studio_entities.id IS 'UUID技术身份';
COMMENT ON COLUMN studio_entities.sequence IS '项目内序号';
COMMENT ON COLUMN studio_entities.code IS '业务编号';
COMMENT ON COLUMN studio_entities.title IS '标题';
COMMENT ON COLUMN studio_entities.summary IS '摘要';
COMMENT ON COLUMN studio_entities.revision IS '实体修订号';
COMMENT ON COLUMN studio_entities.generation IS '占用代数';
COMMENT ON COLUMN studio_entities.material_version IS '材料版本号';
COMMENT ON COLUMN studio_entities.association_revision IS '关联修订号';
COMMENT ON COLUMN studio_entities.template_ref IS '模板固定引用';
COMMENT ON COLUMN studio_entities.current_confirmation_id IS '当前确认版本';
COMMENT ON COLUMN studio_entities.creator_id IS '创建人ID';
COMMENT ON COLUMN studio_entities.creator_account IS '创建人账号';
COMMENT ON COLUMN studio_entities.creator_name IS '创建人姓名';
COMMENT ON COLUMN studio_entities.created_date IS '创建时间';
COMMENT ON COLUMN studio_entities.last_editor_id IS '最后编辑人ID';
COMMENT ON COLUMN studio_entities.last_editor_account IS '最后编辑人账号';
COMMENT ON COLUMN studio_entities.last_editor_name IS '最后编辑人姓名';
COMMENT ON COLUMN studio_entities.last_edited_date IS '最后编辑时间';

-- 编号预留：先分配后记实体；同一新建 operation_key 重试返回同一编号；
-- 分配后失败产生空号，不回收、不强求连续；entity_id 在实体行写入后回填
CREATE TABLE studio_entity_numbers (
  project_id text NOT NULL REFERENCES studio_projects(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  code text NOT NULL CHECK (code = 'SC-' || lpad(sequence::text, 4, '0')),
  operation_key text,
  entity_id text,
  PRIMARY KEY (project_id, sequence),
  UNIQUE (project_id, code),
  UNIQUE (project_id, operation_key),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id)
);
COMMENT ON TABLE studio_entity_numbers IS '编号预留';
COMMENT ON COLUMN studio_entity_numbers.operation_key IS '新建幂等键';
COMMENT ON COLUMN studio_entity_numbers.entity_id IS '占用实体';

ALTER TABLE studio_entities
  ADD CONSTRAINT studio_entities_number_fk
  FOREIGN KEY (project_id, sequence) REFERENCES studio_entity_numbers(project_id, sequence);

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
  PRIMARY KEY (scenario_id, requirement_id),
  FOREIGN KEY (project_id, scenario_id) REFERENCES studio_entities(project_id, id),
  FOREIGN KEY (project_id, requirement_id) REFERENCES studio_entities(project_id, id)
);
COMMENT ON TABLE studio_scenario_requirements IS '场景需求关联';
COMMENT ON COLUMN studio_scenario_requirements.scenario_id IS '场景';
COMMENT ON COLUMN studio_scenario_requirements.requirement_id IS '需求';

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
COMMENT ON TABLE studio_entity_files IS '实体关联文件';
COMMENT ON COLUMN studio_entity_files.path IS '文件路径';

-- ============================================================
-- 设计占用与批次冻结
-- ============================================================

-- 设计占用：同一实体至多一条活跃占用（部分唯一索引）；只读查看已确认版不领取占用；
-- creator 即占有人（CHECK 强制一致），last_editor 记录释放/完成操作者（管理员强制释放时不同）；
-- scenario-batch 用于显式修订的冻结与同批确认
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
  CHECK (creator_id = owner_id)
);
CREATE UNIQUE INDEX studio_one_active_occupation ON studio_occupations(project_id, entity_id) WHERE active;
COMMENT ON TABLE studio_occupations IS '设计占用';
COMMENT ON COLUMN studio_occupations.owner_id IS '占有人';
COMMENT ON COLUMN studio_occupations.task_id IS '任务ID';
COMMENT ON COLUMN studio_occupations.client_id IS '客户端ID';
COMMENT ON COLUMN studio_occupations.expected_revision IS '预期修订号';
COMMENT ON COLUMN studio_occupations.input_version IS '输入版本';
COMMENT ON COLUMN studio_occupations.active IS '是否活跃';

-- scenario-batch 占用冻结的关联需求集合；占用结束时整批解除，不接受单场景保存绕过批次
CREATE TABLE studio_batch_freezes (
  project_id text NOT NULL,
  occupation_id text NOT NULL REFERENCES studio_occupations(id),
  entity_id text NOT NULL,
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (occupation_id, entity_id),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id)
);
COMMENT ON TABLE studio_batch_freezes IS '批次冻结';
COMMENT ON COLUMN studio_batch_freezes.entity_id IS '冻结需求';

ALTER TABLE studio_integrations
  ADD CONSTRAINT studio_integrations_occupation_fk
  FOREIGN KEY (occupation_id) REFERENCES studio_occupations(id);

-- ============================================================
-- 授权修复任务
-- ============================================================

-- “AI 修复并确认”授权任务：rounds_used 累计轮数总额度 3 轮，暂停/补答续接不重置；
-- 终止任务不可由普通聊天或补答自动恢复；最终版本 hash 以接受的确认行为准
CREATE TABLE studio_repair_tasks (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  occupation_id text NOT NULL REFERENCES studio_occupations(id),
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
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id)
);
COMMENT ON TABLE studio_repair_tasks IS '授权修复任务';
COMMENT ON COLUMN studio_repair_tasks.user_action_id IS '用户动作ID';
COMMENT ON COLUMN studio_repair_tasks.start_hash IS '起始哈希';
COMMENT ON COLUMN studio_repair_tasks.rounds_used IS '已用轮数';
COMMENT ON COLUMN studio_repair_tasks.termination_reason IS '终止原因';

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
COMMENT ON TABLE studio_repair_task_events IS '修复任务事件';
COMMENT ON COLUMN studio_repair_task_events.seq IS '事件序号';
COMMENT ON COLUMN studio_repair_task_events.hash_after IS '轮后哈希';
COMMENT ON COLUMN studio_repair_task_events.detail IS '事件细节';

-- ============================================================
-- 固定版本确认与需求来源
-- ============================================================

-- 被项目接受的固定材料版本：任何内容改动须形成新版本，行不可变；
-- creator_* / created_date 即确认人与确认时间；read_hash 为用户阅读版本，
-- 与当前内容不一致时阻断旧版本确认；repair 方式必须关联修复任务
CREATE TABLE studio_confirmations (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  entity_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  revision integer NOT NULL CHECK (revision > 0),
  title text NOT NULL,
  summary text NOT NULL,
  commit_sha text NOT NULL CHECK (commit_sha ~ '^[a-f0-9]{40}$'),
  path text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  method studio_confirmation_method NOT NULL,
  read_hash text NOT NULL CHECK (read_hash ~ '^[a-f0-9]{64}$'),
  repair_task_id text REFERENCES studio_repair_tasks(id),
  integration_id text NOT NULL REFERENCES studio_integrations(id),
  creator_id bigint NOT NULL REFERENCES studio_users(id),
  creator_account varchar(50) NOT NULL,
  creator_name varchar(50) NOT NULL,
  created_date timestamptz NOT NULL DEFAULT now(),
  applicability studio_applicability NOT NULL DEFAULT 'applicable',
  applicability_reason text,
  UNIQUE (project_id, id),
  UNIQUE (project_id, entity_id, version),
  FOREIGN KEY (project_id, entity_id) REFERENCES studio_entities(project_id, id),
  CHECK ((method = 'repair') = (repair_task_id IS NOT NULL)),
  CHECK (
    (applicability = 'applicable' AND applicability_reason IS NULL) OR
    (applicability = 'not-applicable' AND applicability_reason IS NOT NULL AND btrim(applicability_reason) <> '')
  )
);
CREATE INDEX studio_confirmations_entity ON studio_confirmations(project_id, entity_id, version DESC);
COMMENT ON TABLE studio_confirmations IS '固定版本确认';
COMMENT ON COLUMN studio_confirmations.version IS '版本号';
COMMENT ON COLUMN studio_confirmations.revision IS '实体修订号';
COMMENT ON COLUMN studio_confirmations.title IS '标题快照';
COMMENT ON COLUMN studio_confirmations.summary IS '摘要快照';
COMMENT ON COLUMN studio_confirmations.commit_sha IS '固定提交';
COMMENT ON COLUMN studio_confirmations.path IS '文件路径';
COMMENT ON COLUMN studio_confirmations.sha256 IS '内容哈希';
COMMENT ON COLUMN studio_confirmations.read_hash IS '阅读哈希';
COMMENT ON COLUMN studio_confirmations.repair_task_id IS '修复任务';
COMMENT ON COLUMN studio_confirmations.integration_id IS '接受集成';
COMMENT ON COLUMN studio_confirmations.applicability IS '固定版本适用性，场景必须适用';
COMMENT ON COLUMN studio_confirmations.applicability_reason IS '需求固定版本不适用原因';

ALTER TABLE studio_entities
  ADD CONSTRAINT studio_entities_current_confirmation_fk
  FOREIGN KEY (current_confirmation_id) REFERENCES studio_confirmations(id);

-- 需求确认绑定的场景固定版本：至少一个、可多个，提交时触发器强制；
-- 仅允许同项目已接受的场景确认版本，不允许无来源或未确认来源
CREATE TABLE studio_requirement_sources (
  confirmation_id text NOT NULL REFERENCES studio_confirmations(id),
  scenario_confirmation_id text NOT NULL REFERENCES studio_confirmations(id),
  PRIMARY KEY (confirmation_id, scenario_confirmation_id),
  CHECK (confirmation_id <> scenario_confirmation_id)
);
COMMENT ON TABLE studio_requirement_sources IS '需求场景来源';
COMMENT ON COLUMN studio_requirement_sources.confirmation_id IS '需求确认';
COMMENT ON COLUMN studio_requirement_sources.scenario_confirmation_id IS '场景确认版本';

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
COMMENT ON TABLE studio_operations IS '幂等操作';
COMMENT ON COLUMN studio_operations.key IS '幂等键';
COMMENT ON COLUMN studio_operations.action IS '操作类型';
COMMENT ON COLUMN studio_operations.request_hash IS '请求指纹';
COMMENT ON COLUMN studio_operations.result IS '操作结果';

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
CREATE INDEX studio_audit_project ON studio_audit(project_id, created_date);
COMMENT ON TABLE studio_audit IS '审计日志';
COMMENT ON COLUMN studio_audit.creator_id IS '动作执行者';
COMMENT ON COLUMN studio_audit.action IS '审计动作';
COMMENT ON COLUMN studio_audit.data IS '动作细节';

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
  IF NEW.id <> OLD.id OR NEW.creator_id <> OLD.creator_id OR NEW.key <> OLD.key OR
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

-- 编号预留仅允许回填 entity_id；sequence/code/operation_key 不可改、不可删
CREATE FUNCTION studio_guard_entity_number() RETURNS trigger AS $$
BEGIN
  IF NEW.sequence <> OLD.sequence OR NEW.code <> OLD.code OR NEW.operation_key IS DISTINCT FROM OLD.operation_key THEN
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
  IF NEW.id <> OLD.id OR NEW.sequence <> OLD.sequence OR NEW.code <> OLD.code OR NEW.kind <> OLD.kind THEN
    RAISE EXCEPTION 'entity identity, kind, sequence and code are immutable';
  END IF;
  NEW.last_edited_date = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_guard_entity_identity() IS '实体身份守卫';
CREATE TRIGGER studio_entities_guard BEFORE UPDATE ON studio_entities
  FOR EACH ROW EXECUTE FUNCTION studio_guard_entity_identity();

-- 固定版本接受事务的提交时校验：
--   需求确认必须绑定 ≥1 个同项目已确认场景版本，且来源必须是场景；
--   场景必须适用；需求可不适用但须提供原因（列约束强制）；内容清单由 Git 固定版本核验
CREATE FUNCTION studio_check_confirmation_acceptance() RETURNS trigger AS $$
DECLARE
  entity_kind studio_entity_kind;
BEGIN
  SELECT kind INTO entity_kind FROM studio_entities
    WHERE project_id = NEW.project_id AND id = NEW.entity_id;
  IF entity_kind = 'scenario' AND NEW.applicability <> 'applicable' THEN
    RAISE EXCEPTION 'scenario confirmation % must be applicable', NEW.id;
  END IF;
  IF entity_kind = 'requirement' THEN
    IF NOT EXISTS (SELECT 1 FROM studio_requirement_sources WHERE confirmation_id = NEW.id) THEN
      RAISE EXCEPTION 'requirement confirmation % requires at least one confirmed scenario source', NEW.id;
    END IF;
    IF EXISTS (
      SELECT 1 FROM studio_requirement_sources s
      JOIN studio_confirmations sc ON sc.id = s.scenario_confirmation_id
      JOIN studio_entities e ON e.project_id = sc.project_id AND e.id = sc.entity_id
      WHERE s.confirmation_id = NEW.id AND (sc.project_id <> NEW.project_id OR e.kind <> 'scenario')
    ) THEN
      RAISE EXCEPTION 'requirement confirmation % sources must be confirmed scenario versions of the same project', NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
COMMENT ON FUNCTION studio_check_confirmation_acceptance() IS '接受提交校验';

CREATE CONSTRAINT TRIGGER studio_confirmation_acceptance
  AFTER INSERT ON studio_confirmations DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION studio_check_confirmation_acceptance();
COMMENT ON TRIGGER studio_confirmation_acceptance ON studio_confirmations IS '提交时统一校验';
