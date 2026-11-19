// Route-wide checks for the shared application shell, run against a production
// build with the agent server mocked at the network layer.
//
//   npm --workspace web run build
//   (cd web && npx next start -p 3917) &
//   SHELL_BASE_URL=http://127.0.0.1:3917 node scripts/verify-shell-browser.mjs
//
// CHAT_PLAYWRIGHT_MODULE / CHAT_BROWSER_EXECUTABLE work as in verify-chat-page-browser.mjs.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixtures, launchBrowser } from './lib/shellFixtures.mjs';
const base=process.env.SHELL_BASE_URL ?? 'http://127.0.0.1:3917';
const output=await mkdtemp(join(tmpdir(),'shell-browser-'));
const {api,now}=createFixtures();

const browser=await launchBrowser();
const page=await browser.newPage({viewport:{width:1440,height:900}});
const errors=[];page.on('pageerror',error=>errors.push(`${page.url()}: ${error.message}`));
await page.route('**/api/**',api);
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
const collection=name=>page.getByRole('navigation',{name,exact:true});
async function shellContract(route){
 assert(await page.getByRole('main').count()===1,`${route}: one main landmark`);
 assert(await page.locator('aside.app-sidebar').count()===1,`${route}: one sidebar`);
 assert(await page.locator('main aside').count()===0,`${route}: no page-owned side rail inside main`);
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${route}: no horizontal page overflow`);
}

// Activity: history and filters live in the sidebar; selection is in the URL.
await page.goto(`${base}/activity?workspace=1`);
await collection('Conversations and runs').getByRole('link',{name:/Refactor the shell/}).waitFor();
await shellContract('/activity');
assert(await collection('Conversations and runs').getByRole('link').count()===2,'activity lists only the selected workspace');
await collection('Conversations and runs').getByRole('link',{name:/Investigate flaky test/}).click();
await page.waitForURL(/run=run-b/);
await page.getByRole('heading',{name:'Investigate flaky test'}).waitFor();
assert(await collection('Conversations and runs').locator('[aria-current="page"]').innerText().then(text=>text.includes('Investigate flaky test')),'sidebar selection follows the URL');
await page.getByText(/^Filters/).click();
await page.getByLabel('State').selectOption('ERROR');
assert(await collection('Conversations and runs').getByRole('link').count()===1,'state filter narrows the sidebar collection');
await page.screenshot({path:join(output,'activity.png')});

// Workspaces: the library is the sidebar collection and follows the global selection.
await page.goto(`${base}/workspaces?workspace=1`);
await collection('Workspaces').getByRole('button',{name:/Review project/}).waitFor();
await shellContract('/workspaces');
await collection('Workspaces').getByRole('button',{name:/Review project/}).click();
await page.getByRole('heading',{name:'Review project',level:1}).waitFor();
assert(await page.locator('.app-sidebar-top').innerText().then(text=>text.includes('Review project')),'workspace switcher and library agree');
await page.screenshot({path:join(output,'workspaces.png')});

// Changes: change sets in the sidebar, then the run's files with a way back.
await page.goto(`${base}/changes?workspace=1`);
await collection('Change sets').getByRole('link',{name:/Add sidebar collections/}).waitFor();
await shellContract('/changes');
await collection('Change sets').getByRole('link',{name:/Refactor the shell/}).click();
await collection('Changed files').getByRole('link',{name:/web\/lib\/navigation.tsx/}).waitFor();
await shellContract('/changes/[runId]');
await page.getByText('-old web/app/page.tsx').waitFor();
await collection('Changed files').getByRole('link',{name:/web\/lib\/navigation.tsx/}).click();
await page.waitForURL(/file=web%2Flib%2Fnavigation.tsx/);
await page.getByText('+new web/lib/navigation.tsx').waitFor();
await page.goBack();
await page.getByText('-old web/app/page.tsx').waitFor();
await page.screenshot({path:join(output,'changes-review.png')});
await collection('Changed files').getByRole('link',{name:/All change sets/}).click();
await collection('Change sets').waitFor();

// Pipeline: the workspace's pipelines and New pipeline in the sidebar.
await page.goto(`${base}/pipeline?workspace=1`);
await collection('Pipelines').getByRole('link',{name:/Release train/}).waitFor();
await shellContract('/pipeline');
assert(await collection('Pipelines').getByRole('link',{name:/Release train/}).innerText().then(text=>text.includes('1 need you')),'pipeline attention is visible in the collection');
await page.screenshot({path:join(output,'pipeline.png')});

// Pipeline editor: its program/suite picker is the same sidebar collection, not a second rail.
await collection('Pipelines').getByRole('link',{name:/Release train/}).click();
await page.waitForURL(/\/pipeline\/7/);
await collection('Pipeline').getByRole('button',{name:/S11 · Shell/}).waitFor();
await shellContract('/pipeline/7');
await page.getByRole('button',{name:'Edit',exact:true}).click();
const picker=collection('Pipeline suites');
await picker.getByRole('button',{name:/Platform/}).waitFor();
if(await picker.getByRole('button',{name:/Collections/}).count()===0) await picker.getByRole('button',{name:/Platform/}).click();
await picker.getByRole('button',{name:/Collections/}).click();
assert(await picker.locator('[aria-pressed="true"]').count()===2,'ticking a suite in the sidebar adds it to the draft');
await page.getByText('unsaved changes').waitFor();
await shellContract('/pipeline/7 (editing)');
await page.screenshot({path:join(output,'pipeline-editor.png')});

// One application type scale.
assert(await page.evaluate(()=>getComputedStyle(document.body).fontSize)==='16px','body text uses the 16px application scale');
assert(await page.locator('main').evaluate(main=>[...main.querySelectorAll('*')].filter(el=>el.checkVisibility() && el.childElementCount===0 && el.textContent.trim()!=='' && parseFloat(getComputedStyle(el).fontSize)<12).length)===0,'no visible text below 12px on the Pipeline editor');

// Shared detail drawer: docked and non-modal on wide screens, a modal sheet below 1280px.
const details=page.locator('dialog.app-detail');
await page.getByRole('button',{name:/Show details|need you · details/}).click().catch(()=>{});
await details.waitFor();
assert(await details.evaluate(el=>el.open && !el.matches(':modal')),'detail drawer docks beside the content at 1440px');
assert(await details.evaluate(el=>!el.contains(document.activeElement)),'a docked drawer leaves keyboard focus with the content');
assert(await page.getByRole('tab',{name:'Pipeline',exact:true}).getAttribute('aria-selected')==='true','pipeline details open in the drawer');
await page.setViewportSize({width:1100,height:800});
await page.waitForFunction(()=>document.querySelector('dialog.app-detail')?.matches(':modal'));
await page.keyboard.press('Escape');
await page.waitForFunction(()=>!document.querySelector('dialog.app-detail')?.open);
await page.getByRole('button',{name:/Show details|need you · details/}).click();
await page.waitForFunction(()=>document.querySelector('dialog.app-detail')?.matches(':modal'));
await page.getByRole('button',{name:'Close details',exact:true}).click();
await page.setViewportSize({width:1440,height:900});

// Leaving the editor with unsaved changes asks first.
await collection('Pipeline suites').getByRole('link',{name:/All pipelines/}).click();
const guard=page.getByRole('dialog',{name:'Save your changes?'});
await guard.waitFor();
await guard.getByRole('button',{name:'Keep editing'}).click();
assert(new URL(page.url()).pathname==='/pipeline/7','Keep editing stays in the editor');
await page.getByText('unsaved changes').waitFor();
await page.getByRole('button',{name:/^Section: /}).click();
await page.getByRole('navigation',{name:'Sections'}).getByRole('link',{name:'Report'}).click();
await guard.getByRole('button',{name:'Discard changes'}).click();
await page.waitForURL(/\/report/);

// Discarding in the leave dialog leaves nothing to recover.
await page.goto(`${base}/pipeline/7?workspace=1`);
await collection('Pipeline').getByRole('button',{name:/S11 · Shell/}).waitFor();
assert(await page.getByText('You left unsaved changes').count()===0,'discarded changes are not offered back');
// Leaving by browser navigation keeps the unsaved changes recoverable.
await page.getByRole('button',{name:'Edit',exact:true}).click();
const picker2=collection('Pipeline suites');
await picker2.getByRole('button',{name:/Platform/}).waitFor();
if(await picker2.getByRole('button',{name:/Collections/}).count()===0) await picker2.getByRole('button',{name:/Platform/}).click();
await picker2.getByRole('button',{name:/Collections/}).click();
await page.getByText('unsaved changes').waitFor();
await page.goto(`${base}/report`);
await page.goBack();
await page.getByText('You left unsaved changes').waitFor();
await page.getByRole('button',{name:'Restore',exact:true}).click();
assert(await collection('Pipeline suites').locator('[aria-pressed="true"]').count()===2,'restoring brings back the unsaved suite selection');
await collection('Pipeline suites').getByRole('link',{name:/All pipelines/}).click();
await page.getByRole('dialog',{name:'Save your changes?'}).getByRole('button',{name:'Discard changes'}).click();
await page.waitForURL(/\/pipeline(\?|$)/);
assert(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('agent-console.pipeline-draft:')).length)===0,'discarding clears the recoverable draft');
await page.goto(`${base}/report`);

// Report and Agents: sections reachable from the same sidebar.
await collection('Report sections').getByRole('button',{name:'Summary'}).waitFor();
await shellContract('/report');
await collection('Report sections').getByRole('button',{name:'Sessions'}).click();
assert(await page.getByRole('button',{name:'Sessions',pressed:true}).count()===1,'a report link selects its breakdown');
await page.goto(`${base}/agents`);
await collection('Agents settings').getByRole('button',{name:'Model access'}).waitFor();
await shellContract('/agents');
assert(await page.locator('.content-title').getByRole('button').count()===0,'Agents actions sit with the provider list, not in the title');
await page.getByRole('button',{name:'Re-detect'}).waitFor();

// Every route reflows at 320px in every theme.
await page.setViewportSize({width:320,height:740});
for(const route of ['/activity?workspace=1','/workspaces?workspace=1','/changes?workspace=1','/changes/run-a','/pipeline?workspace=1','/pipeline/7?workspace=1','/report','/agents']){
 await page.goto(base+route);await page.waitForTimeout(600);
 for(const theme of ['midnight','deep','daylight']){
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=320),`${route} ${theme}: no horizontal overflow at 320px`);
 }
}
await page.setViewportSize({width:1440,height:900});

// Mobile: the collection moves into the drawer and a selection closes it.
await page.setViewportSize({width:375,height:760});
await page.goto(`${base}/activity?workspace=1`);
await page.getByRole('button',{name:/^Open sidebar/}).click();
const drawer=page.getByRole('dialog',{name:'Navigation'});
await drawer.getByRole('link',{name:/Refactor the shell/}).click();
await page.waitForURL(/run=run-a/);
assert(!await drawer.isVisible(),'selecting a record closes the mobile drawer');
await shellContract('/activity (mobile)');
await page.screenshot({path:join(output,'activity-mobile.png')});

// Live session: running work and pending decisions from any section.
const live=await browser.newPage({viewport:{width:1440,height:900}});
live.on('pageerror',error=>errors.push(`${live.url()}: ${error.message}`));
await live.route('**/api/**',api);
const sent=[];
const question={id:'q1',prompt:'Merge into main?',kind:'single',options:[{value:'yes',label:'Yes',description:null},{value:'no',label:'No',description:null}],required:true,recommendation:null,why:null};
const liveRun={runId:'run-live',provider:'codex',model:null,workspace:{id:1,name:'ai-orchestration',workDirectory:'/tmp/project-1'},source:{type:'saved',promptId:5,promptKey:'P-5',title:'Ship the shell',programName:'Platform',suiteName:'Shell'},role:'execute',state:'running',startedAt:now,elapsedMs:4000,usage:null,detail:null,truncated:false,permissionMode:null,
 events:[{id:'e1',runId:'run-live',provider:'codex',model:null,timestamp:now,type:'input_request',payload:{requestId:'req-1',heading:'Which branch?',questions:[question]}}]};
await live.routeWebSocket(/\/ws$/,ws=>{
 ws.onMessage(message=>{try{sent.push(JSON.parse(String(message)));}catch{}});
 ws.send(JSON.stringify({kind:'hello',providers:[],activeRuns:[liveRun]}));
});
await live.goto(`${base}/pipeline/7?workspace=1`);
const summary=live.getByRole('button',{name:'1 agent working · 1 needs you'});
await summary.waitFor();
await live.locator('dialog.app-detail[open]').waitFor();
await summary.click();
const attention=live.getByRole('dialog',{name:'Running work'});
await attention.waitFor();
assert(!await live.locator('dialog.app-detail').evaluate(el=>el.open),'only one shared drawer shows at a time');
await attention.getByText('Merge into main?').waitFor();
await attention.getByRole('radio',{name:/Yes/}).click();
await attention.getByRole('button',{name:/Send answers/}).click();
await live.waitForFunction(()=>true);
assert(sent.some(m=>m.kind==='input_response'&&m.runId==='run-live'&&m.answers?.q1==='yes'),'a decision answered in the drawer reaches the run');
await attention.getByRole('button',{name:'Stop',exact:true}).click();
assert(sent.some(m=>m.kind==='interrupt'&&m.runId==='run-live'),'Stop in the drawer interrupts that run');
assert(await attention.getByRole('link',{name:'Open',exact:true}).getAttribute('href')==='/activity?workspace=1&run=run-live','Open goes to the run\'s owning record');
await attention.getByRole('button',{name:'Close running work'}).click();
await live.locator('dialog.app-detail[open]').waitFor();
await live.setViewportSize({width:375,height:760});
assert(await live.getByRole('button',{name:'Open sidebar (1 agent working · 1 needs you)'}).isVisible(),'attention stays visible on the mobile trigger');
await live.screenshot({path:join(output,'attention-mobile.png')});

// Chat stays mounted across sections: its composer is the same element after a round trip.
await live.setViewportSize({width:1440,height:900});
await live.goto(`${base}/?workspace=1`);
const prompt=live.getByRole('textbox',{name:'Prompt',exact:true});
await prompt.waitFor();
await prompt.fill('Draft kept across sections');
await prompt.evaluate(el=>{window.__composer=el;});
await live.getByRole('button',{name:/^Section: /}).click();
await live.getByRole('navigation',{name:'Sections'}).getByRole('link',{name:'Report'}).click();
await live.waitForURL(/\/report/);
await live.getByRole('button',{name:/^Section: /}).click();
await live.getByRole('navigation',{name:'Sections'}).getByRole('link',{name:'Chat'}).click();
await prompt.waitFor();
assert(await prompt.evaluate(el=>el===window.__composer),'the conversation stays mounted (queued messages and launches survive navigation)');
assert(await prompt.inputValue()==='Draft kept across sections','the draft survives section navigation');

assert(errors.length===0,errors.join('\n'));
console.log('PASS shared shell: Activity, Workspaces, Changes, Pipeline, Pipeline editor, Report and Agents in the one sidebar, 16px type scale, docked/modal detail drawer, unsaved-changes guard and recovery, live attention drawer (answer, Stop, owner link, one drawer at a time), Chat kept mounted across sections, 320px reflow in three themes, URL-owned selection, filters, workspace agreement, back navigation and mobile drawer');
console.log('Browser artifacts:',output);
await browser.close();
