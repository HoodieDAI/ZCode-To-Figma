#!/usr/bin/env node
// ZCode to Figma CLI — ported from Duoasa/DSH-to-Figma cli.mjs (MIT).
// Setup/pair/status work for the local backend without a running MCP server.
import packageInfo from './package.json' with { type: 'json' }
import { readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client, StreamableHTTPClientTransport, UnauthorizedError } from '@modelcontextprotocol/client'
import { bridgeToken, privateDirectory, readJson } from './lib/storage.mjs'
import { oauthProvider, callbackServer, oauthFetch, REMOTE_URL } from './lib/oauth.mjs'
import { prepareCompanion } from './lib/companion.mjs'
import { figmaDiagnostic } from './lib/diagnostics.mjs'
const root=dirname(fileURLToPath(import.meta.url))
function options(args){const values={command:args.shift()??'help'};while(args.length){const key=args.shift();if(!['--home','--port','--client-id'].includes(key)||!args.length)throw new Error('Unknown or incomplete option');values[key.slice(2)]=args.shift()}return values}
async function main(){
  const opts=options(process.argv.slice(2)),home=resolve(opts.home??process.env.ZCODE_FIGMA_HOME??join(homedir(),'.zcode'))
  if(opts.command==='help'){console.log('zcode-to-figma setup|pair|status|login|logout [--home PATH] [--port 3056] [--client-id ID]\nSetup creates a private pre-paired Figma companion and prints paths only. Pair is a manual fallback and prints a local secret for the Figma companion only. Status prints the recorded bridge state. Login uses the official Figma OAuth service for backend: remote; client approval may be required.');return}
  if(opts.command==='setup'){const state=await readJson(join(await privateDirectory(home),'bridge.json'));const prepared=await prepareCompanion(home,{port:Number(opts.port??state.port??3055)});console.log(JSON.stringify({...prepared,instructions:'Import manifest once in Figma, then run ZCode to Figma · Local. Requires ZCODE_FIGMA_BACKEND: local. Private package: do not share.'},null,2));return}
  if(opts.command==='pair'){const token=await bridgeToken(home),state=await readJson(join(await privateDirectory(home),'bridge.json'));console.log(`Figma companion: ${join(root,'companion/manifest.json')}\nBridge port: ${state.port??3055}\nPairing token (paste into the Figma plugin; do not share):\n${token}`);return}
  if(opts.command==='status'){const directory=await privateDirectory(home),state=await readJson(join(directory,'bridge.json')),oauth=await readJson(join(directory,'oauth.json'));console.log(JSON.stringify({home,recordedBridge:state,bridgeLive:'Check figma_status inside ZCode; the saved record alone does not prove liveness.',oauthSaved:!!oauth.tokens,companion:join(root,'companion/manifest.json')},null,2));return}
  if(opts.command==='logout'){await rm(join(await privateDirectory(home),'oauth.json'),{force:true});console.log('Local Figma OAuth credentials removed. Reconnect/restart the MCP server to close existing sessions. Revoke app access in Figma to revoke the server grant.');return}
  if(opts.command==='login'){
    const port=Number(opts.port??3056);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid OAuth callback port')
    const provider=await oauthProvider(home,{redirectUrl:`http://127.0.0.1:${port}/callback`,clientId:opts['client-id'],onRedirect:url=>console.log(`Open this Figma authorization URL in your browser:\n${url.href}`)})
    const callback=await callbackServer({port,state:provider.state}),client=new Client({name:'zcode-to-figma',version:packageInfo.version}),transport=new StreamableHTTPClientTransport(new URL(REMOTE_URL),{authProvider:provider,fetch:oauthFetch,reconnectionOptions:{maxRetries:0}})
    try{
      try{await client.connect(transport,{timeout:15000})}catch(error){if(!(error instanceof UnauthorizedError))throw error;const params=await callback.result;await transport.finishAuth(params)}
      if(!await provider.tokens())throw new Error('Login did not return credentials')
      console.log('Figma credentials saved privately. Set ZCODE_FIGMA_BACKEND=remote, then use figma_reconnect in ZCode. Availability still depends on Figma client/account access.')
    }finally{await callback.close();await client.close().catch(()=>{});await transport.close().catch(()=>{})}
    return
  }
  throw new Error('Unknown command; run node cli.mjs help')
}
main().catch(error=>{const diagnostic=process.argv[2]==='login'?figmaDiagnostic(error):{code:'command_failed',message:'Command failed. Check the command arguments, home permissions, configured port. Run node cli.mjs help for usage. Sensitive values are not logged.'};console.error(JSON.stringify({ok:false,...diagnostic},null,2));process.exitCode=1})
