# 旧契约项目只读兼容：清单模板目录可选，既有固定材料只读

状态：已确认（2026-10-21，用户选择"补齐式兼容"）。适用于 `packages/contracts`、`packages/asset-domain`、`apps/collaboration-api` 与 `packages/studio-plugin` 的读取链路。

现场是"测试项目"（`c431ed0f-…`）在后端已 `ready`，本机记录重建后重新打开时报 `项目 待处理：项目清单无效。`。根因不是网络或重试：该项目的清单与固定材料都早于当前契约——清单没有 `scenarioTemplates`、仓库根没有 `.template/`；既有 1 个场景、2 个需求的固定正文缺 `templateRef`、场景带分类、`businessEvidence` 没有归档文件与行范围、需求没有场景来源。后台读取路径又用当前契约校验固定正文（`GitLabContent.verify` → `repository.loadMaterial`），因此连 `GET /v1/projects/:id` 都会失败。由此固定三条契约。

**项目清单的模板目录可选，但只对已接受项目生效。** `ProjectManifestSchema.scenarioTemplates` 改为可选；`parseProjectManifest` 在缺省时跳过模板身份、重复与默认项校验。新的初始化接受仍必须声明模板清单并具备 `.template/` tree（`verifyProjectInitialization` 显式要求）——缺省只用来读旧项目，不用来放行新项目。

**空模板目录是明确状态，不是错误。** 清单没有模板目录时，`loadProjectTemplates` 的对应模板目录返回 `{ templates: [] }` 且不带默认项（该方法现返回 `{scenarios,requirements}` 双目录，见 `apps/collaboration-api/src/gitlab-content.ts:49`）；`GET /v1/projects/:id/templates` 原样返回，界面显示"本项目尚未发布场景模板"。补齐走既有模板集成：用户上传 Markdown、预览并发布，客户端把 `.template/<id>.md` 与清单模板目录写进一个真实提交，后台按 `stage:"template"` 校验接受。发布前新建场景以 `PROJECT_TEMPLATES_REQUIRED` 阻断并说明原因；发布后即可新建。理由：模板目录是项目契约的一部分，只能由用户显式发布产生，不能由打开动作代写；这条既不迁移也不回填，只复用已有发布链路。

**旧契约固定材料只读，不接受、不迁移、不改写。** 读取某个已确认固定正文时，若解析/校验抛出契约类错误（`INVALID_MATERIAL`、`INVALID_MANIFEST`、`INVALID_MATERIAL_PATH`、`CORE_UNRESOLVED`、`SCENARIO_SOURCE_REQUIRED`、`TEMPLATE_IDENTITY_MISMATCH`、`TEMPLATE_REFERENCE_MISMATCH`、`EVIDENCE_PATH_SCOPE`、`EVIDENCE_RANGE_INVALID`、`FILE_REFERENCE_CONFLICT`、`SELF_REFERENCE`），`entities()` 不返回 `current`（严格 `FixedVersion`），改为返回 `legacyCurrent`：版本号、固定引用、确认人与时间、库内标题/摘要和只读原因。完整性错误（哈希不符、文件缺失、编码非法、无权限）照旧抛出，不被当作旧契约。"旧契约"只存在于读路径：确认、复用、采用、原型基线、模板绑定仍走严格校验，遇到旧正文即以明确错误拒绝。界面按 `legacyCurrent` 只读展示正文并隐藏编辑、确认、评审、复用入口。

被放弃的替代方案：让旧项目无法打开、只能重建（用户手上的项目内容全部留在 Git 历史里，界面没有任何继续路径）；打开时自动补 `.template/` 并改清单推送（替用户产生内容提交，且等价于 migration，违反"不自动补齐"）；放宽固定正文契约让旧正文进入确认/复用（等于承认两套已确认文档格式，且旧正文缺失的 `templateRef`、来源与证据无法凭空成立）；在后台把旧正文当"草稿"降级（确认状态来自后台，改写它会伪造历史）。

验证：`tests/gitlab-auth-host/projects.test.ts` 断言清单缺 `scenarioTemplates` 的已接受项目按归属标记认领、不重新初始化、不重新克隆；`tests/windows-desktop/legacy-material.test.ts` 断言旧契约实体在投影中只读、不可编辑/确认/复用、正文按固定引用可读，且未发布模板时不能新建场景；`apps/collaboration-api/src/persistence/repository.test.ts` 断言契约类错误落到只读视图、完整性错误照旧失败、缺失版本不被编造；`apps/collaboration-api/src/gitlab-content.test.ts` 断言缺省模板目录返回空目录、模板发布可把旧清单补齐；`apps/collaboration-api/src/project-initialization.test.ts` 断言新初始化仍要求模板目录与 `.template/` tree。
