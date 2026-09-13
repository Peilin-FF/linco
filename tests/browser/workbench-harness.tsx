// The desktop app never imports this synthetic workspace.
await import('./workboard-sessions-mock')
// Inspect the real xterm buffer in lifecycle regressions, never production code.
const { Terminal } = await import('@xterm/xterm')
const terminals = new Map<string, InstanceType<typeof Terminal>>()
const open = Terminal.prototype.open
Terminal.prototype.open = function (parent) {
  open.call(this, parent)
  terminals.set(parent.dataset.terminalId!, this)
}
Object.assign(window, { __conversationTerminals: terminals })
await import('../../src/main')
