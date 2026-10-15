import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { PrototypeResourceFencePlugin } from '../../packages/studio-plugin/assets/prototype-template/config/resource-fence.js';

const template = fileURLToPath(new URL('../../packages/studio-plugin/assets/prototype-template/', import.meta.url));
const dependencies = process.env.EADP_TEMPLATE_DEPENDENCIES || template;
const projectRequire = createRequire(path.join(dependencies, 'package.json'));
const presetRequire = createRequire(projectRequire.resolve('@umijs/preset-umi/package.json'));
const bundlerRequire = createRequire(presetRequire.resolve('@umijs/bundler-webpack/package.json'));
const webpack = bundlerRequire('webpack');

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eadp-inline-loader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await mkdir(project);
  return { directory, project, marker: path.join(directory, 'outside-marker') };
}

async function compile(project, guarded, rules = []) {
  const previous = process.cwd();
  let compiler;
  try {
    process.chdir(project);
    compiler = webpack({ mode: 'production', context: project, entry: './entry.js', output: { path: path.join(project, 'dist'), filename: 'app.js' }, optimization: { minimize: false }, module: { rules }, plugins: guarded ? [new PrototypeResourceFencePlugin()] : [] });
  } finally { process.chdir(previous); }
  return new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(closeError => {
    if (error || closeError) reject(error || closeError);
    else resolve(stats.toJson({ all: false, errors: true }));
  })));
}

test('real Webpack rejects source-provided inline loader execution before its Node side effects', async t => {
  const { project, marker } = await fixture(t);
  await writeFile(path.join(project, 'safe.js'), 'export default 1;');
  await writeFile(path.join(project, 'evil-loader.cjs'), `module.exports = function(source) { require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); return source; };`);
  await writeFile(path.join(project, 'entry.js'), "import value from '!!./evil-loader.cjs!./safe.js'; console.log(value);");
  assert.deepEqual((await compile(project, false)).errors, []);
  assert.equal(await readFile(marker, 'utf8'), 'executed');
  await rm(marker);
  for (const prefix of ['', '!', '!!', '-!']) {
    await writeFile(path.join(project, 'entry.js'), `import value from '${prefix}./evil-loader.cjs!./safe.js'; console.log(value);`);
    const result = await compile(project, true);
    assert.ok(result.errors.length > 0, 'inline loader must fail the build');
    assert.match(result.errors.map(error => error.message).join('\n'), /inline loader/i);
    await assert.rejects(access(marker));
  }
});

test('real Webpack keeps normal resources and protected configuration loader rules usable', async t => {
  const { project } = await fixture(t);
  await writeFile(path.join(project, 'safe.js'), 'export default "ORIGINAL";');
  await writeFile(path.join(project, 'entry.js'), "import value from './safe.js'; console.log(value);");
  await writeFile(path.join(project, 'configured-loader.cjs'), 'module.exports = source => source.replace("ORIGINAL", "PROCESSED");');
  const result = await compile(project, true, [{ test: /safe\.js$/, use: [path.join(project, 'configured-loader.cjs')] }]);
  assert.deepEqual(result.errors, []);
  assert.match(await readFile(path.join(project, 'dist/app.js'), 'utf8'), /PROCESSED/);
});
