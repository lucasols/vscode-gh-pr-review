import { describe, expect, test } from 'vitest'
import { SerialTask, chunk, sleep } from './async'

describe('SerialTask', () => {
  test('never overlaps and queues a single extra run', async () => {
    let active = 0
    let maxActive = 0
    let runs = 0
    const task = new SerialTask(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      runs++
      await sleep(5)
      active--
    })

    await Promise.all([task.run(), task.run(), task.run(), task.run()])

    expect(maxActive).toBe(1)
    expect(runs).toBe(2)
  })

  test('a request made during a run resolves after a run that started later', async () => {
    const started: number[] = []
    const finished: number[] = []
    let n = 0
    const task = new SerialTask(async () => {
      const id = ++n
      started.push(id)
      await sleep(5)
      finished.push(id)
    })

    const first = task.run()
    const second = task.run()
    await second
    await first

    expect(started).toEqual([1, 2])
    expect(finished).toEqual([1, 2])
  })

  test('keeps working after a failed run', async () => {
    let fail = true
    let runs = 0
    const task = new SerialTask(async () => {
      runs++
      await sleep(1)
      if (fail) throw new Error('boom')
    })

    await expect(task.run()).rejects.toThrow('boom')
    fail = false
    await task.run()
    expect(runs).toBe(2)
    expect(task.isRunning).toBe(false)
  })
})

test('chunk splits a list', () => {
  expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  expect(chunk([], 2)).toEqual([])
})
