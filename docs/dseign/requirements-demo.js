/* Local, finite demonstration data; no remote model, backend or Git operations. */
(function () {
  'use strict';
  const KEY = 'eadp-requirements-design-demo-v1';
  let state;
  let activeRequirementId=null;
  let storageProblem = '';
  const clone = value => JSON.parse(JSON.stringify(value));
  const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function toast(message) {
    let stack = document.querySelector('.toast-stack');
    if (!stack) { stack = document.createElement('div'); stack.className = 'toast-stack'; stack.setAttribute('role', 'status'); document.body.appendChild(stack); }
    const item = document.createElement('div'); item.className = 'toast'; item.textContent = message; stack.appendChild(item); setTimeout(() => item.remove(), 5500);
  }
  function showStorageProblem(message) {
    storageProblem = message;
    const shell = document.querySelector('.main-content');
    if (shell && !document.querySelector('.storage-warning')) { const notice = document.createElement('div'); notice.className = 'storage-warning'; notice.setAttribute('role', 'alert'); notice.textContent = message; shell.prepend(notice); }
  }
  function seed() {
    const scenes = [
      ['sc-01','SC-01','核心企业准入与授信','v1.2','企业提交完整资质后进入授信初审；资质到期时暂停新增融资申请。'],
      ['sc-02','SC-02','账单冲销与汇差处理','v1.1','冲销需保留原账单与冲销原因；汇率折算以财务确认口径为准。'],
      ['sc-03','SC-03','电子商业汇票质押','v1.0','质押前核验持票人与票据状态；到期前向经办人发送提示。'],
      ['sc-04','SC-04','监管账户资金清算','v1.3','按照签署的结算协议分账；账户余额不足时终止该笔划拨。'],
      ['sc-05','SC-05','保证金与违约处理','v1.0','保证金低于约定阈值时通知补足；宽限期与罚息口径待业务明确。'],
      ['sc-06','SC-06','多边对账差异调节','v1.2','将商户、企业和银行流水按交易标识匹配；未匹配项保留处理记录。'],
      ['sc-07','SC-07','结算税费与发票','v1.0','结算清单生成后核对税费与发票；不匹配项交经办人核实。'],
      ['sc-08','SC-08','融资申请与审批','v1.1','融资申请引用有效授信额度；审批通过后才能发起放款。'],
      ['sc-09','SC-09','跨境多级保理池','v1.2','贴现报价确认后锁定汇率 60 秒；超时必须重新询价并由用户确认。']
    ].map(([id,code,title,version,excerpt]) => ({id,code,title,version,excerpt,builtin:false,status:'confirmed'}));
    scenes.forEach((scene,index)=>{scene.code='SC-'+String(index+1).padStart(4,'0');});
    scenes.push({id:'general',code:'SC-0010',title:'通用场景',version:'系统预置 v1.0',builtin:true,status:'builtin',excerpt:'为跨场景共通能力提供真实来源归属，不提供具体业务依据，不参与业务拆分。'});
    scenes.forEach((scene,index)=>{scene.assetUuid='10000000-0000-4000-8000-'+String(index+1).padStart(12,'0');});
    const records = [
      [1,'核心企业准入与授信初审规约','核心企业资质核验、授信初审与审批留痕，明确材料有效期与异常处理。',['sc-01'],'confirmed',3,0],
      [2,'对账单冲销与汇差异常处理','保留冲销原因与原始账单，明确跨币种冲销的汇差处理口径。',['sc-02','sc-06'],'draft',2,1],
      [3,'电子商业汇票质押与挂账','支持票据核验、质押登记与到期提示，记录质押状态变化。',['sc-03'],'confirmed',5,0],
      [4,'资金实时划拨与分账结算','按结算协议执行监管账户分账，处理余额不足与划拨异常。',['sc-04'],'confirmed',4,0],
      [5,'保证金追缴与违约罚息机制','根据保证金阈值提示追缴，整理宽限期与罚息的业务约定。',['sc-05'],'draft',2,2],
      [6,'多边对账差异调节表生成','汇总商户、核心企业与银行流水，形成待核实的差异清单。',['sc-06'],'confirmed',4,0],
      [7,'税费自动代扣与电子发票匹配','核对结算税费与发票，支持异常项交人工确认与处理留痕。',['sc-07'],'confirmed',3,0],
      [8,'融资申请额度校验与审批流转','提交融资申请前校验有效额度，审批与放款分别保留业务记录。',['sc-08','sc-01'],'draft',3,1],
      [9,'跨境保理池动态贴现与结算规约','覆盖跨境供应链贴现报价、60 秒汇率锁定与监管账户分账。',['sc-09','sc-04'],'draft',3,1],
      [10,'业务操作记录查询与导出','提供统一的业务操作查询与导出能力，待补充适用范围与权限依据。',['general'],'draft',0,1],
      [11,'融资到期提醒与还款登记','汇总待还融资，支持到期提示与还款登记，保留处理轨迹。',['sc-08'],'draft',2,1],
      [12,'账户分账异常补偿处理','针对划拨失败的交易记录原因并安排人工复核，防止重复处理。',['sc-04'],'draft',2,1],
      [13,'质押解押审核与凭据归档','解押前校验申请权限和票据状态，归档审批依据与处理凭据。',['sc-03'],'confirmed',3,0]
    ];
    const requirements = records.map(([n,title,summary,scenarioIds,status,ruleCount,questionCount]) => {
      const code = 'REQ-' + String(n).padStart(4,'0');
      const rules = Array.from({length:ruleCount},(_,i) => ({title:i === 0 ? scenes.find(s=>s.id===scenarioIds[0]).excerpt : '业务规则 ' + (i+1) + '：关键操作必须记录经办人与处理结果。'}));
      const questions = Array.from({length:questionCount},(_,i) => ({title:n === 9 ? '汇率锁定超时后，已填写的分账信息保留多久？' : '请明确异常分支 ' + (i+1) + ' 的业务处理责任与时限。',core:true,resolved:false}));
      const body = '# ' + title + '\n\n## 目标\n\n' + summary + '\n\n## 范围\n\n本需求覆盖上述业务能力的主流程及异常处理。\n\n## 业务规则\n\n' + rules.map((r,i)=>(i+1)+'. '+r.title).join('\n') + '\n\n## 验收依据\n\n- 给定已具备有效业务资料，当经办人提交操作时，应按已明确的业务规则返回可判断的结果。\n\n## 待澄清\n\n' + (questions.length ? questions.map(q=>'- [ ] '+q.title).join('\n') : '无核心待澄清项。');
      if(n===9) questions.forEach(question=>{question.core=false;});
      const sourceRefs=scenarioIds.map(id=>{const scene=scenes.find(s=>s.id===id);return {scenarioId:id,version:scene.version,excerpt:scene.excerpt};});
      return {id:'req-'+String(n).padStart(4,'0'),assetUuid:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),code,title,summary,scenarioIds,sourceRefs,status,version:status==='confirmed'?'v1.0':'草稿',body,revision:1,creator:n===9?'李宇晨':'陈越',editor:n===9?'李宇晨':'赵宏',updatedAt:'2026-10-'+String(21-(n%7)).padStart(2,'0')+'T09:30:00+08:00',rules,questions,templateId:'default-requirement'};
    });
    return {scenarios:scenes,requirements,findings:[
      {id:'finding-1',requirementId:'req-0009',scenarioId:'sc-09',summary:'来源约定汇率锁定 60 秒；需求尚未明确超时重新询价时如何保留分账信息。',status:'pending',reminder:true,revision:1,note:''},
      {id:'finding-2',requirementId:'req-0002',scenarioId:'sc-02',summary:'冲销汇差使用的汇率时点在两份材料中的表述不同，需要财务确认修改方向。',status:'pending',reminder:true,revision:1,note:''},
      {id:'finding-3',requirementId:'req-0001',scenarioId:'sc-01',summary:'资质到期提示的接收角色在需求中尚未展开。',status:'handled',reminder:false,revision:2,note:'已登记由企业经办人接收，材料修改将单独发起修订。'},
      {id:'finding-4',requirementId:'req-0005',scenarioId:'sc-05',summary:'来源中的宽限期只作举例，不应直接解释为已确认业务规则。',status:'ignored',reminder:false,revision:2,note:'当前为非适用示例，保留忽略记录。'}
    ],comparisons:[],nextSequence:14,templates:[{id:'default-requirement',title:'默认需求模板',version:'v1.0',body:'# 需求名称\n\n## 目标\n\n## 范围\n\n## 业务规则\n\n## 验收依据\n\n## 待澄清\n'}]};
  }
  function load() {
    if (state) return clone(state);
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { state = JSON.parse(raw); if (!Array.isArray(state.requirements) || !Array.isArray(state.scenarios) || !Array.isArray(state.findings) || !Array.isArray(state.comparisons) || !Number.isInteger(state.nextSequence)) throw new Error('演示数据格式错误'); }
      else { state = seed(); localStorage.setItem(KEY, JSON.stringify(state)); }
    } catch (error) {
      state = seed(); showStorageProblem('演示资料无法读取或持久保存；本次修改仅在当前页面有效，跳转后可能丢失。' + (error.message ? ' '+error.message : ''));
    }
    return clone(state);
  }
  function save(next) {
    try { localStorage.setItem(KEY,JSON.stringify(next)); } catch (error) { showStorageProblem('浏览器无法持久保存演示资料；本次修改未保存，请保留输入后重试。'); toast('未能持久保存，请保留当前页面中的内容。'); throw new Error('演示资料未能持久保存，请保留输入后重试。'); }
    state = next;
    renderRequirementNav(activeRequirementId);
    window.dispatchEvent(new CustomEvent('requirements-demo-change'));
  }
  function validSources(ids) {
    if (!Array.isArray(ids) || !ids.length) throw new Error('请至少选择一个来源场景。');
    const known = load().scenarios;
    if (ids.some(id=>!known.some(s=>s.id===id))) throw new Error('来源场景不存在，请重新选择。');
    return [...new Set(ids)];
  }
  function create(input) {
    const data = load(); const title = String(input.title || '').trim();
    if (!title || title.length>100) throw new Error('需求名称为必填，且不得超过 100 个字。');
    const scenarioIds = validSources(input.scenarioIds); const number = data.nextSequence++;
    const code = 'REQ-'+String(number).padStart(4,'0');
    const req = {...input,id:'req-'+String(number).padStart(4,'0'),assetUuid:crypto.randomUUID(),code,title,scenarioIds,status:'draft',version:'草稿',body:input.body||'',summary:input.summary||'',revision:1,creator:'李宇晨',editor:'李宇晨',updatedAt:new Date().toISOString(),rules:input.rules||[],questions:input.questions||[],templateId:input.templateId||'default-requirement'};
    req.sourceRefs=scenarioIds.map(id=>{const scene=data.scenarios.find(s=>s.id===id);return {scenarioId:id,version:scene.version,excerpt:scene.excerpt};});
    data.requirements.push(req); save(data); return clone(req);
  }
  function update(id, patch) {
    const data = load(); const index = data.requirements.findIndex(r=>r.id===id); if(index<0) throw new Error('需求不存在，无法保存。');
    if (patch.scenarioIds) patch = {...patch,scenarioIds:validSources(patch.scenarioIds)};
    const old = data.requirements[index];
    if(patch.scenarioIds && JSON.stringify([...patch.scenarioIds].sort())!==JSON.stringify([...old.scenarioIds].sort())) patch={...patch,sourceRefs:patch.scenarioIds.map(id=>{const previous=old.sourceRefs.find(ref=>ref.scenarioId===id);const scene=data.scenarios.find(s=>s.id===id);return previous||{scenarioId:id,version:scene.version,excerpt:scene.excerpt};})};
    data.requirements[index] = {...old,...patch,id:old.id,code:old.code,creator:old.creator,revision:old.revision+1,updatedAt:new Date().toISOString()};
    save(data); return clone(data.requirements[index]);
  }
  function updateFinding(id, patch) {
    const data=load(); const index=data.findings.findIndex(f=>f.id===id); if(index<0) throw new Error('差异记录不存在。');
    const old=data.findings[index]; const allowed={}; ['status','reminder','note'].forEach(key=>{if(key in patch) allowed[key]=patch[key];});
    data.findings[index]={...old,...allowed,revision:old.revision+1}; save(data); return clone(data.findings[index]);
  }
  function addComparison(requirementId,result) {
    const data=load(); if(!data.requirements.some(r=>r.id===requirementId)) throw new Error('需求不存在。');
    const record={...result,id:'comparison-'+Date.now()+'-'+data.comparisons.length,requirementId,createdAt:new Date().toISOString()}; data.comparisons.push(record); save(data); return clone(record);
  }
  function addFinding(record) {
    const data=load(); if(!data.requirements.some(r=>r.id===record.requirementId)) throw new Error('需求不存在。');
    const finding={status:'pending',reminder:true,note:'',...record,id:'finding-'+Date.now()+'-'+data.findings.length,revision:1}; data.findings.push(finding); save(data); return clone(finding);
  }
  function publishTemplate(input) {
    const data=load();
    if(!String(input.title||'').trim()||!String(input.body||'').trim()) throw new Error('模板名称与正文不能为空。');
    const template={id:'template-'+crypto.randomUUID(),title:String(input.title).trim(),body:String(input.body),version:'v1.0'};
    data.templates.push(template); save(data); return clone(template);
  }
  function renderRequirementNav(currentId) {
    const container=document.getElementById('requirement-nav'); if(!container) return;
    const items=load().requirements; container.dataset.activeId=currentId||'';
    const parent=document.querySelector('.sidebar nav > a.active'); if(parent){if(currentId)parent.removeAttribute('aria-current');else parent.setAttribute('aria-current','page');}
    container.innerHTML=items.map(req=>'<a class="requirement-nav-item'+(req.id===currentId?' current':'')+'" href="需求协同新增编辑.html?id='+encodeURIComponent(req.id)+'" title="'+escape(req.code+' '+req.title)+'"'+(req.id===currentId?' aria-current="page"':'')+'><span class="requirement-nav-code">'+escape(req.code)+'</span><span class="requirement-nav-name">'+escape(req.title)+'</span></a>').join('');
    const counter=document.querySelector('.sidebar .nav-count'); if(counter)counter.textContent=items.length;
    container.querySelector('[aria-current="page"]')?.scrollIntoView({block:'nearest'});
  }
  function mountShell(options) {
    const data=load(); const req=options?.requirement; activeRequirementId=req?.id||null;
    document.querySelector('#app-shell').innerHTML='<header class="topbar"><div class="brand-line"><div class="shell-menu"><button data-shell-action="侧栏菜单" aria-label="侧栏菜单">☰</button><button data-shell-action="应用菜单">应用(A)</button><button data-shell-action="编辑菜单">编辑(E)</button></div><strong>EADP Studio</strong><span class="muted">工作台 / eadp-core-design</span></div><div class="shell-end"><span class="demo-marker">交互设计演示</span><div class="window-controls"><button data-shell-action="最小化窗口" aria-label="最小化窗口">―</button><button data-shell-action="最大化窗口" aria-label="最大化窗口">▢</button><button data-shell-action="关闭窗口" aria-label="关闭窗口">×</button></div></div></header><aside class="sidebar"><div class="project-block"><strong>▤ &nbsp; eadp-core-design</strong><small>供应链金融 · 项目工作空间</small></div><div class="nav-heading">STUDIO NAVIGATION</div><nav><a href="项目场景列表.html"><span class="nav-icon">▦</span>项目场景</a><a class="active" href="需求协同列表.html" aria-current="page"><span class="nav-icon">▤</span>需求协同<span class="nav-count">'+data.requirements.length+'</span></a>'+'<div class="requirement-nav" id="requirement-nav" aria-label="需求编号与名称"></div>'+'<button type="button" data-shell-action="原型展示"><span class="nav-icon">▣</span>原型展示</button><button type="button" data-shell-action="基线确认"><span class="nav-icon">◇</span>基线确认</button><button type="button" data-shell-action="交接清单"><span class="nav-icon">☷</span>交接清单</button></nav><div class="sidebar-footer"><span class="avatar">李</span><div><strong>李宇晨</strong><br><small class="muted">项目成员</small></div></div></aside>';
    document.querySelectorAll('[data-shell-action]').forEach(button=>button.addEventListener('click',()=>toast(button.dataset.shellAction+'不在本次需求设计演示范围内。')));
    renderRequirementNav(activeRequirementId);
    if(storageProblem) showStorageProblem(storageProblem);
  }
  window.RequirementsDemo={load,list:()=>load().requirements,get:id=>load().requirements.find(r=>r.id===id),create,update,updateFinding,addComparison,addFinding,publishTemplate,scene:id=>load().scenarios.find(s=>s.id===id),escape,toast,mountShell};
})();

