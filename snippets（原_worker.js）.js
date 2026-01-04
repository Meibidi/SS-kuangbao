import { connect } from 'cloudflare:sockets';

// 预编译常量 - V8内联缓存友好
const UUID = new Uint8Array([0x55,0xd9,0xec,0x38,0x1b,0x8a,0x45,0x4b,0x98,0x1a,0x6a,0xcf,0xe8,0xf5,0x6d,0x8c]);
const PROXY_HOST = 'sjc.o00o.ooo';
const PROXY_PORT = 443;
const ATYPE_IPV4 = 1;
const ATYPE_DOMAIN = 2;
const ATYPE_IPV6 = 3;

// 单例复用 - 避免重复实例化
const decoder = new TextDecoder();
const encoder = new TextEncoder();

// 响应工厂 - 单态函数
const makeResponse = (status, headers) => new Response(null, headers ? { status, headers } : { status });

// Base64解码 - 类型稳定
const decodeBase64 = (str) => {
  const b = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const len = b.length;
  const arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) arr[i] = b.charCodeAt(i);
  return arr;
};

// UUID验证 - 展开循环优化
const verifyUUID = (data) => {
  return data[1] === UUID[0] && data[2] === UUID[1] && data[3] === UUID[2] && data[4] === UUID[3] &&
         data[5] === UUID[4] && data[6] === UUID[5] && data[7] === UUID[6] && data[8] === UUID[7] &&
         data[9] === UUID[8] && data[10] === UUID[9] && data[11] === UUID[10] && data[12] === UUID[11] &&
         data[13] === UUID[12] && data[14] === UUID[13] && data[15] === UUID[14] && data[16] === UUID[15];
};

// 地址解析器 - 返回固定结构
const parseAddress = (data, offset) => {
  const atype = data[offset + 3];
  const base = offset + 4;

  if (atype === ATYPE_DOMAIN) {
    const len = data[base];
    const end = base + 1 + len;
    return { host: decoder.decode(data.subarray(base + 1, end)), end, ok: end <= data.length };
  }
  if (atype === ATYPE_IPV4) {
    const end = base + 4;
    return { host: `${data[base]}.${data[base+1]}.${data[base+2]}.${data[base+3]}`, end, ok: end <= data.length };
  }
  if (atype === ATYPE_IPV6) {
    const end = base + 16;
    if (end > data.length) return { host: '', end: 0, ok: false };
    const v = new DataView(data.buffer, data.byteOffset + base, 16);
    const host = `${v.getUint16(0).toString(16)}:${v.getUint16(2).toString(16)}:${v.getUint16(4).toString(16)}:${v.getUint16(6).toString(16)}:${v.getUint16(8).toString(16)}:${v.getUint16(10).toString(16)}:${v.getUint16(12).toString(16)}:${v.getUint16(14).toString(16)}`;
    return { host, end, ok: true };
  }
  return { host: '', end: 0, ok: false };
};

// TCP连接器 - 带回退
const connectTCP = async (host, port) => {
  try {
    const sock = connect({ hostname: host, port });
    await sock.opened;
    return sock;
  } catch {
    const sock = connect({ hostname: PROXY_HOST, port: PROXY_PORT });
    await sock.opened;
    return sock;
  }
};

export default {
  async fetch(request) {
    // 快速路径检查
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') return makeResponse(426, { Upgrade: 'websocket' });

    const protocol = request.headers.get('Sec-WebSocket-Protocol');
    if (!protocol) return makeResponse(400);

    // 解码payload
    let data;
    try { data = decodeBase64(protocol) }
    catch { return makeResponse(400) }

    // 长度验证
    if (data.length < 18) return makeResponse(400);

    // UUID验证
    if (!verifyUUID(data)) return makeResponse(403);

    // 计算偏移
    const addrOffset = 18 + data[17];
    if (addrOffset + 4 > data.length) return makeResponse(400);

    // 解析端口
    const port = (data[addrOffset + 1] << 8) | data[addrOffset + 2];

    // 解析地址
    const addr = parseAddress(data, addrOffset);
    if (!addr.ok) return makeResponse(400);

    // 建立TCP连接
    let tcp;
    try { tcp = await connectTCP(addr.host, port) }
    catch { return makeResponse(502) }

    // 创建WebSocket对
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    // 关闭处理器
    let closed = false;
    const shutdown = () => {
      if (closed) return;
      closed = true;
      try { server.close() } catch {}
      try { tcp.close() } catch {}
    };

    // 上行流: WebSocket -> TCP
    const uplink = new ReadableStream({
      start(controller) {
        // 初始数据
        if (data.length > addr.end) {
          controller.enqueue(data.subarray(addr.end));
        }
        // 消息处理
        server.addEventListener('message', (event) => {
          const payload = event.data;
          try {
            if (payload instanceof ArrayBuffer) {
              controller.enqueue(new Uint8Array(payload));
            } else {
              controller.enqueue(encoder.encode(payload));
            }
          } catch { shutdown() }
        });
        server.addEventListener('close', () => { try { controller.close() } catch {} });
        server.addEventListener('error', shutdown);
      },
      cancel: shutdown
    });
    uplink.pipeTo(tcp.writable).catch(shutdown);

    // 下行流: TCP -> WebSocket
    let isFirst = true;
    const downlink = new WritableStream({
      write(chunk) {
        if (isFirst) {
          isFirst = false;
          const frame = new Uint8Array(chunk.length + 2);
          frame[0] = 0;
          frame[1] = 0;
          frame.set(chunk, 2);
          server.send(frame);
        } else {
          server.send(chunk);
        }
      },
      close: shutdown,
      abort: shutdown
    });
    tcp.readable.pipeTo(downlink).catch(shutdown);

    return new Response(null, { status: 101, webSocket: client });
  }
};
