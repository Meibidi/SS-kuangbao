import { connect as connectSocket } from 'cloudflare:sockets'

// === 常量与缓存结构 ===
const socketMap = new Map() // 存放 WebSocket 对象和其状态
const UUID_STRING = '91cb2002-6d55-48ed-a9d9-65bdfb1b93a5'
const UUID_BYTES = new Uint8Array(
  UUID_STRING.replace(/-/g, '').match(/.{2}/g).map(x => parseInt(x, 16))
)

const BUFFER_POOL = new Uint8Array(32768)
const TEMP_POOL = new Array(12)
const HEARTBEAT = new Uint8Array(2)
const RESPONSES = [
  new Response(null, { status: 400 }),
  new Response(null, { status: 502 })
]

let bufferOffset = 0
let poolIndex = 0

// === 地址与端口解析 ===
const parseTarget = bytes => {
  const offset = 19 + bytes[17]
  const port = (bytes[offset] << 8) | bytes[offset + 1]
  const flag = bytes[offset + 2] & 1
  const base = offset + 3
  const host = flag
    ? `${bytes[base]}.${bytes[base + 1]}.${bytes[base + 2]}.${bytes[base + 3]}`
    : new TextDecoder().decode(bytes.subarray(base + 1, base + 1 + bytes[base]))
  return [host, port, flag ? base + 4 : base + 1 + bytes[base]]
}

// === 建立远程 TCP 连接 ===
const openRemote = (host, port) => {
  try {
    const socket = connectSocket({ hostname: host, port })
    return socket.opened.then(() => socket, () => 0)
  } catch {
    return Promise.resolve(0)
  }
}

// === 主逻辑 ===
export default {
  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return RESPONSES[1]

    const protocolHeader = request.headers.get('sec-websocket-protocol')
    if (!protocolHeader) return RESPONSES[0]

    const decoded = atob(protocolHeader.replace(/[-_]/g, x => (x < '.' ? '+' : '/')))
    const length = decoded.length
    if (length < 18) return RESPONSES[0]

    const fits = bufferOffset + length < 32768
    const buf = fits
      ? new Uint8Array(BUFFER_POOL.buffer, bufferOffset, (bufferOffset += length))
      : poolIndex
        ? TEMP_POOL[--poolIndex] || new Uint8Array(length)
        : new Uint8Array(length)

    const recycle = () => {
      if (fits) {
        if (bufferOffset > 24576) bufferOffset = 0
        else bufferOffset -= length
      } else if (poolIndex < 12 && !TEMP_POOL[poolIndex]) {
        TEMP_POOL[poolIndex++] = buf
      }
    }

    for (let i = length; i--;) buf[i] = decoded.charCodeAt(i)

    // 校验版本号
    if (buf[0]) {
      recycle()
      return RESPONSES[0]
    }

    // 校验 UUID
    for (let i = 0; i < 16; i++) {
      if (buf[i + 1] ^ UUID_BYTES[i]) {
        recycle()
        return RESPONSES[0]
      }
    }

    // 解析目标地址
    const [targetHost, targetPort, dataOffset] = parseTarget(buf)
    const remote = await openRemote(targetHost, targetPort) ||
                   await openRemote('proxy.xxxxxxxx.tk', 50001)
    if (!remote) {
      recycle()
      return RESPONSES[1]
    }

    // === 建立 WebSocket 与远程通道绑定 ===
    const { 0: clientSocket, 1: workerSocket } = new WebSocketPair()
    const writer = remote.writable.getWriter()
    const status = [1, 0]

    const cleanup = () => {
      try { workerSocket.close(status[1]) } catch {}
      try { remote.close() } catch {}
      socketMap.delete(workerSocket)
      if (socketMap.size > 999) socketMap.clear()
    }

    const closeAll = () => {
      if (status[0]) {
        status[0] = 0
        writer.releaseLock()
        cleanup()
      }
    }

    workerSocket.accept()
    workerSocket.send(HEARTBEAT)
    socketMap.set(workerSocket, status)

    if (length > dataOffset)
      writer.write(buf.subarray(dataOffset)).catch(() => (status[0] = 0))

    recycle()

    // === 数据双向转发 ===
    workerSocket.addEventListener('message', e =>
      status[0] && writer.write(e.data).catch(() => (status[0] = 0))
    )
    workerSocket.addEventListener('close', () => { status[1] = 1000; closeAll() })
    workerSocket.addEventListener('error', () => { status[1] = 1006; closeAll() })

    remote.readable.pipeTo(new WritableStream({
      write(chunk) { status[0] && workerSocket.send(chunk) },
      close() { status[1] = 1000; closeAll() },
      abort() { status[1] = 1006; closeAll() }
    })).catch(() => {})

    return new Response(null, { status: 101, webSocket: clientSocket })
  }
}
