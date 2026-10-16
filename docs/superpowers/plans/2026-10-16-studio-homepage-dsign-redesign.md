# Studio 首页 dsign 视觉重做实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消除桌面端双侧边栏（Studio 面板满窗），并把 StudioPanel 外壳按 docs/dsign/dsign.html 的视觉语言用 Tailwind v4 重写。

**Architecture:** 两处改动：(1) 发行补丁 `studio-frame-edits.mjs` 在构建树 AppFrame.tsx 中让 studio 面板激活时侧栏列宽为 0 且不渲染 sidebarCol；(2) 插件侧引入 @tailwindcss/cli 预编译（无 preflight、无前缀——spike 实测 v4 的 prefix 与无 preflight 不可兼得），产物走宿主现成的 `dsh-css-global-inline` 注入通道，StudioPanel 外壳 JSX 用 Tailwind 工具类重写，逻辑不变。

**Tech Stack:** Tailwind CSS v4 (@tailwindcss/cli)、React TSX、CSS Modules（保留内部）、node:test、宿主 tsdown.client.ts CSS 虚拟模块管线。

**Spec:** `docs/superpowers/specs/2026-10-16-studio-homepage-dsign-redesign-design.md`

## Global Constraints

- 不修改 `.local/upstream/dsh/` 缓存源码；上游改动一律走 `apps/desktop-distribution/build/` 的锚点 edit，锚点缺失/重复即抛错。
- 验证边界（用户明确）：**不在本机打包桌面客户端验证**；改动完成后提交代码，由 Windows 工作站做宿主验收。本机必做的验证：单元测试通过 + Tailwind 产物生成成功 + `prepare-studio-plugin.mjs --stage-only` 装配无锚点错误。
- 保留 StudioPanel 根节点的 `data-studio-panel="studio"` 属性（`tests/windows-desktop/verify-studio-first-launch.mjs` 依赖它）。
- Tailwind 入口不引入 preflight；工具类**不加前缀**（spike 实测：v4 的 `prefix()` 在拆分 import 上静默失效，全量 import 无法排除 preflight；宿主全量使用 CSS Modules 哈希类名，裸工具类不会作用于宿主 DOM）；面板根节点保留 `studio-root` 类。
- 不加兼容层：外壳旧 CSS 类删除即删除，新旧外壳样式不并存。
- 测试用 `node --test tests/scripts/<file>` 运行，模式参照 `tests/scripts/desktop-startup-edits.test.mjs`。
- StudioPanel 的所有状态逻辑（`call`、`retainSession`、轮询、登录/项目弹窗、五阶段数据）一字不改，只换外壳 JSX 与样式。

---

### Task 1: 满窗发行补丁 STUDIO_FRAME_EDIT + 测试

**Files:**
- Create: `apps/desktop-distribution/build/studio-frame-edits.mjs`
- Test: `tests/scripts/studio-frame-edits.test.mjs`

**Interfaces:**
- Consumes: 上游构建树文件 `packages/client/ui-layout/src/client/AppFrame.tsx`（`.local/upstream/dsh/` 下同源只读引用）。
- Produces: `export const STUDIO_FRAME_EDIT = { file: 'packages/client/ui-layout/src/client/AppFrame.tsx', apply(source) }` —— Task 3 将其接入 `UPSTREAM_EDITS`。

背景（取自上游 AppFrame.tsx 现状，已核实行内容）：

```tsx
// 第 162-172 行附近，组件体内现有代码：
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : layoutInfo.sidebar === 0 ? SIDEBAR_DEFAULT : layoutInfo.sidebar
  const rightbarPreference = layoutInfo.rightbar ?? viewport * RIGHTBAR_DEFAULT_RATIO
  // Desktop reopen controls occupy the frame's shell.leading seat (macOS) or
  // the Windows caption row; neither platform keeps an icon rail.
  const darwin = document.documentElement.dataset.platform === 'darwin'
  const collapsedWidth = darwin
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED
```

`AppFrame` 的 props 解构中已有 `usePanelInfo`（`AppFrame.tsx:114-121`），可直接使用。`computeColumns(viewport, 0, rightbar, 0)` 返回 `sidebar: 0`（`columns.ts:51-56`，`sidebar === 0` 时取 `collapsedWidth`）。`.sidebarCol` 有 `overflow:hidden`（AppFrame.module.css:58-63），但仍带 0.5px 边框，故补丁同时跳过该列的渲染。

- [ ] **Step 1: 写失败测试**

创建 `tests/scripts/studio-frame-edits.test.mjs`：

```js
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { STUDIO_FRAME_EDIT } from '../../apps/desktop-distribution/build/studio-frame-edits.mjs'

const upstream = path.resolve(import.meta.dirname, '../../.local/upstream/dsh')
const appFrame = await readFile(path.join(upstream, 'packages/client/ui-layout/src/client/AppFrame.tsx'), 'utf8')
const columnsSource = await readFile(path.join(upstream, 'packages/client/ui-layout/src/client/columns.ts'), 'utf8')
const computeColumns = new Function(`${stripTypeScriptTypes(columnsSource)
  .replace(/export interface Columns[\s\S]*?\n}\n/, '')
  .replace(/export const/g, 'const')
  .replace(/export function /g, 'function ')}; return computeColumns`)()

// The patched geometry block, evaluated with the same stubs the component would have.
function geometry(source, { panelId, viewport = 1600, sidebar = 280, narrowExpanded = false }) {
  const start = source.indexOf('  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE')
  const endMarker = ': SIDEBAR_COLLAPSED'
  const end = source.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, 'geometry block must exist')
  const block = source.slice(start, end + endMarker.length)
  const run = new Function('usePanelInfo', 'viewport', 'layoutInfo', 'document', `
    const SIDEBAR_AUTO_COLLAPSE = 1024
    const SIDEBAR_DEFAULT = 280
    const RIGHTBAR_DEFAULT_RATIO = 0.45
    const SIDEBAR_COLLAPSED = 56
    ${stripTypeScriptTypes(block)}
    return { sidebarCollapsed, sidebarPreference, collapsedWidth }
  `)
  return run(
    (select) => select({ activePanelId: panelId }),
    viewport,
    { sidebar, narrowExpanded },
    { documentElement: { dataset: {}, hasAttribute: () => false } },
  )
}

test('upstream shell keeps the sidebar column for every main panel', () => {
  const result = geometry(appFrame, { panelId: 'studio' })
  assert.equal(result.sidebarCollapsed, false)
  assert.equal(result.collapsedWidth, 56)
  assert.ok(computeColumns(1600, result.sidebarPreference, 0, result.collapsedWidth).sidebar > 0)
})

test('studio panel closes the shell sidebar column entirely', () => {
  const edited = STUDIO_FRAME_EDIT.apply(appFrame)
  const result = geometry(edited, { panelId: 'studio' })
  assert.equal(result.sidebarCollapsed, true)
  assert.equal(result.collapsedWidth, 0)
  assert.equal(computeColumns(1600, result.sidebarPreference, 0, result.collapsedWidth).sidebar, 0)
  assert.ok(edited.includes("activePanelId !== 'studio' && <div className={css.sidebarCol}>"))
})

test('other panels keep upstream sidebar behavior', () => {
  const edited = STUDIO_FRAME_EDIT.apply(appFrame)
  const conversation = geometry(edited, { panelId: 'conversation' })
  assert.equal(conversation.sidebarCollapsed, false)
  assert.equal(conversation.collapsedWidth, 56)
  const narrow = geometry(edited, { panelId: 'conversation', viewport: 800 })
  assert.equal(narrow.sidebarCollapsed, true)
})

test('frame edit is idempotent, byte-reversible, and fails on anchor drift', () => {
  const edited = STUDIO_FRAME_EDIT.apply(appFrame)
  assert.equal(STUDIO_FRAME_EDIT.apply(edited), edited)
  assert.throws(() => STUDIO_FRAME_EDIT.apply('upstream drift'), /anchor missing or duplicated/)
  assert.throws(() => STUDIO_FRAME_EDIT.apply(`${appFrame}\n  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE\n  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0`), /anchor missing or duplicated/)
  // Outside the three patched regions the file stays byte-for-byte upstream.
  let reversed = edited
  for (const [before, after] of STUDIO_FRAME_EDIT.pairs) reversed = reversed.replace(after, before)
  assert.equal(reversed, appFrame)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/scripts/studio-frame-edits.test.mjs`
Expected: FAIL，`Cannot find module '../../apps/desktop-distribution/build/studio-frame-edits.mjs'`

- [ ] **Step 3: 实现 edit 模块**

创建 `apps/desktop-distribution/build/studio-frame-edits.mjs`：

```js
/** Studio owns the whole frame; the shell sidebar column closes while its main panel is active. */

const pairs = [
  [
    `  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const sidebarCollapsed = narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0`,
    `  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const activePanelId = usePanelInfo(info => info.activePanelId)
  // Studio ships its own navigation column; the shell sidebar closes while it is active.
  const sidebarCollapsed = activePanelId === 'studio' || (narrow ? !layoutInfo.narrowExpanded : layoutInfo.sidebar === 0)`,
  ],
  [
    `  const collapsedWidth = darwin
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED`,
    `  const collapsedWidth = activePanelId === 'studio'
    || darwin
    || document.documentElement.hasAttribute('data-windows-titlebar') ? 0 : SIDEBAR_COLLAPSED`,
  ],
  [
    `      <div className={css.sidebarCol}>
        {sidebar}
      </div>`,
    `      {activePanelId !== 'studio' && <div className={css.sidebarCol}>
        {sidebar}
      </div>}`,
  ],
]

/** Hide the shell sidebar while the Studio main panel is active; replay idempotently. */
export const STUDIO_FRAME_EDIT = {
  file: 'packages/client/ui-layout/src/client/AppFrame.tsx',
  pairs,
  apply(source) {
    if (pairs.every(([, after]) => source.includes(after))) {
      if (pairs.some(([before, after]) => source.includes(before) || source.split(after).length !== 2)) {
        throw new Error('Studio frame edit anchor duplicated')
      }
      return source
    }
    let next = source
    for (const [before, after] of pairs) {
      if (next.split(before).length !== 2) throw new Error('Studio frame edit anchor missing or duplicated')
      next = next.replace(before, after)
    }
    return next
  },
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test tests/scripts/studio-frame-edits.test.mjs`
Expected: PASS（4 个测试全过）

- [ ] **Step 5: Commit**

```bash
git add apps/desktop-distribution/build/studio-frame-edits.mjs tests/scripts/studio-frame-edits.test.mjs
git commit -m "feat(desktop): close the shell sidebar while the Studio panel is active"
```

---

### Task 2: Tailwind v4 接入与 spike

**Files:**
- Create: `packages/studio-plugin/src/client/studio.tw.css`
- Modify: `packages/studio-plugin/package.json`（devDependencies）
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 无。
- Produces: Tailwind 入口 `src/client/studio.tw.css`；生成产物路径约定 `src/client/studio.tw.generated.css`（gitignored，Task 3 的构建步骤生成，Task 4 的 StudioPanel 导入它）；工具类**无前缀**；字体令牌 `--font-sans`/`--font-mono`。

- [ ] **Step 1: 添加依赖**

Run（仓库根目录）: `pnpm --filter @eadp-studio/studio-plugin add -D @tailwindcss/cli@^4`
Expected: `packages/studio-plugin/package.json` 的 devDependencies 出现 `@tailwindcss/cli`（4.x），`pnpm-lock.yaml` 更新，install 成功。

- [ ] **Step 2: 创建 Tailwind 入口**

创建 `packages/studio-plugin/src/client/studio.tw.css`：

```css
/* Studio shell utilities: no preflight (the host shell owns global styles), no prefix
   (v4 drops prefix() on split imports; the host UI is all CSS Modules, so bare
   utility classes never match host DOM). */
@import "tailwindcss/theme.css";
@import "tailwindcss/utilities.css";

@theme {
  --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: "JetBrains Mono", SFMono-Regular, Consolas, monospace;
}
```

- [ ] **Step 3: spike 探针 —— 验证工具类生成、任意值、无 preflight**

背景：2026-10-17 spike 已实测 `prefix(tw)` 在拆分 import 上被静默忽略（产物为无前缀类），全量 import 虽支持 prefix 但必然注入 preflight——故采用「拆分导入、无前缀、无 preflight」方案。本步骤验收该入口的最终行为。

创建临时探针 `packages/studio-plugin/src/client/tw-probe.html`：

```html
<div class="flex w-52 bg-[#1e40af] text-[11px] font-mono space-x-2.5 rounded-md border-slate-200 antialiased"></div>
```

Run（cwd = `packages/studio-plugin`）: `pnpm exec tailwindcss -i src/client/studio.tw.css -o src/client/tw-probe.out.css --minify`

然后用 `grep -o ... | wc -l`（产物为单行 minify，需按出现次数计）验证：
- `grep -o '\.flex' src/client/tw-probe.out.css | wc -l` ≥ 1（工具类生成）
- `grep -o '1e40af' src/client/tw-probe.out.css | wc -l` ≥ 1（任意值生效）
- `grep -o 'w-52' src/client/tw-probe.out.css | wc -l` ≥ 1
- `grep -o 'box-sizing:border-box' src/client/tw-probe.out.css | wc -l` = 0（无 preflight 全局重置）

四条全部符合才能继续；任一不符，停止并以 BLOCKED 上报实测输出。

- [ ] **Step 4: 清理探针并加 gitignore**

```bash
rm packages/studio-plugin/src/client/tw-probe.html packages/studio-plugin/src/client/tw-probe.out.css
```

在 `.gitignore` 末尾追加：

```
/packages/studio-plugin/src/client/studio.tw.generated.css
```

- [ ] **Step 5: Commit**

```bash
git add packages/studio-plugin/package.json packages/studio-plugin/src/client/studio.tw.css pnpm-lock.yaml .gitignore
git commit -m "feat(studio-plugin): add the Tailwind v4 pipeline entry for the Studio shell"
```

---

### Task 3: prepare-studio-plugin.mjs 接线（edit 注册 + 样式生成步骤）

**Files:**
- Modify: `apps/desktop-distribution/build/run-pnpm.mjs`
- Modify: `apps/desktop-distribution/build/prepare-studio-plugin.mjs`

**Interfaces:**
- Consumes: Task 1 的 `STUDIO_FRAME_EDIT`；Task 2 的 `src/client/studio.tw.css` 入口与产物路径约定。
- Produces: `UPSTREAM_EDITS` 包含 `STUDIO_FRAME_EDIT`；`runPnpm('studioStyles', productPlugin)` 操作；`main()` 在 `placePlugin()` 之前调用 `generateStudioStyles()`。

- [ ] **Step 1: run-pnpm.mjs 增加操作**

在 `apps/desktop-distribution/build/run-pnpm.mjs` 的 `OPERATIONS` 对象中，`pack` 条目之后追加一行（注意上一行末尾补逗号）：

```js
  pack: ['pack', '--pack-destination', '../../../../packed-studio'],
  // Regenerate the Studio shell's Tailwind utilities from its source classes.
  studioStyles: ['exec', 'tailwindcss', '-i', 'src/client/studio.tw.css', '-o', 'src/client/studio.tw.generated.css', '--minify'],
```

- [ ] **Step 2: prepare-studio-plugin.mjs 注册 edit 与生成步骤**

在 import 区（第 21 行 `DESKTOP_STARTUP_EDIT` import 之后）加：

```js
import { STUDIO_FRAME_EDIT } from './studio-frame-edits.mjs'
```

在 `UPSTREAM_EDITS` 数组中 `DESKTOP_STARTUP_EDIT,` 之后加一行：

```js
  STUDIO_FRAME_EDIT,
```

在 `placePlugin` 函数定义之前加：

```js
async function generateStudioStyles() {
  runPnpm('studioStyles', productPlugin)
  console.log('Generated the Studio Tailwind stylesheet.')
}
```

在 `main()` 中把：

```js
async function main() {
  await copyVerifiedSource()
  await placePlugin()
```

改为：

```js
async function main() {
  await copyVerifiedSource()
  await generateStudioStyles()
  await placePlugin()
```

（`placePlugin` 整体复制 `src/`，生成的 `studio.tw.generated.css` 随之进入构建树；宿主 `dsh-css-global-inline` 通道负责编译注入。）

- [ ] **Step 3: 验证装配（stage-only，不构建安装包）**

Run（仓库根目录）: `node apps/desktop-distribution/build/prepare-studio-plugin.mjs --stage-only`
Expected: 输出含 `Generated the Studio Tailwind stylesheet.`、`Applied the product edit to packages/client/ui-layout/src/client/AppFrame.tsx`（或 `already applied`），无锚点错误，退出码 0。并确认生成物存在：

```bash
test -f packages/studio-plugin/src/client/studio.tw.generated.css && echo OK
```

- [ ] **Step 4: Commit**

```bash
git add apps/desktop-distribution/build/run-pnpm.mjs apps/desktop-distribution/build/prepare-studio-plugin.mjs
git commit -m "feat(desktop): wire the Studio frame edit and Tailwind generation into assembly"
```

---

### Task 4: StudioPanel 外壳重写 + studio.module.css 收缩

**Files:**
- Modify: `packages/studio-plugin/src/client/studio/StudioPanel.tsx`
- Modify: `packages/studio-plugin/src/client/studio.module.css`

**Interfaces:**
- Consumes: Task 3 生成的 `studio.tw.generated.css`（`import '../studio.tw.generated.css'`）；Task 2 的无前缀工具类约定。
- Produces: 外壳（根节点、顶栏、侧栏、账号区）全部使用 Tailwind 工具类；`studio.module.css` 中重置选择器收缩为 `:where(.studio .main, .studio .dialog)` 作用域，外壳专用类删除；`css.main` 及内部区域类保持原名（内部 JSX 不动）。

关键点：`.studio button` 等重置选择器特异性 (0,1,1) 高于单个工具类 (0,1,0)，不收缩会覆盖外壳的 Tailwind 样式。收缩为 `:where(...)` 后特异性降到 (0,0,1)，工具类与内部 module 类均不受影响（内部 module 类如 `.studio .assetItem` 为 (0,2,0)，仍高于重置）。

- [ ] **Step 1: 重写 StudioPanel 外壳**

对 `packages/studio-plugin/src/client/studio/StudioPanel.tsx` 做以下编辑。

(a) 在第 8 行 `import css from '../studio.module.css'` 之后加一行（其余 import 不变）：

```tsx
import '../studio.tw.generated.css'
```

(b) 在 `const disconnectedState = ...` 行（第 20 行）之后插入图标组件（返回类型由 TS 推断为 `JSX.Element`，不加注解）：

```tsx
const stageIconPaths: Record<Stage, string> = {
  scenarios: 'M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z',
  requirements: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z',
  prototype: 'M15 12a3 3 0 11-6 0 3 3 0 016 0zM2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z',
  baselines: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
  handoffs: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
}
function StageIcon({ path }: { path: string }) {
  return <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d={path} /></svg>
}
```

(c) 替换 return 的外壳部分。old_string 为第 69-81 行（根 div、header、shell div、aside 全部内容，到 `</aside>` 为止）：

```tsx
  return <div className={css.studio} data-studio-panel="studio">
    <header className={css.topbar}>
      <div className={css.wordmark}><span className={css.logo}>e</span><strong>EADP Studio</strong><span className={css.divider}>/</span><span>{state.project?.name ?? '项目工作台'}</span></div>
      <div className={css.topActions}><span className={css.branch}>{state.project?.stableBranch ?? '工作空间'}</span>{state.preview ? <a className={css.previewLink} href={state.preview.url} target="_blank" rel="noreferrer">● 本地原型 ↗</a> : <span className={css.muted}>原型未运行</span>}<button onClick={() => void call({ action: 'state' })} disabled={busy}>刷新</button></div>
    </header>
    <div className={css.shell}>
      <aside className={css.sidebar} aria-label="工作台导航">
        <div className={css.projectPicker}><label htmlFor="studio-project">工作空间 / 项目</label><select id="studio-project" value={state.selectedProjectId ?? ''} onChange={e => { setSelectedId(undefined); void call({ action: 'selectProject', projectId: e.target.value }) }}><option value="" disabled>选择项目</option>{state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><button className={css.newProject} disabled={!state.connected} onClick={() => setProjectDialog(true)}>＋ 新建 / 获取项目</button></div>
        <p className={css.eyebrow}>STUDIO WORKSPACE</p>
        <nav>{stages.map(item => <button key={item.id} aria-current={stage === item.id ? 'page' : undefined} className={`${css.navItem} ${stage === item.id ? css.activeNav : ''}`} onClick={() => selectStage(item.id)}><span className={css.navNumber}>{item.mark}</span>{item.name}<span className={css.navArrow}>›</span></button>)}</nav>
        <div className={css.sidebarNote}>从业务材料出发<br />与 AI 一起形成可交付成果</div>
        <div className={css.account}><span className={css.avatar}>{state.account?.name?.slice(0, 1) ?? 'S'}</span><div><strong>{state.account?.name ?? '登录协同工作台'}</strong><small>{state.account ? `@${state.account.username} · GitLab @${state.account.gitlabUsername}` : '登录后查看可用项目'}</small></div><button onClick={() => { if (state.connected) { setState(disconnectedState()); setSelectedId(undefined); void call({ action: 'logout' }) } else setLoginDialog(true) }}>{state.connected ? '退出' : '登录'}</button></div>
      </aside>
```

new_string（逻辑表达式逐项保留，仅换结构与样式；侧栏导航标签沿用 dsign 的 eyebrow 样式，文案保留 STUDIO WORKSPACE）：

```tsx
  return <div className={`${css.studio} studio-root flex h-full w-full flex-col overflow-hidden bg-[#f4f6fa] antialiased`} data-studio-panel="studio">
    <header className="flex h-10 flex-shrink-0 items-center justify-between border-b border-slate-200 bg-[#f8fafc] px-3">
      <div className="flex min-w-0 items-center space-x-2">
        <span className="text-[12px] font-medium tracking-tight text-slate-800">EADP Studio</span>
        <span className="text-slate-400">/</span>
        <span className="truncate rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">{state.project?.name ?? '项目工作台'}</span>
        <span className="flex items-center space-x-1 pl-1 font-mono text-[10px] text-slate-500">
          <span className={`h-1.5 w-1.5 rounded-full ${state.connected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          <span>{state.project?.stableBranch ?? '工作空间'}{state.connected ? '（已同步）' : ''}</span>
        </span>
      </div>
      <div className="flex items-center space-x-2">
        {state.preview ? <a className="text-[11px] text-emerald-700 hover:text-emerald-800" href={state.preview.url} target="_blank" rel="noreferrer">● 本地原型 ↗</a> : <span className="text-[11px] text-slate-400">原型未运行</span>}
        <button className="rounded border border-slate-200 bg-white px-2 py-1 text-[11px] text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50" onClick={() => void call({ action: 'state' })} disabled={busy}>刷新</button>
      </div>
    </header>
    <div className="flex flex-1 overflow-hidden">
      <aside className="flex w-52 flex-shrink-0 flex-col justify-between border-r border-slate-200 bg-white" aria-label="工作台导航">
        <div>
          <div className="border-b border-slate-100 bg-slate-50/50 p-3">
            <label htmlFor="studio-project" className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-400">工作空间 / 项目</label>
            <select id="studio-project" className="w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-[11px] font-semibold text-slate-700" value={state.selectedProjectId ?? ''} onChange={e => { setSelectedId(undefined); void call({ action: 'selectProject', projectId: e.target.value }) }}><option value="" disabled>选择项目</option>{state.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            <button className="mt-2 w-full rounded-md border border-dashed border-slate-300 py-1.5 text-[11px] text-slate-600 transition-colors hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50" disabled={!state.connected} onClick={() => setProjectDialog(true)}>＋ 新建 / 获取项目</button>
          </div>
          <nav className="space-y-1 p-2">
            <div className="px-2 py-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Studio Workspace</div>
            {stages.map(item => <button key={item.id} aria-current={stage === item.id ? 'page' : undefined} className={`flex w-full items-center space-x-2.5 rounded-md px-3 py-2 text-left text-[11px] transition-colors ${stage === item.id ? 'bg-[#1e40af] font-semibold text-white shadow-sm' : 'font-medium text-slate-600 hover:bg-slate-100/80'}`} onClick={() => selectStage(item.id)}>
              <span className={stage === item.id ? 'text-white' : 'text-slate-400'}><StageIcon path={stageIconPaths[item.id]} /></span>
              <span>{item.name}</span>
              <span className={`ml-auto ${stage === item.id ? 'text-indigo-200' : 'text-slate-300'}`}>›</span>
            </button>)}
          </nav>
        </div>
        <div className="flex flex-shrink-0 items-center justify-between border-t border-slate-200 bg-slate-50/70 p-3">
          <div className="flex min-w-0 items-center space-x-2">
            <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-slate-300 bg-slate-200 text-[11px] text-slate-600">{state.account?.name?.slice(0, 1) ?? 'S'}</div>
            <div className="min-w-0 leading-tight">
              <div className="truncate text-[11px] font-medium text-slate-800">{state.account?.name ?? '登录协同工作台'}</div>
              <div className="truncate font-mono text-[9px] text-slate-500">{state.account ? `@${state.account.username} · GitLab @${state.account.gitlabUsername}` : '登录后查看可用项目'}</div>
            </div>
          </div>
          <button className="rounded p-1 text-[10px] text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-700" onClick={() => { if (state.connected) { setState(disconnectedState()); setSelectedId(undefined); void call({ action: 'logout' }) } else setLoginDialog(true) }}>{state.connected ? '退出' : '登录'}</button>
        </div>
      </aside>
```

`<main className={css.main}>` 及其内部全部内容、结尾的 `</div>{loginDialog && ...}` 保持不变。

- [ ] **Step 2: 收缩并重写 studio.module.css**

完整替换 `packages/studio-plugin/src/client/studio.module.css` 为以下内容（重置选择器改为 `:where(.studio .main, .studio .dialog)` 作用域；外壳类 topbar/wordmark/logo/divider/branch/previewLink/topActions/shell/sidebar/projectPicker/newProject/navItem/navNumber/navArrow/activeNav/sidebarNote/account/avatar 全部删除；内部区域类原样保留；媒体查询中的外壳引用删除）：

```css
.studio{color-scheme:light;--ink:#1e293b;--muted:#64748b;--line:#e2e8f0;--blue:#1e40af;box-sizing:border-box;color:var(--ink);font:13px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;text-align:left}
.studio *{box-sizing:border-box}
:where(.studio .main, .studio .dialog) :where(button, input, select, textarea){font:inherit}
:where(.studio .main, .studio .dialog) button{border:1px solid var(--line);background:white;color:inherit;border-radius:6px;padding:6px 11px;cursor:pointer;white-space:nowrap;transition:background .15s}
:where(.studio .main, .studio .dialog) button:hover{background:#f1f5f9}
:where(.studio .main, .studio .dialog) button:disabled{opacity:.48;cursor:not-allowed}
:where(.studio .main, .studio .dialog) :where(input, select, textarea){border:1px solid #d8e0eb;border-radius:5px;padding:8px;background:white;color:inherit;min-width:0}
.studio :focus-visible{outline:2px solid #3b82f6;outline-offset:2px}
:where(.studio .main, .studio .dialog) label{display:flex;flex-direction:column;gap:5px;color:#475569;font-size:12px}
:where(.studio .main, .studio .dialog) :where(h1, h2, h3, p){margin:0}
:where(.studio .main, .studio .dialog) h1{font-size:23px;font-weight:650;letter-spacing:-.6px}
:where(.studio .main, .studio .dialog) h2{font-size:15px;font-weight:650}
:where(.studio .main, .studio .dialog) h3{font-size:13px}
:where(.studio .main, .studio .dialog) small{font-size:11px}
:where(.studio .main, .studio .dialog) code{font:11px/1.6 Consolas,monospace;word-break:break-all}
:where(.studio .main, .studio .dialog) .primary{background:var(--blue);border-color:var(--blue);color:white}
:where(.studio .main, .studio .dialog) .primary:hover{background:#17338d}
:where(.studio .main, .studio .dialog) summary{cursor:pointer}
.muted{color:var(--muted)}.success{color:#15805b;font-size:11px}.eyebrow{color:#8995a6;font-size:10px;letter-spacing:1.3px;font-weight:600}
.main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;overflow:hidden}.pageHeader{display:flex;justify-content:space-between;align-items:center;padding:22px 25px 19px;flex-shrink:0}.pageHeader .eyebrow{margin-bottom:4px}.pageHeader h1+p{color:#7b8797;font-size:11px;margin-top:5px}.statusPill{border:1px solid #dbe3ef;background:#fff;border-radius:20px;padding:5px 10px;color:#64748b;font-size:10px;display:flex;align-items:center;gap:6px}.statusPill i{height:5px;width:5px;border-radius:50%;background:#7c91b2}.workspace{display:grid;grid-template-columns:205px minmax(280px,1fr) minmax(280px,365px);gap:12px;padding:0 20px 18px;flex:1;min-height:0}.catalog,.taskArea,.inspector{background:white;border:1px solid var(--line);border-radius:8px;min-height:0;min-width:0;overflow:hidden;display:flex;flex-direction:column}.catalogHeader{display:flex;justify-content:space-between;padding:15px 13px;border-bottom:1px solid #f0f2f5}.catalogHeader span{color:#94a3b8}.search{margin:11px!important;font-size:11px!important}.assetList{flex:1;overflow:auto;padding:0 7px}.studio .assetItem{display:flex;flex-direction:column;gap:5px;text-align:left;width:100%;margin:3px 0;padding:11px;border-color:transparent;white-space:normal}.assetItem small{font:9px Consolas,monospace;color:#8e9aab}.assetItem strong{font-size:12px;line-height:1.6}.assetItem>div{display:flex;justify-content:space-between;gap:5px;font-size:10px;color:#9aa5b3}.studio .selectedAsset{background:#f0f4ff;border-color:#c8d6f6}.addMaterial{display:flex;flex-direction:column;gap:8px;padding:12px;border-top:1px solid #edf0f5}.categoryForm{padding:10px 13px;border-top:1px solid #edf0f5;color:#8190a5;font-size:11px}.categoryForm form{display:flex;flex-direction:column;gap:6px;padding-top:8px}.taskHeader{height:65px;display:flex;align-items:center;justify-content:space-between;padding:12px 15px;border-bottom:1px solid var(--line);gap:10px}.taskHeader .eyebrow{font:9px Consolas,monospace}.taskHeader h2{margin-top:3px;font-size:13px}.taskHeader button{font-size:11px}.contextStrip{display:flex;gap:15px;padding:8px 15px;font-size:10px;color:#8794a5;background:#fafbfe;border-bottom:1px solid #edf0f5;flex-wrap:wrap}.contextStrip strong{color:#b45309}.nativeConversation{flex:1;min-height:150px;display:flex;flex-direction:column;position:relative;overflow:hidden}.nativeConversation>div{min-height:0;flex:1}.conversationEmpty{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;padding:22px;text-align:center;color:#8c98a8;min-height:180px}.conversationEmpty>span{font-size:30px;color:#a4b7e5;margin-bottom:15px}.conversationEmpty h3{color:#64748b;font-weight:500;margin-bottom:7px}.conversationEmpty p{font-size:11px;line-height:1.9}.confirmBar{padding:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);background:#f8fafc}.confirmBar strong,.confirmBar small{display:block}.confirmBar strong{font-size:11px}.confirmBar small{font-size:9px;color:#8b98a9;margin-top:3px}.naturalConfirm{display:flex;gap:6px;padding:0 14px 12px;background:#f8fafc}.naturalConfirm input{flex:1;font-size:11px}.naturalConfirm button{font-size:11px}.tabs{display:flex;padding:0 14px;border-bottom:1px solid var(--line);gap:17px;flex-shrink:0}.studio .tabs button{padding:14px 0;border:0;border-bottom:2px solid transparent;border-radius:0;color:#94a3b8;font-size:11px}.studio .tabs button[aria-selected=true]{border-bottom-color:var(--blue);color:var(--blue)}.editor{display:flex;flex-direction:column;gap:13px;padding:16px;overflow:auto;flex:1}.editorHeading{display:flex;align-items:center;gap:9px;border-bottom:1px solid #edf0f5;padding-bottom:13px}.editorHeading>div{flex:1}.editorHeading small{display:block;color:#94a3b8;font:9px Consolas,monospace;margin-top:2px}.editorHeading strong{font-size:11px}.editorHeading>.muted{font-size:9px}.assetIcon{display:grid;place-items:center;width:29px;height:32px;border:1px solid #dce5f3;border-radius:5px;background:#f5f8fd;color:#6e89b3;font:10px Consolas,monospace;flex-shrink:0}.bodyLabel{flex:1;min-height:220px}.materialBody{flex:1;resize:vertical;line-height:1.9!important;font-size:12px!important;min-height:210px}.editor details{font-size:11px;color:#8190a5}.editor details>label,.editor fieldset{margin-top:12px}.editor fieldset{border:1px solid var(--line);border-radius:5px}.editor .checkbox{display:flex;flex-direction:row;align-items:center;gap:7px;margin:7px 0}.editor>.muted{font-size:10px;line-height:1.8}.versionPanel{overflow:auto;padding:18px;display:flex;flex-direction:column;gap:11px;flex:1;font-size:11px}.versionPanel h3{margin-top:13px}.versionPanel code{color:#7c8ca2}.release{margin:10px;font-size:10px!important;color:#9b6e53!important}.empty{padding:28px 15px;color:#94a3b8;font-size:11px;line-height:1.9;text-align:center}.error,.notice{margin:0 20px 10px;padding:10px 12px;display:flex;justify-content:space-between;align-items:center;gap:10px;border-radius:6px;font-size:11px;flex-shrink:0}.error{background:#fff1f2;color:#b91c1c;border:1px solid #fecdd3}.notice{background:#fffbeb;color:#92400e;border:1px solid #fde68a}.error button{background:transparent;border:0}.resultList{padding:0 24px;overflow:auto}.sectionHeading{padding:17px 0;display:flex;justify-content:space-between;align-items:center}.sectionHeading span{font-size:11px;color:#94a3b8}.baseline{display:flex;align-items:center;gap:20px;padding:22px;background:white;border:1px solid var(--line);border-radius:8px;margin-bottom:10px}.baseline>div{flex:1}.baseline p{font-size:11px;color:#94a3b8;margin:4px 0}.baseline code{color:#9aa5b3}.welcome{margin:auto;display:flex;flex-direction:column;align-items:center;text-align:center;padding:35px;gap:16px}.welcomeMark{height:65px;width:65px;border-radius:18px;background:#e8eefb;color:var(--blue);font:bold 60px/1 sans-serif;display:grid;place-items:center;margin-bottom:7px}.welcome h2{font-size:25px;letter-spacing:-.5px}.welcome p:not(.eyebrow){color:#94a3b8;font-size:12px;line-height:1.9}.welcome small{color:#b1bbc8;font-size:10px}.welcome button{padding:10px 20px}.candidates{padding:15px;border-top:1px solid var(--line);max-height:220px;overflow:auto}.candidates>div{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid #edf0f5}.candidates p{color:#8c98a8;font-size:10px}.actionBar{display:flex;flex-wrap:wrap;gap:7px;padding:12px;border-top:1px solid var(--line)}.actionBar button{font-size:10px}.publication{padding:0 20px 13px;display:flex;justify-content:flex-end;gap:10px;align-items:center;font-size:10px;color:#94a3b8}.publication button{font-size:10px}.dialog{width:460px;max-width:90vw;border:1px solid var(--line);border-radius:12px;padding:27px;color:var(--ink);font:13px/1.6 Inter,"Microsoft YaHei",sans-serif;box-shadow:0 20px 70px #0f172a25}.dialog::backdrop{background:#0f172a55;backdrop-filter:blur(3px)}.dialog form{display:flex;flex-direction:column;gap:19px}.dialog header{display:flex;justify-content:space-between;align-items:center}.dialog h2{font-size:21px;margin:3px 0}.dialog p{color:var(--muted);font-size:11px}.dialog footer{display:flex;justify-content:flex-end;gap:9px;padding-top:8px}.dialog input,.dialog select{width:100%}
@media(max-width:1250px){.workspace{grid-template-columns:166px minmax(250px,1fr) 285px;padding:0 12px 12px;gap:9px}.pageHeader{padding:18px}.taskHeader{padding:10px}.confirmBar small{display:none}.editor{padding:12px}}
@media(max-width:980px){.workspace{grid-template-columns:155px minmax(230px,1fr)}.inspector{grid-column:1/-1;max-height:380px;min-height:280px}.workspace{overflow:auto}.catalog,.taskArea{min-height:440px}.pageHeader h1+p{display:none}}
```

- [ ] **Step 3: 引用扫描 —— 确认没有残留的外壳类引用**

Run: `grep -n "css\.\(topbar\|wordmark\|logo\|divider\|branch\|previewLink\|topActions\|shell\|sidebar\|projectPicker\|newProject\|navItem\|navNumber\|navArrow\|activeNav\|sidebarNote\|account\|avatar\)" -r packages/studio-plugin/src`
Expected: 无输出（0 匹配）。再确认生成物与导入：

Run: `grep -n "studio.tw.generated.css\|studio-root\|data-studio-panel" packages/studio-plugin/src/client/studio/StudioPanel.tsx`
Expected: 三处均命中（import、根类名、data 属性）。

- [ ] **Step 4: 重新生成样式并 stage-only 装配**

Run（仓库根目录）:
```bash
node apps/desktop-distribution/build/prepare-studio-plugin.mjs --stage-only
```
Expected: 退出码 0；`packages/studio-plugin/src/client/studio.tw.generated.css` 内容包含 `.flex` 与 `.bg-\[\#1e40af\]`（用 `grep -c 'bg-' packages/studio-plugin/src/client/studio.tw.generated.css` ≥ 1 验证新外壳类已被扫描进产物）。

- [ ] **Step 5: Commit**

```bash
git add packages/studio-plugin/src/client/studio/StudioPanel.tsx packages/studio-plugin/src/client/studio.module.css
git commit -m "feat(studio-plugin): reskin the Studio shell with Tailwind utilities after the dsign reference"
```

---

### Task 5: 终验与收尾

**Files:**
- Modify: 无（仅验证；如有回归回到对应 Task 修复）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 干净的 git 状态与交接说明。

- [ ] **Step 1: 全量脚本测试**

Run（仓库根目录）: `node --test 'tests/scripts/*.test.mjs'`
Expected: 47 项中 43 通过、2 跳过、2 失败——失败的 2 项（desktop-policy-edits.test.mjs、studio-typert-edits 中的 "fixed upstream bounded analysis..."）为 base 上可复现的 Node 22 环境限制，非本计划回归。

- [ ] **Step 2: stage-only 装配终验**

Run: `node apps/desktop-distribution/build/prepare-studio-plugin.mjs --stage-only`
Expected: 退出码 0，无锚点错误。

- [ ] **Step 3: 确认提交边界**

Run: `git status --short`
Expected: 无未跟踪/未提交残留（`studio.tw.generated.css` 已被 gitignore；构建树在 `.local/` 下本就被忽略）。

- [ ] **Step 4: 交接说明**

在最终回复中明确写出留给 Windows 工作站的验收清单：
1. `node apps/desktop-distribution/build/prepare-studio-plugin.mjs`（完整构建，验证 lightningcss 对 Tailwind v4 产物的编译与插件打包）；
2. Windows 安装/运行后：`node tests/windows-desktop/verify-studio-first-launch.mjs --exe <exe 路径> --screenshot`，目视核对截图 —— 无 DSH 深色侧栏、Studio 满窗、外壳样式符合 dsign.html（浅色侧栏 w-52、indigo 激活项、高密度字号）；
3. 五阶段切换、登录/项目弹窗、刷新按钮功能回归。
