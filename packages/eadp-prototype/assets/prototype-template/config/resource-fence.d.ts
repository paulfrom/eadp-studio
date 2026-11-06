import type { webpack } from '@umijs/preset-umi';

/** Webpack plugin consumed by the protected Umi build configuration. */
export class PrototypeResourceFencePlugin {
  apply(compiler: webpack.Compiler): void;
}
