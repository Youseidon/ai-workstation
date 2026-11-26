import Database from 'better-sqlite3';
const [mode,directory]=process.argv.slice(2);
const {workspaces}=await import('../../src/repositories/workspaces.ts');
if(mode==='seed') {
  const workspace=workspaces.create({name:'Isolated migration fixture',description:'',workDirectory:directory});
  const program=workspaces.createChild('program',workspace.id,{name:'Program',overview:''});
  const suite=workspaces.createChild('suite',program.id,{name:'Suite',overview:''});
  const prompt=workspaces.createChild('prompt',suite.id,{title:'Historical requirement',content:'Preserve historical implementation'});
  const runId='run_migration_fixture';
  workspaces.beginAgentRun({runId,workspaceId:workspace.id,promptId:prompt.id,provider:'codex',model:null,tokenHash:'fixture',expiresAt:new Date(Date.now()+3600000).toISOString()});
  workspaces.recordAgentEvent(runId,{id:'evt_migration_fixture',runId,provider:'codex',model:null,timestamp:new Date().toISOString(),type:'assistant_text',payload:{blockId:'history',kind:'message',delta:false,text:'Historical implementation evidence'}});
  workspaces.updateAgentStatus(runId,{requestId:'migration-status-fixture',expectedStatus:'IN_PROGRESS',status:'CONTINUE',reason:'Historical checkpoint preserved'});
  workspaces.finishAgentRun(runId,'done');
}
workspaces.close();
const db=new Database(process.env.HYDRA_DB);
console.log(JSON.stringify({version:db.prepare('SELECT MAX(version) n FROM schema_migration').get().n,integrity:db.pragma('integrity_check',{simple:true}),foreignKeys:db.pragma('foreign_key_check')}));
db.close();
