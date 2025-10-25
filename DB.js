// Config
const UUID = '', //UUID
	HOST = ''; //自定义域名或者Snippets域名指向
const REGIONS = ['HK', 'TW', 'JP', 'SG', 'KR', 'US']; //控制想要排列的顺序
const PAGE_SIZE = 30,
	BATCH_SIZE = 50,
	MAX_VLESS = 500;

const json = (d, s = 200) => Response.json(d, { status: s });
const err = (m, s = 400) => Response.json({ error: m }, { status: s });

const tasks = {};

const execBatches = async (db, statements) => {
	for (let i = 0; i < statements.length; i += BATCH_SIZE) {
		await db.batch(statements.slice(i, i + BATCH_SIZE));
	}
};

const formatIP = (ip) => {
	const t = ip.trim();
	if (!t) return null;
	if (t.startsWith('[')) {
		const e = t.indexOf(']');
		if (e > -1) {
			const ipv6 = t.substring(0, e + 1),
				rest = t.substring(e + 1);
			if (rest.startsWith(':')) {
				const m = rest.match(/^:(\d+)(#.*)?$/);
				if (m) return `${ipv6}:${m[1]}${m[2] || ''}`;
			} else if (rest.startsWith('#') || !rest) return `${ipv6}:443${rest || ''}`;
		}
	}
	const h = t.indexOf('#');
	let ipPart = h > -1 ? t.substring(0, h) : t;
	const namePart = h > -1 ? t.substring(h) : '';
	if (!ipPart.includes(':')) ipPart += ':443';
	return `${ipPart}${namePart}`;
};

const parseIP = (ip) => {
	if (ip.startsWith('[')) {
		const e = ip.indexOf(']'),
			ipv6 = ip.substring(0, e + 1),
			m = ip.substring(e + 1).match(/^:(\d+)/);
		return { displayIp: ipv6, port: m ? m[1] : '443' };
	}
	const [i, p = '443'] = ip.split('#')[0].split(':');
	return { displayIp: i, port: p };
};

// 新增函数：提取纯IP地址（不包含端口）
const extractPureIP = (ip) => {
	if (ip.startsWith('[')) {
		const e = ip.indexOf(']');
		return e > -1 ? ip.substring(0, e + 1) : ip;
	}
	const colonIndex = ip.indexOf(':');
	return colonIndex > -1 ? ip.substring(0, colonIndex) : ip;
};

const extractRegion = (n) => (n ? REGIONS.find((r) => new RegExp(r, 'i').test(n)) || '' : '');

const generateVless = (ip, host) => {
	const { displayIp, port } = parseIP(ip.ip);
	const name = ip.name ? encodeURIComponent(ip.name) : encodeURIComponent(displayIp.replace(/[\.\[\]:]/g, '-') + '-' + port);
	return `vless://${UUID}@${displayIp}:${port}?encryption=none&security=tls&type=ws&host=${host}&path=%2F%3Fed%3D2560&sni=${host}#${name}`;
};

const sortByRegion = (ips) =>
	ips.sort((a, b) => {
		const ar = extractRegion(a.name || ''),
			br = extractRegion(b.name || '');
		let ai = REGIONS.indexOf(ar),
			bi = REGIONS.indexOf(br);
		if (ai === -1) ai = REGIONS.length;
		if (bi === -1) bi = REGIONS.length;
		const regionDiff = ai - bi;
		if (regionDiff) return regionDiff;
		if (a.priority !== b.priority) return a.priority - b.priority;
		const aIsV6 = a.displayIp.startsWith('[') ? 0 : 1,
			bIsV6 = b.displayIp.startsWith('[') ? 0 : 1;
		if (aIsV6 !== bIsV6) return aIsV6 - bIsV6;
		return a.id - b.id;
	});

const saveTask = async (kv, id, status, msg = '') => {
	const data = { status, message: msg, timestamp: Date.now() };
	if (kv) {
		await kv.put(`task:${id}`, JSON.stringify(data), { expirationTtl: 300 }).catch(() => {});
	}
	tasks[id] = data;
	setTimeout(() => delete tasks[id], 300000);
};

const getTask = async (kv, id) => {
	if (kv) {
		try {
			const data = await kv.get(`task:${id}`);
			if (data) return JSON.parse(data);
		} catch {}
	}
	return tasks[id] || null;
};

const api = {
	async getIps(db, params) {
		const page = parseInt(params.get('page') || '1');
		const limit = parseInt(params.get('limit') || PAGE_SIZE);
		const offset = (page - 1) * limit;
		const needTotal = params.get('needTotal') === 'true';

		if (needTotal) {
			const [{ results }, { total }] = await Promise.all([
				db.prepare('SELECT id,ip,name,active,priority FROM ips ORDER BY id LIMIT ? OFFSET ?').bind(limit, offset).all(),
				db.prepare('SELECT COUNT(*)as total FROM ips').first(),
			]);
			return json({
				ips: results.map((r) => ({ ...r, ...parseIP(r.ip), name: r.name || '', region: extractRegion(r.name || '') })),
				pagination: { page, limit, total, pages: Math.ceil(total / limit) },
			});
		}

		const { results } = await db.prepare('SELECT id,ip,name,active,priority FROM ips ORDER BY id LIMIT ? OFFSET ?').bind(limit, offset).all();
		return json({
			ips: results.map((r) => ({ ...r, ...parseIP(r.ip), name: r.name || '', region: extractRegion(r.name || '') })),
			pagination: { page, limit },
		});
	},

	async getStats(db) {
		const { total, active } = await db.prepare('SELECT COUNT(*)as total,SUM(CASE WHEN active=1 THEN 1 ELSE 0 END)as active FROM ips').first();
		return json({ total, active: active || 0, inactive: total - (active || 0) });
	},

	async getTaskStatus(kv, taskId) {
		const task = await getTask(kv, taskId);
		if (!task) return err('任务不存在', 404);
		return json(task);
	},

	async addIp(db, { ip, priority }) {
		if (!ip) return err('IP不能为空');
		const formatted = formatIP(ip);
		if (!formatted) return err('IP格式错误');
		const [ipPort, name] = formatted.split('#');
		const prio = priority || (await db.prepare('SELECT COALESCE(MAX(priority),0)+1 as n FROM ips').first()).n;
		const result = await db.prepare('INSERT OR IGNORE INTO ips(ip,name,active,priority)VALUES(?,?,1,?)').bind(ipPort, name || null, prio).run();
		if (result.meta.changes === 0) return err('IP已存在');
		return json({ success: true });
	},

	async batchImport(db, { ips }, ctx, kv) {
		if (!Array.isArray(ips) || !ips.length) return err('列表为空');
		const taskId = crypto.randomUUID();
		const importTask = async () => {
			try {
				await saveTask(kv, taskId, 'running', '准备导入');
				const { p } = await db.prepare('SELECT COALESCE(MAX(priority),0)as p FROM ips').first();
				const stmt = db.prepare('INSERT OR IGNORE INTO ips(ip,name,active,priority)VALUES(?,?,1,?)');
				const batch = ips
					.map((ip, i) => {
						const formatted = formatIP(ip.trim());
						if (!formatted) return null;
						const [ipPort, name] = formatted.split('#');
						return stmt.bind(ipPort, name || null, p + i + 1);
					})
					.filter(Boolean);
				if (batch.length) {
					await saveTask(kv, taskId, 'running', `导入 ${batch.length} 条`);
					await execBatches(db, batch);
				}
				await saveTask(kv, taskId, 'completed', `成功导入 ${batch.length} 条`);
			} catch (e) {
				await saveTask(kv, taskId, 'failed', e.message);
				console.error('Import:', e);
			}
		};
		if (ips.length > 50) {
			ctx.waitUntil(importTask());
			return json({ success: true, async: true, taskId, count: ips.length });
		}
		await importTask();
		return json({ success: true, count: ips.length });
	},

	async batchDelete(db, { ips }, ctx, kv) {
		if (!Array.isArray(ips) || !ips.length) return err('列表为空');
		const taskId = crypto.randomUUID();
		const deleteTask = async () => {
			try {
				await saveTask(kv, taskId, 'running', '准备删除');
				await execBatches(db, ips.map((ip) => db.prepare('DELETE FROM ips WHERE ip=?').bind(ip)));
				await saveTask(kv, taskId, 'completed', `成功删除 ${ips.length} 条`);
			} catch (e) {
				await saveTask(kv, taskId, 'failed', e.message);
				console.error('Delete:', e);
			}
		};
		if (ips.length > 20) {
			ctx.waitUntil(deleteTask());
			return json({ success: true, async: true, taskId, count: ips.length });
		}
		await deleteTask();
		return json({ success: true, count: ips.length });
	},

	async sortIps(db, ctx, kv) {
		const taskId = crypto.randomUUID();
		ctx.waitUntil(
			(async () => {
				try {
					await saveTask(kv, taskId, 'running', '查询数据');
					const { results } = await db.prepare('SELECT id,ip,name,active,priority FROM ips').all();
					await saveTask(kv, taskId, 'running', '排序中');
					const sorted = sortByRegion(results.map((r) => ({ ...r, ...parseIP(r.ip), region: extractRegion(r.name || '') })));
					const batch = [];
					sorted.forEach((s, i) => batch.push(db.prepare('UPDATE ips SET id=? WHERE id=?').bind(-(i + 1), s.id)));
					sorted.forEach((s, i) => batch.push(db.prepare('UPDATE ips SET id=? WHERE id=?').bind(i + 1, -(i + 1))));
					await saveTask(kv, taskId, 'running', '更新数据库');
					await execBatches(db, batch);
					await saveTask(kv, taskId, 'completed', '排序完成');
				} catch (e) {
					await saveTask(kv, taskId, 'failed', e.message);
					console.error('Sort:', e);
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
					const { results } = await db.prepare('SELECT id,ip,name,active,priority FROM ips').all();
					await saveTask(kv, taskId, 'running', '按优先级排序中');
					const sorted = results.sort((a, b) => {
						if (a.priority !== b.priority) return a.priority - b.priority;
						return a.id - b.id;
					});
					const batch = [];
					sorted.forEach((s, i) => batch.push(db.prepare('UPDATE ips SET id=? WHERE id=?').bind(-(i + 1), s.id)));
					sorted.forEach((s, i) => batch.push(db.prepare('UPDATE ips SET id=? WHERE id=?').bind(i + 1, -(i + 1))));
					await saveTask(kv, taskId, 'running', '更新数据库');
					await execBatches(db, batch);
					await saveTask(kv, taskId, 'completed', '按优先级排序完成');
				} catch (e) {
					await saveTask(kv, taskId, 'failed', e.message);
					console.error('Sort by priority:', e);
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
					await saveTask(kv, taskId, 'running', '查找重复数据');
					const { results } = await db.prepare('SELECT id, ip FROM ips').all();
					
					if (results.length === 0) {
						await saveTask(kv, taskId, 'completed', '没有发现重复数据');
						return;
					}

					// 根据纯IP地址分组（忽略端口）
					const ipGroups = {};
					results.forEach(row => {
						const pureIP = extractPureIP(row.ip);
						if (!ipGroups[pureIP]) {
							ipGroups[pureIP] = [];
						}
						ipGroups[pureIP].push(row);
					});

					// 找出重复的IP组
					const duplicateGroups = Object.values(ipGroups).filter(group => group.length > 1);
					
					if (duplicateGroups.length === 0) {
						await saveTask(kv, taskId, 'completed', '没有发现重复数据');
						return;
					}

					await saveTask(kv, taskId, 'running', `发现 ${duplicateGroups.length} 组重复IP，正在清理`);
					
					const batch = [];
					let totalDuplicates = 0;
					
					for (const group of duplicateGroups) {
						// 按ID排序，保留第一个（最早的）记录，删除其他重复项
						group.sort((a, b) => a.id - b.id);
						const keepId = group[0].id;
						const deleteIds = group.slice(1).map(item => item.id);
						
						totalDuplicates += deleteIds.length;
						
						for (const deleteId of deleteIds) {
							batch.push(db.prepare('DELETE FROM ips WHERE id=?').bind(deleteId));
						}
					}

					if (batch.length > 0) {
						await execBatches(db, batch);
						await saveTask(kv, taskId, 'completed', `成功删除 ${totalDuplicates} 条重复数据，保留 ${duplicateGroups.length} 个唯一IP`);
					} else {
						await saveTask(kv, taskId, 'completed', '重复数据清理完成');
					}
				} catch (e) {
					await saveTask(kv, taskId, 'failed', e.message);
					console.error('Remove duplicates:', e);
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
					const { results } = await db.prepare('SELECT id,ip,name,active,priority FROM ips ORDER BY id').all();
					await saveTask(kv, taskId, 'running', '分组处理');
					const processed = results.map((r) => ({ ...r, ...parseIP(r.ip), region: extractRegion(r.name || '') }));
					const grouped = {};
					processed.forEach((ip) => {
						const reg = ip.region || 'OTHER';
						if (!grouped[reg]) grouped[reg] = [];
						grouped[reg].push(ip);
					});
					let prio = 1;
					const batch = Object.keys(grouped)
						.sort((a, b) => {
							const ai = a === 'OTHER' ? REGIONS.length : REGIONS.indexOf(a);
							const bi = b === 'OTHER' ? REGIONS.length : REGIONS.indexOf(b);
							return ai - bi;
						})
						.flatMap((reg) =>
							grouped[reg]
								.sort((a, b) => a.id - b.id)
								.map((ip) => db.prepare('UPDATE ips SET priority=? WHERE id=?').bind(prio++, ip.id))
						);
					await saveTask(kv, taskId, 'running', '更新优先级');
					await execBatches(db, batch);
					await saveTask(kv, taskId, 'completed', '优先级调整完成');
				} catch (e) {
					await saveTask(kv, taskId, 'failed', e.message);
					console.error('Reorder:', e);
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
					await db.prepare('UPDATE ips SET active=?').bind(active).run();
					await saveTask(kv, taskId, 'completed', '更新完成');
				} catch (e) {
					await saveTask(kv, taskId, 'failed', e.message);
					console.error('Toggle:', e);
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
					console.error('Clear:', e);
				}
			})()
		);
		return json({ success: true, async: true, taskId });
	},

	async updateIp(db, id, body) {
		const updates = [],
			binds = [];
		if ('active' in body) {
			updates.push('active=?');
			binds.push(body.active);
		}
		if ('ip' in body) {
			const formatted = formatIP(body.ip);
			if (!formatted) return err('IP格式错误');
			const [ipPort, name] = formatted.split('#');
			updates.push('ip=?,name=?');
			binds.push(ipPort, name || null);
		}
		if ('priority' in body) {
			const newPriority = body.priority;
			const [current, conflict] = await Promise.all([
				db.prepare('SELECT priority FROM ips WHERE id=?').bind(id).first(),
				db.prepare('SELECT id FROM ips WHERE priority=? AND id!=?').bind(newPriority, id).first(),
			]);
			if (conflict) {
				await db.batch([
					db.prepare('UPDATE ips SET priority=? WHERE id=?').bind(current.priority, conflict.id),
					db.prepare('UPDATE ips SET priority=? WHERE id=?').bind(newPriority, id),
				]);
				return json({ success: true, swapped: true });
			}
			updates.push('priority=?');
			binds.push(newPriority);
		}
		if (updates.length) {
			binds.push(id);
			await db.prepare(`UPDATE ips SET ${updates.join(',')} WHERE id=?`).bind(...binds).run();
		}
		return json({ success: true });
	},

	async deleteIp(db, id) {
		await db.prepare('DELETE FROM ips WHERE id=?').bind(id).run();
		return json({ success: true });
	},

	async initDb(db) {
		await db.batch([
			db.prepare('CREATE TABLE IF NOT EXISTS ips(id INTEGER PRIMARY KEY AUTOINCREMENT,ip TEXT UNIQUE NOT NULL,name TEXT,active INTEGER DEFAULT 1,priority INTEGER DEFAULT 0)'),
			db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_ips_ip ON ips(ip)'),
			db.prepare('CREATE INDEX IF NOT EXISTS idx_ips_active ON ips(active)'),
			db.prepare('CREATE INDEX IF NOT EXISTS idx_ips_priority ON ips(priority)'),
		]);
		return json({ success: true });
	},
};

const route = async (path, method, db, body, params, ctx, kv) => {
	try {
		if (path === '/ips' && method === 'GET') return api.getIps(db, params);
		if (path === '/ips/stats' && method === 'GET') return api.getStats(db);
		if (path === '/ips' && method === 'POST') return api.addIp(db, body);
		if (path === '/ips/batch' && method === 'POST') return api.batchImport(db, body, ctx, kv);
		if (path === '/ips/batch-delete' && method === 'POST') return api.batchDelete(db, body, ctx, kv);
		if (path === '/ips/sort' && method === 'POST') return api.sortIps(db, ctx, kv);
		if (path === '/ips/sort-priority' && method === 'POST') return api.sortByPriority(db, ctx, kv);
		if (path === '/ips/remove-duplicates' && method === 'POST') return api.removeDuplicates(db, ctx, kv);
		if (path === '/ips/reorder-priority' && method === 'POST') return api.reorderPriority(db, ctx, kv);
		if (path === '/ips/toggle-all' && method === 'POST') return api.toggleAll(db, body, ctx, kv);
		if (path === '/ips/clear' && method === 'DELETE') return api.clearAll(db, ctx, kv);
		if (path === '/init' && method === 'POST') return api.initDb(db);
		const taskMatch = path.match(/^\/task\/([a-f0-9-]+)$/);
		if (taskMatch && method === 'GET') return api.getTaskStatus(kv, taskMatch[1]);
		const idMatch = path.match(/^\/ips\/(\d+)$/);
		if (idMatch) {
			if (method === 'PUT') return api.updateIp(db, idMatch[1], body);
			if (method === 'DELETE') return api.deleteIp(db, idMatch[1]);
		}
		return new Response(null, { status: 404 });
	} catch (e) {
		console.error(e);
		return err(e.message, 500);
	}
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
			<button class="purple" onclick="sortByRegion()">地区排序</button>
			<button class="purple" onclick="reorderPriority()">优先级调整</button>
			<button class="purple" onclick="sortByPriority()">优先级排序</button>
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

export default {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);
		const { pathname, searchParams } = url;

		if (pathname === '/') return new Response(getHTML(), { headers: { 'Content-Type': 'text/html;charset=utf-8' } });

		if (pathname === '/Vless') {
			const host = searchParams.get('host') || HOST;
			const cacheKey = new Request(url, req);
			const cache = caches.default;
			let res = await cache.match(cacheKey);
			if (res) return res;
			const { results } = await env.DB.prepare('SELECT ip,name FROM ips WHERE active=1 ORDER BY priority,id LIMIT ?').bind(MAX_VLESS).all();
			const links = results.map((ip) => generateVless(ip, host)).join('\n');
			res = new Response(links || '暂无节点', { headers: { 'Content-Type': 'text/plain;charset=utf-8', 'Cache-Control': 'public,max-age=60' } });
			ctx.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
			return res;
		}

		if (pathname.startsWith('/api')) {
			const body = req.method !== 'GET' && req.method !== 'DELETE' ? await req.json().catch(() => ({})) : {};
			return route(pathname.slice(4), req.method, env.DB, body, searchParams, ctx, env.TASK_KV);
		}

		return new Response(null, { status: 404 });
	},
};
