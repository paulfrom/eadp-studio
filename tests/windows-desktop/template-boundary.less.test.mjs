import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const template = fileURLToPath(new URL('../../packages/studio-plugin/assets/prototype-template/', import.meta.url));
const dependencies = process.env.EADP_TEMPLATE_DEPENDENCIES || template;
const projectRequire = createRequire(path.join(dependencies, 'package.json'));
const presetRequire = createRequire(projectRequire.resolve('@umijs/preset-umi/package.json'));
const bundlerRequire = createRequire(presetRequire.resolve('@umijs/bundler-webpack/package.json'));
const less = bundlerRequire('@umijs/bundler-utils/compiled/less');
const config = await readFile(path.join(template, 'config/config.ts'), 'utf8');
const options = {
  javascriptEnabled: !/javascriptEnabled:\s*false/.test(config),
  disablePluginRule: /disablePluginRule:\s*true/.test(config),
  math: 'always',
};

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eadp-less-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, marker: path.join(directory, 'outside-marker') };
}

test('actual frozen Umi Less rejects inline JavaScript before its Node side effects', async t => {
  assert.deepEqual(less.version, [4, 1, 3]);
  const { marker } = await fixture(t);
  const payload = `@result: \u0060(process.getBuiltinModule('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'), 1)\u0060; .page { width: @result; }`;
  await less.render(payload, { javascriptEnabled: true });
  assert.equal(await readFile(marker, 'utf8'), 'executed');
  await rm(marker);
  await assert.rejects(less.render(payload, options), /JavaScript is not enabled/);
  await assert.rejects(access(marker));
});

test('actual frozen Umi Less rejects local JavaScript plugin directives', async t => {
  const { directory, marker } = await fixture(t);
  await writeFile(path.join(directory, 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed'); module.exports = { install() {} };`);
  await assert.rejects(less.render('@plugin "./evil.js"; .page { width: 1px; }', { ...options, filename: path.join(directory, 'page.less') }), /[Pp]lugin statements are not allowed/);
  await assert.rejects(access(marker));
});

test('actual frozen Umi Less still renders variables, nesting, mixins and math', async () => {
  const result = await less.render('@base: 8px; .size(@n) { padding: @n * 2; } .page { .size(@base); .title { color: #123456; } }', options);
  assert.match(result.css, /padding: 16px/);
  assert.match(result.css, /\.page \.title/);
});
