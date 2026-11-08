#!/usr/bin/env node
// ZCode to Figma — MCP stdio server for ZCode.
// Ported from Duoasa/DSH-to-Figma 0.3.5 (MIT): local bridge + paired Figma
// companion plugin, with optional official Figma desktop/remote MCP backends.
// DSH-specific session plumbing is replaced by a single process-wide binding.
import { readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { LocalBridge } from './lib/bridge.mjs'
import { bridgeToken, privateDirectory, privateJson } from './lib/storage.mjs'
import { LOCAL_TOOLS, SUPPORTED_BACKENDS, requiresQueryFeatures, requiredQueryFeatureVersion } from './lib/catalog.mjs'
import { PerformanceLog } from './lib/performance.mjs'
import { readAssets, saveAssets, localResult } from './lib/assets.mjs'
import { connectOfficial, desktopUrl } from './lib/official.mjs'
import { prepareCompanion } from './lib/companion.mjs'
import { figmaDiagnostic } from './lib/diagnostics.mjs'
import { FIGMA_USE_CONTRACT, LocalFigmaTasks } from './lib/figma-use-contract.mjs'
import { preflightScript, ScriptPreflightError } from './lib/script-preflight.mjs'
import packageJson from './package.json' with { type: 'json' }

const integer=(value,min,max,fallback)=>{const n=Number(value);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback}
const config={
  backend:process.env.ZCODE_FIGMA_BACKEND||'local',
  bridgePort:integer(process.env.ZCODE_FIGMA_BRIDGE_PORT,1024,65535,3055),
  desktopServerUrl:process.env.ZCODE_FIGMA_DESKTOP_SERVER_URL||'http://127.0.0.1:3845/mcp',
  toolCallTimeoutMs:integer(process.env.ZCODE_FIGMA_TOOL_CALL_TIMEOUT_MS,1000,300000,120000),
  oauthClientId:process.env.ZCODE_FIGMA_OAUTH_CLIENT_ID||'',
}
const home=process.env.ZCODE_FIGMA_HOME||join(homedir(),'.zcode')
if(process.env.ZCODE_FIGMA_DISABLED==='1')process.exit(0)
if(!SUPPORTED_BACKENDS.includes(config.backend)){console.error(`Figma backend must be local, desktop, or remote; got ${config.backend}`);process.exit(1)}

const skillDir=fileURLToPath(new URL('./skills/figma-workbench/',import.meta.url))
const result=value=>({content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value})
const guides=['user-guide','help-connection','help-design','help-motion','help-troubleshooting','workflow','plugin-api','design-to-code','figjam-slides','components-variables','assets-scenes','official-services','motion','text-motion','custom-animation-styles','specs']
const OWNER='zcode'

const mcp=new McpServer({name:'zcode-to-figma',version:packageJson.version})
const registeredTools=new Map(),dynamic=[]
// One document binding per MCP server process; ZCode sessions share it and
// canvas calls are serialized by the bridge, exactly like a single DSH Work.
let binding=null
const sessions=new Map(),performanceLogs=new Map(),figmaTasks=new LocalFigmaTasks()
const shutdown=new AbortController()
let stopped=false,bridge,companion,available=false,toolNames=[],remoteInstructions='',refreshing,errorCode=null,diagnostic=null
let gate=Promise.resolve()
const exclusive=run=>{const next=gate.then(run);gate=next.catch(()=>{});return next}
const assertOpen=()=>{if(stopped)throw new Error('Figma plugin has stopped')}
const warn=message=>console.error(`[zcode-to-figma] ${message}`)
const metricsFor=id=>{let log=performanceLogs.get(id);if(!log){log=new PerformanceLog();performanceLogs.set(id,log)}return log}
const connect=(context)=>connectOfficial({backend:config.backend,home,desktopServerUrl:config.desktopServerUrl,clientId:config.oauthClientId,signal:context.signal})

async function workspacePath(){
  const env=process.env.ZCODE_FIGMA_WORKSPACE
  if(env)return await realpath(env)
  const cwd=process.cwd()
  if(cwd&&isAbsolute(cwd)&&cwd!=='/'){try{return await realpath(cwd)}catch{}}
  try{
    const {roots}=await mcp.server.listRoots(undefined,{timeout:3000})
    const uri=roots?.find(root=>typeof root?.uri==='string'&&root.uri.startsWith('file:'))?.uri
    if(uri)return await realpath(fileURLToPath(new URL(uri)))
  }catch{}
  throw new Error('Figma tools require a workspace directory; set ZCODE_FIGMA_WORKSPACE or start ZCode inside your project')
}

const callContext=async extra=>{
  assertOpen()
  const signal=AbortSignal.any([extra?.signal,shutdown.signal].filter(Boolean))
  signal.throwIfAborted()
  return {workspace:await workspacePath(),signal}
}

function register(rawName,description,inputSchema,call,{outputSchema}={}){
  const convert=schema=>{try{return fromJsonSchema(schema)}catch(error){warn(`Schema for ${rawName} fell back to a plain object: ${error?.message}`);return fromJsonSchema({type:'object',properties:{},additionalProperties:true})}}
  const registered=mcp.registerTool(rawName,{
    description,
    inputSchema:inputSchema?convert(inputSchema):undefined,
    ...(outputSchema?{outputSchema:convert(outputSchema)}:{}),
    annotations:{readOnlyHint:['figma_status','figma_read_guide'].includes(rawName)},
  },(args,extra)=>call(args??{},extra))
  registeredTools.set(rawName,registered);return registered
}

function removeTools(list){for(const registered of list.splice(0))try{registered.remove()}catch{}}

const closeSession=async id=>{performanceLogs.delete(id);figmaTasks.close(id);const connection=sessions.get(id);sessions.delete(id);if(connection)await connection.then(c=>c.close()).catch(()=>{})}
async function close(){
  if(stopped)return;stopped=true;shutdown.abort()
  removeTools([...registeredTools.values()].splice(0));removeTools(dynamic)
  registeredTools.clear()
  await bridge?.close();await Promise.all([...sessions.keys()].map(closeSession));performanceLogs.clear();figmaTasks.clear();available=false
}
for(const signal of ['SIGINT','SIGTERM','SIGHUP'])process.on(signal,()=>{void close().finally(()=>process.exit(0))})
process.stdin.on('close',()=>{void close().finally(()=>process.exit(0))})

register('figma_status','Show connected documents and actual plugin/companion versions and cached read-only feature probes. documentBinding state is unbound, connected, or disconnected; documents.bindingMatch is selected, same-file-key, same-name-unverified, or none. Reconnect hints never rebind; use figma_select_document after confirming the target. Use get_capabilities to refresh the selected document. Prefer compact:true. includeMetrics:true adds a bounded canvas-call summary. Save performance.cursor before a task and pass it as metricsSince afterward; metricsDetails:true adds per-call records. Not model token usage.',{type:'object',properties:{compact:{type:'boolean'},includeMetrics:{type:'boolean'},metricsSince:{type:'object',properties:{epoch:{type:'string'},sequence:{type:'integer',minimum:0}},required:['epoch','sequence'],additionalProperties:false},metricsDetails:{type:'boolean'}},required:[],additionalProperties:false},async(args={})=>{
  if((args.metricsSince!==undefined||args.metricsDetails!==undefined)&&!args.includeMetrics)throw new Error('metricsSince and metricsDetails require includeMetrics:true')
  const documents=bridge?.list()??[]
  const health={backend:config.backend,pluginVersion:packageJson.version,available,errorCode,diagnostic,documents:documents.map(doc=>({...doc,fileKey:doc.fileKey??`local:${doc.connectionId}`})),...(config.backend==='local'?{figmaUseContract:FIGMA_USE_CONTRACT}:{})}
  if(config.backend==='local'){
    const state=!binding?'unbound':documents.some(doc=>doc.connectionId===binding.id)?'connected':'disconnected'
    health.documentBinding={state,requiresSelection:binding?state!=='connected':documents.length>1,lastSelected:binding?{connectionId:binding.id,name:binding.name,editorType:binding.editorType,fileKey:binding.fileKey}:null}
    for(let i=0;i<documents.length;i++){
      const doc=documents[i];let match='none'
      if(binding){
        if(doc.connectionId===binding.id)match='selected'
        else if(state==='disconnected'&&doc.editorType===binding.editorType){
          if(binding.fileKey&&doc.fileKey){if(binding.fileKey===doc.fileKey)match='same-file-key'}
          else if(binding.name===doc.name)match='same-name-unverified'
        }
      }
      health.documents[i].bindingMatch=match
    }
  }
  if(!args.compact)Object.assign(health,{tools:toolNames,companion:companion??null,documentSelection:config.backend==='local'?'A single connected document is selected on first use. Multiple documents and disconnected bindings require explicit selection.':'Use the actual official tool schema and intended file or selection.',bridgePort:bridge?.port??null,skill:'figma-workbench',cloudAccess:config.backend==='remote'?'Depends on official client approval, account and seat.':config.backend==='desktop'?'Official desktop MCP provides design reading and screenshots, not canvas writing or cloud generation.':'Cloud-only generation is not provided by the local bridge.',setup:config.backend==='local'?'Import the paired companion.manifest once in Figma, then run ZCode to Figma · Local. It connects automatically; keep it open. Call figma_setup for installation paths.':config.backend==='desktop'?'Keep Figma desktop open with its built-in MCP enabled, then run figma_reconnect. No companion plugin or remote OAuth login is required.':'Run the bundled CLI login command with the same home, then figma_reconnect.'})
  if(args.includeMetrics)health.performance=metricsFor(OWNER).snapshot({since:args.metricsSince,details:args.metricsDetails===true})
  return result(health)
})
register('figma_setup','Prepare the private, pre-paired Figma companion. Return installation paths only; never read or share its credential-bearing code or archive.',{type:'object',properties:{},required:[],additionalProperties:false},async()=>{
  companion=await prepareCompanion(home,{port:bridge?.port??config.bridgePort,token:bridge?.token})
  return result({backend:config.backend,bridgeRunning:!!bridge&&available,...companion,instructions:'Import this manifest once through Figma Plugins > Development > Import plugin from manifest. Run ZCode to Figma · Local in your target file. Keep the window open. Requires backend: local; restart ZCode after changing backend. Do not upload or share this private package.'})
})
register('figma_read_guide','Read bundled offline user help or a technical Figma guide. For usage questions start with user-guide, then help-connection (setup/update/modes), help-design (editing/assets/export/code), help-motion (animation/FigJam/Slides), or help-troubleshooting (errors/recovery). No active canvas is needed to read help.',{type:'object',properties:{topic:{type:'string',enum:guides}},required:['topic'],additionalProperties:false},async args=>{
  if(!guides.includes(args.topic))throw new Error('Unknown Figma guide')
  return {content:[{type:'text',text:await readFile(join(skillDir,'references',args.topic+'.md'),'utf8')}]}
})
register('figma_select_document','Bind this ZCode workspace to one explicitly chosen local Figma document. IDs come from figma_status. Never silently switches targets.',{type:'object',properties:{connectionId:{type:'string'}},required:['connectionId'],additionalProperties:false},async args=>{
  if(!bridge)throw new Error('Document binding is only used with the local backend')
  const workspace=await workspacePath()
  const doc=bridge.list().find(d=>d.connectionId===args.connectionId)
  if(!doc)throw new Error('Document is not connected')
  binding={id:doc.connectionId,workspace,name:doc.name,editorType:doc.editorType,fileKey:doc.fileKey??null}
  return result({selected:doc})
})
register('figma_reconnect','Refresh the official MCP tool catalog after login or enabling Figma desktop MCP. No canvas tools are called.',{type:'object',properties:{},required:[],additionalProperties:false},async()=>result(await refresh()))

if(config.backend==='local'){
  try{
    if(config.backend==='desktop')desktopUrl(config.desktopServerUrl)
    bridge=new LocalBridge({token:await bridgeToken(home),port:config.bridgePort,timeoutMs:config.toolCallTimeoutMs})
    await bridge.start()
    companion=await prepareCompanion(home,{port:bridge.port,token:bridge.token})
    await privateJson(join(await privateDirectory(home),'bridge.json'),{port:bridge.port,pid:process.pid,companion:companion.manifest,startedAt:new Date().toISOString()})
    for(const tool of LOCAL_TOOLS)register(tool.name,tool.description,tool.inputSchema,async(args={},extra)=>{
      let dispatched=false
      try{
        const {workspace,signal}=await callContext(extra)
        if(!binding){
          const documents=bridge.list()
          if(documents.length!==1)throw new Error(documents.length?'Multiple Figma documents are connected. Choose the target with figma_select_document using figma_status.':'No Figma document is connected. Run the paired Figma companion; use figma_setup for its manifest path.')
          binding={id:documents[0].connectionId,workspace,name:documents[0].name,editorType:documents[0].editorType,fileKey:documents[0].fileKey??null}
        }
        const document=bridge.list().find(doc=>doc.connectionId===binding.id)
        if(!document)throw new Error('The previously selected Figma document disconnected. Read figma_status for documentBinding and bindingMatch hints. Explicitly choose the intended document with figma_select_document; it will not switch automatically.')
        if(binding.workspace!==workspace){binding=null;throw new Error('Workspace changed; explicitly select the document again with figma_select_document')}
        if((document.featureVersion??0)<requiredQueryFeatureVersion(tool.name,args))throw new Error('The connected Figma companion does not support these query features yet. Run figma_setup, then close and rerun ZCode to Figma · Local from its paired manifest; inspect figma_status and reselect the document. Legacy queries remain available.')
        const context=figmaTasks.context(OWNER,workspace,document,args)
        if(tool.name==='create_session')return result(figmaTasks.create(OWNER,workspace,document,args))
        if(tool.name==='use_figma')preflightScript(args.code)
        const id=binding.id
        const performanceLog=metricsFor(OWNER)
        const started=performance.now()
        let payload=args,response,output,bridgeMetric,status='failed'
        try{
          if(tool.name==='upload_assets')payload={parentId:args.parentId,assets:await readAssets(workspace,args.files)}
          dispatched=true
          if(context.task){context.task.calls++;context.task.files.add(context.fileKey)}
          response=await bridge.call(id,tool.name,payload,{signal,mutation:tool.mutation,inspect:tool.inspect&&!requiresQueryFeatures(tool.name,args),onMetric:metric=>{bridgeMetric=metric}})
          signal.throwIfAborted()
          if(tool.name==='download_assets')response.value={...response.value,files:await saveAssets(workspace,response.assets)}
          const files=tool.name==='use_figma'&&response.assets?.length?await saveAssets(workspace,response.assets):[]
          output=localResult(response)
          if(files.length){output.structuredContent.files=files;output.content.push({type:'text',text:JSON.stringify({files})})}
          if(tool.name==='use_figma')output.structuredContent.execution={fileKey:context.fileKey,sessionId:args.sessionId??null,description:args.description??null,skillNames:args.skillNames??null}
          status='ok';return output
        }finally{
          if(signal.aborted)status='canceled'
          performanceLog.record({tool:tool.name,status,hostMs:performance.now()-started,bridge:bridgeMetric,runtime:response?.metrics,
            textBytes:output?Buffer.byteLength(output.content[0].text):null,
            imageCount:output?output.content.filter(block=>block.type==='image').length:null,
            imageBytes:output?output.content.filter(block=>block.type==='image').reduce((total,block)=>total+Buffer.byteLength(block.data,'base64'),0):null})
        }
      }catch(error){
        if(tool.name!=='use_figma')throw error
        const value={error:String(error?.message||error),safeToRetryWithoutCanvasRead:!dispatched||error?.safeToRetryWithoutCanvasRead===true}
        if(!dispatched&&error instanceof ScriptPreflightError)value.diagnostic={stage:'preflight',...error.diagnostic}
        return {...result(value),isError:true}
      }
    })
    toolNames=LOCAL_TOOLS.map(tool=>tool.name);available=true
  }catch(error){
    await bridge?.close()
    for(const [name,registered] of [...registeredTools])if(!name.startsWith('figma_')){try{registered.remove()}catch{}registeredTools.delete(name)}
    errorCode=error?.code==='EADDRINUSE'?'bridge_port_in_use':'local_start_failed'
    warn('Figma local bridge unavailable; check figma_status and port configuration.')
  }
}

const connectionFor=async context=>{
  let pending=sessions.get(OWNER)
  if(!pending){pending=connect(context).then(async connection=>{
    if(stopped||context.signal.aborted){await connection.close();throw new Error('Figma connection canceled')}
    connection.workspace=context.workspace;return connection
  });sessions.set(OWNER,pending);pending.catch(()=>{if(sessions.get(OWNER)===pending)sessions.delete(OWNER)})}
  const connection=await pending
  if(connection.workspace!==context.workspace)throw new Error('Workspace changed; start a new session')
  return connection
}
const refresh=()=>{
  if(refreshing)return refreshing
  refreshing=exclusive(async()=>{
    assertOpen();if(config.backend==='local')return {available,tools:toolNames,errorCode}
    let discovery
    try{
      discovery=await connect({backend:config.backend,home,desktopServerUrl:config.desktopServerUrl,clientId:config.oauthClientId,signal:shutdown.signal})
      const listed=await discovery.client.listTools(undefined,{timeout:15000,cacheMode:'refresh'})
      if(!Array.isArray(listed.tools)||listed.tools.length>300||new Set(listed.tools.map(t=>t.name)).size!==listed.tools.length)throw new Error('Invalid tool catalog')
      const instructions=discovery.client.getInstructions?.()??''
      if(Buffer.byteLength(instructions)>65536)throw new Error('Instructions too large')
      assertOpen();await Promise.all([...sessions.keys()].map(closeSession));assertOpen()
      removeTools(dynamic);available=false;toolNames=[];remoteInstructions=''
      for(const tool of listed.tools){
        if(typeof tool.name!=='string'||!tool.name||tool.name.length>200)throw new Error('Invalid tool name')
        const registered=register(tool.name,tool.description??'',tool.inputSchema,async(args,extra)=>exclusive(async()=>{
          const context=await callContext(extra),connection=await connectionFor(context)
          const secured={...args}
          if(tool.name==='get_screenshot'&&tool.inputSchema?.properties?.enableBase64Response)secured.enableBase64Response=true
          try{return await connection.client.callTool({name:tool.name,arguments:secured},{signal:context.signal,timeout:config.toolCallTimeoutMs,toolDefinition:tool})}
          catch(error){await closeSession(OWNER);throw new Error('Official Figma call failed or was interrupted. The operation was not replayed. Inspect the canvas before retrying; check login, access and service status.')}
        }),{outputSchema:tool.outputSchema})
        dynamic.push(registered)
      }
      toolNames=listed.tools.map(t=>t.name);remoteInstructions=instructions;available=true;errorCode=null;diagnostic=null
    }catch(error){
      diagnostic=figmaDiagnostic(error);errorCode=diagnostic.code
      if(!available){removeTools(dynamic);toolNames=[]}
      warn(diagnostic.message)
    }
    finally{await discovery?.close()}
    return {available,tools:toolNames,errorCode,diagnostic}
  }).finally(()=>{refreshing=null});return refreshing
}

if(config.backend!=='local'){
  register('figma_resources','List or read official MCP resources and resource templates, preserving original content.',{type:'object',properties:{operation:{type:'string',enum:['list','templates','read']},uri:{type:'string'},cursor:{type:'string'}},required:['operation'],additionalProperties:false},async(args,extra)=>exclusive(async()=>{
    const context=await callContext(extra),{client}=await connectionFor(context),options={signal:context.signal,timeout:config.toolCallTimeoutMs}
    if(args.operation==='read'&&!args.uri)throw new Error('Resource URI required')
    const value=args.operation==='read'?await client.readResource({uri:args.uri},options):args.operation==='templates'?await client.listResourceTemplates({cursor:args.cursor},options):await client.listResources({cursor:args.cursor},options)
    return result(value)
  }))
  register('figma_prompts','List or retrieve an official MCP prompt.',{type:'object',properties:{operation:{type:'string',enum:['list','get']},name:{type:'string'},arguments:{type:'object',additionalProperties:{type:'string'}}},required:['operation'],additionalProperties:false},async(args,extra)=>exclusive(async()=>{
    const context=await callContext(extra),{client}=await connectionFor(context),options={signal:context.signal,timeout:config.toolCallTimeoutMs}
    if(args.operation==='get'&&!args.name)throw new Error('Prompt name required')
    return result(args.operation==='get'?await client.getPrompt({name:args.name,arguments:args.arguments},options):await client.listPrompts(undefined,options))
  }))
  await refresh()
}

// serverName('figma')-style qualification is applied by the ZCode host; raw
// names keep the skill guidance and tool descriptions aligned with upstream.
await mcp.connect(new StdioServerTransport())
warn(`ready: backend=${config.backend} tools=${toolNames.length||registeredTools.size} home=${home}`)
