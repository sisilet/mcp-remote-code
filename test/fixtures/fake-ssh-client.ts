import { EventEmitter } from "events"

/**
 * A stand-in for an ssh2 channel. Enough surface for `execOnChannel` and
 * `execStream`: data, stderr, close with (code, signal), and the kill path.
 */
export class FakeStream extends EventEmitter {
  stderr = new EventEmitter()
  signalled: string | undefined
  wasClosed = false
  wasDestroyed = false
  stdinData: string | undefined

  signal(name: string): void {
    this.signalled = name
  }
  close(): void {
    this.wasClosed = true
  }
  destroy(): void {
    this.wasDestroyed = true
  }
  end(data?: string): void {
    this.stdinData = data
  }
  resume(): void {}

  /** Finish the command, the way ssh2 reports it. */
  finish(code: number | null, signal?: string): void {
    this.emit("close", code, signal)
  }

  get killed(): boolean {
    return this.signalled !== undefined || this.wasClosed || this.wasDestroyed
  }
}

/**
 * A stand-in for an ssh2 Client. Lets a test kill the transport, delay a
 * channel opening, or hold a command open indefinitely — the three
 * situations that produced F-31, F-32 and F-34 and that no test could reach
 * while the only way in was a real SSH server.
 */
export class FakeClient extends EventEmitter {
  execCommands: string[] = []
  streams: FakeStream[] = []
  ended = false
  /** Milliseconds before the exec callback delivers its stream. */
  execDelayMs = 0
  /** When false, the caller finishes each stream by hand. */
  autoFinish = true
  sftpAvailable = false

  exec(command: string, cb: (err: Error | undefined, stream: FakeStream) => void): void {
    this.execCommands.push(command)
    const deliver = () => {
      const stream = new FakeStream()
      this.streams.push(stream)
      cb(undefined, stream)
      if (this.autoFinish) {
        queueMicrotask(() => {
          if (!stream.killed) stream.finish(0)
        })
      }
    }
    if (this.execDelayMs > 0) setTimeout(deliver, this.execDelayMs)
    else queueMicrotask(deliver)
  }

  sftp(cb: (err: Error | undefined, sftp?: unknown) => void): void {
    if (!this.sftpAvailable) {
      cb(new Error("Unable to start subsystem: sftp"))
      return
    }
    cb(undefined, Object.assign(new EventEmitter(), { end() {} }))
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    this.emit("close")
  }

  /** Transport dies without anyone calling end(). */
  killTransport(): void {
    this.emit("close")
  }
}

/** A connector that hands out FakeClients and records how often it was called. */
export function fakeConnector() {
  const clients: FakeClient[] = []
  let calls = 0
  let gate: Promise<void> | undefined
  let openGate: (() => void) | undefined

  return {
    clients,
    get calls() {
      return calls
    },
    /** Hold every connect attempt until release() is called. */
    block() {
      gate = new Promise<void>((resolve) => {
        openGate = resolve
      })
    },
    release() {
      openGate?.()
      gate = undefined
    },
    connect: async (): Promise<any> => {
      calls++
      if (gate) await gate
      const client = new FakeClient()
      clients.push(client)
      return client
    },
  }
}
