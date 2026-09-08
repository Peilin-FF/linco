import { afterEach, beforeEach, expect, it, vi } from 'vitest'

beforeEach(() => { vi.resetModules(); vi.stubGlobal('window', new EventTarget()) })
afterEach(() => vi.unstubAllGlobals())

it('scripted garden edits are deterministic and preserve existing plants', async () => {
  const { editGarden, readGarden } = await import('../demo/garden')
  editGarden('Add a sunflower')
  editGarden('Add a sunflower')
  expect(readGarden().plants).toEqual(['Basil', 'Mint', 'Lavender', 'Sunflower'])
  editGarden('Make it midnight')
  expect(readGarden().night).toBe(true)
  editGarden('reset')
  expect(readGarden().night).toBe(false)
})

it('unknown prompts do not perform changes or execute anything', async () => {
  const { editGarden, readGarden } = await import('../demo/garden')
  const before = JSON.stringify(readGarden())
  expect(editGarden('run a shell command')).toContain('Try')
  expect(JSON.stringify(readGarden())).toBe(before)
})

it('validates edited project data and emits a preview update', async () => {
  const { saveGarden, readGarden } = await import('../demo/garden')
  const listener = vi.fn()
  window.addEventListener('linco:garden-change', listener)
  saveGarden(JSON.stringify({ title: 'My garden', night: true, plants: ['Fern'] }))
  expect(readGarden().plants).toEqual(['Fern'])
  expect(listener).toHaveBeenCalledTimes(1)
  expect(() => saveGarden('{')).toThrow()
  expect(() => saveGarden(JSON.stringify({ title: 'Garden', night: 'yes', plants: [] }))).toThrow()
  expect(readGarden().title).toBe('My garden')
})
