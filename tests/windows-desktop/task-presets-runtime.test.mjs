import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'

// Uses the real fixed Windows production runtime. Like desktop-plugin-runtime,
// run after preparing the desktop package set; no provider/model is called.
const repository = path.resolve(import.meta.dirname, '../..')
const sharedRoot = path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repository, encoding: 'utf8' }).trim())
const prepared = path.join(sharedRoot, '.local/build/dsh/apps/desktop/.desktop-build/targets/win-x64/dsh')
const require = createRequire(path.join(sharedRoot, 'apps/collaboration-api/package.json'))
const { build } = createRequire(require.resolve('tsx'))('esbuild')

test('real alpha4 task presets expose file tools and enforce Studio boundaries on create and resume', { timeout: 90_000 }, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'studio-task-presets-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()))
    await rm(fixture, { recursive: true, force: true })
  })
  await symlink(path.join(prepared, 'node_modules'), path.join(fixture, 'node_modules'), 'junction')
  const entry = path.join(fixture, 'adapter-entry.ts')
  await writeFile(entry, 'export { DshTaskSessions } from ' + JSON.stringify(path.join(repository, 'packages/studio-plugin/src/host/adapters/dsh/sessions.ts')) + ';\nexport { studioToolGuard } from ' + JSON.stringify(path.join(repository, 'packages/studio-plugin/src/host/adapters/platform/execution-guard.ts')) + ';\n')
  await build({ entryPoints: [entry], outfile: path.join(fixture, 'adapter.mjs'), bundle: true, platform: 'node', format: 'esm', external: ['@deepseek-ai/*'] })
  const profile = path.join(fixture, 'home/profiles/desktop')
  await mkdir(profile, { recursive: true })
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
  const diagnostic = path.join(fixture, 'diagnostic.mjs'), output = path.join(fixture, 'result.json')
  await writeFile(diagnostic, String.raw`
    import assert from 'node:assert/strict';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
    import { DshTaskSessions, studioToolGuard } from './adapter.mjs';
    const fixture=process.argv[2], output=process.argv[3], source=process.argv[4], manifest=process.argv[5], modules=path.join(fixture,'node_modules');
    const boot=await import(pathToFileURL(path.join(modules,'@deepseek-ai/dsh-app-boot/lib/index.js')));
    const { runProfile }=await import(pathToFileURL(path.join(modules,'@deepseek-ai/dsh/lib/profile-boot.js')));
    const { scopeOf }=await import(pathToFileURL(path.join(modules,'@deepseek-ai/dsh-scope/lib/index.js')));
    const installAnchor=path.join(modules,'@deepseek-ai/dsh/package.json');
    const profile=boot.loadProfileDirectory('dsh',path.join(fixture,'home/profiles/desktop'),installAnchor);
    const app=await runProfile({environment:boot.loadLayeredEnv('dsh'),profile:'desktop',resolvedProfile:{profile,installAnchor},patchFiles:[],args:['--no-open','--host','127.0.0.1','--port','0']});
    try {
      await app.ctx.loader.await(); await Promise.resolve();
      const ctx=app.ctx, worktree=path.join(fixture,'worktree'), file='需求/requirement.md';
      await mkdir(path.join(worktree,'需求'),{recursive:true}); await writeFile(path.join(worktree,file),'original');
      const globalNames=ctx.tools.schemas().map(tool=>tool.name);
      for(const name of ['read','write','edit','glob','grep']) assert.ok(!globalNames.includes(name),'fixture must keep global file tools disabled');
      const releaseGuard=ctx.tools.guard(studioToolGuard);
      await cp(source,path.join(worktree,'原型代码'),{recursive:true});
      const results=[];
      for (const purpose of ['material','prototype']) {
        const task={ projectId:'project',entityId:'requirement',sessionId:'studio-preset-runtime-'+purpose,worktree,purpose,inputHash:'' };
        const target=purpose==='prototype'?'原型代码/src/pages/preset-runtime.tsx':file;
        if(purpose==='prototype'){await mkdir(path.dirname(path.join(worktree,target)),{recursive:true});await writeFile(path.join(worktree,target),'initial prototype');}
        const input=purpose==='prototype'?{prototypeRoot:path.join(worktree,'原型代码'),manifestPath:manifest,assetId:'asset',requirementId:task.entityId,sessionId:task.sessionId,sourceSha:'a'.repeat(40)}:undefined;
        let sessions=new DshTaskSessions(ctx,manifest,async()=>{});
        for (const restore of [false,true]) {
          await sessions.open(task,purpose==='prototype'?'按已确认需求完成原型；作者通过工作台确认。':'仅编辑 需求/requirement.md；作者通过工作台确认。',input);
          const agent=ctx.agents.get(task.sessionId);
          assert.ok(agent);
          const names=ctx.tools.schemas(scopeOf(agent.ctx)).map(tool=>tool.name);
          for (const name of ['read','write','edit','glob','grep']) assert.ok(names.includes(name),name+' missing from task preset');
          const compositions=ctx.agentPresets.inspectCompositions(agent.ctx);
          assert.ok(compositions.length>0);
          assert.equal(studioToolGuard({name:'write',arguments:{file_path:target},agent}),undefined);
          const protectedReason=studioToolGuard({name:'write',arguments:{file_path:'原型代码/AGENT.md'},agent});
          assert.ok(protectedReason);
          assert.ok(studioToolGuard({name:'read',arguments:{file_path:'../outside'},agent}));
          assert.ok(studioToolGuard({name:'shell',arguments:{command:'echo forbidden'},agent}));
          const invoke=(name,args)=>ctx.tools.execute({callId:'runtime-'+name+'-'+restore,name,arguments:args,agent,signal:new AbortController().signal});
          const read=await invoke('read',{file_path:target});
          const protectedBytes=await readFile(path.join(worktree,'原型代码/AGENT.md'),'utf8');
          const denied=await invoke('write',{file_path:'原型代码/AGENT.md',content:'forbidden'});
          assert.equal(read.isError,false,JSON.stringify(read));
          assert.equal(denied.isError,true,JSON.stringify(denied));
          assert.ok(JSON.stringify(denied).includes(protectedReason));
          assert.equal(await readFile(path.join(worktree,'原型代码/AGENT.md'),'utf8'),protectedBytes);
          const outside=await invoke('read',{file_path:'../outside'});
          assert.equal(outside.isError,true,JSON.stringify(outside));
          if(purpose==='prototype'){const materialWrite=await invoke('write',{file_path:file,content:'forbidden'});assert.equal(materialWrite.isError,true,JSON.stringify(materialWrite));}
          const allowed=await invoke('write',{file_path:target,content:'updated '+restore});
          assert.equal(allowed.isError,false,JSON.stringify(allowed));
          assert.equal(await readFile(path.join(worktree,target),'utf8'),'updated '+restore);
          results.push({purpose,restore,names,compositions,read,denied,outside,allowed});
          await sessions.dispose();
          sessions=new DshTaskSessions(ctx,manifest,async()=>{});
        }
        await sessions.dispose();
      }
      releaseGuard();
      await writeFile(output,JSON.stringify(results));
    } finally {await app.shutdown.shutdown(0)}
  `.replaceAll('\`','`'))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^DSH_|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name)))
  await promisify(execFile)(path.join(prepared, '../electron/electron.exe'), ['--expose-internals', diagnostic, fixture, output, path.join(repository,'packages/studio-plugin/assets/prototype-template'), path.join(repository,'packages/studio-plugin/assets/prototype-template.manifest.json')], { cwd: fixture,
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(fixture, 'home'), DSH_AGENTS_HOME: path.join(fixture, 'agents'), DSH_TELEMETRY_DISABLED: '1', NARB_NATIVE_CACHE_DIR: path.join(fixture, 'native-cache') },
    windowsHide: true, timeout: 80_000, maxBuffer: 2 * 1024 * 1024 })
  const results=JSON.parse(await readFile(output,'utf8'))
  assert.equal(results.length,4)
})
