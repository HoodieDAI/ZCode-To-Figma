#!/usr/bin/env node
// Smoke test: launch server.mjs over stdio exactly like the ZCode host does,
// then verify handshake, tool catalog and key tool calls without Figma.
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const home=await mkdtemp(join(tmpdir(),'zcode-figma-smoke-'))
const transport=new StdioClientTransport({command:'node',args:[new URL('../server.mjs',import.meta.url).pathname],env:{...process.env,ZCODE_FIGMA_HOME:home,ZCODE_FIGMA_BRIDGE_PORT:'3066'}})
const client=new Client({name:'smoke',version:'0.0.0'})
await client.connect(transport)

const {tools}=await client.listTools()
const names=tools.map(tool=>tool.name).sort()
const expected=['create_session','download_assets','figma_read_guide','figma_select_document','figma_setup','figma_status','figma_reconnect','get_capabilities','get_component_context','get_design_context','get_figjam','get_libraries','get_local_component_links','get_metadata','get_motion_context','get_screenshot','get_selection','get_variable_defs','import_scene','list_fonts','search_design_system','set_local_component_links','upload_assets','use_figma']
const missing=expected.filter(name=>!names.includes(name)),extra=names.filter(name=>!expected.includes(name))
console.log(`tools/list: ${names.length} tools; missing=[${missing}] extra=[${extra}]`)
if(missing.length||extra.length)process.exit(1)

const status=await client.callTool({name:'figma_status',arguments:{compact:true}})
const health=JSON.parse(status.content[0].text)
console.log(`figma_status: backend=${health.backend} available=${health.available} binding=${health.documentBinding?.state} docs=${health.documents.length}`)
if(health.backend!=='local'||health.documentBinding?.state!=='unbound')process.exit(1)

const setup=await client.callTool({name:'figma_setup',arguments:{}})
const prepared=JSON.parse(setup.content[0].text)
const manifest=JSON.parse(await readFile(prepared.manifest,'utf8'))
console.log(`figma_setup: paired=${prepared.paired} name=${manifest.name} id=${manifest.id} port=${prepared.port}`)
if(!prepared.paired||manifest.name!=='ZCode to Figma · Local'||!/^zcode-to-figma-local-[0-9a-f]{12}$/.test(manifest.id))process.exit(1)

const guide=await client.callTool({name:'figma_read_guide',arguments:{topic:'user-guide'}})
console.log(`figma_read_guide: ${guide.content[0].text.length} chars`)

const noDoc=await client.callTool({name:'get_metadata',arguments:{}})
console.log(`get_metadata (no canvas): isError=${noDoc.isError} text=${String(noDoc.content[0].text).slice(0,60)}`)
if(noDoc.isError!==true||!/No Figma document is connected/.test(noDoc.content[0].text))process.exit(1)

const badScript=await client.callTool({name:'use_figma',arguments:{code:'const x ='}})
const badValue=JSON.parse(badScript.content[0].text)
console.log(`use_figma preflight guard: error=${JSON.stringify(badValue.error).slice(0,60)} safeToRetry=${badValue.safeToRetryWithoutCanvasRead}`)
if(badScript.isError!==true||badValue.safeToRetryWithoutCanvasRead!==true)process.exit(1)

await client.close()
console.log('SMOKE PASS')
