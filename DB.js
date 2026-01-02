// --- 全局配置 ---
const UUID = '';
const HOST = '';
const REGIONS = [
  'HK',
  '香港',
  'TW',
  '台湾',
  'JP',
  '日本',
  'SG',
  '新加坡',
  'KR',
  '韩国',
  'US',
  '美国'
];
const PAGE_SIZE = 30;
const BATCH_SIZE = 50;
const MAX_VLESS = 500;
const CACHE_TTL = 60; // 缓存 TTL（秒）
const STATS_CACHE_KEY = 'cache:stats';
const TASK_TTL = 300; // 任务状态 TTL（秒）

// --- 预编译正则 & 查找表 ---
const IP_FORMAT_REGEX = /^(\[[a-fA-F0-9:]+\]|[^:#\[\]]+)(?::(\d+))?(#.*)?$/;
const VLESS_EXTRACT_REGEX = /@([^?:]+:[^?]+)\??/;
const REGION_ORDER = new Map(REGIONS.map((r, i) => [r, i]));
const UNKNOWN_REGION_INDEX = REGIONS.length;

// 预编译地区匹配正则 - 使用单一正则提升性能
const REGION_PATTERNS = REGIONS.map(r => `(${r})`).join('|');
const COMBINED_REGION_REGEX = new RegExp(REGION_PATTERNS, 'i');

// --- 工具函数 ---
const json = (d, s = 200) => Response.json(d, { status: s });
const err = (m, s = 400) => Response.json({ error: m }, { status: s });

// 内存任务缓存（作为 KV 的回退）
const taskCache = new Map();

// --- 核心工具函数 ---
const parseIP = (ip) => {
    const match = ip.match(IP_FORMAT_REGEX);
    if (!match) return { displayIp: ip, port: 'N/A', name: '' };
    return {
        displayIp: match[1],
        port: match[2] || '443',
        name: (match[3] || '').slice(1),
    };
};

const extractRegion = (name) => {
    if (!name) return '';
    const match = name.match(COMBINED_REGION_REGEX);
    return match ? match[0].toUpperCase() : '';
};

const getRegionIndex = (region) => region ? (REGION_ORDER.get(region) ?? UNKNOWN_REGION_INDEX) : UNKNOWN_REGION_INDEX;

// --- 批量执行优化 ---
const execBatches = async (db, statements) => {
    const len = statements.length;
    if (len === 0) return;
    if (len <= BATCH_SIZE) {
        await db.batch(statements);
        return;
    }
    for (let i = 0; i < len; i += BATCH_SIZE) {
        await db.batch(statements.slice(i, Math.min(i + BATCH_SIZE, len)));
    }
};

// --- 任务状态管理（优化版）---
const saveTask = async (kv, id, status, msg = '') => {
    const data = { status, message: msg, timestamp: Date.now() };
    taskCache.set(id, data);
    setTimeout(() => taskCache.delete(id), TASK_TTL * 1000);
    if (kv) {
        await kv.put(`task:${id}`, JSON.stringify(data), { expirationTtl: TASK_TTL }).catch(() => {});
    }
};

const getTask = async (kv, id) => {
    const cached = taskCache.get(id);
    if (cached) return cached;
    if (kv) {
        try {
            const data = await kv.get(`task:${id}`, { type: 'json' });
            if (data) {
                taskCache.set(id, data);
                return data;
            }
        } catch {}
    }
    return null;
};

// --- 缓存管理 ---
const invalidateCache = async (kv) => {
    if (kv) {
        await kv.delete(STATS_CACHE_KEY).catch(() => {});
    }
};

const getCachedStats = async (kv) => {
    if (!kv) return null;
    try {
        return await kv.get(STATS_CACHE_KEY, { type: 'json' });
    } catch {
        return null;
    }
};

const setCachedStats = async (kv, stats) => {
    if (kv) {
        await kv.put(STATS_CACHE_KEY, JSON.stringify(stats), { expirationTtl: CACHE_TTL }).catch(() => {});
    }
};

// --- VLESS 生成优化 ---
const generateVless = (row, host) => {
    const { displayIp, port } = parseIP(row.ip);
    const effectiveHost = host || displayIp;
    const name = row.name || `${displayIp.replace(/[\.\[\]:]/g, '-')}-${port}`;
    return `vless://${UUID}@${displayIp}:${port}?encryption=none&security=tls&type=ws&host=${effectiveHost}&path=%2F%3Fed%3D2560&sni=${effectiveHost}#${encodeURIComponent(name)}`;
};

// --- 排序优化 ---
const sortByRegion = (items) => {
    return items.sort((a, b) => {
        const ai = getRegionIndex(a.region);
        const bi = getRegionIndex(b.region);
        if (ai !== bi) return ai - bi;
        if (a.priority !== b.priority) return a.priority - b.priority;
        const av6 = a.ip.startsWith('[') ? 0 : 1;
        const bv6 = b.ip.startsWith('[') ? 0 : 1;
        if (av6 !== bv6) return av6 - bv6;
        return a.id - b.id;
    });
};

// --- ID 重排序优化（使用负数临时ID避免冲突）---
const performIdReorder = async (db, sortedIds) => {
    if (sortedIds.length === 0) return;

    // 使用两阶段更新：先设为负数，再设为正序
    const tempStmts = sortedIds.map((id, i) =>
        db.prepare('UPDATE ips SET id = ? WHERE id = ?').bind(-(i + 1), id)
    );
    const finalStmts = sortedIds.map((_, i) =>
        db.prepare('UPDATE ips SET id = ? WHERE id = ?').bind(i + 1, -(i + 1))
    );

    await execBatches(db, tempStmts);
    await execBatches(db, finalStmts);
};

// --- API 实现 ---
const api = {
    // 获取 IP 列表（优化分页）
    async getIps(db, params) {
        const page = Math.max(1, parseInt(params.get('page')) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(params.get('limit')) || PAGE_SIZE));
        const offset = (page - 1) * limit;
        const needTotal = params.get('needTotal') === 'true';

        const queries = [
            db.prepare('SELECT id, ip, name, active, priority FROM ips ORDER BY id LIMIT ? OFFSET ?').bind(limit, offset)
        ];

        if (needTotal) {
            queries.push(db.prepare('SELECT COUNT(*) as total FROM ips'));
        }

        const results = await db.batch(queries);
        const ips = results[0].results.map(r => {
            const { displayIp, port } = parseIP(r.ip);
            return { ...r, displayIp, port, region: extractRegion(r.name) };
        });

        const pagination = { page, limit };
        if (needTotal) {
            const total = results[1].results[0].total;
            pagination.total = total;
            pagination.pages = Math.ceil(total / limit);
        }

        return json({ ips, pagination });
    },

    // 获取统计信息（带缓存）
    async getStats(db, kv) {
        const cached = await getCachedStats(kv);
        if (cached) return json(cached);

        const { total, active } = await db.prepare('SELECT COUNT(*) as total, SUM(active) as active FROM ips').first();
        const stats = { total, active: active || 0, inactive: total - (active || 0) };

        await setCachedStats(kv, stats);
        return json(stats);
    },

    // 获取任务状态
    async getTaskStatus(kv, taskId) {
        const task = await getTask(kv, taskId);
        return task ? json(task) : err('任务不存在或已过期', 404);
    },

    // 添加单个 IP
    async addIp(db, { ip, priority }, kv) {
        if (!ip) return err('IP不能为空');

        const { displayIp, port, name } = parseIP(ip);
        if (port === 'N/A') return err('IP格式错误');

        const finalIp = `${displayIp}:${port}`;

        // 使用单次查询获取最大优先级（如果未指定）
        let prio = priority;
        if (prio === undefined || prio === null) {
            const { n } = await db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 as n FROM ips').first();
            prio = n;
        }

        const { meta } = await db.prepare('INSERT OR IGNORE INTO ips(ip, name, active, priority) VALUES(?, ?, 1, ?)')
            .bind(finalIp, name || null, prio).run();

        if (meta.changes === 0) return err('IP已存在');

        await invalidateCache(kv);
        return json({ success: true });
    },

    // 批量导入
    async batchImport(db, { ips }, ctx, kv) {
        if (!Array.isArray(ips) || !ips.length) return err('列表为空');

        const taskId = crypto.randomUUID();

        ctx.waitUntil((async () => {
            try {
                await saveTask(kv, taskId, 'running', '准备导入');

                // 预处理所有 IP
                const parsed = ips.map(ip => {
                    const { displayIp, port, name } = parseIP(ip);
                    return port === 'N/A' ? null : { ip: `${displayIp}:${port}`, name: name || null };
                }).filter(Boolean);

                if (parsed.length === 0) {
                    await saveTask(kv, taskId, 'completed', '没有有效的IP地址');
                    return;
                }

                const { p } = await db.prepare('SELECT COALESCE(MAX(priority), 0) as p FROM ips').first();

                await saveTask(kv, taskId, 'running', `正在导入 ${parsed.length} 条数据...`);

                const stmt = db.prepare('INSERT OR IGNORE INTO ips(ip, name, active, priority) VALUES(?, ?, 1, ?)');
                const batch = parsed.map((item, i) => stmt.bind(item.ip, item.name, p + i + 1));

                await execBatches(db, batch);
                await invalidateCache(kv);
                await saveTask(kv, taskId, 'completed', `成功导入 ${parsed.length} 条数据`);
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
            }
        })());

        return json({ success: true, async: true, taskId, count: ips.length });
    },

    // 批量删除
    async batchDelete(db, { ips }, ctx, kv) {
        if (!Array.isArray(ips) || !ips.length) return err('列表为空');

        const taskId = crypto.randomUUID();

        ctx.waitUntil((async () => {
            try {
                await saveTask(kv, taskId, 'running', '准备删除');

                const deleteIps = ips.map(line => {
                    // 尝试从 VLESS 链接提取
                    const match = line.match(VLESS_EXTRACT_REGEX);
                    if (match) return match[1];
                    // 按普通格式解析
                    const { displayIp, port } = parseIP(line);
                    return port === 'N/A' ? null : `${displayIp}:${port}`;
                }).filter(Boolean);

                if (deleteIps.length === 0) {
                    await saveTask(kv, taskId, 'completed', '没有有效的IP地址');
                    return;
                }

                await saveTask(kv, taskId, 'running', `正在删除 ${deleteIps.length} 条数据...`);

                const batch = deleteIps.map(ip => db.prepare('DELETE FROM ips WHERE ip=?').bind(ip));
                await execBatches(db, batch);

                await invalidateCache(kv);
                await saveTask(kv, taskId, 'completed', `成功删除 ${deleteIps.length} 条匹配的数据`);
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
            }
        })());

        return json({ success: true, async: true, taskId, count: ips.length });
    },

    // 按地区排序
    async sortIps(db, ctx, kv) {
        const taskId = crypto.randomUUID();

        ctx.waitUntil((async () => {
            try {
                await saveTask(kv, taskId, 'running', '查询数据');
                const { results } = await db.prepare('SELECT id, ip, name, priority FROM ips').all();

                if (results.length === 0) {
                    await saveTask(kv, taskId, 'completed', '没有数据需要排序');
                    return;
                }

                await saveTask(kv, taskId, 'running', '排序中');
                const parsed = results.map(r => ({ ...r, region: extractRegion(r.name) }));
                const sorted = sortByRegion(parsed);

                await saveTask(kv, taskId, 'running', '更新数据库');
                await performIdReorder(db, sorted.map(s => s.id));

                await invalidateCache(kv);
                await saveTask(kv, taskId, 'completed', '排序完成');
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
            }
        })());

        return json({ success: true, async: true, taskId });
    },

    // 按优先级排序
    async sortByPriority(db, ctx, kv) {
        const taskId = crypto.randomUUID();

        ctx.waitUntil((async () => {
            try {
                await saveTask(kv, taskId, 'running', '查询数据');
                const { results } = await db.prepare('SELECT id, priority FROM ips').all();

                if (results.length === 0) {
                    await saveTask(kv, taskId, 'completed', '没有数据需要排序');
                    return;
                }

                await saveTask(kv, taskId, 'running', '排序中');
                results.sort((a, b) => a.priority - b.priority || a.id - b.id);

                await saveTask(kv, taskId, 'running', '更新数据库');
                await performIdReorder(db, results.map(r => r.id));

                await invalidateCache(kv);
                await saveTask(kv, taskId, 'completed', '按优先级排序完成');
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
            }
        })());

        return json({ success: true, async: true, taskId });
    },

    // 去除重复
    async removeDuplicates(db, ctx, kv) {
        const taskId = crypto.randomUUID();

        ctx.waitUntil((async () => {
            try {
                await saveTask(kv, taskId, 'running', '查找重复项');

                // 优化：直接在SQL中找出需要删除的ID
                const { results } = await db.prepare(`
                    SELECT GROUP_CONCAT(id) as ids
                    FROM ips
                    GROUP BY SUBSTR(ip, 1, INSTR(ip, ':') - 1)
                    HAVING COUNT(*) > 1
                `).all();

                if (results.length === 0) {
                    await saveTask(kv, taskId, 'completed', '没有发现重复数据');
                    return;
                }

                // 提取需要删除的ID（保留每组中ID最小的）
                const deleteIds = results.flatMap(r =>
                    r.ids.split(',').map(Number).sort((a, b) => a - b).slice(1)
                );

                if (deleteIds.length === 0) {
                    await saveTask(kv, taskId, 'completed', '重复数据清理完成');
                    return;
                }

                await saveTask(kv, taskId, 'running', `正在删除 ${deleteIds.length} 条重复数据...`);

                const batch = deleteIds.map(id => db.prepare('DELETE FROM ips WHERE id = ?').bind(id));
                await execBatches(db, batch);

                await invalidateCache(kv);
                await saveTask(kv, taskId, 'completed', `成功删除 ${deleteIds.length} 条重复数据`);
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
            }
        })());

        return json({ success: true, async: true, taskId });
    },

    // 重新排列优先级
    async reorderPriority(db, ctx, kv) {
        const taskId = crypto.randomUUID();

        ctx.waitUntil((async () => {
            try {
                await saveTask(kv, taskId, 'running', '查询数据');
                const { results } = await db.prepare('SELECT id, name FROM ips ORDER BY id').all();

                if (results.length === 0) {
                    await saveTask(kv, taskId, 'completed', '没有数据需要调整');
                    return;
                }

                await saveTask(kv, taskId, 'running', '计算优先级');
                const parsed = results.map(r => ({ ...r, region: extractRegion(r.name) }));

                // 按地区排序
                parsed.sort((a, b) => {
                    const ai = getRegionIndex(a.region);
                    const bi = getRegionIndex(b.region);
                    return ai - bi || a.id - b.id;
                });

                await saveTask(kv, taskId, 'running', '更新优先级');
                const batch = parsed.map((r, i) =>
                    db.prepare('UPDATE ips SET priority = ? WHERE id = ?').bind(i + 1, r.id)
                );
                await execBatches(db, batch);

                await invalidateCache(kv);
                await saveTask(kv, taskId, 'completed', '优先级调整完成');
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
            }
        })());

        return json({ success: true, async: true, taskId });
    },

    // 切换所有状态
    async toggleAll(db, { active }, ctx, kv) {
        const taskId = crypto.randomUUID();

        ctx.waitUntil((async () => {
            try {
                await saveTask(kv, taskId, 'running', '更新中');
                await db.prepare('UPDATE ips SET active = ?').bind(active ? 1 : 0).run();
                await invalidateCache(kv);
                await saveTask(kv, taskId, 'completed', '更新完成');
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
            }
        })());

        return json({ success: true, async: true, taskId });
    },

    // 清空所有
    async clearAll(db, ctx, kv) {
        const taskId = crypto.randomUUID();

        ctx.waitUntil((async () => {
            try {
                await saveTask(kv, taskId, 'running', '清空中');
                await db.prepare('DELETE FROM ips').run();
                await invalidateCache(kv);
                await saveTask(kv, taskId, 'completed', '清空完成');
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
            }
        })());

        return json({ success: true, async: true, taskId });
    },

    // 更新单个 IP
    async updateIp(db, id, body, kv) {
        const { active, ip, priority } = body;
        const updates = [];

        if (ip !== undefined) {
            const { displayIp, port, name } = parseIP(ip);
            if (port === 'N/A') return err('IP格式错误');
            updates.push(db.prepare('UPDATE ips SET ip=?, name=? WHERE id=?').bind(`${displayIp}:${port}`, name || null, id));
        }

        if (active !== undefined) {
            updates.push(db.prepare('UPDATE ips SET active=? WHERE id=?').bind(active ? 1 : 0, id));
        }

        if (priority !== undefined) {
            const row = await db.prepare('SELECT priority FROM ips WHERE id=?').bind(id).first();
            if (row) {
                updates.push(
                    db.prepare('UPDATE ips SET priority = ? WHERE priority = ? AND id != ?').bind(row.priority, priority, id),
                    db.prepare('UPDATE ips SET priority = ? WHERE id = ?').bind(priority, id)
                );
            }
        }

        if (updates.length > 0) {
            await db.batch(updates);
            await invalidateCache(kv);
        }

        return json({ success: true });
    },

    // 删除单个 IP
    async deleteIp(db, id, kv) {
        await db.prepare('DELETE FROM ips WHERE id=?').bind(id).run();
        await invalidateCache(kv);
        return json({ success: true });
    },

    // 初始化数据库
    async initDb(db) {
        await db.batch([
            db.prepare('CREATE TABLE IF NOT EXISTS ips(id INTEGER PRIMARY KEY, ip TEXT UNIQUE NOT NULL, name TEXT, active INTEGER DEFAULT 1, priority INTEGER DEFAULT 0)'),
            db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_ips_ip ON ips(ip)'),
            db.prepare('CREATE INDEX IF NOT EXISTS idx_ips_active ON ips(active)'),
            db.prepare('CREATE INDEX IF NOT EXISTS idx_ips_priority ON ips(priority)'),
        ]);
        return json({ success: true });
    },
};

// --- 路由分发 ---
const route = async (req, db, ctx, kv) => {
    const url = new URL(req.url);
    const path = url.pathname.slice(4); // 去掉 '/api'
    const method = req.method;

    try {
        // POST/PUT 请求解析 body
        const body = (method === 'POST' || method === 'PUT') ? await req.json().catch(() => ({})) : {};

        // 静态路由表
        if (path === '/ips') {
            if (method === 'GET') return api.getIps(db, url.searchParams);
            if (method === 'POST') return api.addIp(db, body, kv);
        }
        if (path === '/ips/stats' && method === 'GET') return api.getStats(db, kv);
        if (path === '/ips/batch' && method === 'POST') return api.batchImport(db, body, ctx, kv);
        if (path === '/ips/batch-delete' && method === 'POST') return api.batchDelete(db, body, ctx, kv);
        if (path === '/ips/sort' && method === 'POST') return api.sortIps(db, ctx, kv);
        if (path === '/ips/sort-priority' && method === 'POST') return api.sortByPriority(db, ctx, kv);
        if (path === '/ips/remove-duplicates' && method === 'POST') return api.removeDuplicates(db, ctx, kv);
        if (path === '/ips/reorder-priority' && method === 'POST') return api.reorderPriority(db, ctx, kv);
        if (path === '/ips/toggle-all' && method === 'POST') return api.toggleAll(db, body, ctx, kv);
        if (path === '/ips/clear' && method === 'DELETE') return api.clearAll(db, ctx, kv);
        if (path === '/init' && method === 'POST') return api.initDb(db);

        // 动态路由：任务状态
        if (path.startsWith('/task/') && method === 'GET') {
            return api.getTaskStatus(kv, path.slice(6));
        }

        // 动态路由：单个 IP 操作
        const idMatch = path.match(/^\/ips\/(\d+)$/);
        if (idMatch) {
            const id = idMatch[1];
            if (method === 'PUT') return api.updateIp(db, id, body, kv);
            if (method === 'DELETE') return api.deleteIp(db, id, kv);
        }

        return new Response('Not Found', { status: 404 });
    } catch (e) {
        console.error('API Error:', e);
        return err(e.message, 500);
    }
};

// --- HTML 模板（压缩CSS变量，优化结构）---
const getHTML = () => `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>节点管理</title>
<style>
:root{--bg:#0d1117;--bg2:#161b22;--bg3:#21262d;--fg:#e6edf3;--fg2:#b3bac4;--fg3:#8b949e;--border:#30363d;--blue:#58a6ff;--green:#3fb950;--red:#f85149;--purple:#a371f7;--orange:#db6d28;--radius:12px;--shadow:0 4px 24px rgba(1,4,9,.8)}
*{margin:0;padding:0;box-sizing:border-box}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh}
.container{max-width:1400px;margin:0 auto;padding:30px 24px}
.header{text-align:center;margin-bottom:48px}
h1{font-size:40px;font-weight:700;margin-bottom:12px;background:linear-gradient(135deg,var(--blue),var(--purple));-webkit-background-clip:text;background-clip:text;color:transparent}
.subtitle{font-size:17px;color:var(--fg2)}
.section{background:var(--bg2);border-radius:var(--radius);padding:32px;margin-bottom:28px;border:1px solid var(--border)}
.section h2{font-size:22px;font-weight:600;margin-bottom:24px;display:flex;align-items:center;gap:12px}
.section h2::before{content:'';width:4px;height:20px;background:var(--blue);border-radius:2px}
.form-group{margin-bottom:24px}
label{display:block;margin-bottom:10px;color:var(--fg2);font-size:14px;font-weight:500}
input,textarea,select{width:100%;padding:14px 16px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--fg);font:inherit}
input:focus,textarea:focus{outline:none;border-color:var(--blue);box-shadow:0 0 0 3px rgba(88,166,255,.1)}
button{background:var(--blue);color:#fff;border:none;padding:14px 28px;border-radius:var(--radius);cursor:pointer;font-size:15px;font-weight:500;transition:all .2s;display:inline-flex;align-items:center;gap:8px}
button:hover{filter:brightness(1.1);transform:translateY(-1px)}
button.danger{background:var(--red)}
button.secondary{background:var(--bg3);color:var(--fg2)}
button.success{background:var(--green)}
button.purple{background:var(--purple)}
button.orange{background:var(--orange)}
button.small{padding:10px 16px;font-size:14px;border-radius:8px}
.button-group,.batch-actions{display:flex;gap:12px;flex-wrap:wrap}
.batch-actions{margin-top:20px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
.stat{background:var(--bg3);padding:24px;border-radius:var(--radius);text-align:center;border:1px solid var(--border)}
.stat-number{font-size:32px;font-weight:700;color:var(--blue);margin-bottom:6px}
.stat-label{font-size:14px;color:var(--fg2)}
.ip-list{list-style:none;display:grid;gap:12px}
.ip-item{display:flex;align-items:center;justify-content:space-between;padding:20px;background:var(--bg3);border-radius:var(--radius);border:1px solid var(--border);transition:all .2s}
.ip-item:hover{background:#1c2128;transform:translateX(4px)}
.ip-info{flex:1;display:flex;align-items:center;gap:20px}
.ip-details{display:flex;flex-direction:column;gap:8px}
.ip-address{font-family:'SF Mono',monospace;font-weight:600;font-size:15px}
.ip-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.node-name{font-size:13px;color:var(--blue);background:rgba(88,166,255,.1);padding:4px 10px;border-radius:6px;border:1px solid rgba(88,166,255,.2)}
.region-tag{font-size:12px;color:var(--purple);background:rgba(163,113,247,.1);padding:4px 8px;border-radius:6px;border:1px solid rgba(163,113,247,.2)}
.priority-tag{font-size:12px;color:var(--orange);background:rgba(219,109,40,.1);padding:4px 8px;border-radius:6px;border:1px solid rgba(219,109,40,.2)}
.status{padding:6px 12px;border-radius:20px;font-size:12px;font-weight:600;text-transform:uppercase}
.status.active{background:rgba(63,185,80,.1);color:var(--green);border:1px solid rgba(63,185,80,.2)}
.status.inactive{background:rgba(248,81,73,.1);color:var(--red);border:1px solid rgba(248,81,73,.2)}
.ip-actions{display:flex;gap:10px}
.message{padding:16px 20px;border-radius:var(--radius);margin-bottom:20px;text-align:center;font-weight:500;animation:slideIn .3s ease;border:1px solid}
@keyframes slideIn{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
.message.success{background:rgba(63,185,80,.1);color:var(--green);border-color:rgba(63,185,80,.2)}
.message.error{background:rgba(248,81,73,.1);color:var(--red);border-color:rgba(248,81,73,.2)}
.form-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.actions{display:flex;gap:12px;margin-bottom:24px;flex-wrap:wrap}
textarea{min-height:140px;font-family:'SF Mono',monospace;font-size:14px;resize:vertical}
.loading,.empty{text-align:center;padding:60px 20px;color:var(--fg2)}
.loading{display:flex;flex-direction:column;align-items:center;gap:16px}
.modal{position:fixed;inset:0;background:rgba(13,17,23,.8);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:1000;padding:20px}
.modal-content{background:var(--bg2);border-radius:var(--radius);padding:32px;max-width:520px;width:100%;border:1px solid var(--border);box-shadow:var(--shadow)}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.modal-title{font-size:20px;font-weight:600}
.close-btn{background:none;border:none;color:var(--fg2);font-size:24px;cursor:pointer;padding:6px;border-radius:6px;width:32px;height:32px;display:flex;align-items:center;justify-content:center}
.close-btn:hover{color:var(--fg);background:var(--bg3)}
.modal-buttons{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}
.spinner{border:2px solid rgba(88,166,255,.2);border-left-color:var(--blue);border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.pagination{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:24px;padding:16px}
.page-info{font-size:14px;color:var(--fg2);min-width:100px;text-align:center}
@media(max-width:768px){.container{padding:20px 16px}h1{font-size:32px}.section{padding:24px}.stats{grid-template-columns:1fr}.ip-item{flex-direction:column;gap:16px;align-items:flex-start}.ip-info,.ip-actions{width:100%}.ip-actions{justify-content:flex-end}.form-row{grid-template-columns:1fr}.button-group,.batch-actions{flex-direction:column}button{width:100%;justify-content:center}}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--bg2)}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body>
<div class="container">
<div class="header"><h1>节点管理中心</h1><div class="subtitle">简洁高效的代理节点管理平台</div></div>
<div class="section"><h2>统计概览</h2><div class="stats"><div class="stat"><div class="stat-number" id="total">-</div><div class="stat-label">总节点数</div></div><div class="stat"><div class="stat-number" id="active">-</div><div class="stat-label">活跃节点</div></div><div class="stat"><div class="stat-number" id="inactive">-</div><div class="stat-label">禁用节点</div></div></div></div>
<div class="section"><h2>添加节点</h2><div class="form-group"><label>IP地址</label><input id="newIp" placeholder="IPv4: 192.168.1.1 | IPv6: [2001:db8::1] | 域名: example.com"></div><div class="form-row"><div class="form-group"><label>端口号</label><input id="newPort" placeholder="443" value="443"></div><div class="form-group"><label>节点名称</label><input id="newName" placeholder="香港节点01-HK"></div><div class="form-group"><label>优先级</label><input id="newPriority" type="number" placeholder="自动分配" min="0"></div></div><button onclick="addIp()">添加节点</button></div>
<div class="section"><h2>批量操作</h2><div class="form-group"><label>节点列表（每行一个，支持 IP:端口#名称 格式）</label><textarea id="batchIps" placeholder="192.168.1.1:443#香港-HK&#10;[2001:db8::1]:443#日本-JP&#10;example.com:443#美国-US"></textarea></div><div class="batch-actions"><button onclick="batchImport()">批量导入</button><button class="danger" onclick="batchDelete()">批量删除</button></div></div>
<div class="section"><h2>配置生成</h2><button class="purple" onclick="location.href='/Vless'">生成 Vless 链接</button></div>
<div class="section"><h2>节点列表</h2><div id="message"></div><div class="actions"><button onclick="loadIps()">刷新</button><button class="purple" onclick="sortByRegion()">按地区排序</button><button class="purple" onclick="reorderPriority()">调整优先级</button><button class="purple" onclick="sortByPriority()">按优先级排序</button><button class="orange" onclick="removeDuplicates()">一键去重</button><button class="success" onclick="toggleAll(1)">全部启用</button><button class="secondary" onclick="toggleAll(0)">全部禁用</button><button class="danger" onclick="clearAll()">清空所有</button></div><div id="ipContainer"><div class="loading"><div class="spinner"></div><div>正在加载...</div></div></div><div id="pagination" class="pagination"><button id="prevBtn" class="secondary" onclick="loadIps(page-1,1)">上一页</button><span id="pageInfo" class="page-info">第 1 页</span><button id="nextBtn" class="secondary" onclick="loadIps(page+1,1)">下一页</button></div></div>
</div>
<div id="editModal" class="modal"><div class="modal-content"><div class="modal-header"><div class="modal-title">编辑节点</div><button class="close-btn" onclick="closeModal()">&times;</button></div><form onsubmit="saveEdit(event)"><div class="form-group"><label>IP地址</label><input id="editIp" required></div><div class="form-row"><div class="form-group"><label>端口号</label><input id="editPort" required></div><div class="form-group"><label>节点名称</label><input id="editName"></div><div class="form-group"><label>优先级</label><input id="editPriority" type="number" required min="0"></div></div><div class="modal-buttons"><button type="submit">保存</button><button type="button" class="secondary" onclick="closeModal()">取消</button></div></form></div></div>
<script>
const API='/api',PS=${PAGE_SIZE};
let editId=null,page=1,pages=1,scroll=0,poll=null;

const $=id=>document.getElementById(id);
const msg=(t,c='success')=>{$('message').innerHTML='<div class="message '+c+'">'+t+'</div>';setTimeout(()=>$('message').innerHTML='',5e3)};

const api=async(e,o={})=>{const r=await fetch(API+e,{headers:{'Content-Type':'application/json'},...o});const d=await r.json();if(!r.ok)throw new Error(d.error);return d};

const pollTask=(id,cb)=>{if(poll)clearInterval(poll);poll=setInterval(async()=>{try{const{status,message}=await api('/task/'+id);if(status==='completed'){clearInterval(poll);msg(message);cb&&cb()}else if(status==='failed'){clearInterval(poll);msg(message,'error')}}catch{clearInterval(poll)}},1e3)};

const loadStats=async()=>{try{const{total,active,inactive}=await api('/ips/stats');$('total').textContent=total;$('active').textContent=active;$('inactive').textContent=inactive}catch{}};

const loadIps=async(p=1,k=0)=>{if(k)scroll=window.scrollY;p=Math.max(1,p);const c=$('ipContainer');c.innerHTML='<div class="loading"><div class="spinner"></div><div>加载中...</div></div>';try{const{ips,pagination}=await api('/ips?page='+p+'&limit='+PS+'&needTotal=true');page=pagination.page;pages=pagination.pages||1;$('pageInfo').textContent='第 '+page+' 页 / 共 '+pages+' 页';$('prevBtn').disabled=page===1;$('nextBtn').disabled=page===pages;c.innerHTML=ips.length?'<ul class="ip-list">'+ips.map(ip=>'<li class="ip-item"><div class="ip-info"><div class="ip-details"><div class="ip-address">'+ip.displayIp+':'+ip.port+'</div><div class="ip-meta">'+(ip.name?'<span class="node-name">'+ip.name+'</span>':'')+(ip.region?'<span class="region-tag">'+ip.region+'</span>':'')+'<span class="priority-tag">优先级: '+ip.priority+'</span></div></div><span class="status '+(ip.active?'active':'inactive')+'">'+(ip.active?'启用中':'已禁用')+'</span></div><div class="ip-actions"><button class="small" onclick="editIp('+ip.id+',\\''+ip.displayIp+'\\',\\''+ip.port+'\\',\\''+(ip.name||'')+'\\','+ip.priority+')">编辑</button><button class="small" onclick="toggleIp('+ip.id+','+ip.active+')">'+(ip.active?'禁用':'启用')+'</button><button class="small danger" onclick="deleteIp('+ip.id+')">删除</button></div></li>').join('')+'</ul>':'<div class="empty">暂无数据</div>';loadStats();if(k)setTimeout(()=>window.scrollTo(0,scroll),50)}catch{c.innerHTML='<div class="empty">加载失败</div>'}};

const sortByRegion=async()=>{try{const{taskId}=await api('/ips/sort',{method:'POST'});msg('排序任务启动...');pollTask(taskId,()=>loadIps(page,1))}catch{}};
const sortByPriority=async()=>{try{const{taskId}=await api('/ips/sort-priority',{method:'POST'});msg('排序任务启动...');pollTask(taskId,()=>loadIps(page,1))}catch{}};
const removeDuplicates=async()=>{if(!confirm('确定要去重吗？'))return;try{const{taskId}=await api('/ips/remove-duplicates',{method:'POST'});msg('去重任务启动...');pollTask(taskId,()=>loadIps(page,1))}catch{}};
const reorderPriority=async()=>{try{const{taskId}=await api('/ips/reorder-priority',{method:'POST'});msg('优先级调整启动...');pollTask(taskId,()=>loadIps(page,1))}catch{}};

const addIp=async()=>{const ip=$('newIp').value.trim(),port=$('newPort').value.trim(),name=$('newName').value.trim(),priority=$('newPriority').value.trim();if(!ip)return msg('请输入IP','error');let full=ip;if(port){if(ip.startsWith('[')&&ip.includes(']')){const e=ip.indexOf(']');full=ip.slice(0,e+1)+':'+port}else if(!ip.includes(':'))full+=':'+port}if(name)full+='#'+name;try{await api('/ips',{method:'POST',body:JSON.stringify({ip:full,priority:priority?+priority:undefined})});msg('添加成功');['newIp','newName','newPriority'].forEach(id=>$(id).value='');$('newPort').value='443';loadIps(page,1)}catch{}};

const batchImport=async()=>{const lines=$('batchIps').value.split('\\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));if(!lines.length)return msg('请输入节点','error');try{const{count,taskId}=await api('/ips/batch',{method:'POST',body:JSON.stringify({ips:lines})});msg('导入启动('+count+'条)...');pollTask(taskId,()=>{$('batchIps').value='';loadIps(page,1)})}catch{}};

const batchDelete=async()=>{const lines=$('batchIps').value.split('\\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));if(!lines.length)return msg('请输入节点','error');if(!confirm('确定删除？'))return;try{const{count,taskId}=await api('/ips/batch-delete',{method:'POST',body:JSON.stringify({ips:lines})});msg('删除启动('+count+'条)...');pollTask(taskId,()=>{$('batchIps').value='';loadIps(page,1)})}catch{}};

const editIp=(id,ip,port,name,priority)=>{editId=id;$('editIp').value=ip;$('editPort').value=port;$('editName').value=name;$('editPriority').value=priority;$('editModal').style.display='flex'};
const closeModal=()=>{$('editModal').style.display='none';editId=null};

const saveEdit=async e=>{e.preventDefault();const ip=$('editIp').value.trim(),port=$('editPort').value.trim(),name=$('editName').value.trim(),priority=$('editPriority').value.trim();if(!ip||!port)return msg('IP和端口必填','error');let full=ip.startsWith('[')?ip:ip;if(!full.includes(':'))full+=':'+port;if(name)full+='#'+name;try{await api('/ips/'+editId,{method:'PUT',body:JSON.stringify({ip:full,priority:+priority||0})});msg('更新成功');closeModal();loadIps(page,1)}catch{}};

const toggleIp=async(id,active)=>{try{await api('/ips/'+id,{method:'PUT',body:JSON.stringify({active:active?0:1})});msg(active?'已禁用':'已启用');loadIps(page,1)}catch{}};
const deleteIp=async id=>{if(!confirm('确定删除？'))return;try{await api('/ips/'+id,{method:'DELETE'});msg('删除成功');loadIps(page,1)}catch{}};

const toggleAll=async active=>{if(!confirm(active?'启用全部？':'禁用全部？'))return;try{const{taskId}=await api('/ips/toggle-all',{method:'POST',body:JSON.stringify({active})});msg('操作启动...');pollTask(taskId,()=>loadIps(page,1))}catch{}};

const clearAll=async()=>{if(!confirm('清空所有？')||!confirm('⚠️ 不可恢复！'))return;try{const{taskId}=await api('/ips/clear',{method:'DELETE'});msg('清空启动...');pollTask(taskId,()=>loadIps(1))}catch{}};

$('editModal').onclick=e=>{if(e.target===e.currentTarget)closeModal()};
loadIps();
</script>
</body>
</html>`;

// --- 主入口 ---
export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);
        const path = url.pathname;

        // 首页
        if (path === '/') {
            return new Response(getHTML(), {
                headers: { 'Content-Type': 'text/html;charset=utf-8' }
            });
        }

        // VLESS 订阅（带缓存）
        if (path === '/Vless') {
            const host = url.searchParams.get('host') || HOST;
            const cache = caches.default;
            const cacheKey = new Request(req.url, req);

            // 尝试从缓存读取
            let res = await cache.match(cacheKey);
            if (res) return res;

            // 查询数据库
            const { results } = await env.DB.prepare(
                'SELECT ip, name FROM ips WHERE active=1 ORDER BY priority, id LIMIT ?'
            ).bind(MAX_VLESS).all();

            // 批量生成 VLESS 链接
            const links = results.map(row => generateVless(row, host)).join('\n');

            res = new Response(links || '暂无节点', {
                headers: {
                    'Content-Type': 'text/plain;charset=utf-8',
                    'Cache-Control': `public, max-age=${CACHE_TTL}`
                }
            });

            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return res;
        }

        // API 路由
        if (path.startsWith('/api/')) {
            return route(req, env.DB, ctx, env.TASK_KV);
        }

        return new Response('Not Found', { status: 404 });
    },
};
