import type { Terminal } from '@xterm/xterm'

/** Conversations are readable transcripts even when the agent/tmux enables mouse reporting.
 * Route ordinary left drags through xterm's built-in Shift-selection behavior.
 * Wheel events, right clicks, Alt-clicks and ordinary shell/TUI terminals are unchanged.
 */
export function installConversationSelection(term: Terminal, isConversation: () => boolean): { dispose(): void } {
  const element = term.element
  if (!element) return { dispose() {} }
  const isMac = /mac/i.test(navigator.platform)
  const previousMacSelection = term.options.macOptionClickForcesSelection
  let dragging = false
  let forwarding = false
  const forward = (event: MouseEvent): void => {
    if (forwarding || !(event.target instanceof EventTarget)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    forwarding = true
    try {
      event.target.dispatchEvent(new MouseEvent(event.type, {
        bubbles: true, cancelable: true, view: window,
        clientX: event.clientX, clientY: event.clientY,
        screenX: event.screenX, screenY: event.screenY,
        button: event.button, buttons: event.buttons, detail: event.detail,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: isMac || event.altKey, shiftKey: !isMac || event.shiftKey,
      }))
    } finally { forwarding = false }
  }
  const down = (event: MouseEvent): void => {
    if (forwarding || event.button !== 0 || event.altKey || event.shiftKey || !isConversation()
      || term.modes.mouseTrackingMode === 'none') return
    // xterm uses Option, not Shift, on macOS. Change its option only for this
    // conversation drag; ordinary shell/TUI interactions keep their settings.
    if (isMac) term.options.macOptionClickForcesSelection = true
    dragging = true
    forward(event)
  }
  const move = (event: MouseEvent): void => { if (dragging) forward(event) }
  const up = (event: MouseEvent): void => {
    if (forwarding || !dragging) return
    forward(event)
    dragging = false
    if (isMac) term.options.macOptionClickForcesSelection = previousMacSelection
  }
  element.addEventListener('mousedown', down, true)
  document.addEventListener('mousemove', move, true)
  document.addEventListener('mouseup', up, true)
  return { dispose() {
    dragging = false
    if (isMac) term.options.macOptionClickForcesSelection = previousMacSelection
    element.removeEventListener('mousedown', down, true)
    document.removeEventListener('mousemove', move, true)
    document.removeEventListener('mouseup', up, true)
  } }
}
