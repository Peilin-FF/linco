export const GARDEN_PATH = 'C:\\Projects\\linco/src/garden.json'
export const initialGarden = { title: 'A little room to grow.', night: false, plants: ['Basil', 'Mint', 'Lavender'] }
let garden = { ...initialGarden, plants: [...initialGarden.plants] }
export function readGarden() { return garden }
export function saveGarden(text: string) {
  const value = JSON.parse(text)
  if (typeof value.title !== 'string' || typeof value.night !== 'boolean' || !Array.isArray(value.plants) || value.plants.length > 12 || !value.plants.every((p: unknown) => typeof p === 'string' && p.length <= 40)) {
    throw new Error('Use a title, a true/false night setting, and up to 12 short plant names.')
  }
  garden = { title: value.title.slice(0, 120), night: value.night, plants: [...value.plants] }
  window.dispatchEvent(new Event('linco:garden-change'))
}
export function editGarden(prompt: string): string {
  if (/sunflower|向日葵/i.test(prompt)) {
    if (!garden.plants.includes('Sunflower')) garden.plants = [...garden.plants, 'Sunflower'].slice(0, 12)
  } else if (/night|midnight|dark|夜/i.test(prompt)) garden.night = !garden.night
  else if (/reset|重新/i.test(prompt)) garden = { ...initialGarden, plants: [...initialGarden.plants] }
  else return 'Try "Add a sunflower" or "Make it midnight", or edit src/garden.json yourself.'
  window.dispatchEvent(new Event('linco:garden-change'))
  return 'Updated src/garden.json in demo memory. Open Live preview to play, or inspect the file in Code.'
}
