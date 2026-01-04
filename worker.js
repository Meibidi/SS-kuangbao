import { connect } from 'cloudflare:sockets';

// ==================== 配置常量 ====================
// 使用 Uint8Array 避免字符串比较开销
const UUID = new Uint8Array([
  0x55, 0xd9, 0xec, 0x38, 0x1b, 0x8a, 0x45, 0x4b, 0x98, 0x1a, 0x6a, 0xcf, 0xe8, 0xf5, 0x6d, 0x8c,
]);
const PROXY_HOST = 'sjc.o00o.ooo';
const PROXY_PORT = 443;

// 性能调优参数 (使用位运算友好的值)
const CHUNK_SIZE = 32768; // 32KB = 1 << 15
const CONCURRENCY = 4;
const UPLINK_BATCH_SIZE = 8;

// 地址类型常量 (V8 会将小整数作为 Smi 优化)
const ATYPE_IPV4 = 1;
const ATYPE_DOMAIN = 2;
const ATYPE_IPV6 = 3;

// ==================== 预分配/缓存 ====================
const decoder = new TextDecoder();
const encoder = new TextEncoder();

// 预分配首包响应头
const RESPONSE_HEADER = new Uint8Array([0, 0]);

// 响应工厂函数 (每次返回新实例，避免 Response 被消费后无法重用)
const resp426 = () => new Response(null, { status: 426, headers: { Upgrade: 'websocket' } });
const resp400 = () => new Response(null, { status: 400 });
const resp403 = () => new Response(null, { status: 403 });
const resp502 = () => new Response(null, { status: 502 });

// Base64 字符映射表 (避免正则替换)
const B64_DECODE_MAP = new Uint8Array(128);
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
for (let i = 0; i < 64; i++) B64_DECODE_MAP[B64_CHARS.charCodeAt(i)] = i;
B64_DECODE_MAP[45] = 62; // '-' -> '+'
B64_DECODE_MAP[95] = 63; // '_' -> '/'

// ==================== 工具函数 ====================

// Base64 URL-safe 解码 (查表法，无正则)
const decodeBase64 = str => {
  const len = str.length;
  // 计算输出长度 (处理 padding)
  let padding = 0;
  if (len > 0 && str.charCodeAt(len - 1) === 61) padding++;
  if (len > 1 && str.charCodeAt(len - 2) === 61) padding++;
  const outLen = ((len * 3) >> 2) - padding;
  const arr = new Uint8Array(outLen);

  let j = 0;
  for (let i = 0; i < len; ) {
    const a = B64_DECODE_MAP[str.charCodeAt(i++)];
    const b = B64_DECODE_MAP[str.charCodeAt(i++)];
    const c = B64_DECODE_MAP[str.charCodeAt(i++)];
    const d = B64_DECODE_MAP[str.charCodeAt(i++)];
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    if (j < outLen) arr[j++] = (triple >> 16) & 0xff;
    if (j < outLen) arr[j++] = (triple >> 8) & 0xff;
    if (j < outLen) arr[j++] = triple & 0xff;
  }
  return arr;
};

// UUID 验证 - 完全展开循环
const verifyUUID = data =>
  data[1] === UUID[0] &&
  data[2] === UUID[1] &&
  data[3] === UUID[2] &&
  data[4] === UUID[3] &&
  data[5] === UUID[4] &&
  data[6] === UUID[5] &&
  data[7] === UUID[6] &&
  data[8] === UUID[7] &&
  data[9] === UUID[8] &&
  data[10] === UUID[9] &&
  data[11] === UUID[10] &&
  data[12] === UUID[11] &&
  data[13] === UUID[12] &&
  data[14] === UUID[13] &&
  data[15] === UUID[14] &&
  data[16] === UUID[15];

// 地址解析 - 单一出口优化
const parseAddress = (data, offset) => {
  const atype = data[offset + 3];
  const base = offset + 4;
  let host, end;

  switch (atype) {
    case ATYPE_DOMAIN: {
      const len = data[base];
      end = base + 1 + len;
      if (end > data.length) return null;
      host = decoder.decode(data.subarray(base + 1, end));
      break;
    }
    case ATYPE_IPV4: {
      end = base + 4;
      if (end > data.length) return null;
      host = `${data[base]}.${data[base + 1]}.${data[base + 2]}.${data[base + 3]}`;
      break;
    }
    case ATYPE_IPV6: {
      end = base + 16;
      if (end > data.length) return null;
      const v = new DataView(data.buffer, data.byteOffset + base, 16);
      host = `${v.getUint16(0).toString(16)}:${v.getUint16(2).toString(16)}:${v
        .getUint16(4)
        .toString(16)}:${v.getUint16(6).toString(16)}:${v.getUint16(8).toString(16)}:${v
        .getUint16(10)
        .toString(16)}:${v.getUint16(12).toString(16)}:${v.getUint16(14).toString(16)}`;
      break;
    }
    default:
      return null;
  }
  return { host, end, atype };
};

// ==================== 连接策略 ====================

// 单次连接 Promise
const createConnect = (hostname, port) => {
  const socket = connect({ hostname, port });
  return socket.opened.then(() => socket);
};

// 智能并发连接 - 改进版 Race 策略
// 直连失败时立即触发代理，而不是固定等待
const connectTCP = async (host, port, atype) => {
  const concurrency = atype === ATYPE_DOMAIN ? CONCURRENCY : 2;

  // 创建一个可以外部触发的代理连接
  let triggerProxy;
  const proxyPromise = new Promise(resolve => {
    triggerProxy = () => createConnect(PROXY_HOST, PROXY_PORT).then(resolve).catch(() => {});
  });

  // 直连任务 - 失败时立即触发代理
  const directTasks = [];
  for (let i = 0; i < concurrency; i++) {
    const task = createConnect(host, port).catch(err => {
      triggerProxy(); // 直连失败，立即尝试代理
      throw err;
    });
    directTasks.push(task);
  }

  // 超时后也触发代理 (防止直连卡住)
  const timeoutId = setTimeout(triggerProxy, 50);

  try {
    // 竞争：直连 vs 代理
    const result = await Promise.any([...directTasks, proxyPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch {
    clearTimeout(timeoutId);
    // 全部失败，最后尝试代理
    return await createConnect(PROXY_HOST, PROXY_PORT);
  }
};

// ==================== 流处理 ====================

// BYOB 下行泵 (TCP -> WebSocket) - 零拷贝优化版
// Cloudflare Workers 的 WebSocket.send() 会立即序列化数据，
// 因此可以直接传递 BYOB 缓冲区的视图，无需 slice() 复制
const pumpDownlink = async (readable, send, shutdown) => {
  let buffer = new ArrayBuffer(CHUNK_SIZE);
  let isFirst = true;
  const reader = readable.getReader({ mode: 'byob' });

  try {
    while (true) {
      const { done, value } = await reader.read(new Uint8Array(buffer));
      if (done) break;
      buffer = value.buffer;

      if (isFirst) {
        isFirst = false;
        // 首包: 必须拼接头部 (无法避免分配)
        const frame = new Uint8Array(value.length + 2);
        frame.set(RESPONSE_HEADER);
        frame.set(value, 2);
        send(frame);
      } else {
        // 后续包: 直接发送视图，避免 slice() 分配
        // 注意: 这依赖于 send() 在返回前完成数据拷贝
        // 如果遇到问题，可回退到 send(value.slice())
        send(value);
      }
    }
  } catch {
    // 静默处理读取错误
  } finally {
    reader.releaseLock();
    shutdown();
  }
};

// 批量上行泵 (WebSocket -> TCP)
// 收集多个小消息后一次性写入，减少系统调用
const createUplinkPump = (tcpWritable, shutdown) => {
  const writer = tcpWritable.getWriter();
  const queue = [];
  let scheduled = false;
  let totalBytes = 0;

  const flush = () => {
    scheduled = false;
    const len = queue.length;
    if (len === 0) return;

    // 单消息优化：无需合并
    if (len === 1) {
      const single = queue[0];
      queue.length = 0;
      totalBytes = 0;
      writer.write(single).catch(shutdown);
      return;
    }

    // 多消息合并
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (let i = 0; i < len; i++) {
      const chunk = queue[i];
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    queue.length = 0;
    totalBytes = 0;
    writer.write(merged).catch(shutdown);
  };

  // 使用 queueMicrotask 而非 setTimeout (更快, ~0.1ms vs ~4ms)
  const scheduleFlush = () => {
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(flush);
    }
  };

  const enqueue = data => {
    // 类型转换 (保持单态性: 始终处理 Uint8Array)
    let chunk;
    if (data instanceof ArrayBuffer) {
      chunk = new Uint8Array(data);
    } else if (data.buffer) {
      // 已经是 TypedArray (包括 Uint8Array)
      chunk = data;
    } else {
      // string
      chunk = encoder.encode(data);
    }

    queue.push(chunk);
    totalBytes += chunk.length;

    // 立即刷新大批量
    if (queue.length >= UPLINK_BATCH_SIZE || totalBytes >= CHUNK_SIZE) {
      flush();
    } else {
      scheduleFlush();
    }
  };

  const close = () => {
    flush();
    writer.close().catch(() => {});
  };

  return { enqueue, close };
};

// ==================== 主处理器 ====================

export default {
  async fetch(request) {
    // 快速路径: WebSocket 检查
    if (request.headers.get('Upgrade') !== 'websocket') return resp426();

    const protocol = request.headers.get('Sec-WebSocket-Protocol');
    if (!protocol) return resp400();

    // 解码 payload
    let data;
    try {
      data = decodeBase64(protocol);
    } catch {
      return resp400();
    }

    // 验证
    if (data.length < 18 || !verifyUUID(data)) return resp403();

    // 解析偏移
    const addrOffset = 18 + data[17];
    if (addrOffset + 4 > data.length) return resp400();

    // 解析端口和地址
    const port = (data[addrOffset + 1] << 8) | data[addrOffset + 2];
    const addr = parseAddress(data, addrOffset);
    if (!addr) return resp400();

    // 建立 TCP 连接 (智能并发)
    let tcp;
    try {
      tcp = await connectTCP(addr.host, port, addr.atype);
    } catch {
      return resp502();
    }

    // 创建 WebSocket 对
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    // 状态管理 (使用位标志减少分支预测失败)
    let state = 0; // 0=open, 1=closing, 2=closed
    const shutdown = () => {
      if (state !== 0) return;
      state = 1;
      try {
        server.close();
      } catch {}
      try {
        tcp.close();
      } catch {}
      state = 2;
    };

    // 初始化上行泵
    const uplink = createUplinkPump(tcp.writable, shutdown);

    // 发送初始数据 (如果有)
    if (data.length > addr.end) {
      uplink.enqueue(data.subarray(addr.end));
    }

    // WebSocket 事件处理
    server.addEventListener('message', e => uplink.enqueue(e.data));
    server.addEventListener('close', () => {
      uplink.close();
      shutdown();
    });
    server.addEventListener('error', shutdown);

    // 启动下行泵 (不阻塞)
    pumpDownlink(tcp.readable, d => server.send(d), shutdown);

    return new Response(null, { status: 101, webSocket: client });
  },
};
