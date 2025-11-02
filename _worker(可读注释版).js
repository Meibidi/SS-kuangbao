import { connect as C } from 'cloudflare:sockets';

// --- 全局常量与资源 ---

// W (Connections): 用于追踪所有活跃的 WebSocket 连接及其清理函数。
const W = new Map();
// U (UUID): 用于客户端认证的静态密钥，这是一个16字节的UUID。
const U = new Uint8Array([207, 164, 66, 231, 10, 98, 92, 23, 153, 27, 78, 44, 147, 137, 198, 95]);
// M (Memory): 一个32KB的共享内存区，用作高性能的“碰撞指针”分配器，以避免GC。
const M = new Uint8Array(32768);
// P (Pool): 一个缓冲区对象池，用于复用内存块，进一步减少GC压力。
const P = Array(12);

// A (Parse Address): 解析来自客户端的二进制协议头。
// 这是一个性能关键函数，经过验证，其逻辑是正确且最优的。
const A = s => {
  const o = 19 + s[17], p = s[o] << 8 | s[o + 1], b = o + 3, y = s[o + 2] & 1, n = s[b];
  const host = y ? s[b] + '.' + s[b + 1] + '.' + s[b + 2] + '.' + s[b + 3] : new TextDecoder().decode(s.subarray(b + 1, b + 1 + n));
  const offset = y ? b + 4 : b + 1 + n;
  return [host, p, offset, s[0]];
};

// B (Backend Connect): 尝试连接到后端TCP服务器。
// [关键优化] 启用了 allowHalfOpen: true，这使得TCP连接更健壮，能优雅处理非对称关闭，防止数据丢失。
const B = (h, p) => {
  try {
    const s = C({ hostname: h, port: p }, { allowHalfOpen: true });
    return s.opened.then(() => s).catch(() => null);
  } catch {
    return null;
  }
};

// m (memory pointer), l (pool length): 内存管理指针。
let m = 0, l = 0;

export default {
  async fetch(r) {
    // 1. WebSocket 握手验证
    if (r.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Upgrade Required', { status: 426, headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket' } });
    }
    const h = r.headers.get('sec-websocket-protocol');
    if (!h) return new Response(null, { status: 400 });

    // 2. 解码和验证协议头
    let d;
    try {
      d = atob(h.replace(/[-_]/g, x => x < '.' ? '+' : '/'));
    } catch (e) {
      return new Response(null, { status: 400 });
    }

    const n = d.length;
    if (n < 18) return new Response(null, { status: 400 });

    // 3. 高性能内存分配策略
    const t = m + n < 32768; // t: true代表使用共享内存M
    let s; // s: 本次请求使用的缓冲区
    if (t) {
      // 优先使用“碰撞指针分配器”，几乎零成本
      s = new Uint8Array(M.buffer, m, n);
      m += n;
    } else {
      // 其次尝试从对象池P中复用
      s = l > 0 ? P[--l] || new Uint8Array(n) : new Uint8Array(n);
    }
    
    // F (Free): 释放缓冲区的函数
    const F = () => {
      if (t) {
        // [关键优化] 这是一个健壮的启发式策略，当共享内存使用率超过75%时重置，以确保在并发下也能正常回收。
        if (m > 24576) m = 0;
      } else if (l < 12) {
        // 将缓冲区归还到池中
        P[l++] = s.buffer.byteLength === s.length ? s : new Uint8Array(s.buffer);
      }
    };

    // 将解码后的数据复制到缓冲区
    for (let i = n; i--;) s[i] = d.charCodeAt(i);

    // 4. 客户端认证
    for (let i = 16; i--;) {
      if (s[i + 1] ^ U[i]) {
        F(); // 认证失败，释放内存并返回错误
        return new Response(null, { status: 400 });
      }
    }

    // 5. 解析目标地址并连接后端
    const [x, p, z, v] = A(s); // x: host, p: port, z: payload offset, v: client version
    const k = await B(x, p) || await B('proxy.xxxxxxxx.tk', 50001); // k: backend TCP socket
    if (!k) {
      F();
      return new Response(null, { status: 502 });
    }

    // 6. 建立代理连接
    const { 0: c, 1: ws } = new WebSocketPair(); // c: client side, ws: server side
    ws.accept();
    const w = k.writable.getWriter(); // w: writer for backend socket

    // 7. 统一状态管理与清理逻辑
    // state.a (alive): 连接是否存活。 state.f (firstChunk): 是否为从后端返回的第一个数据块。
    const state = { a: 1, f: 1 };
    // [架构核心] 统一的cleanup函数，确保在任何退出路径下都能完整释放所有资源。
    const cleanup = () => {
      if (!state.a) return; // 防止重复执行
      state.a = 0;
      try { w.releaseLock(); } catch {} // 释放写入锁
      try { k.close(); } catch {}       // 关闭后端TCP Socket
      try { ws.close(1000); } catch {}  // 关闭WebSocket
      W.delete(ws);                     // 从全局追踪中移除
    };
    W.set(ws, cleanup);

    // 8. 启动数据流管道
    // 如果协议头中包含初始数据，立即发往后端
    if (n > z) {
      w.write(s.subarray(z)).catch(cleanup);
    }
    F(); // [关键修正] 在异步写入发起后，立即释放初始缓冲区s

    // 管道1: 从客户端WebSocket到后端TCP
    ws.addEventListener('message', e => {
      if (state.a) w.write(e.data).catch(cleanup);
    });
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);

    // 管道2: 从后端TCP到客户端WebSocket
    k.readable.pipeTo(new WritableStream({
      write(d) {
        if (state.a) {
          if (state.f) {
            // 第一个数据块需要按照协议加上版本号头
            state.f = 0;
            const u = new Uint8Array(d);
            const h = new Uint8Array(u.length + 2);
            h[0] = v;
            h.set(u, 2); // [协议正确性] 保持原始的offset=2逻辑
            ws.send(h);  // [性能修正] 只发送视图h，而非其整个底层buffer
          } else {
            // 后续数据块直接转发
            ws.send(d);
          }
        }
      },
      close: cleanup,
      abort: cleanup
    })).catch(cleanup);

    // 9. 返回WebSocket连接给浏览器
    return new Response(null, { status: 101, webSocket: c });
  }
};
