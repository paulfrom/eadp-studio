# Studio plugin build inputs

这两个文件不是产品 workspace 的构建输入，而是把本包装配进固定 DSH 构建树后的上游构建输入。装配目标位置固定为 `<dsh-build-tree>/packages/eadp/studio-plugin/`：

| 源 | 装配后位置 |
| --- | --- |
| `build/tsconfig.json` | `<pkg>/tsconfig.json` |
| `build/tsdown.config.ts` | `<pkg>/tsdown.config.ts` |
| `../src/`、`../package.json` | `<pkg>/src/`、`<pkg>/package.json` |

- `tsconfig.json` 末尾的 `../../../tsconfig.base.client.json` 与 `../../client/*` 引用，都相对于 `packages/eadp/studio-plugin` 这一固定位置。
- `tsdown.config.ts` 复用固定上游的 `packages/client/tsdown.client.ts` 预设；该预设依赖上游仓库内模块，包不能在构建树之外单独产出 client bundle。
- 装配脚本还会把构建树需要的 `peerDependencies`/`devDependencies`（`@deepseek-ai/*` 为上游 workspace 包）合并进 `<pkg>/package.json`，并在构建树 `tsconfig.client.json` 的 `references` 中加入本包；产品根 workspace 的 `package.json` 不声明这些依赖，避免把 DSH 工具链并入工作台工作区。
- 实测产物：`lib/index.js`（Host 半边 ESM）与 `lib/client.js`（`window.__ModuleLoader__.load` 闭包工厂，`react/jsx-runtime` 为外部依赖）。
