/**
 * One SSH-owned operation under remote flock. The target is a configured POSIX
 * filesystem; its web root resolves <root>/current. Only that pointer is public.
 * Node and flock are explicit target prerequisites, never an installed daemon.
 */
export const REMOTE_PUBLICATION_RUNNER = String.raw`
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let text=''; process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {text+=chunk;if(Buffer.byteLength(text)>100*1024*1024)process.exit(2)});
process.stdin.on('end',()=>run().catch(()=>{process.stdout.write(JSON.stringify({operationId:'unknown',phase:'unknown',message:'远端操作中断，必须查询当前结果。'}));process.exitCode=1}));
async function run(){
 const q=JSON.parse(text), root=q.root, current=path.join(root,'current'), operations=path.join(root,'.operations');
 if(!path.isAbsolute(root)||!/^[-a-zA-Z0-9/_. ]+$/.test(root)||root==='/')throw Error('root');
 if(q.operationId!==undefined&&!/^[a-f0-9-]{36}$/.test(q.operationId))throw Error('operation');
 await fs.mkdir(operations,{recursive:true,mode:0o700});
 const atomic=async(file,value)=>{const tmp=file+'.'+crypto.randomUUID();await fs.writeFile(tmp,JSON.stringify(value),{mode:0o600});await fs.rename(tmp,file)};
 const read=async(file)=>{try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}};
 const info=async()=>read(path.join(current,'studio-publication.json'));
 const answer=value=>process.stdout.write(JSON.stringify(value));
 const existing=await info();
 const verify=async descriptor=>{
  if(!descriptor||!Array.isArray(descriptor.files))throw Error('descriptor');
  const headers=q.accessHeaders||{};
  const descriptorUrl=new URL('studio-publication.json',q.url);descriptorUrl.searchParams.set('studio-operation',crypto.randomUUID());
  if(q.access==='restricted'){
   const unauthorized=await fetch(descriptorUrl,{redirect:'manual',cache:'no-store',signal:AbortSignal.timeout(10000)});
   if(![401,403].includes(unauthorized.status))throw Error('access policy');
  }
  const remote=await fetch(descriptorUrl,{headers,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!remote.ok||JSON.stringify(await remote.json())!==JSON.stringify(descriptor))throw Error('online descriptor');
  for(const file of descriptor.files){
   const url=new URL(file.path.split('/').map(encodeURIComponent).join('/'),q.url);url.searchParams.set('studio-build',descriptor.buildId);
   const response=await fetch(url,{headers,cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!response.ok||hash(Buffer.from(await response.arrayBuffer()))!==file.sha256)throw Error('online checksum');
  }
 };
 if(q.action==='query'){
  const record=q.operationId?await read(path.join(operations,q.operationId+'.json')):null;
  if(q.operationId&&record&&record.phase!=='unknown'){answer(record);return}
  if(existing&&(!q.operationId||existing.operationId===q.operationId)){
   try{await verify(existing);const result={operationId:existing.operationId,phase:'shareable',baselineId:existing.baselineId,commitSha:existing.commitSha,artifactSha256:existing.artifactSha256,url:q.url};await atomic(path.join(operations,existing.operationId+'.json'),result);answer(result)}
   catch{answer({operationId:existing.operationId,phase:'unknown',message:'当前线上产物尚未通过核验。'})}
  }else answer(q.operationId?record||{operationId:q.operationId,phase:'unknown'}:{operationId:'none',phase:'revoked'});return;
 }
 if(!/^[a-f0-9-]{36}$/.test(q.operationId))throw Error('operation');
 const recordFile=path.join(operations,q.operationId+'.json');
 const prior=await read(recordFile);if(prior){answer(prior);return}
 let result={operationId:q.operationId,phase:'unknown'};
 await atomic(recordFile,result);
 const withdraw=async()=>{
  let target;try{target=await fs.readlink(current)}catch(e){if(e.code!=='ENOENT')throw e}
  if(target&&!/^\.upload-[a-f0-9-]{36}$/.test(target))throw Error('unmanaged current');
  await fs.rm(current,{force:true});if(target)await fs.rm(path.join(root,target),{recursive:true,force:true});
  const url=new URL('studio-publication.json',q.url);url.searchParams.set('studio-operation',q.operationId);
  const response=await fetch(url,{cache:'no-store',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(![401,403,404,410].includes(response.status))throw Error('withdraw verification');
 };
 if(q.action==='revoke'){
  if(!existing||existing.artifactSha256!==q.expectedArtifactSha256)throw Error('stale revoke');
  await withdraw();result={operationId:q.operationId,phase:'revoked'};await atomic(recordFile,result);answer(result);return;
 }
 if(q.action!=='publish')throw Error('action');
 const a=q.artifact, baseline=a.baseline;
 // The authority is read again INSIDE the remote lock, using a short-lived
 // operation-scoped read token; an old desktop request cannot replace a new baseline.
 const checkAuthority=async()=>{
  const authorityResponse=await fetch(q.authorityUrl,{headers:{Authorization:'Bearer '+q.authorityToken},redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!authorityResponse.ok)throw Error('authority');
  const latest=await authorityResponse.json();
  if(latest.projectId!==baseline.projectId||latest.assetId!==baseline.assetId||latest.baselineId!==baseline.baselineId||latest.commitSha!==baseline.commitSha||latest.acceptedHead!==baseline.acceptedHead||!latest.completionEvidence?.length||JSON.stringify(latest.completionEvidence)!==JSON.stringify(baseline.completionEvidence))throw Error('stale baseline');
 };
 await checkAuthority();
 const stageName='.upload-'+q.operationId, stage=path.join(root,stageName);let replaced=false;
 try{
  await fs.mkdir(stage,{mode:0o755});
  for(const file of a.files){
   if(typeof file.path!=='string'||file.path.startsWith('/')||file.path.includes('\\')||file.path.split('/').some(p=>!p||p==='..'||p==='.'||p.startsWith('.'))||/\.(?:md|pem|key|pfx|map)$/i.test(file.path))throw Error('artifact path');
   const bytes=Buffer.from(file.bytes,'base64');if(hash(bytes)!==file.sha256)throw Error('artifact checksum');
   const target=path.join(stage,file.path);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,bytes,{flag:'wx',mode:0o644});
  }
  if(hash(JSON.stringify(a.files.map(({path,sha256})=>({path,sha256}))))!==a.sha256)throw Error('manifest checksum');
  const descriptor={operationId:q.operationId,projectId:baseline.projectId,assetId:baseline.assetId,baselineId:baseline.baselineId,commitSha:baseline.commitSha,buildId:a.buildId,artifactSha256:a.sha256,files:a.files.map(({path,sha256})=>({path,sha256}))};
  await fs.writeFile(path.join(stage,'studio-publication.json'),JSON.stringify(descriptor),{flag:'wx',mode:0o644});
  let previous;try{previous=await fs.readlink(current)}catch(e){if(e.code!=='ENOENT')throw e}
  if(previous&&!/^\.upload-[a-f0-9-]{36}$/.test(previous))throw Error('unmanaged current');
  await checkAuthority();
  const pointer=path.join(root,'.pointer-'+q.operationId);await fs.symlink(stageName,pointer);await fs.rename(pointer,current);replaced=true;
  if(previous)await fs.rm(path.join(root,previous),{recursive:true,force:true});
  await verify(descriptor);
  result={operationId:q.operationId,phase:'shareable',baselineId:baseline.baselineId,commitSha:baseline.commitSha,artifactSha256:a.sha256,url:q.url};
 }catch(e){
  if(replaced){try{await withdraw();result={operationId:q.operationId,phase:'failed',message:'当前站点验证失败，已撤回访问。'}}catch{result={operationId:q.operationId,phase:'unknown',message:'当前站点验证或撤回结果未知，必须核对。'}}}
  else{await fs.rm(stage,{recursive:true,force:true});result={operationId:q.operationId,phase:'failed',message:'替换前发布失败，当前站点未改变。'}}
 }
 await atomic(recordFile,result);answer(result);
}`
