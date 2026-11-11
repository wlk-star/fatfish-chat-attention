import {createRequire} from 'node:module'
import {dirname,join} from 'node:path'
import {existsSync} from 'node:fs'
import {pathToFileURL} from 'node:url'

/** Resolve DSH's own peer instance, including its packaged Electron runtime. */
export async function loadHostPeer(name){
  if(!name.startsWith('@deepseek-ai/'))throw Error('Only DSH peer packages are allowed')
  const packaged=join(dirname(process.execPath),'resources','app.asar','dsh','package.json')
  const require=process.versions.electron && existsSync(packaged)?createRequire(packaged):createRequire(import.meta.url)
  return import(pathToFileURL(require.resolve(name)).href)
}
