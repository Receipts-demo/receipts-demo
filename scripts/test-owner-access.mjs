import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const ts=require(process.env.RECEIPTS_TYPESCRIPT_PATH || 'typescript');
const owner='11111111-1111-4111-8111-111111111111', project='22222222-2222-4222-8222-222222222222';
const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture',ANTHROPIC_API_KEY:'fixture'};
function load(name,{fetch,client}){
 let handler;
 const source=readFileSync(new URL('../supabase/functions/'+name.replace('-canonical.ts','/index.ts'),import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
 assert.equal(js.diagnostics.length,0);
 const context={Request,Response,Headers,URL,console:{log(){},error(){}},fetch,Deno:{env:{get:k=>env[k]},serve:h=>handler=h},require:id=>id.includes('supabase')?{createClient:()=>client}:{serve:h=>handler=h},exports:{}};
 vm.runInNewContext(js.outputText,context);
 return handler;
}
let count=0;
for(const variant of ['canonical']){
 for(const scenario of ['missing','invalid','foreign','absent','owner','malformed','options']){
  const calls=[];let provider=0;
  const client={auth:{getUser:async token=>{calls.push(['auth',token]);return {data:{user:scenario==='invalid'?null:{id:owner}},error:scenario==='invalid'?{}:null};}},from:table=>{
   const q={filters:[],updateValue:null,select(){return q;},eq(k,v){q.filters.push([k,v]);return q;},order(){return q;},update(v){q.updateValue=v;return q;},insert(){throw Error('unexpected feed write');},single:async()=>{
    calls.push([table,q.filters,q.updateValue]);
    if(table==='profiles')return {data:{display_name:'Owner',workspace_id:null},error:null};
    assert(q.filters.some(([k,v])=>k==='owner_id'&&v===owner),'owner filter missing');
    return scenario==='foreign'||scenario==='absent'?{data:null,error:{code:'PGRST116'}}:{data:{id:project,name:'Build',owner_id:owner,status:'In Progress',...q.updateValue},error:null};
   },then(resolve){calls.push([table,q.filters]);assert(q.filters.some(([k,v])=>k==='owner_id'&&v===owner));return Promise.resolve({data:[],error:null}).then(resolve);}};return q;
  }};
  const handler=load(`generate-shipped-card-${variant}.ts`,{client,fetch:async()=>{provider++;return Response.json({stop_reason:'end_turn',content:[{text:'{}'}]});}});
  const headers=scenario==='missing'?{}:{Authorization:'Bearer fixture-token'};
  const req=new Request('https://example.test',{method:scenario==='options'?'OPTIONS':'POST',headers,body:scenario==='options'?undefined:JSON.stringify({project_id:scenario==='malformed'?'bad':project})});
  const res=await handler(req);
  assert.equal(res.status,scenario==='owner'?200:scenario==='options'?200:scenario==='missing'||scenario==='invalid'?401:scenario==='malformed'?400:404);
  assert.equal(provider,scenario==='owner'?1:0);
  if(scenario!=='owner')assert(!calls.some(c=>c[0]==='entries'||c[2]));
  count++;
 }
 for(const scenario of ['foreign','owner','injection','missing','invalid']){
  const requests=[];
  const handler=load(`receipts-mcp-${variant}.ts`,{fetch:async(url,opts={})=>{
   requests.push([url,opts.method||'GET']);
   if(url.includes('/auth/v1/user'))return scenario==='invalid'?new Response('',{status:401}):Response.json({id:owner});
   if(url.includes('entries?')){assert(url.includes(`owner_id=eq.${owner}`));return Response.json([{claim:'Private entry',entry_type:'decision'}]);}
   if(url.includes('projects?')){
    assert(url.includes(`owner_id=eq.${owner}`));
    if(scenario==='foreign')return Response.json([]);
    return Response.json([{id:project,name:'Build',goal:'Goal',key_wins:[]}]);
   }
   throw Error('unexpected request '+url);
  }});
  const res=await handler(new Request('https://example.test',{method:'POST',headers:scenario==='missing'?{}:{Authorization:'Bearer fixture-token'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'copy_build',arguments:{project_id:scenario==='injection'?project+'&owner_id=neq.'+owner:project}}})}));
  assert.equal(res.status,scenario==='missing'||scenario==='invalid'?401:200);
  if(scenario==='owner'){const body=await res.json();assert(body.result.content[0].text.includes('Private entry'));assert(requests.some(r=>r[1]==='PATCH'));}
  else {assert(!requests.some(r=>r[0].includes('entries?')||r[1]==='PATCH'));if(scenario==='foreign'||scenario==='injection')assert((await res.text()).includes('Build not found'));}
  count++;
 }
}
console.log(`${count} owner-access scenarios passed for canonical handlers; provider/database mocked.`);
