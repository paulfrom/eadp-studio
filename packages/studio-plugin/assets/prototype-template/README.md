# 合成数据原型模板

企业 React / Umi / SUID 工程，独立运行，无主应用、登录服务或业务后台依赖。全部演示请求在浏览器内存处理，刷新恢复合成数据。网络护栏在应用 bundle 前安装，CSP 阻断实际业务连接。

使用 Node 22.22.3、pnpm 11.28.5，在本目录执行：

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run preview -- --port 4173
```

打开 `http://127.0.0.1:4173/#/demo`。支持正常/空列表、请求错误、加载、详情编辑、取消、保存失败、重置。`dist/` 为单一静态产物；hash 路由和相对资源路径可部署在静态站点的子路径。

`/__eadp_preview_ready` 是服务 ready 检查，浏览器 `window.__EADP_MOCK__.ready` 是 Mock ready 检查。直接 fetch/XHR/WS 等请求均拒绝；页面服务通过 `src/mock/runtime.ts` 调用精确的本地 handler，未知 method/path 拒绝。

具体生成规则见 `AGENT.md`，模板版本、完整文件校验值与保护区由同级 `prototype-template.manifest.json` 固定。Windows 原生执行、DSH 会话规则加载和最终打包由 Windows 验收，不能由 Linux 检查替代。

路由只在 `config/routes.json` 中声明，保护配置以 JSON 解析并验证 `path`、`component`、`title`、`redirect`、`routes`；拒绝额外字段、外部重定向、重复路径和页面目录外的组件。组件使用 `./PageName`（指向 `src/pages/`），嵌套路径使用绝对路由；整体布局固定在 `config/config.ts`。不支持可执行路由配置。该边界不构成完整操作系统沙箱。
