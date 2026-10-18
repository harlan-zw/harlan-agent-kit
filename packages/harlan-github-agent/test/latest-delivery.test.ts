import { expect, it } from 'vitest'
import { latestDelivery } from '../src/latest-delivery.ts'

it('sends the newest complete state after a slow write, without queuing obsolete states', async () => {
  const written: number[] = []
  let release: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const delivery = latestDelivery(async (value: number) => {
    written.push(value)
    if (value === 1)
      await blocked
  }, () => { throw new Error('Unexpected delivery failure') })
  delivery.push(1)
  delivery.push(2)
  delivery.push(3)
  expect(written).toEqual([1])
  release!()
  await expect.poll(() => written).toEqual([1, 3])
  delivery.push(4)
  await expect.poll(() => written).toEqual([1, 3, 4])
})

it('discards pending state when a subscriber disconnects', async () => {
  const written: number[] = []
  let release: (() => void) | undefined
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const delivery = latestDelivery(async (value: number) => {
    written.push(value)
    await blocked
  }, () => undefined)
  delivery.push(1)
  delivery.push(2)
  delivery.close()
  delivery.push(3)
  release!()
  await blocked
  expect(written).toEqual([1])
})

it('reports a write failure once and stops accepting state', async () => {
  const written: number[] = []
  let failures = 0
  const delivery = latestDelivery(async (value: number) => {
    written.push(value)
    throw new Error('Disconnected')
  }, () => {
    failures++
  })
  delivery.push(1)
  delivery.push(2)
  await expect.poll(() => failures).toBe(1)
  delivery.push(3)
  expect(written).toEqual([1])
})
