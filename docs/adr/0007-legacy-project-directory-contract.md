# 旧项目沿用三目录清单：读旧、新初始化仍严格

状态：Superseded by [ADR-0009](0009-remove-legacy-compatibility.md)（2026-10-28 移除全部 legacy 兼容路径）。原为已确认（2026-10-23，沿用 [ADR-0006](0006-legacy-project-readonly-compatibility.md) 的"只对已接受项目放宽读取、新初始化保持严格"）。适用于 `packages/contracts`、`packages/asset-domain`、`apps/collaboration-api` 与 `packages/studio-plugin` 的清单读取链路。

现场：用户报告项目初始化最后提示 `项目清单无效。`。本机两份真实清单（`training-demo` 的 `46032037-…`、`sei-studio` 的 `d46d348a-…`）都在后台已 `ready`、本机有 `.git` 与目录旁归属标记，但清单 `directories` 只有 `场景`、`需求`、`原型代码` 三项，仓库根也没有 `交接/`。根因是 `4814ab2`（2026-10-22）把项目目录契约由三目录改为四目录，同时改了清单 schema、Host 写入与打开校验、后台初始化校验，却没有处理此前已被后台接受的项目：`isProjectManifest` 直接判清单无效，打开、克隆与新初始化全部止步在这一句。同一批现场还有第二种情况：同一个 GitLab 仓库被登记成第二个后台项目（`4ec1302a-…`），克隆拿到的清单根本不是本项目的，也被同一句"清单无效"掩盖。

**清单接受两套目录布局，只为读已接受项目。** `ProjectManifestSchema.directories` 改为 `ProjectDirectoriesSchema`：当前契约的四目录（`场景`、`需求`、`交接`、`原型代码`），或交接目录引入前三目录（`场景`、`需求`、`原型代码`）。`parseProjectManifest` 因此也能通过——这不是附带效果，而是必要条件：后台读取已接受项目的候选提交（`GitLabContent.verify` → `parseProjectManifest`）若继续拒三目录清单，旧项目即使能打开也无法确认任何材料。

**打开已接受项目时按清单声明的目录核验，不再固定要求四目录。** Host 的 `verify` 要求清单声明的每个业务目录存在；新初始化仍写四目录清单与 `交接/.gitkeep`（`expectedManifest`/`initializeFiles` 不变）。后台 `verifyProjectInitialization` 的目录契约比较同样不变：三目录清单在新初始化接受时返回 `INITIALIZATION_MANIFEST_MISMATCH`，`directories` 少于两项仍返回 `INITIALIZATION_MANIFEST_INVALID`。即读取兼容不为新项目放行。

**清单属于另一个后台项目时说明真实原因。** 清单通过结构校验但 `projectId` 不是本项目，Host 报"该 GitLab 仓库的项目清单属于另一个项目（`<projectId>`），一个仓库只能对应一个后台项目。"，不再把它归为清单无效；同时不认领该目录、不新建第二份克隆。

被放弃的替代方案：打开旧项目时补写 `交接/` 并推一次清单提交（等同 migration，替用户产生内容提交，ADR-0006 已否决同类做法）；让三目录项目无法打开、只能重建（用户手上的项目内容全部留在 Git 历史里，而 ADR-0006 刚为同一类问题建立了读兼容）；放宽后台新初始化接受放行三目录（承认两套新初始化契约，而缺少交接目录的新项目无法生成交接清单）；把三目录清单一律当作旧项目只读（三目录项目仍可正常使用场景、需求与原型，与固定正文缺字段的情形不同，没有理由整项目冻结）。

已知后果：三目录项目首次生成交接清单时，材料写入按需创建 `交接/` 并随该次提交进入仓库，但清单目录声明不会因此被自动改写（只有在模板发布等既有写路径更新清单时才会变），读取侧按声明布局核验目录，两者不会互相阻断。

验证：`tests/gitlab-auth-host/projects.test.ts` 断言三目录已接受项目按归属标记认领、不重新初始化、不重新克隆、不报清单无效，以及仓库清单属于另一个项目时拒绝认领并给出原因；`apps/collaboration-api/src/project-initialization.test.ts` 断言三目录清单的新初始化仍被拒（`INITIALIZATION_MANIFEST_MISMATCH`）。实机清单 `training-demo`、`sei-studio` 以 `isProjectManifest` 与 `parseProjectManifest` 校验通过。
