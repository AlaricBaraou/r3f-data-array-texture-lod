import TileWorker from './tileWorker.js?worker'

// Worker pool — pull-based priority queue (highest LOD dispatched first)
export class TileLoaderPool {
  constructor(poolSize = 4) {
    this.workers = Array.from({ length: poolSize }, () => new TileWorker())
    this.idleWorkers = [...Array(poolSize).keys()]
    this.queue = [] // kept sorted: highest priority first
    this.active = new Map() // id -> { resolve, reject, workerIdx }
    this.idCounter = 0

    this.workers.forEach((worker, idx) => {
      worker.onmessage = (e) => {
        const { id, status } = e.data
        if (status !== 'done' && status !== 'error') return // ignore intermediate messages
        const entry = this.active.get(id)
        if (entry) {
          if (status === 'done') entry.resolve(e.data)
          else entry.reject(new Error(e.data.error))
          this.active.delete(id)
          this.idleWorkers.push(idx)
          this._dispatch()
        }
      }
    })
  }

  _dispatch() {
    while (this.idleWorkers.length > 0 && this.queue.length > 0) {
      const task = this.queue.shift()
      const workerIdx = this.idleWorkers.pop()
      this.active.set(task.id, { resolve: task.resolve, reject: task.reject, workerIdx })
      this.workers[workerIdx].postMessage({
        url: task.url, imageIndex: task.imageIndex, lodLevel: task.lodLevel, id: task.id
      })
    }
  }

  loadImageTiles(url, imageIndex, lodLevel, priority = lodLevel) {
    return new Promise((resolve, reject) => {
      const id = this.idCounter++
      // Insert in priority order (highest first)
      let i = 0
      while (i < this.queue.length && this.queue[i].priority >= priority) i++
      this.queue.splice(i, 0, { id, url, imageIndex, lodLevel, priority, resolve, reject })
      this._dispatch()
    })
  }

  // Cancel queued (not yet dispatched to worker) tasks for an image below a given LOD
  cancelPending(imageIndex, belowLod) {
    const kept = []
    for (const task of this.queue) {
      if (task.imageIndex === imageIndex && task.lodLevel < belowLod) {
        task.reject(new Error('cancelled'))
      } else {
        kept.push(task)
      }
    }
    this.queue = kept
  }

  dispose() {
    for (const task of this.queue) task.reject(new Error('disposed'))
    this.queue = []
    this.workers.forEach(w => w.terminate())
  }
}

let loaderPool = null
export function getLoaderPool() {
  if (!loaderPool) {
    loaderPool = new TileLoaderPool(4)
  }
  return loaderPool
}
