// --- 全局配置 ---
const UUID = '';
const HOST = ''; // 默认的 VLESS host
const REGIONS = ['HK', 'TW', 'JP', 'SG', 'KR', 'US']; // 地区排序优先级
const PAGE_SIZE = 30; // 分页大小
const BATCH_SIZE = 50; // D1 数据库批量操作大小
const MAX_VLESS = 500; // VLESS 订阅链接的最大节点数

// --- 性能优化：预编译正则表达式 & 查找表 ---
const IP_FORMAT_REGEX = /^(\[[a-fA-F0-9:]+\]|[^:#\[\]]+)(?::(\d+))?(#.*)?$/;
const VLESS_EXTRACT_REGEX = /@([^?:]+:[^?]+)\??/;
const PRECOMPILED_REGION_REGEX = new Map(REGIONS.map(r => [r, new RegExp(r, 'i')]));

// --- 工具函数 ---
const json = (d, s = 200) => Response.json(d, { status: s });
const err = (m, s = 400) => Response.json({ error: m }, { status: s });

const tasks = {}; // 内存中的任务状态回退机制

const execBatches = async (db, statements) => {
    for (let i = 0; i < statements.length; i += BATCH_SIZE) {
        await db.batch(statements.slice(i, i + BATCH_SIZE));
    }
};

// --- 经过优化的 IP 和地区解析函数 ---
const parseIP = (ip) => {
    const match = ip.match(IP_FORMAT_REGEX);
    if (!match) return { displayIp: ip, port: 'N/A', name: '' };
    
    const [, ipPart, portPart, namePart] = match;
    return {
        displayIp: ipPart,
        port: portPart || '443',
        name: (namePart || '').substring(1),
    };
};

const extractRegion = (name) => {
    if (!name) return '';
    for (const [region, regex] of PRECOMPILED_REGION_REGEX.entries()) {
        if (regex.test(name)) return region;
    }
    return '';
};

// --- 经过优化的排序函数 ---
const sortByRegion = (ips) => {
    const REGION_ORDER = new Map(REGIONS.map((r, i) => [r, i]));
    const UNKNOWN_REGION_INDEX = REGIONS.length;

    const sortableIps = ips.map(ip => ({
        ...ip,
        _regionIndex: ip.region ? (REGION_ORDER.get(ip.region) ?? UNKNOWN_REGION_INDEX) : UNKNOWN_REGION_INDEX,
        _isV6: ip.ip.startsWith('[') ? 0 : 1,
    }));

    return sortableIps.sort((a, b) => 
        a._regionIndex - b._regionIndex ||
        a.priority - b.priority ||
        a._isV6 - b._isV6 ||
        a.id - b.id
    );
};

// --- 其他工具函数 ---
const generateVless = (dbIpRow, host) => {
    const { displayIp, port } = parseIP(dbIpRow.ip);
    const name = dbIpRow.name;
    const encodedName = name ? encodeURIComponent(name) : encodeURIComponent(`${displayIp.replace(/[\.\[\]:]/g, '-')}-${port}`);
    const effectiveHost = host || displayIp;
    return `vless://${UUID}@${displayIp}:${port}?encryption=none&security=tls&type=ws&host=${effectiveHost}&path=%2F%3Fed%3D2560&sni=${effectiveHost}#${encodedName}`;
};

const saveTask = async (kv, id, status, msg = '') => {
    const data = { status, message: msg, timestamp: Date.now() };
    tasks[id] = data;
    setTimeout(() => delete tasks[id], 300000);
    if (kv) {
        await kv.put(`task:${id}`, JSON.stringify(data), { expirationTtl: 300 }).catch(console.error);
    }
};

const getTask = async (kv, id) => {
    if (tasks[id]) return tasks[id];
    if (kv) {
        try {
            const data = await kv.get(`task:${id}`);
            return data ? JSON.parse(data) : null;
        } catch { /* 忽略读取错误 */ }
    }
    return null;
};

// --- API 实现 (最终修正优化版) ---
const api = {
    async getIps(db, params) {
        const page = parseInt(params.get('page') || '1');
        const limit = parseInt(params.get('limit') || PAGE_SIZE);
        const offset = (page - 1) * limit;

        const baseQuery = db.prepare('SELECT id, ip, name, active, priority FROM ips ORDER BY id LIMIT ? OFFSET ?').bind(limit, offset);
        
        if (params.get('needTotal') !== 'true') {
            const { results } = await baseQuery.all();
            const ips = results.map(r => {
                const { displayIp, port } = parseIP(r.ip);
                return { ...r, displayIp, port, region: extractRegion(r.name) };
            });
            return json({ ips, pagination: { page, limit } });
        }

        const countQuery = db.prepare('SELECT COUNT(*) as total FROM ips');
        const [data, totalResult] = await db.batch([baseQuery, countQuery]);
        
        const ips = data.results.map(r => {
            const { displayIp, port } = parseIP(r.ip);
            return { ...r, displayIp, port, region: extractRegion(r.name) };
        });
        const total = totalResult.results[0].total;

        return json({
            ips,
            pagination: { page, limit, total, pages: Math.ceil(total / limit) },
        });
    },

    async getStats(db) {
        const { total, active } = await db.prepare('SELECT COUNT(*) as total, SUM(active) as active FROM ips').first();
        return json({ total, active: active || 0, inactive: total - (active || 0) });
    },

    async getTaskStatus(kv, taskId) {
        const task = await getTask(kv, taskId);
        if (!task) return err('任务不存在或已过期', 404);
        return json(task);
    },

    async addIp(db, { ip, priority }) {
        if (!ip) return err('IP不能为空');
        const { displayIp, port, name } = parseIP(ip);
        if (port === 'N/A') return err('IP格式错误');
        
        let prio = priority;
        if (prio === undefined || prio === null) {
            const result = await db.prepare('SELECT COALESCE(MAX(priority), 0) + 1 as n FROM ips').first();
            prio = result.n;
        }
        
        const { meta } = await db.prepare('INSERT OR IGNORE INTO ips(ip, name, active, priority) VALUES(?, ?, 1, ?)')
            .bind(`${displayIp}:${port}`, name || null, prio).run();

        if (meta.changes === 0) return err('IP已存在');
        return json({ success: true });
    },

    async batchImport(db, { ips }, ctx, kv) {
        if (!Array.isArray(ips) || !ips.length) return err('列表为空');
        const taskId = crypto.randomUUID();
        const importTask = async () => {
            try {
                await saveTask(kv, taskId, 'running', '准备导入');
                const { p } = await db.prepare('SELECT COALESCE(MAX(priority), 0) as p FROM ips').first();
                const stmt = db.prepare('INSERT OR IGNORE INTO ips(ip, name, active, priority) VALUES(?, ?, 1, ?)');
                const batch = ips.map((ip, i) => {
                    const { displayIp, port, name } = parseIP(ip);
                    if (port === 'N/A') return null;
                    return stmt.bind(`${displayIp}:${port}`, name || null, p + i + 1);
                }).filter(Boolean);

                if (batch.length) {
                    await saveTask(kv, taskId, 'running', `正在导入 ${batch.length} 条数据...`);
                    await execBatches(db, batch);
                }
                await saveTask(kv, taskId, 'completed', `成功导入 ${batch.length} 条数据`);
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
                console.error('Import Error:', e);
            }
        };
        ctx.waitUntil(importTask());
        return json({ success: true, async: true, taskId, count: ips.length });
    },

    async batchDelete(db, { ips }, ctx, kv) {
        if (!Array.isArray(ips) || !ips.length) return err('列表为空');
        const taskId = crypto.randomUUID();
        const deleteTask = async () => {
            try {
                await saveTask(kv, taskId, 'running', '准备删除');
                const deleteIps = ips.map(line => {
                    const match = line.match(VLESS_EXTRACT_REGEX);
                    if (match) return match[1];
                    const { displayIp, port } = parseIP(line);
                    return port === 'N/A' ? null : `${displayIp}:${port}`;
                }).filter(Boolean);

                if (deleteIps.length) {
                    await execBatches(db, deleteIps.map(ip => db.prepare('DELETE FROM ips WHERE ip=?').bind(ip)));
                }
                await saveTask(kv, taskId, 'completed', `成功删除 ${deleteIps.length} 条匹配的数据`);
            } catch (e) {
                await saveTask(kv, taskId, 'failed', e.message);
                console.error('Delete Error:', e);
            }
        };
        ctx.waitUntil(deleteTask());
        return json({ success: true, async: true, taskId, count: ips.length });
    },

    async _performSort(db, sortedIds) {
        if (sortedIds.length === 0) return;
        const tempUpdates = sortedIds.map((id, index) => db.prepare('UPDATE ips SET id = ? WHERE id = ?').bind(-(index + 1), id));
        const finalUpdates = sortedIds.map((id, index) => db.prepare('UPDATE ips SET id = ? WHERE id = ?').bind(index + 1, -(index + 1)));
        
        await execBatches(db, tempUpdates);
        await execBatches(db, finalUpdates);
    },

    async sortIps(db, ctx, kv) {
        const taskId = crypto.randomUUID();
        ctx.waitUntil(
            (async () => {
                try {
                    await saveTask(kv, taskId, 'running', '查询数据');
                    const { results } = await db.prepare('SELECT id, ip, name, priority FROM ips').all();
                    await saveTask(kv, taskId, 'running', '排序中');
                    const parsed = results.map(r => ({ ...r, region: extractRegion(r.name) }));
                    const sorted = sortByRegion(parsed);
                    await saveTask(kv, taskId, 'running', '更新数据库');
                    await api._performSort(db, sorted.map(s => s.id));
                    await saveTask(kv, taskId, 'completed', '排序完成');
                } catch (e) {
                    await saveTask(kv, taskId, 'failed', e.message);
                    console.error('Sort Error:', e);
                }
            })()
        );
        return json({ success: true, async: true, taskId });
    },
    
    async sortByPriority(db, ctx, kv) {
        const taskId = crypto.randomUUID();
        ctx.waitUntil(
            (async () => {
                try {
                    await saveTask(kv, taskId, 'running', '查询数据');
                    const { results } = await db.prepare('SELECT id, priority FROM ips').all();
                    await saveTask(kv, taskId, 'running', '排序中');
                    results.sort((a,b) => a.priority - b.priority || a.id - b.id);
                    await saveTask(kv, taskId, 'running', '更新数据库');
                    await api._performSort(db, results.map(r => r.id));
                    await saveTask(kv, taskId, 'completed', '按优先级排序完成');
                } catch (e) {
                    await saveTask(kv, taskId, 'failed', e.message);
                    console.error('Sort by Priority Error:', e);
                }
            })()
        );
        return json({ success: true, async: true, taskId });
    },
    
    async removeDuplicates(db, ctx, kv) {
        const taskId = crypto.randomUUID();
        ctx.waitUntil(
            (async () => {
                try {
                    await saveTask(kv, taskId, 'running', '查找重复项');
                    const { results } = await db.prepare("SELECT GROUP_CONCAT(id, ',') as ids FROM ips GROUP BY SUBSTR(ip, 1, INSTR(ip, ':') - 1) HAVING COUNT(id) > 1").all();
                    
                    if (results.length === 0) {
                        await saveTask(kv, taskId, 'completed', '没有发现重复数据');
                        return;
                    }
                    
                    const deleteIds = results.flatMap(r => 
                        r.ids.split(',').map(Number).sort((a,b) => a-b).slice(1)
                    );

                    if (deleteIds.length > 0) {
                        await saveTask(kv, taskId, 'running', `正在删除 ${deleteIds.length} 条重复数据...`);
                        const batch = deleteIds.map(id => db.prepare('DELETE FROM ips WHERE id = ?').bind(id));
                        await execBatches(db, batch);
                        await saveTask(kv, taskId, 'completed', `成功删除 ${deleteIds.length} 条重复数据`);
                    } else {
                        await saveTask(kv, taskId, 'completed', '重复数据清理完成');
                    }
                } catch (e) {
                    await saveTask(kv, taskId, 'failed', e.message);
                    console.error('Remove Duplicates Error:', e);
                }
            })()
        );
        return json({ success: true, async: true, taskId });
    },
    
    async reorderPriority(db, ctx, kv) {
        const taskId = crypto.randomUUID();
        ctx.waitUntil(
            (async () => {
                try {
                    await saveTask(kv, taskId, 'running', '查询数据');
                    const { results } = await db.prepare('SELECT id, name FROM ips ORDER BY id').all();
                    
                    const parsed = results.map(r => ({ ...r, region: extractRegion(r.name) }));
                    const REGION_ORDER = new Map(REGIONS.map((r, i) => [r, i]));
                    const UNKNOWN_REGION_INDEX = REGIONS.length;
                    
                    parsed.sort((a,b) => {
                        const ai = a.region ? (REGION_ORDER.get(a.region) ?? UNKNOWN_REGION_INDEX) : UNKNOWN_REGION_INDEX;
                        const bi = b.region ? (REGION_ORDER.get(b.region) ?? UNKNOWN_REGION_INDEX) : UNKNOWN_REGION_INDEX;
                        return ai - bi || a.id - b.id;
                    });

                    await saveTask(kv, taskId, 'running', '更新优先级');
                    const batch = parsed.map((r, i) => db.prepare('UPDATE ips SET priority = ? WHERE id = ?').bind(i + 1, r.id));
                    await execBatches(db, batch);
                    await saveTask(kv, taskId, 'completed', '优先级调整完成');
                } catch (e) {
                    await saveTask(kv, taskId, 'failed', e.message);
                    console.error('Reorder Priority Error:', e);
                }
            })()
        );
        return json({ success: true, async: true, taskId });
    },

    async toggleAll(db, { active }, ctx, kv) {
        const taskId = crypto.randomUUID();
        ctx.waitUntil(
            (async () => {
                try {
                    await saveTask(kv, taskId, 'running', '更新中');
                    await db.prepare('UPDATE ips SET active = ?').bind(active ? 1 : 0).run();
                    await saveTask(kv, taskId, 'completed', '更新完成');
                } catch (e) {
                    await saveTask(kv, taskId, 'failed', e.message);
                    console.error('Toggle All Error:', e);
                }
            })()
        );
        return json({ success: true, async: true, taskId });
    },

    async clearAll(db, ctx, kv) {
        const taskId = crypto.randomUUID();
        ctx.waitUntil(
            (async () => {
                try {
                    await saveTask(kv, taskId, 'running', '清空中');
                    await db.prepare('DELETE FROM ips').run();
                    await saveTask(kv, taskId, 'completed', '清空完成');
                } catch (e) {
                    await saveTask(kv, taskId, 'failed', e.message);
                    console.error('Clear All Error:', e);
                }
            })()
        );
        return json({ success: true, async: true, taskId });
    },

    async updateIp(db, id, body) {
        const { active, ip, priority } = body;
        
        if (ip !== undefined) {
            const { displayIp, port, name } = parseIP(ip);
            if (port === 'N/A') return err('IP格式错误');
            await db.prepare('UPDATE ips SET ip=?, name=? WHERE id=?').bind(`${displayIp}:${port}`, name || null, id).run();
        }
        if (active !== undefined) {
            await db.prepare('UPDATE ips SET active=? WHERE id=?').bind(active ? 1 : 0, id).run();
        }
        if (priority !== undefined) {
            const { current_priority } = await db.prepare('SELECT priority as current_priority FROM ips WHERE id=?').bind(id).first();
            await db.batch([
                db.prepare('UPDATE ips SET priority = ? WHERE priority = ? AND id != ?').bind(current_priority, priority, id),
                db.prepare('UPDATE ips SET priority = ? WHERE id = ?').bind(priority, id)
            ]);
        }
        
        return json({ success: true });
    },

    async deleteIp(db, id) {
        await db.prepare('DELETE FROM ips WHERE id=?').bind(id).run();
        return json({ success: true });
    },

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

// --- 路由分发器 (最终修正版) ---
const route = (req, db, ctx, kv) => {
    const url = new URL(req.url);
    const apiPath = url.pathname.slice(4);
    const method = req.method;

    const handle = async () => {
        const body = (method === 'POST' || method === 'PUT') ? await req.json().catch(() => ({})) : {};
        
        const routes = {
            '/ips': { GET: () => api.getIps(db, url.searchParams), POST: () => api.addIp(db, body) },
            '/ips/stats': { GET: () => api.getStats(db) },
            '/ips/batch': { POST: () => api.batchImport(db, body, ctx, kv) },
            '/ips/batch-delete': { POST: () => api.batchDelete(db, body, ctx, kv) },
            '/ips/sort': { POST: () => api.sortIps(db, ctx, kv) },
            '/ips/sort-priority': { POST: () => api.sortByPriority(db, ctx, kv) },
            '/ips/remove-duplicates': { POST: () => api.removeDuplicates(db, ctx, kv) },
            '/ips/reorder-priority': { POST: () => api.reorderPriority(db, ctx, kv) },
            '/ips/toggle-all': { POST: () => api.toggleAll(db, body, ctx, kv) },
            '/ips/clear': { DELETE: () => api.clearAll(db, ctx, kv) },
            '/init': { POST: () => api.initDb(db) },
        };

        if (routes[apiPath] && routes[apiPath][method]) {
            return routes[apiPath][method]();
        }

        const taskMatch = apiPath.match(/^\/task\/([a-f0-9-]+)$/);
        if (taskMatch && method === 'GET') return api.getTaskStatus(kv, taskMatch[1]);
        
        const idMatch = apiPath.match(/^\/ips\/(\d+)$/);
        if (idMatch) {
            if (method === 'PUT') return api.updateIp(db, idMatch[1], body);
            if (method === 'DELETE') return api.deleteIp(db, idMatch[1]);
        }
        
        return new Response('Not Found', { status: 404 });
    };

    return handle().catch(e => {
        console.error(e);
        return err(e.message, 500);
    });
};

const getHTML = () => `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>节点管理</title>
<style>
	:root {
		--bg: #0d1117;
		--bg-secondary: #161b22;
		--bg-tertiary: #21262d;
		--fg: #e6edf3;
		--fg-secondary: #b3bac4;
		--fg-tertiary: #8b949e;
		--card: #161b22;
		--card-hover: #1c2128;
		--border: #30363d;
		--border-light: #21262d;
		--input: #0d1117;
		--input-focus: #151b23;
		--blue: #58a6ff;
		--blue-light: #79c0ff;
		--green: #3fb950;
		--green-light: #56d364;
		--red: #f85149;
		--red-light: #ff7b72;
		--yellow: #d29922;
		--yellow-light: #e3b341;
		--purple: #a371f7;
		--purple-light: #bc8cff;
		--orange: #db6d28;
		--orange-light: #ffa657;
		--cyan: #39c5cf;
		--gray: #6e7681;
		--shadow: 0 4px 24px rgba(1, 4, 9, 0.8);
		--shadow-light: 0 2px 16px rgba(1, 4, 9, 0.6);
		--gradient: linear-gradient(135deg, var(--blue), var(--purple));
		--gradient-green: linear-gradient(135deg, var(--green), var(--cyan));
		--gradient-orange: linear-gradient(135deg, var(--orange), var(--yellow));
		--radius: 12px;
		--radius-lg: 16px;
		--transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
	}

	* {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	body {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif;
		background: var(--bg);
		color: var(--fg);
		line-height: 1.6;
		min-height: 100vh;
		font-size: 15px;
		font-weight: 400;
		-webkit-font-smoothing: antialiased;
		-moz-osx-font-smoothing: grayscale;
	}

	.container {
		max-width: 1400px;
		margin: 0 auto;
		padding: 30px 24px;
	}

	.header {
		text-align: center;
		margin-bottom: 48px;
		padding: 0 20px;
	}

	h1 {
		font-size: 40px;
		font-weight: 700;
		margin-bottom: 12px;
		background: linear-gradient(135deg, var(--blue), var(--purple));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		letter-spacing: -0.5px;
	}

	.subtitle {
		font-size: 17px;
		color: var(--fg-secondary);
		font-weight: 400;
		line-height: 1.5;
	}

	.section {
		background: var(--card);
		border-radius: var(--radius-lg);
		padding: 32px;
		margin-bottom: 28px;
		border: 1px solid var(--border);
		box-shadow: var(--shadow-light);
		transition: var(--transition);
	}

	.section:hover {
		box-shadow: var(--shadow);
		border-color: var(--border-light);
	}

	.section h2 {
		font-size: 22px;
		font-weight: 600;
		color: var(--fg);
		margin-bottom: 24px;
		display: flex;
		align-items: center;
		gap: 12px;
	}

	.section h2::before {
		content: '';
		width: 4px;
		height: 20px;
		background: var(--blue);
		border-radius: 2px;
	}

	.form-group {
		margin-bottom: 24px;
	}

	label {
		display: block;
		margin-bottom: 10px;
		color: var(--fg-secondary);
		font-size: 14px;
		font-weight: 500;
	}

	input, textarea, select {
		width: 100%;
		padding: 14px 16px;
		background: var(--input);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		color: var(--fg);
		font: inherit;
		font-size: 15px;
		transition: var(--transition);
	}

	input:focus, textarea:focus, select:focus {
		outline: none;
		border-color: var(--blue);
		background: var(--input-focus);
		box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.1);
	}

	input::placeholder, textarea::placeholder {
		color: var(--fg-tertiary);
	}

	button {
		background: var(--blue);
		color: white;
		border: none;
		padding: 14px 28px;
		border-radius: var(--radius);
		cursor: pointer;
		font-size: 15px;
		font-weight: 500;
		transition: var(--transition);
		display: inline-flex;
		align-items: center;
		gap: 8px;
		position: relative;
		overflow: hidden;
	}

	button::before {
		content: '';
		position: absolute;
		top: 0;
		left: -100%;
		width: 100%;
		height: 100%;
		background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.1), transparent);
		transition: left 0.6s;
	}

	button:hover::before {
		left: 100%;
	}

	button:hover {
		background: var(--blue-light);
		transform: translateY(-1px);
		box-shadow: 0 6px 20px rgba(88, 166, 255, 0.2);
	}

	button:active {
		transform: translateY(0);
	}

	button.danger {
		background: var(--red);
	}

	button.danger:hover {
		background: var(--red-light);
		box-shadow: 0 6px 20px rgba(248, 81, 73, 0.2);
	}

	button.secondary {
		background: var(--bg-tertiary);
		color: var(--fg-secondary);
	}

	button.secondary:hover {
		background: var(--border);
		color: var(--fg);
		box-shadow: 0 6px 20px rgba(110, 118, 129, 0.1);
	}

	button.success {
		background: var(--green);
	}

	button.success:hover {
		background: var(--green-light);
		box-shadow: 0 6px 20px rgba(63, 185, 80, 0.2);
	}

	button.purple {
		background: var(--purple);
	}

	button.purple:hover {
		background: var(--purple-light);
		box-shadow: 0 6px 20px rgba(163, 113, 247, 0.2);
	}

	button.orange {
		background: var(--orange);
	}

	button.orange:hover {
		background: var(--orange-light);
		box-shadow: 0 6px 20px rgba(219, 109, 40, 0.2);
	}

	button.small {
		padding: 10px 16px;
		font-size: 14px;
		border-radius: 8px;
	}

	.button-group {
		display: flex;
		gap: 12px;
		flex-wrap: wrap;
	}

	.batch-actions {
		display: flex;
		gap: 16px;
		justify-content: flex-start;
		margin-top: 20px;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: 16px;
		margin-bottom: 28px;
	}

	.stat {
		background: var(--bg-tertiary);
		padding: 24px;
		border-radius: var(--radius);
		text-align: center;
		border: 1px solid var(--border);
		transition: var(--transition);
	}

	.stat:hover {
		background: var(--card-hover);
		transform: translateY(-2px);
	}

	.stat-number {
		font-size: 32px;
		font-weight: 700;
		color: var(--blue);
		margin-bottom: 6px;
	}

	.stat-label {
		font-size: 14px;
		color: var(--fg-secondary);
		font-weight: 500;
	}

	.ip-list {
		list-style: none;
		display: grid;
		gap: 12px;
	}

	.ip-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 20px;
		background: var(--bg-tertiary);
		border-radius: var(--radius);
		border: 1px solid var(--border);
		transition: var(--transition);
	}

	.ip-item:hover {
		background: var(--card-hover);
		border-color: var(--border-light);
		transform: translateX(4px);
	}

	.ip-info {
		flex: 1;
		display: flex;
		align-items: center;
		gap: 20px;
	}

	.ip-details {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.ip-address {
		font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
		font-weight: 600;
		font-size: 15px;
		color: var(--fg);
		letter-spacing: -0.2px;
	}

	.ip-meta {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
	}

	.node-name {
		font-size: 13px;
		color: var(--blue);
		background: rgba(88, 166, 255, 0.1);
		padding: 4px 10px;
		border-radius: 6px;
		font-weight: 500;
		border: 1px solid rgba(88, 166, 255, 0.2);
	}

	.region-tag {
		font-size: 12px;
		color: var(--purple);
		background: rgba(163, 113, 247, 0.1);
		padding: 4px 8px;
		border-radius: 6px;
		font-weight: 500;
		border: 1px solid rgba(163, 113, 247, 0.2);
	}

	.priority-tag {
		font-size: 12px;
		color: var(--orange);
		background: rgba(219, 109, 40, 0.1);
		padding: 4px 8px;
		border-radius: 6px;
		font-weight: 500;
		border: 1px solid rgba(219, 109, 40, 0.2);
	}

	.status {
		padding: 6px 12px;
		border-radius: 20px;
		font-size: 12px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.3px;
	}

	.status.active {
		background: rgba(63, 185, 80, 0.1);
		color: var(--green);
		border: 1px solid rgba(63, 185, 80, 0.2);
	}

	.status.inactive {
		background: rgba(248, 81, 73, 0.1);
		color: var(--red);
		border: 1px solid rgba(248, 81, 73, 0.2);
	}

	.ip-actions {
		display: flex;
		gap: 10px;
	}

	.message {
		padding: 16px 20px;
		border-radius: var(--radius);
		margin-bottom: 20px;
		text-align: center;
		font-weight: 500;
		font-size: 14px;
		opacity: 0;
		animation: slideIn 0.3s ease forwards;
		border: 1px solid;
	}

	@keyframes slideIn {
		from { opacity: 0; transform: translateY(-10px); }
		to { opacity: 1; transform: translateY(0); }
	}

	.message.success {
		background: rgba(63, 185, 80, 0.1);
		color: var(--green);
		border-color: rgba(63, 185, 80, 0.2);
	}

	.message.error {
		background: rgba(248, 81, 73, 0.1);
		color: var(--red);
		border-color: rgba(248, 81, 73, 0.2);
	}

	.form-row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
		gap: 16px;
	}

	.actions {
		display: flex;
		gap: 12px;
		margin-bottom: 24px;
		flex-wrap: wrap;
	}

	textarea {
		min-height: 140px;
		font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
		font-size: 14px;
		line-height: 1.5;
		resize: vertical;
	}

	.loading, .empty {
		text-align: center;
		padding: 60px 20px;
		color: var(--fg-secondary);
		font-size: 16px;
	}

	.loading {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
	}

	.modal {
		position: fixed;
		inset: 0;
		background: rgba(13, 17, 23, 0.8);
		backdrop-filter: blur(4px);
		display: none;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		animation: fadeIn 0.2s ease;
		padding: 20px;
	}

	.modal-content {
		background: var(--card);
		border-radius: var(--radius-lg);
		padding: 32px;
		max-width: 520px;
		width: 100%;
		border: 1px solid var(--border);
		box-shadow: var(--shadow);
		transform: scale(0.95);
		animation: scaleUp 0.2s ease forwards;
	}

	@keyframes scaleUp {
		to { transform: scale(1); }
	}

	.modal-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 24px;
	}

	.modal-title {
		color: var(--fg);
		font-size: 20px;
		font-weight: 600;
	}

	.close-btn {
		background: none;
		border: none;
		color: var(--fg-secondary);
		font-size: 24px;
		cursor: pointer;
		padding: 6px;
		border-radius: 6px;
		transition: var(--transition);
		width: 32px;
		height: 32px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.close-btn:hover {
		color: var(--fg);
		background: var(--bg-tertiary);
	}

	.modal-buttons {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
		margin-top: 20px;
	}

	.spinner {
		border: 2px solid rgba(88, 166, 255, 0.2);
		border-left-color: var(--blue);
		border-radius: 50%;
		width: 40px;
		height: 40px;
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		0% { transform: rotate(0deg); }
		100% { transform: rotate(360deg); }
	}

	.pagination {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 16px;
		margin-top: 24px;
		padding: 16px;
	}

	.page-info {
		font-size: 14px;
		color: var(--fg-secondary);
		font-weight: 500;
		min-width: 100px;
		text-align: center;
	}

	.tooltip {
		position: relative;
	}

	.tooltip::after {
		content: attr(data-tooltip);
		position: absolute;
		bottom: 100%;
		left: 50%;
		transform: translateX(-50%);
		background: var(--bg-tertiary);
		color: var(--fg);
		padding: 6px 10px;
		border-radius: 6px;
		font-size: 12px;
		white-space: nowrap;
		opacity: 0;
		pointer-events: none;
		transition: opacity 0.2s ease;
		border: 1px solid var(--border);
		box-shadow: var(--shadow-light);
		margin-bottom: 8px;
	}

	.tooltip:hover::after {
		opacity: 1;
	}

	@media (max-width: 768px) {
		.container { padding: 20px 16px; }
		h1 { font-size: 32px; }
		.subtitle { font-size: 15px; }
		.section { padding: 24px; margin-bottom: 20px; }
		.section h2 { font-size: 20px; }
		.stats { grid-template-columns: 1fr; gap: 12px; }
		.stat { padding: 20px; }
		.stat-number { font-size: 28px; }
		.ip-item { flex-direction: column; gap: 16px; align-items: flex-start; }
		.ip-info { width: 100%; }
		.ip-actions { width: 100%; justify-content: flex-end; }
		.form-row { grid-template-columns: 1fr; gap: 12px; }
		.modal-content { padding: 24px; margin: 10px; }
		.modal-title { font-size: 18px; }
		.button-group { flex-direction: column; }
		.batch-actions { flex-direction: column; gap: 12px; }
		button { width: 100%; justify-content: center; }
		.actions { gap: 8px; }
		.ip-meta { gap: 6px; }
	}

	@media (max-width: 480px) {
		body { font-size: 14px; }
		.container { padding: 16px 12px; }
		.section { padding: 20px; border-radius: var(--radius); }
		.section h2 { font-size: 18px; margin-bottom: 20px; }
		input, textarea, select { padding: 12px 14px; }
		button { padding: 12px 16px; }
		.stat { padding: 16px; }
		.stat-number { font-size: 24px; }
		.modal-content { padding: 20px; }
		.pagination { flex-direction: column; gap: 12px; }
	}

	/* 滚动条样式 */
	::-webkit-scrollbar {
		width: 6px;
	}

	::-webkit-scrollbar-track {
		background: var(--bg-secondary);
	}

	::-webkit-scrollbar-thumb {
		background: var(--border);
		border-radius: 3px;
	}

	::-webkit-scrollbar-thumb:hover {
		background: var(--border-light);
	}

	/* 选择文本样式 */
	::selection {
		background: rgba(88, 166, 255, 0.2);
		color: inherit;
	}
</style>
</head>
<body>
<div class="container">
	<div class="header">
		<h1>节点管理中心</h1>
		<div class="subtitle">简洁高效的代理节点管理平台</div>
	</div>

	<div class="section">
		<h2>统计概览</h2>
		<div class="stats">
			<div class="stat">
				<div class="stat-number" id="total">-</div>
				<div class="stat-label">总节点数</div>
			</div>
			<div class="stat">
				<div class="stat-number" id="active">-</div>
				<div class="stat-label">活跃节点</div>
			</div>
			<div class="stat">
				<div class="stat-number" id="inactive">-</div>
				<div class="stat-label">禁用节点</div>
			</div>
		</div>
	</div>

	<div class="section">
		<h2>添加节点</h2>
		<div class="form-group">
			<label>IP地址</label>
			<input id="newIp" placeholder="IPv4: 192.168.1.1 | IPv6: [2001:db8::1] | 域名: example.com">
		</div>
		<div class="form-row">
			<div class="form-group">
				<label>端口号</label>
				<input id="newPort" placeholder="443" value="443">
			</div>
			<div class="form-group">
				<label>节点名称</label>
				<input id="newName" placeholder="香港节点01-HK">
			</div>
			<div class="form-group">
				<label>优先级</label>
				<input id="newPriority" type="number" placeholder="自动分配" min="0">
			</div>
		</div>
		<button onclick="addIp()">添加节点</button>
	</div>

	<div class="section">
		<h2>批量操作</h2>
		<div class="form-group">
			<label>节点列表（每行一个，支持 IP:端口#名称 格式）</label>
			<textarea id="batchIps" placeholder="192.168.1.1:443#香港-HK&#10;[2001:db8::1]:443#日本-JP&#10;example.com:443#美国-US&#10;导入：格式仅支持IP:PORT#NAME&#10;删除：格式支持直接使用节点链接，会自动提取IP和PROT匹配删除"></textarea>
		</div>
		<div class="batch-actions">
			<button onclick="batchImport()">批量导入</button>
			<button class="danger" onclick="batchDelete()">批量删除</button>
		</div>
	</div>

	<div class="section">
		<h2>配置生成</h2>
		<button class="purple" onclick="window.location.href='/Vless'">生成 Vless 链接</button>
	</div>

	<div class="section">
		<h2>节点列表</h2>
		<div id="message"></div>
		
		<div class="actions">
			<button onclick="loadIps()">刷新</button>
			<button class="purple" onclick="sortByRegion()">按地区排序</button>
			<button class="purple" onclick="reorderPriority()">调整优先级</button>
			<button class="purple" onclick="sortByPriority()">按优先级排序</button>
			<button class="orange" onclick="removeDuplicates()">一键去重</button>
			<button class="success" onclick="toggleAll(1)">全部启用</button>
			<button class="secondary" onclick="toggleAll(0)">全部禁用</button>
			<button class="danger" onclick="clearAll()">清空所有</button>
		</div>

		<div id="ipContainer">
			<div class="loading">
				<div class="spinner"></div>
				<div>正在加载节点数据...</div>
			</div>
		</div>

		<div id="pagination" class="pagination">
			<button id="prevPageBtn" class="secondary" onclick="prevPage()">上一页</button>
			<span id="pageInfo" class="page-info">第 1 页 / 共 1 页</span>
			<button id="nextPageBtn" class="secondary" onclick="nextPage()">下一页</button>
		</div>
	</div>
</div>

<div id="editModal" class="modal">
	<div class="modal-content">
		<div class="modal-header">
			<div class="modal-title">编辑节点</div>
			<button class="close-btn" onclick="closeModal()">&times;</button>
		</div>
		<form onsubmit="saveEdit(event)">
			<div class="form-group">
				<label>IP地址</label>
				<input id="editIp" required>
			</div>
			<div class="form-row">
				<div class="form-group">
					<label>端口号</label>
					<input id="editPort" required>
				</div>
				<div class="form-group">
					<label>节点名称</label>
					<input id="editName">
				</div>
				<div class="form-group">
					<label>优先级</label>
					<input id="editPriority" type="number" required min="0">
				</div>
			</div>
			<div class="modal-buttons">
				<button type="submit">保存更改</button>
				<button type="button" class="secondary" onclick="closeModal()">取消</button>
			</div>
		</form>
	</div>
</div>

<script>
const API='/api',PAGE_SIZE=${PAGE_SIZE};
let editId=null,currentPage=1,totalPages=1,pollInterval=null;

// 保存滚动位置
let scrollPosition = 0;

const saveScrollPosition = () => {
	scrollPosition = window.scrollY || document.documentElement.scrollTop;
};

const restoreScrollPosition = () => {
	requestAnimationFrame(() => {
		window.scrollTo(0, scrollPosition);
	});
};

const msg=(t,type='success')=>{
	const messageEl=document.getElementById('message');
	messageEl.innerHTML=\`<div class="message \${type}">\${t}</div>\`;
	setTimeout(()=>messageEl.innerHTML='',5000);
};

const api=async(e,o={})=>{
	try{
		const r=await fetch(API+e,{headers:{'Content-Type':'application/json'},...o});
		const d=await r.json();
		if(!r.ok)throw new Error(d.error);
		return d;
	}catch(error){
		msg(error.message,'error');
		throw error;
	}
};

const pollTask=async(taskId,onComplete)=>{
	if(pollInterval)clearInterval(pollInterval);
	pollInterval=setInterval(async()=>{
		try{
			const{status,message}=await api(\`/task/\${taskId}\`);
			if(status==='completed'){
				clearInterval(pollInterval);
				msg(message||'操作完成');
				if(onComplete)onComplete();
			}else if(status==='failed'){
				clearInterval(pollInterval);
				msg(message||'操作失败','error');
			}
		}catch{
			clearInterval(pollInterval);
		}
	},1000);
};

const loadStats=async()=>{
	try{
		const{total,active,inactive}=await api('/ips/stats');
		document.getElementById('total').textContent=total;
		document.getElementById('active').textContent=active;
		document.getElementById('inactive').textContent=inactive;
	}catch{}
};

const loadIps = async (page = 1, keepScroll = false) => {
    if (keepScroll) {
        saveScrollPosition();
    }
    
    const c = document.getElementById('ipContainer');
    c.innerHTML = '<div class="loading"><div class="spinner"></div><div>正在加载节点数据...</div></div>';
    try {
      const { ips, pagination } = await api(\`/ips?page=\${page}&limit=\${PAGE_SIZE}&needTotal=true\`);
      currentPage = pagination.page;
      totalPages = pagination.pages || 1;
      document.getElementById('pageInfo').textContent = \`第 \${currentPage} 页 / 共 \${totalPages} 页\`;
      document.getElementById('pagination').style.display = 'flex';
      document.getElementById('prevPageBtn').disabled = currentPage === 1;
      document.getElementById('nextPageBtn').disabled = currentPage === totalPages;
      c.innerHTML = ips.length ? \`
        <ul class="ip-list">
          \${ips.map(ip => \`
            <li class="ip-item">
              <div class="ip-info">
                <div class="ip-details">
                  <div class="ip-address">\${ip.displayIp}:\${ip.port}</div>
                  <div class="ip-meta">
                    \${ip.name ? \`<span class="node-name">\${ip.name}</span>\` : ''}
                    \${ip.region ? \`<span class="region-tag">\${ip.region}</span>\` : ''}
                    <span class="priority-tag">优先级: \${ip.priority}</span>
                  </div>
                </div>
                <span class="status \${ip.active ? 'active' : 'inactive'}">\${ip.active ? '启用中' : '已禁用'}</span>
              </div>
              <div class="ip-actions">
                <button class="small tooltip" data-tooltip="编辑节点" onclick="editIp(\${ip.id},'\${ip.displayIp}','\${ip.port}','\${ip.name || ''}',\${ip.priority})">编辑</button>
                <button class="small tooltip" data-tooltip="\${ip.active ? '禁用节点' : '启用节点'}" onclick="toggleIp(\${ip.id},\${ip.active})">\${ip.active ? '禁用' : '启用'}</button>
                <button class="small danger tooltip" data-tooltip="删除节点" onclick="deleteIp(\${ip.id})">删除</button>
              </div>
            </li>
          \`).join('')}
        </ul>
      \` : '<div class="empty">暂无节点数据</div>';
      loadStats();
      
      if (keepScroll) {
          setTimeout(restoreScrollPosition, 50);
      }
    } catch (error) {
      console.error('Load IPs failed:', error);
      c.innerHTML = '<div class="empty">加载失败，请重试</div>';
    }
  };

const prevPage=()=>{
	saveScrollPosition();
	loadIps(currentPage-1, true);
};
const nextPage=()=>{
	saveScrollPosition();
	loadIps(currentPage+1, true);
};

const sortByRegion=async()=>{
	try{
		const{taskId,async}=await api('/ips/sort',{method:'POST'});
		if(async){
			msg('排序任务启动，等待完成...');
			pollTask(taskId,()=>loadIps(currentPage, true));
		}else{
			msg('排序完成');
			loadIps(currentPage, true);
		}
	}catch{}
};

const sortByPriority=async()=>{
	try{
		const{taskId,async}=await api('/ips/sort-priority',{method:'POST'});
		if(async){
			msg('按优先级排序任务启动，等待完成...');
			pollTask(taskId,()=>loadIps(currentPage, true));
		}else{
			msg('按优先级排序完成');
			loadIps(currentPage, true);
		}
	}catch{}
};

const removeDuplicates=async()=>{
	if(!confirm('确定要删除所有重复的节点吗？此操作将根据IP地址（忽略端口）判断重复，不可撤销！'))return;
	try{
		const{taskId,async}=await api('/ips/remove-duplicates',{method:'POST'});
		if(async){
			msg('去重任务启动，等待完成...');
			pollTask(taskId,()=>loadIps(currentPage, true));
		}else{
			msg('去重完成');
			loadIps(currentPage, true);
		}
	}catch{}
};

const reorderPriority=async()=>{
	try{
		const{taskId,async}=await api('/ips/reorder-priority',{method:'POST'});
		if(async){
			msg('优先级调整启动，等待完成...');
			pollTask(taskId,()=>loadIps(currentPage, true));
		}else{
			msg('调整完成');
			loadIps(currentPage, true);
		}
	}catch{}
};

const addIp=async()=>{
	const ip=document.getElementById('newIp').value.trim();
	const port=document.getElementById('newPort').value.trim();
	const name=document.getElementById('newName').value.trim();
	const priority=document.getElementById('newPriority').value.trim();
	if(!ip)return msg('请输入IP地址','error');
	let full=ip;
	if(port){
		if(ip.startsWith('[')&&ip.includes(']')){
			const e=ip.indexOf(']');
			full=ip.substring(0,e+1)+':'+port;
		}else if(!ip.includes(':')){
			full+=':'+port;
		}
	}
	if(name)full+=\`#\${name}\`;
	try{
		await api('/ips',{method:'POST',body:JSON.stringify({ip:full,priority:priority?parseInt(priority):undefined})});
		msg('节点添加成功');
		['newIp','newPort','newName','newPriority'].forEach(id=>document.getElementById(id).value='');
		document.getElementById('newPort').value='443';
		loadIps(currentPage, true);
	}catch{}
};

const batchImport=async()=>{
	const lines=document.getElementById('batchIps').value.split('\\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
	if(!lines.length)return msg('请输入要导入的节点列表','error');
	try{
		const{count,async,taskId}=await api('/ips/batch',{method:'POST',body:JSON.stringify({ips:lines})});
		if(async){
			msg(\`批量导入启动（\${count}条），等待完成...\`);
			pollTask(taskId,()=>{
				document.getElementById('batchIps').value='';
				loadIps(currentPage, true);
			});
		}else{
			msg(\`成功导入 \${count} 条节点\`);
			document.getElementById('batchIps').value='';
			loadIps(currentPage, true);
		}
	}catch{}
};

const batchDelete=async()=>{
	const lines=document.getElementById('batchIps').value.split('\\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
	if(!lines.length)return msg('请输入要删除的节点列表','error');
	if(!confirm('确定要删除这些节点吗？此操作不可撤销！'))return;
	const ips=[];
	lines.forEach(line=>{
		const match=line.match(/@([^?]+)?/);
		if(match)ips.push(match[1]);
		else{
			const h=line.indexOf('#');
			let ipPart=h>-1?line.substring(0,h):line;
			if(!ipPart.includes(':'))ipPart+=':443';
			ips.push(ipPart);
		}
	});
	if(!ips.length)return msg('未提取到有效的IP地址','error');
	try{
		const{count,async,taskId}=await api('/ips/batch-delete',{method:'POST',body:JSON.stringify({ips})});
		if(async){
			msg(\`批量删除启动（\${count}条），等待完成...\`);
			pollTask(taskId,()=>{
				document.getElementById('batchIps').value='';
				loadIps(currentPage, true);
			});
		}else{
			msg(\`成功删除 \${count} 条节点\`);
			document.getElementById('batchIps').value='';
			loadIps(currentPage, true);
		}
	}catch{}
};

const editIp=(id,ip,port,name,priority)=>{
	editId=id;
	document.getElementById('editIp').value=ip;
	document.getElementById('editPort').value=port;
	document.getElementById('editName').value=name;
	document.getElementById('editPriority').value=priority;
	document.getElementById('editModal').style.display='flex';
};

const closeModal=()=>{
	document.getElementById('editModal').style.display='none';
	editId=null;
};

const saveEdit=async e=>{
	e.preventDefault();
	const ip=document.getElementById('editIp').value.trim();
	const port=document.getElementById('editPort').value.trim();
	const name=document.getElementById('editName').value.trim();
	const priority=document.getElementById('editPriority').value.trim();
	if(!ip||!port)return msg('IP地址和端口号不能为空','error');
	let full=ip.startsWith('[')?ip:ip;
	if(!full.includes(':'))full+=':'+port;
	if(name)full+=\`#\${name}\`;
	try{
		await api(\`/ips/\${editId}\`,{method:'PUT',body:JSON.stringify({ip:full,priority:parseInt(priority)||0})});
		msg('节点信息更新成功');
		closeModal();
		loadIps(currentPage, true);
	}catch{}
};

const toggleIp=async(id,active)=>{
	try{
		await api(\`/ips/\${id}\`,{method:'PUT',body:JSON.stringify({active:active?0:1})});
		msg(\`节点已\${active?'禁用':'启用'}\`);
		loadIps(currentPage, true);
	}catch{}
};

const deleteIp=async id=>{
	if(!confirm('确定要删除这个节点吗？此操作不可撤销！'))return;
	try{
		await api(\`/ips/\${id}\`,{method:'DELETE'});
		msg('节点删除成功');
		loadIps(currentPage, true);
	}catch{}
};

const toggleAll=async active=>{
	const action=active?'启用':'禁用';
	if(!confirm(\`确定要\${action}所有节点吗？\`))return;
	try{
		const{taskId,async}=await api('/ips/toggle-all',{method:'POST',body:JSON.stringify({active})});
		if(async){
			msg(\`批量\${action}启动，等待完成...\`);
			pollTask(taskId,()=>loadIps(currentPage, true));
		}else{
			msg(\`所有节点已\${action}\`);
			loadIps(currentPage, true);
		}
	}catch{}
};

const clearAll=async()=>{
	if(!confirm('确定要清空所有节点吗？')||!confirm('⚠️  此操作不可恢复！请再次确认！'))return;
	try{
		const{taskId,async}=await api('/ips/clear',{method:'DELETE'});
		if(async){
			msg('清空任务启动，等待完成...');
			pollTask(taskId,()=>loadIps(1));
		}else{
			msg('所有节点已清空');
			loadIps(1);
		}
	}catch{}
};

document.getElementById('editModal').onclick=e=>{
	if(e.target===e.currentTarget)closeModal();
};

// 初始化加载
loadIps();
</script>
</body>
</html>`;

// --- 主 Fetch Handler ---
export default {
    async fetch(req, env, ctx) {
        const url = new URL(req.url);

        if (url.pathname === '/') {
            return new Response(getHTML(), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });
        }

        if (url.pathname === '/Vless') {
            const host = url.searchParams.get('host') || HOST;
            const cacheKey = new Request(req.url, req);
            const cache = caches.default;
            let res = await cache.match(cacheKey);
            if (res) return res;

            const { results } = await env.DB.prepare('SELECT ip, name FROM ips WHERE active=1 ORDER BY priority, id LIMIT ?').bind(MAX_VLESS).all();
            const links = results.map((ipRow) => generateVless(ipRow, host)).join('\n');
            
            res = new Response(links || '暂无节点', { headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'public, max-age=60' } });
            ctx.waitUntil(cache.put(cacheKey, res.clone()));
            return res;
        }

        if (url.pathname.startsWith('/api/')) {
            return route(req, env.DB, ctx, env.TASK_KV);
        }

        return new Response('Not Found', { status: 404 });
    },
};
