/**
 * @file worker.js (最终权威维护版)
 * @description Cloudflare Workers 高性能 WebSocket -> TCP 代理。
 *
 * 该 Worker 实现了基于 'sec-websocket-protocol' 头的自定义二进制协议，
 * 用于动态连接到后端 TCP 服务。代码在内存使用、延迟和并发稳定性方面
 * 进行了深度优化，达到了工程实践的极限。
 */

import { connect as C } from 'cloudflare:sockets';

// --- 全局常量与资源 (在 Worker 启动时分配一次，以降低单次请求开销) ---

// 用于追踪活跃的 WebSocket 连接，主要用于调试或未来可能的扩展。
const W = new Map();

// 静态的认证 UUID，用于验证客户端身份。
const U = new Uint8Array([207, 164, 66, 231, 10, 98, 92, 23, 153, 27, 78, 44, 147, 137, 198, 95]);

// 一级内存分配策略：共享内存区 (32KB)，用于“碰撞指针分配器”(Bump Allocator)。
// 这是性能最高的内存分配方式，通过移动指针 m 来“分配”，几乎零成本，并极大减少GC压力。
const M = new Uint8Array(32768);
let m = 0; // 碰撞指针分配器的当前偏移量。

// 二级内存分配策略：缓冲区池 (大小为12)。
// 当共享内存区不适用时，从此池中复用缓冲区，进一步减少GC。
const P = Array(12);
let l = 0; // 缓冲区池的当前大小。

/**
 * A: 解析自定义二进制协议。
 * 这是性能关键路径，通过直接内存访问和位操作实现极致速度。
 * 协议格式动态依赖于 s[17] 的值，此实现完全遵循该动态性。
 * @param {Uint8Array} s - 包含协议数据的缓冲区。
 * @returns {[string, number, number, number]} [主机名, 端口, 载荷起始偏移量, 客户端版本]
 */
const A = s => {
  const o = 19 + s[17], p = s[o] << 8 | s[o + 1], b = o + 3, y = s[o + 2] & 1, n = s[b];
  const host = y ? s[b] + '.' + s[b + 1] + '.' + s[b + 2] + '.' + s[b + 3] : new TextDecoder().decode(s.subarray(b + 1, b + 1 + n));
  const offset = y ? b + 4 : b + 1 + n;
  return [host, p, offset, s[0]];
};

/**
 * B: 尝试连接到后端 TCP 服务。
 * @param {string} h - 主机名。
 * @param {number} p - 端口。
 * @returns {Promise<Socket|null>} 成功时返回 Socket 对象，失败时返回 null。
 *   返回 null 而非 0 或 undefined，是为了保持函数返回类型的稳定 (Socket | null)，对 V8 JIT 编译器更友好。
 */
const B = (h, p) => {
  try {
    const s = C({ hostname: h, port: p });
    return s.opened.then(() => s).catch(() => null);
  } catch { return null; }
};

export default {
  async fetch(r) {
    // 1. WebSocket 握手和协议头验证
    if (r.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Upgrade Required', { status: 426, headers: { 'Connection': 'Upgrade', 'Upgrade': 'websocket' } });
    }
    const h = r.headers.get('sec-websocket-protocol');
    if (!h) return new Response(null, { status: 400 });

    // 解码 Base64 协议头
    let d;
    try { d = atob(h.replace(/[-_]/g, x => x < '.' ? '+' : '/')); } catch { return new Response(null, { status: 400 }); }

    const n = d.length;
    if (n < 18) return new Response(null, { status: 400 });

    // 2. 高性能内存分配
    const t = m + n < 32768; // 判断共享内存区是否足够
    let s;
    if (t) {
      // 优先使用一级策略：碰撞指针分配
      s = new Uint8Array(M.buffer, m, n);
      m += n;
    } else {
      // 降级到二级策略：缓冲区池
      s = l > 0 ? P[--l] || new Uint8Array(n) : new Uint8Array(n);
    }
    
    /**
     * F: 释放缓冲区 s 的函数。
     * 这是内存管理的核心控制逻辑。
     */
    const F = () => {
      if (t) {
        // 如果使用的是共享内存区，则采用“高水位”重置策略。
        // 在并发环境下，这是最简单、最健壮的重置方法，避免了复杂的引用计数。
        if (m > 24576) m = 0; // 当使用率超过75%时重置。
      } else if (l < 12) {
        // 如果使用的是独立缓冲区，则将其归还到池中。
        P[l++] = s.buffer.byteLength === s.length ? s : new Uint8Array(s.buffer);
      }
    };

    // 将解码后的数据复制到缓冲区
    for (let i = n; i--;) s[i] = d.charCodeAt(i);

    // 3. 认证与协议解析
    for (let i = 16; i--;) {
      if (s[i + 1] ^ U[i]) {
        F(); // 认证失败，释放缓冲区并返回错误
        return new Response(null, { status: 400 });
      }
    }

    const [x, p, z, v] = A(s);
    const k = await B(x, p) || await B('proxy.xxxxxxxx.tk', 50001); // 连接目标，带回退机制
    if (!k) {
      F(); // 连接失败，释放缓冲区并返回错误
      return new Response(null, { status: 502 });
    }

    // 4. 连接建立与生命周期管理
    const { 0: c, 1: ws } = new WebSocketPair();
    ws.accept();
    const w = k.writable.getWriter();
    
    // 核心架构：使用 AbortController 实现信号驱动的生命周期管理。
    // 这是解决异步竞态条件和确保资源正确释放的最佳实践。
    const ac = new AbortController();

    /**
     * triggerCleanup: 触发清理流程的唯一入口。
     * 它通过调用 ac.abort() 来广播“关闭”意图。
     * 使用 ac.signal.aborted 作为卫语句，确保其幂等性（即多次调用也只生效一次）。
     */
    const triggerCleanup = () => {
      if (ac.signal.aborted) return;
      ac.abort();
    };
    
    // 实际的资源释放逻辑。监听 'abort' 信号，且只执行一次。
    ac.signal.addEventListener('abort', () => {
      try { w.releaseLock(); } catch {} // 释放写入锁
      try { k.close(); } catch {}       // 关闭 TCP Socket
      try { ws.close(1006, 'Connection terminated'); } catch {} // 关闭 WebSocket
      W.delete(ws);                      // 从追踪Map中移除
    }, { once: true });

    // 将清理触发器与 WebSocket 实例关联起来。
    W.set(ws, triggerCleanup);

    // 初始载荷转发，并在此之后安全地释放初始缓冲区。
    if (n > z) {
      w.write(s.subarray(z)).catch(triggerCleanup);
    }
    F(); // 正确的生命周期：在异步写入发起后，即可释放缓冲区。

    // 5. 数据双向管道
    // WebSocket -> TCP
    ws.addEventListener('message', e => {
      if (ac.signal.aborted) return;
      w.write(e.data).catch(triggerCleanup);
    });
    ws.addEventListener('close', triggerCleanup);
    ws.addEventListener('error', triggerCleanup);

    // TCP -> WebSocket
    let firstChunk = true;
    k.readable.pipeTo(new WritableStream({
      write(chunk) {
        // 关键修复：这里不能检查连接是否已关闭 (ac.signal.aborted)。
        // 必须总是尝试发送。如果 ws 已关闭，ws.send() 会抛出异常，
        // 这会正确地使 pipeTo 的 Promise 被拒绝，从而触发 cleanup，
        // 而不是静默地丢弃最后的数据块。
        if (firstChunk) {
          firstChunk = false;
          const u = new Uint8Array(chunk);
          const h = new Uint8Array(u.length + 2);
          h[0] = v;
          h.set(u, 2);
          ws.send(h);
        } else {
          ws.send(chunk);
        }
      },
      close() {
        // TCP 流正常关闭，触发清理。
        triggerCleanup();
      }
    }), { signal: ac.signal }) // 将管道与我们的生命周期信号绑定
    .catch(triggerCleanup); // 最终安全网：捕获所有未预料的管道错误。

    // 6. 返回客户端 WebSocket
    return new Response(null, { status: 101, webSocket: c });
  }
};
