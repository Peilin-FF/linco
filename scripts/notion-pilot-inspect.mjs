// Inspect existing development webviews without starting or closing windows.
// Direct page CDP avoids attaching to Notion's unrelated shared workers.
import { writeFileSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
const { values } = parseArgs({ options: { 'page-url': { type: 'string' }, 'binding-file': { type: 'string' } } })
const targets = [
  ['app', 'http://127.0.0.1:9225'],
  ['notion', 'http://127.0.0.1:9226'],
]
for (const [name, endpoint] of targets) {
  let socket
  try {
    const pages = await (await fetch(`${endpoint}/json/list`)).json()
    const page = pages.find((item) => item.type === 'page')
    if (!page) throw new Error('Development page unavailable')
    socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let nextId = 0
    const pending = new Map()
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const item = pending.get(message.id)
      if (!item) return
      pending.delete(message.id); clearTimeout(item.timer)
      if (message.error) item.reject(new Error(message.error.message))
      else item.resolve(message.result)
    }
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 15_000)
      pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result.value
    }
    const details = await evaluate('({title:document.title,url:location.href,editing:!!document.activeElement?.isContentEditable})')
    console.log(JSON.stringify({ target: name, ...details }))
    if (name === 'app' && values['binding-file']) {
      const binding = JSON.parse(readFileSync(values['binding-file'], 'utf8'))
      if (!binding.key.startsWith('linco:notion:page:v1:') || !binding.key.endsWith(':workbench:v1')) throw new Error('Expected a project-scoped notebook binding')
      const result = await evaluate(`(() => { const key=${JSON.stringify(binding.key)}; if(localStorage.getItem(key)) return 'Existing project binding preserved'; localStorage.setItem(key,${JSON.stringify(JSON.stringify(binding.value))}); localStorage.setItem(key.slice(0,-':workbench:v1'.length),${JSON.stringify(binding.value.home)}); return 'Project notebook linked'; })()`)
      console.log(result)
    }
    if (name === 'notion' && values['page-url']) {
      const url = new URL(values['page-url'])
      if (url.origin !== 'https://app.notion.com' || !/^\/p\/[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) throw new Error('Use an explicit canonical Notion page URL')
      if (details.editing) throw new Error('An editable Notion field is focused; leave navigation to the user.')
      await rpc('Page.navigate', { url: url.href })
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        if (await evaluate('document.body?.innerText.includes("On the workbench")')) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      const screenshot = await rpc('Page.captureScreenshot', { format: 'png' })
      writeFileSync('artifacts/notion-pilot-home.png', Buffer.from(screenshot.data, 'base64'))
      console.log(JSON.stringify({ target: name, pilotVisible: await evaluate('document.body?.innerText.includes("On the workbench")'), title: await evaluate('document.title') }))
    }
  } catch (error) { console.error(`${name}: ${error.message}`); process.exitCode = 1 }
  finally { socket?.close() }
}
