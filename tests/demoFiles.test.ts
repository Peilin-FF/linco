import { describe, expect, it } from 'vitest'
import { demoFiles, listDemoFiles, readDemoFile } from '../demo/files'

describe('public demo files', () => {
  it('lists only files with distinct, non-placeholder content', () => {
    const visit = (dir: string): string[] => listDemoFiles(dir).flatMap(entry => {
      const path = dir ? `${dir}/${entry}` : entry
      return entry.endsWith('/') ? visit(path.slice(0, -1)) : [path]
    })
    const paths = visit('')
    expect(paths.sort()).toEqual(Object.keys(demoFiles).sort())
    const contents = paths.map(readDemoFile)
    expect(new Set(contents).size).toBe(paths.length)
    for (const content of contents) {
      expect(content.trim()).not.toBe('')
      expect(content).not.toContain('Make something wonderful.')
    }
  })
  it('serves valid structured data and correct source formats', () => {
    expect(JSON.parse(readDemoFile('package.json')).name).toBe('pocket-garden-demo')
    expect(JSON.parse(readDemoFile('src/garden.json')).plants).toContain('Basil')
    for (const line of readDemoFile('data/events.jsonl').trim().split('\n')) expect(JSON.parse(line)).toHaveProperty('event')
    expect(readDemoFile('README.md')).toMatch(/^# Pocket Garden/)
    expect(readDemoFile('index.html')).toMatch(/^<!doctype html>/)
    expect(readDemoFile('src/Preview.tsx')).toContain('export default function Preview')
    expect(readDemoFile('scripts/evaluate.py')).toContain('import csv')
  })
  it('rejects unknown files instead of substituting unrelated JSX', () => {
    expect(() => readDemoFile('missing.md')).toThrow('File not found')
    expect(() => readDemoFile('toString')).toThrow('File not found')
    expect(listDemoFiles('missing')).toEqual([])
  })
})
