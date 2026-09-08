/** Heuristics for scanning logs, not an assertion about a process's health. */
export type LogLevel = 'error' | 'warning' | 'success' | 'section' | 'metric' | 'debug' | 'plain'

export function logLevel(text: string): LogLevel {
  if (/(?:^|[\s\[\]:])(?:ERROR|FATAL|CRITICAL)(?:$|[\s:\]])|Traceback \(most recent call last\)|\b[A-Za-z]*(?:Error|Exception):|CUDA out of memory|\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]\d*\b/i.test(text)) return 'error'
  if (/(?:^|[\s\[\]:])WARN(?:ING)?(?:$|[\s:\]])|\bdeprecated\b/i.test(text)) return 'warning'
  // Ray/GCS state dumps contain metrics, but are primarily diagnostic noise.
  if (/\[state-dump\]|(?:^|[\s\[\]:])(?:DEBUG|TRACE)(?:$|[\s:\]])/i.test(text)) return 'debug'
  if (/\b(?:loss|accuracy|reward|learning_rate|throughput|eval_loss|train_loss|grad_norm)\s*[:=]|\b(?:epoch|step|iteration)\s*[:=]?\s*\d/i.test(text)) return 'metric'
  if (/^\s*(?:={3,}|-{3,}|#{1,3}\s)\s*\S|^\s*\[[\w ./:-]+\]\s*$/.test(text)) return 'section'
  if (/(?:^|[\s\[\]:])(?:completed|finished|success(?:ful(?:ly)?)?|passed|saved checkpoint)(?:$|[\s:!])|\b\d+ passed\b/i.test(text) && !/\bnot\s+success|\b(?:un|in)successful|\bfailed\b/i.test(text)) return 'success'
  return 'plain'
}

export function isLogHighlight(level: LogLevel): boolean {
  return level !== 'plain' && level !== 'debug'
}

interface BufferLine {
  isWrapped: boolean
  translateToString(trimRight?: boolean): string
}

interface LogBuffer {
  length: number
  getLine(index: number): BufferLine | undefined
}

// Read xterm's interpreted buffer: ANSI escapes and carriage-return progress
// updates are already handled correctly. Join soft wraps into logical lines.
export function logBufferLines(buffer: LogBuffer, limit = 5000): string[] {
  const lines: string[] = []
  for (let i = Math.max(0, buffer.length - limit); i < buffer.length; i++) {
    const line = buffer.getLine(i)
    if (!line) continue
    const text = line.translateToString(!buffer.getLine(i + 1)?.isWrapped)
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text
    else lines.push(text)
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}
