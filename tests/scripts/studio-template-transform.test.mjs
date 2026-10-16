import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { STUDIO_TEMPLATE_TRANSFORM_EDITS } from '../../apps/desktop-distribution/build/studio-template-edits.mjs'

test('real electron-builder cleanup preserves frozen template source and still strips dependency scripts', async () => {
  const repo = path.resolve(import.meta.dirname, '../..')
  const prepared = path.join(repo, '.local/build/dsh')
  const fixture = await mkdtemp(path.join(prepared, 'apps/desktop/.studio-transform-'))
  try {
    const helper = path.join(fixture, 'studio-template-transform.mjs')
    await cp(path.join(repo, 'apps/desktop-distribution/build/studio-template-transform.mjs'), helper)
    const asset = path.join(fixture, 'node_modules/@eadp-studio/studio-plugin/assets/prototype-template/package.json')
    const dependency = path.join(fixture, 'node_modules/ordinary/package.json')
    const bytes = '{"name":"fixture","scripts":{"build":"umi build"},"keywords":["source"]}\n'
    for (const filename of [asset, dependency]) { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes) }
    const program = `
      import assert from 'node:assert/strict';
      import {createRequire} from 'node:module';
      import {readFile} from 'node:fs/promises';
      const module = createRequire(${JSON.stringify(pathToFileURL(helper).href)})('app-builder-lib/out/fileTransformer.js');
      assert.ok(await module.createTransformer(${JSON.stringify(fixture)}, {}, undefined)(${JSON.stringify(asset)}));
      await import(${JSON.stringify(pathToFileURL(helper).href)});
      const factory = module.createTransformer;
      await import(${JSON.stringify(pathToFileURL(helper).href + '?replay')});
      assert.equal(module.createTransformer, factory);
      const transform = factory(${JSON.stringify(fixture)}, {}, undefined);
      assert.equal(await transform(${JSON.stringify(asset)}), null);
      const clean = JSON.parse(await transform(${JSON.stringify(dependency)}));
      assert.equal(clean.scripts, undefined); assert.equal(clean.keywords, undefined);
      assert.equal(await readFile(${JSON.stringify(asset)}, 'utf8'), ${JSON.stringify(bytes)});
    `
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { cwd: prepared, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    for (const edit of STUDIO_TEMPLATE_TRANSFORM_EDITS) {
      const source = await readFile(path.join(prepared, edit.file), 'utf8')
      const changed = edit.apply(source)
      assert.equal(edit.apply(changed), changed)
      assert.throws(() => edit.apply('anchor changed'), /anchor/)
    }
  } finally { await rm(fixture, { recursive: true, force: true }) }
})
