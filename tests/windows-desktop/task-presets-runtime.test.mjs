import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import { STUDIO_MODEL_SELECTION_EDITS } from '../../apps/desktop-distribution/build/model-selection-edits.mjs'

// Uses the real fixed Windows production runtime. Like desktop-plugin-runtime,
// run after preparing the desktop package set; provider calls use an in-memory adapter.
const repository = path.resolve(import.meta.dirname, '../..')
const sharedRoot = path.dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repository, encoding: 'utf8' }).trim())
const prepared = path.join(sharedRoot, '.local/build/dsh/apps/desktop/.desktop-build/targets/win-x64/dsh')
const require = createRequire(path.join(sharedRoot, 'apps/collaboration-api/package.json'))
const { build } = createRequire(require.resolve('tsx'))('esbuild')

test('fixed alpha4 task presets enforce Studio boundaries and real model routes across recovery and API switches', { timeout: 180_000 }, async t => {
  const fixture = await mkdtemp(path.join(tmpdir(), 'studio-task-presets-'))
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(tmpdir()))
    await rm(fixture, { recursive: true, force: true })
  })
  // Freeze the production dependency closure before applying the maintained
  // source edit to this fixture's Agent package; never mutate shared builds.
  const copied = await promisify(execFile)('robocopy.exe', [path.join(prepared, 'node_modules'), path.join(fixture, 'node_modules'), '/E', '/MT:16', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS'], { windowsHide: true }).catch(error => { if (error.code < 8) return error; throw error })
  assert.ok(copied)
  const upstream = path.join(sharedRoot, '.local/upstream/dsh')
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
  const release = JSON.parse(await readFile(path.join(repository, 'apps/desktop-distribution/release.lock.json'), 'utf8'))
  const sourceSha256 = Object.fromEntries(await Promise.all(STUDIO_MODEL_SELECTION_EDITS.map(async edit => [edit.file, sha256(await readFile(path.join(upstream, edit.file)))])))
  const selectionEdit = STUDIO_MODEL_SELECTION_EDITS[0]
  const compiled = await build({ entryPoints: [path.join(upstream, selectionEdit.file)], bundle: true, write: false, platform: 'node', format: 'esm', target: 'node22', packages: 'external', plugins: [{ name: 'studio-model-selection-edit', setup(builder) { builder.onLoad({ filter: /model-selection\.ts$/ }, async ({ path: sourcePath }) => ({ contents: selectionEdit.apply(await readFile(sourcePath, 'utf8')), loader: 'ts' })) } }] })
  const helper = compiled.outputFiles[0].text
  const helperStart = helper.indexOf('function installModelSelection('), helperEnd = helper.lastIndexOf('\nexport {')
  const noticeMapStart = helper.indexOf('var modelSelectionNotices ='), noticeMapEnd = helper.indexOf('\n', noticeMapStart)
  assert.ok(noticeMapStart >= 0 && noticeMapEnd > noticeMapStart)
  assert.ok(helperStart >= 0 && helperEnd > helperStart)
  const runtimeAgent = path.join(fixture, 'node_modules/@deepseek-ai/dsh-agent/lib/index.js')
  const production = (await readFile(runtimeAgent, 'utf8')).replaceAll('\r\n', '\n')
  const start = production.indexOf('function installModelSelection('), end = production.indexOf('\n}\n//#endregion', start) + 2
  assert.ok(start >= 0 && end > start && production.indexOf('function installModelSelection(', start + 1) === -1)
  const noticeMap = production.includes('modelSelectionNotices =') ? '' : helper.slice(noticeMapStart, noticeMapEnd) + '\n'
  await writeFile(runtimeAgent, production.slice(0, start) + noticeMap + helper.slice(helperStart, helperEnd) + production.slice(end))
  const loopEdit = STUDIO_MODEL_SELECTION_EDITS.find(edit => edit.file === 'packages/core/agent-loop/src/agent.ts')
  const loopSource = loopEdit.apply(await readFile(path.join(upstream, loopEdit.file), 'utf8'))
  const loopStart = loopSource.indexOf('  private async preStep('), loopEnd = loopSource.indexOf('  /** Whether the assembled tool schemas differ', loopStart)
  assert.ok(loopStart >= 0 && loopEnd > loopStart)
  const methodSource = loopSource.slice(loopStart, loopEnd).replace('private async preStep(', 'async preStep(')
  const compiledLoop = await build({ stdin: { contents: 'export class Fixture {\n' + methodSource + '\n}', loader: 'ts' }, write: false, platform: 'node', format: 'esm', target: 'node22' })
  const method = compiledLoop.outputFiles[0].text
  const methodStart = method.indexOf('async preStep('), methodEnd = method.indexOf('\n}\nexport {', methodStart)
  assert.ok(methodStart >= 0 && methodEnd > methodStart)
  const runtimeLoop = path.join(fixture, 'node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js')
  const loopProduction = (await readFile(runtimeLoop, 'utf8')).replaceAll('\r\n', '\n')
  const runtimeStart = loopProduction.indexOf('async preStep('), runtimeEnd = loopProduction.indexOf('\n\t/** Whether the assembled tool schemas differ', runtimeStart)
  assert.ok(runtimeStart >= 0 && runtimeEnd > runtimeStart)
  await writeFile(runtimeLoop, loopProduction.slice(0, runtimeStart) + method.slice(methodStart, methodEnd) + loopProduction.slice(runtimeEnd))
  execFileSync(process.execPath, ['--check', runtimeAgent], { windowsHide: true })
  execFileSync(process.execPath, ['--check', runtimeLoop], { windowsHide: true })
  t.diagnostic(JSON.stringify({ fixtureSourceReceipt: { upstreamCommit: release.dsh.commit, sourceArchiveSha256: release.dsh.archive.sha256, sourceSha256, replacements: ['dsh-agent: installModelSelection + shared notice map', 'dsh-agent-loop: preStep'], preservedAgentOutsideSha256: sha256(production.slice(0, start) + production.slice(end)), preservedLoopOutsideSha256: sha256(loopProduction.slice(0, runtimeStart) + loopProduction.slice(runtimeEnd)) } }))
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
      await cp(source,path.join(worktree,'原型代码'),{recursive:true,filter(entry){
        const relative=path.relative(source,entry), parts=relative.split(path.sep);
        return !parts.includes('node_modules') && !parts.includes('dist') && !parts.includes('.umi') && !parts.includes('.umi-production');
      }});
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
      // Enter the real loop through Studio's direct followup path. All supplier
      // calls terminate in this deterministic in-memory adapter.
      const { LlmAdapter }=await import(pathToFileURL(path.join(modules,'@deepseek-ai/dsh-llm/lib/index.js')));
      const requests=[];
      let defaultEffort='low';
      class FixtureAdapter extends LlmAdapter {
        providerInfo(provider){return {id:provider,name:provider};}
        async listModels(provider){return ['alpha','beta'].map(id=>({provider,id,name:id}));}
        async resolveModel(provider,model){return {provider,id:model,name:model,inputModalities:['text','image'],reasoning:{efforts:[{id:'low',name:'Low'},{id:'high',name:'High'}],defaultEffort}};}
        async *stream(options){
          requests.push({provider:options.provider,model:options.model,reasoningEffort:options.reasoningEffort});
          yield {type:'block-start',index:0,blockType:'text'};
          yield {type:'text-delta',index:0,text:'local supplier completed'};
          yield {type:'block-end',index:0,block:{type:'text',text:'local supplier completed'}};
          yield {type:'usage',usage:{inputTokens:1,outputTokens:1}};
          yield {type:'finish',reason:{kind:'stop'}};
        }
      }
      ctx.llm.registerAdapter(['studio-fixture-a','studio-fixture-b','studio-fixture-c'],new FixtureAdapter());
      await ctx.agentDefaultModel.saveSelection({provider:'studio-fixture-a',model:'alpha'});
      const defaultDeadline=Date.now()+10000;
      while(ctx.agentDefaultModel.currentSelection().provider!=='studio-fixture-a'){
        if(Date.now()>defaultDeadline)throw new Error('fixture default model configuration did not settle');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      const task={projectId:'project',entityId:'requirement',sessionId:'studio-model-routing-runtime',worktree,purpose:'material',inputHash:''};
      let sessions=new DshTaskSessions(ctx,manifest,async()=>{});
      const reopen=async()=>{await sessions.dispose();sessions=new DshTaskSessions(ctx,manifest,async()=>{});await sessions.open(task,'仅编辑 需求/requirement.md；作者通过工作台确认。',undefined);};
      const routes=[];
      const send=async(label,expected,adapterDefault,expectedModelNotices=0,dispatch=text=>sessions.prompt(task.sessionId,text))=>{
        const agent=ctx.agents.get(task.sessionId), before=requests.length;
                const countNotices=()=>agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='model-selection').length;
        const beforeNotices=countNotices();
        let release;
        const done=new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{release();reject(new Error('task did not become idle: '+label));},10000);
          release=ctx.on('agent/status',({agent:subject,status})=>{if(subject===agent&&status==='idle'){clearTimeout(timer);release();resolve();}});
        });
        await dispatch(label);await done;
        assert.equal(requests.length,before+1,label+' must make one real adapter request '+JSON.stringify(agent.session.snapshotEvents().slice(-5)));
        assert.deepEqual(requests.at(-1),expected,label);
        const header=agent.session.requestHeader();
        assert.equal(header.adapterDefaults?.reasoningEffort===true,adapterDefault,label+' default provenance');
        const terminal=agent.session.snapshotEvents().findLast(event=>event.type==='turn/end');
        assert.equal(terminal.data.reason.kind,'completed',label+' must complete');
        assert.equal(countNotices()-beforeNotices,expectedModelNotices,label+' model switch notice count');
        routes.push({label,request:requests.at(-1),adapterDefault:header.adapterDefaults?.reasoningEffort===true,addedModelNotices:countNotices()-beforeNotices});
        console.log('studio-model-route',JSON.stringify(routes.at(-1)));
      };
      await sessions.open(task,'仅编辑 需求/requirement.md；作者通过工作台确认。',undefined);
      await assert.rejects(ctx.sessionController.selectModel({sessionId:task.sessionId,provider:'studio-fixture-a',model:'not-listed'}));
      await send('new direct followup after rejected API switch',{provider:'studio-fixture-a',model:'alpha',reasoningEffort:'low'},true);
      defaultEffort='high';await reopen();
      await send('restore lastUsed adapter default',{provider:'studio-fixture-a',model:'alpha',reasoningEffort:'high'},true);
      await ctx.sessionController.selectModel({sessionId:task.sessionId,provider:'studio-fixture-a',model:'alpha',reasoningEffort:'low'});
      await send('API explicit effort switch',{provider:'studio-fixture-a',model:'alpha',reasoningEffort:'low'},false);
      await reopen();
      await send('restore lastUsed explicit effort',{provider:'studio-fixture-a',model:'alpha',reasoningEffort:'low'},false);
      ctx.agents.get(task.sessionId).session.append('model/selection',{provider:'studio-fixture-b',model:'beta',reasoningEffort:'high'});
      await reopen();
      await send('restore pending different route',{provider:'studio-fixture-b',model:'beta',reasoningEffort:'high'},false,1);
      defaultEffort='low';
      ctx.agents.get(task.sessionId).session.append('model/selection',{provider:'studio-fixture-b',model:'beta'});
      await reopen();
      await send('pending same route clears explicit effort',{provider:'studio-fixture-b',model:'beta',reasoningEffort:'low'},true);
      await ctx.sessionController.selectModel({sessionId:task.sessionId,provider:'studio-fixture-a',model:'alpha',reasoningEffort:'high'});
      await send('later API route switch remains effective',{provider:'studio-fixture-a',model:'alpha',reasoningEffort:'high'},false,1);
      // Both official installers must snapshot one route before delegation. A
      // switch while an inner assembly is paused belongs to the next request.
      const live=ctx.agents.get(task.sessionId), assemblies=[];
      let enterBarrier, releaseBarrier;
      const entered=new Promise(resolve=>{enterBarrier=resolve;});
      const barrier=new Promise(resolve=>{releaseBarrier=resolve;});
      let paused=false;
      const disposeCapture=live.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{const value=await next();assemblies.push({provider:value.variables.provider,model:value.variables.model});return value;},{prepend:true});
      const disposeBarrier=live.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{if(!paused){paused=true;enterBarrier();await barrier;}return next();});
      const concurrent=send('concurrent assembly keeps captured route',{provider:'studio-fixture-a',model:'alpha',reasoningEffort:'high'},false);
      await entered;
      await ctx.sessionController.selectModel({sessionId:task.sessionId,provider:'studio-fixture-b',model:'beta',reasoningEffort:'low'});
      releaseBarrier();await concurrent;
      assert.deepEqual(assemblies.at(-1),{provider:'studio-fixture-a',model:'alpha'});
      await send('concurrent switch takes next request',{provider:'studio-fixture-b',model:'beta',reasoningEffort:'low'},false,1);
      assert.deepEqual(assemblies.at(-1),{provider:'studio-fixture-b',model:'beta'});
      disposeCapture();disposeBarrier();
      await send('official API image admission uses shared route',{provider:'studio-fixture-b',model:'beta',reasoningEffort:'low'},false,0,async()=>{
        await ctx.sessionController.prompt({sessionId:task.sessionId,requestId:'studio-local-image',mode:'queue',content:[{type:'image',mediaType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='}]},new AbortController().signal);
      });
      // Put an asynchronous middleware between the two entry-point installers.
      // The switch notice must describe the final route sent to the supplier.
      await reopen();
      const middle=ctx.agents.get(task.sessionId);
      let enterMiddle, releaseMiddle;
      const middleEntered=new Promise(resolve=>{enterMiddle=resolve;});
      const middleGate=new Promise(resolve=>{releaseMiddle=resolve;});
      let middlePaused=false;
      const disposeMiddle=middle.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{if(!middlePaused){middlePaused=true;enterMiddle();await middleGate;}return next();});
      await ctx.sessionController.selectModel({sessionId:task.sessionId,provider:'studio-fixture-a',model:'alpha',reasoningEffort:'high'});
      const noticeBefore=middle.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='model-selection').length;
      const middleRequest=send('middle middleware keeps captured route',{provider:'studio-fixture-a',model:'alpha',reasoningEffort:'high'},false,1);
      await middleEntered;
      await ctx.sessionController.selectModel({sessionId:task.sessionId,provider:'studio-fixture-c',model:'alpha',reasoningEffort:'low'});
      releaseMiddle();await middleRequest;
      const middleNotices=middle.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='model-selection').slice(noticeBefore);
      assert.match(JSON.stringify(middleNotices),/session continues with studio-fixture-a\/alpha/,'notice must describe the supplier route captured before the middle middleware');
      disposeMiddle();
      await send('middle switch takes next request',{provider:'studio-fixture-c',model:'alpha',reasoningEffort:'low'},false,1);
      await reopen();
      const firstApi=ctx.agents.get(task.sessionId);
      let enterFirst, releaseFirst;
      const firstEntered=new Promise(resolve=>{enterFirst=resolve;});
      const firstGate=new Promise(resolve=>{releaseFirst=resolve;});
      let firstPaused=false;
      const disposeFirst=firstApi.ctx.on('system-prompt/assemble',async(_assembly,_context,next)=>{if(!firstPaused){firstPaused=true;enterFirst();await firstGate;}return next();});
      const firstRequest=send('first API installation keeps captured request',{provider:'studio-fixture-c',model:'alpha',reasoningEffort:'low'},false);
      await firstEntered;
      await ctx.sessionController.selectModel({sessionId:task.sessionId,provider:'studio-fixture-a',model:'alpha',reasoningEffort:'high'});
      releaseFirst();await firstRequest;
      await send('first API installation applies on next request',{provider:'studio-fixture-a',model:'alpha',reasoningEffort:'high'},false,1);
      disposeFirst();
      await sessions.dispose();results.push({routes});
      releaseGuard();
      await writeFile(output,JSON.stringify(results));
    } finally {await app.shutdown.shutdown(0)}
  `.replaceAll('\`','`'))
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|^DSH_|^NODE_OPTIONS$|^NODE_PATH$/iu.test(name)))
  const executed = await promisify(execFile)(path.join(prepared, '../electron/electron.exe'), ['--expose-internals', diagnostic, fixture, output, path.join(repository,'packages/studio-plugin/assets/prototype-template'), path.join(repository,'packages/studio-plugin/assets/prototype-template.manifest.json')], { cwd: fixture,
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: path.join(fixture, 'home'), DSH_AGENTS_HOME: path.join(fixture, 'agents'), DSH_TELEMETRY_DISABLED: '1', DSH_CLIENT_VERSION: 'studio-task-preset-acceptance', NARB_NATIVE_CACHE_DIR: path.join(fixture, 'native-cache') },
    windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }).catch(error => { throw new Error(`${error.message}\ncode=${error.code} signal=${error.signal} killed=${error.killed}\nstdout:\n${error.stdout}\nstderr:\n${error.stderr}`, { cause: error }) })
  assert.ok(!executed.killed)
  const results=JSON.parse(await readFile(output,'utf8'))
  assert.equal(results.length,5)
  assert.equal(results[4].routes.length,14)
  t.diagnostic(JSON.stringify(results[4]))
})
