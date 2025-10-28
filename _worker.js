import { connect as connectSocket } from 'cloudflare:sockets'

// === 基本常量 ===
const socketMap = new Map()

// 使用标准 UUID 格式
const UUID_STRING = '' //UUID
const UUID_BYTES = new Uint8Array(
  UUID_STRING.replace(/-/g, '').match(/.{2}/g).map(x => parseInt(x, 16))
)

const BUFFER_POOL = new Uint8Array(32768)
const TEMP_POOL = new Array(12)
const RESPONSES = [
  new Response(null, { status: 400 }),
  new Response(null, { status: 502 })
]

let bufferOffset = 0
let poolIndex = 0

// === 地址与端口解析 ===
const parseTarget = buffer => {
  const offset = 19 + buffer[17]
  const port = (buffer[offset] << 8) | buffer[offset + 1]
  const isIPv4 = buffer[offset + 2] & 1
  const base = offset + 3
  const host = isIPv4
    ? `${buffer[base]}.${buffer[base + 1]}.${buffer[base + 2]}.${buffer[base + 3]}`
    : new TextDecoder().decode(buffer.subarray(base + 1, base + 1 + buffer[base]))
  return [host, port, isIPv4 ? base + 4 : base + 1 + buffer[base], buffer[0]]
}

// === 打开远程 TCP 连接 ===
const openRemoteSocket = (host, port) => {
  try {
    const socket = connectSocket({ hostname: host, port })
    return socket.opened.then(() => socket, () => 0).catch(() => 0)
  } catch {
    return Promise.resolve(0)
  }
}

// === Worker 主逻辑 ===
export default {
  async fetch(request) {
    if (request.headers.get('upgrade') !== 'websocket') return RESPONSES[1]

    const protocolHeader = request.headers.get('sec-websocket-protocol')
    if (!protocolHeader) return RESPONSES[0]

    const decoded = atob(protocolHeader.replace(/[-_]/g, x => (x < '.' ? '+' : '/')))
    const length = decoded.length
    if (length < 18) return RESPONSES[0]

    // 使用预分配内存池
    const fits = bufferOffset + length < 32768
    const buffer = fits
      ? new Uint8Array(BUFFER_POOL.buffer, bufferOffset, (bufferOffset += length))
      : poolIndex
        ? TEMP_POOL[--poolIndex] || new Uint8Array(length)
        : new Uint8Array(length)

    const recycle = () => {
      if (fits) {
        if (bufferOffset > 24576) bufferOffset = 0
        else bufferOffset -= length
      } else if (poolIndex < 12 && !TEMP_POOL[poolIndex]) {
        TEMP_POOL[poolIndex++] = buffer
      }
    }

    // 将协议头解码填充入缓冲区
    for (let i = length; i--;) buffer[i] = decoded.charCodeAt(i)

    // 校验协议版本
    if (buffer[0]) {
      recycle()
      return RESPONSES[0]
    }

    // 校验 UUID 字节序列
    for (let i = 0; i < 16; i++) {
      if (buffer[i + 1] ^ UUID_BYTES[i]) {
        recycle()
        return RESPONSES[0]
      }
    }

    // 解析目标地址与端口
    const [targetHost, targetPort, dataOffset, versionFlag] = parseTarget(buffer)

    // 建立远程连接
    const remote =
      (await openRemoteSocket(targetHost, targetPort)) ||
      (await openRemoteSocket('proxy.xxxxxxxx.tk', 50001)) //Proxyip
    if (!remote) {
      recycle()
      return RESPONSES[1]
    }

    // === WebSocket 双向绑定 ===
    const { 0: client, 1: ws } = new WebSocketPair()
    const writer = remote.writable.getWriter()
    const state = [1, 0]
    const header = new Uint8Array([versionFlag, 0])
    let pendingHeader = header

    ws.accept()
    socketMap.set(ws, state)
    if (length > dataOffset)
      writer.write(buffer.subarray(dataOffset)).catch(() => (state[0] = 0))
    recycle()

    // === 清理与关闭函数 ===
    const cleanup = () => {
      try { ws.close(state[1]) } catch {}
      try { remote.close() } catch {}
      socketMap.delete(ws)
      if (socketMap.size > 999) socketMap.clear()
    }

    const closeAll = () => {
      if (state[0]) {
        state[0] = 0
        writer.releaseLock()
        cleanup()
      }
    }

    // === 双向数据流 ===
    ws.addEventListener('message', e =>
      state[0] && writer.write(e.data).catch(() => (state[0] = 0))
    )
    ws.addEventListener('close', () => { state[1] = 1000; closeAll() })
    ws.addEventListener('error', () => { state[1] = 1006; closeAll() })

    remote.readable.pipeTo(new WritableStream({
      async write(chunk) {
        if (state[0]) {
          if (pendingHeader) {
            ws.send(await new Blob([pendingHeader, chunk]).arrayBuffer())
            pendingHeader = null
          } else ws.send(chunk)
        }
      },
      close() { state[1] = 1000; closeAll() },
      abort() { state[1] = 1006; closeAll() }
    })).catch(() => {})

    return new Response(null, { status: 101, webSocket: client })
  }
}
