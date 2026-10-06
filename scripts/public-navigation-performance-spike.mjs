/** Explicitly gated, read-only navigation timing probe. No provider or page action. */
if(process.env.PLAYWRIGHT_DEMO_NAVIGATION_SPIKE!=='1')throw new Error('Navigation spike gate is closed');
const {randomUUID}=await import('node:crypto');
const {loadProjectEnv}=await import('../dist/local/project-env.js');
loadProjectEnv();
const {readSubprocessTrustedConfiguration}=await import('../dist/subprocess/entry.js');
const {ProfileCatalog,ProtectedContextFactory}=await import('../dist/profile/index.js');
const {McpExplorationSession}=await import('../dist/exploration/mcp.js');
const root='https://the-internet.herokuapp.com/';
const configPath=process.env.PLAYWRIGHT_DEMO_TRUSTED_CONFIG;
if(!configPath)throw new Error('Trusted configuration is required');
const config=await readSubprocessTrustedConfiguration(configPath,'active-poc');
const ref=config.publicTargetApproval?.executionProfileRef;
if(!ref)throw new Error('No approved public profile');
const catalog=new ProfileCatalog(config.profiles,config.networkPolicies),profile=catalog.resolve(ref);
const factory=new ProtectedContextFactory(catalog);
const rows=[];
async function targetReady(page,deadline){
  const target=page.getByRole('link',{name:'Dropdown',exact:true});
  while(Date.now()<deadline){
    if(await target.count()===1&&await target.isVisible()&&await target.isEnabled())return true;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  return false;
}
for(const phase of ['exploration','compilation','replay_1','replay_2']){
  let session,cleanup='not_started';
  const row={phase,requestStartMs:0,domcontentloadedMs:null,freshTargetMs:null,authoredStepStartMs:null,
    bootstrapAdopted:false,cleanup};rows.push(row);
  const start=performance.now();
  try{
    if(phase==='exploration'||phase==='compilation'){
      session=await McpExplorationSession.open(factory,ref,profile,`${phase}-${randomUUID()}`);
      row.requestStartMs=Math.round(performance.now()-start);
      await session.navigate(root);
      row.domcontentloadedMs=Math.round(performance.now()-start);
      row.bootstrapAdopted=session.consumeMatchingBootstrapNavigation(root);
      const page=session.browserSession.context.pages()[0];
      if(!page||!row.bootstrapAdopted)throw new Error('NAVIGATION_NOT_REUSABLE');
      if(!await targetReady(page,Date.now()+10000))throw new Error('TARGET_UNAVAILABLE');
    }else{
      session=await factory.open(ref,profile,{observationOwner:{kind:'run',id:`${phase}-${randomUUID()}`}});
      const page=await session.context.newPage();
      row.requestStartMs=Math.round(performance.now()-start);
      const response=await page.goto(root,{waitUntil:'domcontentloaded',timeout:profile.profile.timeoutPolicy.navigationMs});
      row.domcontentloadedMs=Math.round(performance.now()-start);
      row.bootstrapAdopted=!!response&&!response.request().redirectedFrom()&&response.url()===root&&page.url()===root;
      if(!row.bootstrapAdopted)throw new Error('NAVIGATION_NOT_REUSABLE');
      if(!await targetReady(page,Date.now()+10000))throw new Error('TARGET_UNAVAILABLE');
    }
    row.freshTargetMs=Math.round(performance.now()-start);
    row.authoredStepStartMs=row.freshTargetMs;
  }catch(error){row.stop=error instanceof Error?error.name:'ENVIRONMENT_STOP';}
  finally{
    if(session)try{await session.close();cleanup='verified';}catch{cleanup='unverified';}
    row.cleanup=cleanup;
  }
}
for(const row of rows)process.stdout.write(JSON.stringify(row)+'\n');
if(rows.some(row=>row.stop||row.cleanup!=='verified'))process.exitCode=1;
