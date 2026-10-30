/**
 * QQ 机器人（OneBot v11）通知队列
 *
 * 设计：消息落库后立刻入队，再用 ctx.waitUntil 立即推一次，cron 兜底重试。
 * 加密群只发「有新消息」，正文永不出服务器。
 */

import { db, now, safeParse, convRow, getProfile, getProfiles } from './chat-core';

export async function pickBot(c, conv) {
	if (conv.notify_bot_id) {
		const b = await db.first(c, 'SELECT * FROM chat_bot WHERE id = ? AND enabled = 1', conv.notify_bot_id);
		if (b) return b;
	}
	const def = await db.first(c, "SELECT v FROM chat_setting WHERE k = 'default_bot_id'");
	if (def && def.v) {
		const b = await db.first(c, 'SELECT * FROM chat_bot WHERE id = ? AND enabled = 1', def.v);
		if (b) return b;
	}
	const legacy = await db.first(c, 'SELECT * FROM chat_bot WHERE enabled = 1 AND conv_id = ? LIMIT 1', conv.id);
	if (legacy) return legacy;
	return await db.first(c, 'SELECT * FROM chat_bot WHERE enabled = 1 ORDER BY created_at ASC LIMIT 1');
}

/** 谁该被提醒：群里绑了 QQ 的成员（群内绑定优先，其次个人全站绑定）；私聊是对方 */
export async function notifyTargets(c, conv, senderId) {
	if (conv.type === 'dm') {
		const other = await db.first(c,
			'SELECT user_id FROM chat_member WHERE conv_id = ? AND user_id <> ? LIMIT 1', conv.id, senderId);
		if (!other) return [];
		const prof = await getProfile(c, Number(other.user_id));
		const qq = prof.qq ? String(prof.qq).trim() : '';
		return qq ? [{ userId: Number(other.user_id), qq }] : [];
	}
	const rows = await db.all(c, `SELECT mem.user_id, mem.qq AS member_qq
		FROM chat_member mem
		WHERE mem.conv_id = ? AND mem.status = 'active' AND mem.user_id <> ?`, conv.id, senderId);
	// 一次批量取个人 QQ（群内绑定优先，其次全站绑定）
	const profiles = await getProfiles(c, rows.map(r => Number(r.user_id)));
	const out = [];
	for (const r of rows) {
		let qq = (r.member_qq || '').trim();
		if (!qq) {
			const prof = profiles.get(Number(r.user_id)) || {};
			qq = prof.qq ? String(prof.qq).trim() : '';
		}
		if (qq) out.push({ userId: Number(r.user_id), qq });
	}
	return out;
}

async function pushQueue(c, bot, conv, msg, payload) {
	if (payload.kind === 'private') {
		// 同一个群对同一个人 90 秒内只提醒一次，避免刷屏
		const recent = await db.first(c,
			`SELECT id FROM chat_bot_queue WHERE conv_id = ? AND status = 'pending' AND payload LIKE ? AND created_at > ?`,
			conv.id, `%"userId":"${payload.userId}"%`, now() - 90_000);
		if (recent) return;
	}
	await db.run(c, `INSERT INTO chat_bot_queue (bot_id, conv_id, msg_id, payload, status, attempts, next_at, created_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		bot.id, conv.id, msg.id, JSON.stringify(payload), 'pending', 0, now(), now());
}

export async function callOneBot(bot, payload) {
	const p = typeof payload === 'string' ? { kind: 'group', text: payload } : (payload || {});
	const base = bot.endpoint ? bot.endpoint.replace(/\/+$/, '') : '';
	if (!base) return { ok: false, message: '未配置接口地址' };

	let url;
	let body;
	if (p.kind === 'private') {
		if (!p.userId) return { ok: false, message: '缺少 QQ 号' };
		url = `${base}/send_private_msg`;
		body = {
			user_id: /^\d+$/.test(String(p.userId)) ? Number(p.userId) : p.userId,
			message: [{ type: 'text', data: { text: p.text || '' } }]
		};
	} else {
		if (!bot.qq_group_id) return { ok: false, message: '未配置 QQ 群号' };
		url = `${base}/send_group_msg`;
		body = {
			group_id: Number(bot.qq_group_id) || bot.qq_group_id,
			message: [{ type: 'text', data: { text: p.text || '' } }]
		};
	}

	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				...(bot.token ? { Authorization: `Bearer ${bot.token}` } : {})
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(8000)
		});
		const raw = await res.text();
		return { ok: res.ok, status: res.status, body: raw.slice(0, 300) };
	} catch (e) {
		return { ok: false, message: e.message };
	}
}

/** 消息入库后调用：入队 + 立刻推一次 */
export async function dispatchNotify(c, conv, msg, senderName) {
	const bot = await pickBot(c, conv);
	if (!bot) return;
	const convName = conv.name || (conv.type === 'dm' ? '私信' : '聊天组');
	const text = msg.body && typeof msg.body.text === 'string' ? msg.body.text : '';

	// 1) 明文群 + 配了 QQ 群号：正文转到 QQ 群
	if (conv.type === 'group' && conv.enc_mode === 'plain' && bot.qq_group_id && text) {
		await pushQueue(c, bot, conv, msg, {
			kind: 'group',
			text: `【${convName}】${senderName}：${text.slice(0, 400)}`
		});
	}

	// 2) 私聊提醒：只说「有新消息」，加密内容永不出服务器
	const targets = await notifyTargets(c, conv, msg.senderId);
	for (const t of targets) {
		const body = conv.enc_mode === 'e2ee'
			? (conv.type === 'dm'
				? `【私信】${senderName} 给你发了一条加密消息`
				: `【${convName}】${senderName} 发了新消息（端到端加密，内容仅群内可见）`)
			: `【${convName}】${senderName}：${text.slice(0, 200)}`;
		await pushQueue(c, bot, conv, msg, { kind: 'private', userId: t.qq, toUser: t.userId, text: body });
	}

	await pumpBots(c);
}

/** 消费队列；失败按指数退避重排，7 次后判定失败 */
export async function pumpBots(c) {
	const rows = await db.all(c, `SELECT q.*, b.endpoint, b.token, b.qq_group_id, b.enabled
		FROM chat_bot_queue q JOIN chat_bot b ON b.id = q.bot_id
		WHERE q.status = 'pending' AND q.next_at <= ? ORDER BY q.id ASC LIMIT 15`, now());

	for (const row of rows) {
		if (!Number(row.enabled)) {
			await db.run(c, "UPDATE chat_bot_queue SET status = 'skipped' WHERE id = ?", row.id);
			continue;
		}
		if (!row.endpoint) {
			await db.run(c, "UPDATE chat_bot_queue SET status = 'failed', attempts = attempts + 1 WHERE id = ?", row.id);
			continue;
		}
		const payload = safeParse(row.payload);
		const result = await callOneBot({ endpoint: row.endpoint, token: row.token, qq_group_id: row.qq_group_id }, payload);
		if (result.ok) {
			await db.run(c, "UPDATE chat_bot_queue SET status = 'done', attempts = attempts + 1 WHERE id = ?", row.id);
		} else {
			const attempts = Number(row.attempts) + 1;
			const delay = Math.min(300_000, 5_000 * Math.pow(2, attempts));
			await db.run(c, 'UPDATE chat_bot_queue SET attempts = ?, next_at = ?, status = ? WHERE id = ?',
				attempts, now() + delay, attempts >= 7 ? 'failed' : 'pending', row.id);
		}
	}
}

/** QQ → 站内：验证机器人 secret 后写入明文公开群 */
export async function inboundFromQQ(c, body, secret) {
	const bot = await db.first(c, 'SELECT * FROM chat_bot WHERE secret = ? AND enabled = 1', secret);
	if (!bot) return null;
	const convId = String(body.convId || bot.conv_id || '').slice(0, 64);
	const text = String(body.text || '').slice(0, 1500);
	const sender = String(body.sender || 'QQ').slice(0, 32);
	if (!convId || !text) return null;

	const conv = await convRow(c, convId);
	if (!conv || conv.enc_mode !== 'plain') return null;

	const t = now();
	const info = await db.run(c, `INSERT INTO chat_message (conv_id, sender_id, kind, body, created_at)
		VALUES (?,?,?,?,?)`, convId, 0, 'text', JSON.stringify({ text: `${sender}：${text}` }), t);
	await db.run(c, 'UPDATE chat_conversation SET updated_at = ? WHERE id = ?', t, convId);
	return {
		id: Number(info.meta?.last_row_id || 0),
		convId,
		senderId: 0,
		senderName: '🤖 ' + bot.name,
		kind: 'text',
		body: { text: `${sender}：${text}` },
		createdAt: t
	};
}
