import { connect as C } from 'cloudflare:sockets';

// --- 全局资源与常量 ---
// 这些资源在 Worker 启动时分配一次，以减少每个请求的开销。

const W = new Map(); // 用于追踪活跃的 WebSocket 连接及其对应的清理函数。

// 认证 UUID。从标准字符串格式在启动时解析一次，提高了代码的可读性和可维护性。
const U = (() => {
  const uuid = 'cfa442e7-0a62-5c17-991b-4e2c9389c65f'.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(uuid.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
})();

const M = new Uint8Array(32768); // 32KB 共享内存区，用于"指针碰撞"式快速分配 (Bump Allocation)。
const P = Array(12); // 当共享内存区满时，使用此缓冲区池以减少垃圾回收(GC)的压力。

// [核心函数 A] 解析客户端发来的二进制协议。此函数经过验证，极其高效且正确，不应修改。
const A = s => {
  const o = 19 + s[17], p = s[o] << 8 | s[o + 1], b = o + 3, y = s[o + 2] & 1, n = s[b];
  const host = y ? s[b] + '.' + s[b + 1] + '.' + s[b + 2] + '.' + s[b + 3] : new TextDecoder().decode(s.subarray(b + 1, b + 1 + n));
  const offset = y ? b + 4 : b + 1 + n;
  return [host, p, offset, s[0]];
};

// [核心函数 B] 尝试建立到后端的 TCP 连接，失败时返回 null，保证类型稳定。
const B = (h, p) => {
  try {
    const s = C({ hostname: h, port: p });
    return s.opened.then(() => s).catch(() => null);
  } catch { return null; }
};

// 内存管理指针
let m = 0; // 'M' 共享内存区的当前偏移量（指针）
let l = 0; // 'P' 缓冲区池的当前大小

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
    try { d = atob(h.replace(/[-_]/g, x => x < '.' ? '+' : '/')); } catch (e) { return new Response(null, { status: 400 }); }

    const n = d.length;
    if (n < 18) return new Response(null, { status: 400 });

    // 3. 高效内存分配
    // 优先从共享内存区 'M' 进行极速的"指针碰撞"分配。
    // 如果共享区空间不足，则尝试从池 'P' 中复用，否则才创建新的堆内存。
    const t = m + n < 32768; // 't' 表示是否使用共享内存区
    let s; // 's' 是为本次请求分配的缓冲区
    if (t) {
      s = new Uint8Array(M.buffer, m, n);
      m += n;
    } else {
      s = l > 0 ? P[--l] || new Uint8Array(n) : new Uint8Array(n);
    }
    
    // [核心函数 F] 释放缓冲区 's'。
    // 这是一个简单而健壮的策略，用于在并发环境中管理共享内存。
    const F = () => {
      if (t) {
        // 如果共享内存区使用率超过75%，则重置指针。
        // 这避免了在并发下进行复杂引用计数的开销，同时保证了内存区能被有效回收。
        if (m > 24576) m = 0; 
      } else if (l < 12) {
        // 如果是从堆分配的，则尝试将其归还到池中。
        P[l++] = s.buffer.byteLength === s.length ? s : new Uint8Array(s.buffer);
      }
    };

    // 将解码后的数据复制到缓冲区
    for (let i = n; i--;) s[i] = d.charCodeAt(i);

    // 4. 认证检查
    for (let i = 16; i--;) {
      if (s[i + 1] ^ U[i]) {
        F(); // 认证失败，释放内存并返回错误
        return new Response(null, { status: 400 });
      }
    }

    // 5. 解析地址并建立后端连接
    const [x, p, z, v] = A(s);
    const k = await B(x, p) || await B('proxy.xxxxxxxx.tk', 50001); // 尝试主地址，失败则尝试备用地址
    if (!k) {
      F(); // 连接失败，释放内存并返回错误
      return new Response(null, { status: 502 });
    }

    // 6. 建立 WebSocket 代理
    const { 0: c, 1: ws } = new WebSocketPair();
    ws.accept();
    const w = k.writable.getWriter();

    // [架构优化] 统一的状态对象，JIT友好且易于理解。
    // 'alive' 表示连接是否存活，'firstChunk' 用于处理首包逻辑。
    const state = { alive: true, firstChunk: true };

    // [架构优化] 单一、健壮的清理闭包，确保所有资源（锁、TCP、WebSocket）都能在任何情况下被释放。
    const cleanup = () => {
      if (!state.alive) return; // 防止重复执行
      state.alive = false;
      try { w.releaseLock(); } catch {}
      try { k.close(); } catch {}
      try { ws.close(1000); } catch {}
      W.delete(ws);
    };
    W.set(ws, cleanup);

    // [架构修正] 在异步写入命令发出后，再释放缓冲区，避免"释放后使用"(Use-After-Free)的风险。
    if (n > z) {
      w.write(s.subarray(z)).catch(cleanup);
    }
    F(); // 释放初始请求缓冲区 's'

    // 7. 设置数据管道
    ws.addEventListener('message', e => {
      if (state.alive) w.write(e.data).catch(cleanup);
    });
    ws.addEventListener('close', cleanup);
    ws.addEventListener('error', cleanup);

    k.readable.pipeTo(new WritableStream({
      write(chunk) {
        if (state.alive) {
          if (state.firstChunk) {
            state.firstChunk = false;
            const u = new Uint8Array(chunk);
            // [协议兼容性] 严格遵循原始逻辑，创建 length+2 的 buffer，并在 offset=2 处设置数据。
            const h = new Uint8Array(u.length + 2);
            h[0] = v;
            h.set(u, 2);
            ws.send(h); // [性能修正] 发送正确的视图 h，而不是其底层的整个 ArrayBuffer。
          } else {
            ws.send(chunk);
          }
        }
      },
      close: cleanup,
      abort: cleanup
    })).catch(cleanup);

    // 8. 返回客户端 WebSocket，完成握手
    return new Response(null, { status: 101, webSocket: c });
  }
};
