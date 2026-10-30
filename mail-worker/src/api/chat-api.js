/**
 * 聊天组 HTTP 路由
 *
 * 前缀 /chat（对外是 /api/chat/*）。
 * 鉴权由 security.js 的「可选鉴权」分支完成：登录了就有 c.get('user')，游客则为空。
 * 因此这里可以同一套路由同时服务游客与登录用户，由业务层判断权限。
 */

import app from '../hono/hono';
import BizError from '../error/biz-error';
import chatService from '../service/chat-service';
import { dispatchNotify, inboundFromQQ, callOneBot, pumpBots } from '../service/chat-bot';
import { pushToUsers, loadVapid, sendPush } from '../service/chat-push';
import {
	qqConfig, getAccessToken, sendQQPrivate, verifyCallback, signPlainToken,
	setBindCode, bindByCode, unbind, resetTokenCache, selfCheckSign
} from '../service/chat-qq';
import {
	currentUser, requireUser, isSiteAdmin, clampStr, toInt, now, uid, sha256Hex,
	ensureSchema, convRow, getProfile, setProfile, audit, rateLimit,
	putBlob, getBlob, mimeOf, sniffImage, blobExtFor, assertR2, db
} from '../service/chat-core';

// ---------------------------------------------------------------- 包装

const route = handler => async (c) => {
	try {
		await ensureSchema(c);
		const data = await handler(c);
		if (data instanceof Response) return data;
		return c.json({ code: 200, message: 'success', data: data === undefined ? null : data });
	} catch (e) {
		const raw = Number(e && e.code);
		const status = raw >= 400 && raw <= 599 ? raw : 500;
		if (status >= 500) console.error('[chat]', c.req.method, c.req.path, e && e.stack || e);
		return c.json({ code: status, message: (e && e.message) || '服务器内部错误' }, status);
	}
};

const adminOnly = c => {
	const user = requireUser(c);
	if (!isSiteAdmin(c, user)) throw new BizError('仅管理员可访问', 403);
	return user;
};

const json = async c => {
	try { return await c.req.json(); } catch { return {}; }
};

const viewerId = c => {
	const u = currentUser(c);
	return u ? u.userId : null;
};

// ---------------------------------------------------------------- 健康检查

app.get('/chat/health', route(async c => ({
	ok: true,
	runtime: 'cloudflare-workers',
	time: now(),
	r2: Boolean(c.env.r2),
	d1: Boolean(c.env.db)
})));

// ---------------------------------------------------------------- 我

app.get('/chat/me', route(async c => {
	const user = requireUser(c);
	const prof = await getProfile(c, user.userId);
	if (Number(prof.banned) === 1) throw new BizError('账号已被封禁', 403);
	return {
		user: {
			id: user.email,
			uid: user.userId,
			nickname: user.nickname || user.email.split('@')[0],
			avatar: prof.avatar || '',
			qq: prof.qq || '',
			role: 'user',
			banned: false,
			pubKey: prof.pubKey || null
		},
		isAdmin: isSiteAdmin(c, user),
		hasKey: Boolean(prof.pubKey),
		hasBackup: Boolean(prof.keyBackup),
		qqBound: Boolean(prof.qqOpenid)
	};
}));

app.post('/chat/me/keys', route(async c => {
	const user = requireUser(c);
	const body = await json(c);
	const pubKey = clampStr(body.pubKey, 4096);
	const backup = typeof body.keyBackup === 'string' ? body.keyBackup.slice(0, 200_000) : null;
	if (!pubKey && !backup) throw new BizError('缺少参数', 400);

	const prof = await getProfile(c, user.userId);
	if (pubKey && prof.pubKey && prof.pubKey !== pubKey && now() - Number(prof.keyUpdatedAt || 0) < 10 * 60_000) {
		throw new BizError('密钥更换过于频繁，请稍后再试', 429);
	}
	const patch = {};
	if (pubKey) { patch.pubKey = pubKey; patch.keyUpdatedAt = now(); }
	if (backup) patch.keyBackup = backup;
	await setProfile(c, user.userId, patch);
	return { saved: true };
}));

app.get('/chat/me/keybackup', route(async c => {
	const user = requireUser(c);
	const prof = await getProfile(c, user.userId);
	return { keyBackup: prof.keyBackup || null };
}));

app.post('/chat/me/qq', route(async c => {
	const user = requireUser(c);
	const body = await json(c);
	const qq = clampStr(body.qq, 20);
	if (qq !== '' && !/^\d{5,12}$/.test(qq)) throw new BizError('QQ 号格式不正确', 400);
	await setProfile(c, user.userId, { qq });
	await audit(c, user.userId, 'user.qq', String(user.userId), { qq });
	return { qq };
}));

// ---------------------------------------------------------------- 头像

const AVATAR_RE = /^\/api\/chat\/avatar\/[A-Za-z0-9._-]{1,80}$/;

app.post('/chat/me/avatar', route(async c => {
	const user = requireUser(c);
	const body = await json(c);
	const raw = clampStr(body.avatar, 400);
	const builtin = /^\/123\/emoji_([1-9]|1\d|2[0-4])\.(webp|avif)$/.test(raw);
	const uploaded = AVATAR_RE.test(raw);
	const remote = raw === '' || (raw.startsWith('https://') && !/[\s"']/.test(raw) && raw.length <= 300);
	if (raw !== '' && !builtin && !uploaded && !remote) {
		throw new BizError('只支持站内 emoji 头像、上传的图片或 https 地址', 400);
	}
	await setProfile(c, user.userId, { avatar: raw });
	await audit(c, user.userId, 'user.avatar', String(user.userId), { builtin, uploaded, remote });
	const prof = await getProfile(c, user.userId);
	return {
		id: user.email, uid: user.userId,
		nickname: user.nickname || user.email.split('@')[0],
		avatar: prof.avatar || '', qq: prof.qq || '', role: 'user', banned: false, pubKey: prof.pubKey || null
	};
}));

app.post('/chat/me/avatar/upload', route(async c => {
	const user = requireUser(c);
	assertR2(c);
	const declared = Number(c.req.header('content-length') || 0);
	if (declared > 2 * 1024 * 1024) throw new BizError('图片请控制在 2MB 以内', 413);
	const buf = new Uint8Array(await c.req.arrayBuffer());
	if (!buf.length) throw new BizError('没有收到文件', 400);
	if (buf.length > 2 * 1024 * 1024) throw new BizError('图片请控制在 2MB 以内', 413);
	const ext = sniffImage(buf);
	if (!ext) throw new BizError('只支持 png / jpg / webp / gif', 400);
	if (!await rateLimit(c, 'av:' + user.userId, 10, 300)) throw new BizError('上传太频繁，稍后再试', 429);

	const name = (await sha256Hex(buf)).slice(0, 32) + '.' + ext;
	await putBlob(c, 'avatars/' + name, buf, mimeOf(name));
	const value = '/api/chat/avatar/' + name;
	await audit(c, user.userId, 'avatar.upload', String(user.userId), { name, bytes: buf.length });
	return { avatar: value, bytes: buf.length };
}));

app.get('/chat/avatar/:name', route(async c => {
	const name = c.req.param('name');
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(name) || name.includes('..')) throw new BizError('bad name', 400);
	const blob = await getBlob(c, 'avatars/' + name);
	if (!blob) throw new BizError('not found', 404);
	return new Response(blob.body, {
		headers: {
			'Content-Type': mimeOf(name),
			'Cache-Control': 'public, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff'
		}
	});
}));

// ---------------------------------------------------------------- 图片上传与读取

app.post('/chat/upload', route(async c => {
	const user = requireUser(c);
	assertR2(c);
	const convId = clampStr(c.req.query('conv') || '', 64);
	const conv = await convRow(c, convId);
	if (!conv) throw new BizError('会话不存在', 404);
	const me = await db.first(c, 'SELECT * FROM chat_member WHERE conv_id = ? AND user_id = ?', conv.id, user.userId);
	if (!me || me.status !== 'active') throw new BizError('只有群成员可以上传', 403);
	if (Number(conv.archived) === 1) throw new BizError('群组已解散', 400);
	if (!await rateLimit(c, 'up:' + user.userId, 20, 60)) throw new BizError('上传太频繁，缓一下', 429);

	const declared = Number(c.req.header('content-length') || 0);
	if (declared > 5 * 1024 * 1024) throw new BizError('单张图片请控制在 5MB 以内', 413);
	const buf = new Uint8Array(await c.req.arrayBuffer());
	if (!buf.length) throw new BizError('没有收到内容', 400);
	if (buf.length > 5 * 1024 * 1024) throw new BizError('单张图片请控制在 5MB 以内', 413);

	const ctype = String(c.req.header('content-type') || 'application/octet-stream');
	const isCipher = ctype.startsWith('application/octet-stream');
	if (!isCipher) {
		if (!sniffImage(buf)) throw new BizError('只支持 png / jpg / webp / gif', 400);
	} else if (conv.enc_mode !== 'e2ee') {
		throw new BizError('明文群请直接上传图片', 400);
	}

	const ext = blobExtFor(ctype);
	const key = conv.id + '/' + crypto.randomUUID().replace(/-/g, '').slice(0, 20) + '.' + ext;
	await putBlob(c, key, buf, isCipher ? 'application/octet-stream' : mimeOf(key));
	return { key, size: buf.length, enc: isCipher };
}));

app.get('/chat/blob/*', route(async c => {
	const key = decodeURIComponent(c.req.path.replace(/^.*?\/chat\/blob\//, ''));
	if (!key || key.includes('..')) throw new BizError('bad key', 400);
	const convId = key.split('/')[0];
	const conv = await convRow(c, convId);
	if (!conv) throw new BizError('不存在', 404);

	const me = viewerId(c);
	const readable = (conv.type === 'group' && conv.visibility === 'public'
		&& conv.enc_mode === 'plain' && Number(conv.archived) === 0)
		|| Boolean(me && await db.first(c, `SELECT 1 AS ok FROM chat_member
			WHERE conv_id = ? AND user_id = ? AND status = 'active'`, conv.id, me));
	if (!readable) throw new BizError('无权读取', 403);

	const blob = await getBlob(c, key);
	if (!blob) throw new BizError('文件不存在', 404);
	return new Response(blob.body, {
		headers: {
			'Content-Type': mimeOf(key),
			'Cache-Control': 'private, max-age=31536000, immutable',
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "default-src 'none'; sandbox"
		}
	});
}));

// ---------------------------------------------------------------- 浏览器推送

app.get('/chat/push/config', route(async c => {
	const vapid = await loadVapid(c);
	return { publicKey: vapid.publicB64u };
}));

app.post('/chat/push/subscribe', route(async c => {
	const user = requireUser(c);
	const body = await json(c);
	const sub = body.subscription;
	if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
		throw new BizError('订阅数据不完整', 400);
	}
	if (String(sub.endpoint).length > 800) throw new BizError('订阅地址过长', 400);
	await db.run(c, `INSERT INTO chat_push_sub (endpoint, user_id, p256dh, auth, ua, created_at)
		VALUES (?,?,?,?,?,?)
		ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh,
			auth = excluded.auth, ua = excluded.ua`,
		String(sub.endpoint), user.userId, String(sub.keys.p256dh), String(sub.keys.auth),
		clampStr(c.req.header('user-agent') || '', 120), now());
	return { subscribed: true };
}));

app.delete('/chat/push/subscribe', route(async c => {
	const user = requireUser(c);
	const body = await json(c);
	const endpoint = clampStr(body.endpoint, 800);
	if (endpoint) await db.run(c, 'DELETE FROM chat_push_sub WHERE endpoint = ? AND user_id = ?', endpoint, user.userId);
	return { removed: true };
}));

app.post('/chat/push/test', route(async c => {
	const user = requireUser(c);
	const subs = await db.all(c, 'SELECT * FROM chat_push_sub WHERE user_id = ?', user.userId);
	if (!subs.length) throw new BizError('还没有订阅，请先开启通知', 400);
	const results = [];
	for (const sb of subs) {
		const r = await sendPush(c, sb, {
			title: '聊天组测试通知',
			body: '如果你看到这条，说明推送链路通了 🎉',
			url: '/chat/'
		});
		if (r.gone) await db.run(c, 'DELETE FROM chat_push_sub WHERE endpoint = ?', sb.endpoint);
		results.push({
			endpoint: String(sb.endpoint).slice(0, 48),
			ok: Boolean(r.ok),
			status: r.status || 0,
			detail: r.detail || r.message || ''
		});
	}
	return { sent: subs.length, ok: results.filter(r => r.ok).length, results };
}));

// ---------------------------------------------------------------- 会话

app.get('/chat/conversations', route(async c => {
	const user = requireUser(c);
	return await chatService.listMine(c, user.userId);
}));

app.get('/chat/public/groups', route(async c => {
	return await chatService.discover(c, viewerId(c), c.req.query('q'), c.req.query('limit'));
}));

app.get('/chat/users/search', route(async c => {
	const user = requireUser(c);
	return await chatService.searchUsers(c, user, c.req.query('q'));
}));

// 取对方的 ECDH 公钥（私聊 / 群密钥包裹用）
app.get('/chat/users/:id/pubkey', route(async c => {
	requireUser(c);
	const raw = String(c.req.param('id') || '');
	const u = /^\d{1,12}$/.test(raw)
		? await db.first(c, 'SELECT user_id, email, nickname FROM user WHERE user_id = ?', Number(raw))
		: await db.first(c, 'SELECT user_id, email, nickname FROM user WHERE LOWER(email) = ?', raw.toLowerCase());
	if (!u) throw new BizError('用户不存在', 404);
	const prof = await getProfile(c, Number(u.user_id));
	return {
		id: String(u.email).toLowerCase(),
		uid: Number(u.user_id),
		nickname: u.nickname || String(u.email).split('@')[0],
		pubKey: prof.pubKey || null
	};
}));

app.post('/chat/conversations', route(async c => {
	const user = requireUser(c);
	return await chatService.createGroup(c, user, await json(c));
}));

app.post('/chat/dm', route(async c => {
	const user = requireUser(c);
	return await chatService.openDM(c, user, await json(c));
}));

app.get('/chat/conversations/:id', route(async c => {
	return await chatService.detail(c, c.req.param('id'), viewerId(c));
}));

app.patch('/chat/conversations/:id', route(async c => {
	const user = requireUser(c);
	return await chatService.updateConversation(c, user, c.req.param('id'), await json(c), isSiteAdmin(c, user));
}));

app.delete('/chat/conversations/:id', route(async c => {
	const user = requireUser(c);
	return await chatService.archive(c, user, c.req.param('id'), isSiteAdmin(c, user));
}));

app.post('/chat/conversations/:id/join', route(async c => {
	const user = requireUser(c);
	return await chatService.join(c, user, c.req.param('id'), await json(c));
}));

app.get('/chat/conversations/:id/requests', route(async c => {
	const user = requireUser(c);
	return await chatService.pendingList(c, user, c.req.param('id'), isSiteAdmin(c, user));
}));

app.post('/chat/conversations/:id/requests', route(async c => {
	const user = requireUser(c);
	return await chatService.review(c, user, c.req.param('id'), await json(c), isSiteAdmin(c, user));
}));

app.post('/chat/conversations/:id/members', route(async c => {
	const user = requireUser(c);
	return await chatService.addMember(c, user, c.req.param('id'), await json(c), isSiteAdmin(c, user));
}));

app.post('/chat/conversations/:id/members/:uid/role', route(async c => {
	const user = requireUser(c);
	return await chatService.setRole(c, user, c.req.param('id'), c.req.param('uid'), await json(c), isSiteAdmin(c, user));
}));

app.post('/chat/conversations/:id/kick', route(async c => {
	const user = requireUser(c);
	return await chatService.kick(c, user, c.req.param('id'), await json(c), isSiteAdmin(c, user));
}));

app.post('/chat/conversations/:id/leave', route(async c => {
	const user = requireUser(c);
	return await chatService.leave(c, user, c.req.param('id'));
}));

app.get('/chat/conversations/:id/invites', route(async c => {
	const user = requireUser(c);
	return await chatService.listInvites(c, user, c.req.param('id'), isSiteAdmin(c, user));
}));

app.post('/chat/conversations/:id/invites', route(async c => {
	const user = requireUser(c);
	return await chatService.createInvite(c, user, c.req.param('id'), await json(c), isSiteAdmin(c, user));
}));

app.get('/chat/conversations/:id/my-qq', route(async c => {
	const user = requireUser(c);
	return await chatService.getMyQQ(c, user, c.req.param('id'));
}));

app.post('/chat/conversations/:id/my-qq', route(async c => {
	const user = requireUser(c);
	return await chatService.setMyQQ(c, user, c.req.param('id'), await json(c));
}));

app.post('/chat/conversations/:id/notify', route(async c => {
	const user = requireUser(c);
	return await chatService.bindNotify(c, user, c.req.param('id'), await json(c), isSiteAdmin(c, user));
}));

// ---------------------------------------------------------------- 消息

app.get('/chat/conversations/:id/messages', route(async c => {
	return await chatService.messages(c, c.req.param('id'), viewerId(c), {
		before: c.req.query('before'),
		after: c.req.query('after'),
		limit: c.req.query('limit')
	});
}));

app.post('/chat/conversations/:id/messages', route(async c => {
	const user = requireUser(c);
	const convId = c.req.param('id');
	const conv = await convRow(c, convId);
	if (!conv) throw new BizError('会话不存在', 404);

	const msg = await chatService.sendMessage(c, user, convId, await json(c));

	// 提醒与推送不阻塞响应
	const tasks = [];
	tasks.push(dispatchNotify(c, conv, msg, msg.senderName));
	tasks.push((async () => {
		const targets = await db.all(c, `SELECT user_id FROM chat_member
			WHERE conv_id = ? AND status = 'active' AND user_id <> ?`, conv.id, user.userId);
		const ids = targets.map(t => Number(t.user_id));
		if (!ids.length) return;
		const isE2EE = conv.enc_mode === 'e2ee';
		const title = conv.type === 'dm' ? `💬 ${msg.senderName}` : `💬 ${conv.name || '聊天组'}`;
		const body = isE2EE
			? (conv.type === 'dm' ? '给你发了一条加密消息' : `${msg.senderName} 发了新消息（加密）`)
			: `${msg.senderName}：${msg.body && msg.body.text ? String(msg.body.text).slice(0, 120) : ''}`;
		await pushToUsers(c, ids, { title, body, url: '/chat/?conv=' + encodeURIComponent(conv.id) });
	})());
	if (c.executionCtx && c.executionCtx.waitUntil) {
		c.executionCtx.waitUntil(Promise.allSettled(tasks));
	} else {
		await Promise.allSettled(tasks);
	}

	return msg;
}));

app.post('/chat/conversations/:id/read', route(async c => {
	const user = requireUser(c);
	return await chatService.markRead(c, user, c.req.param('id'), await json(c));
}));

// ---------------------------------------------------------------- 群密钥

app.get('/chat/conversations/:id/keys/me', route(async c => {
	const user = requireUser(c);
	return await chatService.myKey(c, user, c.req.param('id'));
}));

app.get('/chat/conversations/:id/keys/members', route(async c => {
	const user = requireUser(c);
	return await chatService.keyMembers(c, user, c.req.param('id'));
}));

app.post('/chat/conversations/:id/keys', route(async c => {
	const user = requireUser(c);
	return await chatService.putKey(c, user, c.req.param('id'), await json(c));
}));

// ---------------------------------------------------------------- 举报

app.post('/chat/reports', route(async c => {
	const user = requireUser(c);
	return await chatService.report(c, user, await json(c));
}));

// ---------------------------------------------------------------- QQ 官方机器人

/** 生成 6 位绑定码：用户在 QQ 里私聊机器人发送这个码即可完成绑定 */
app.post('/chat/me/qq/bind-code', route(async c => {
	const user = requireUser(c);
	const code = await setBindCode(c, user.userId);
	const cfg = await qqConfig(c);
	return { code, botUin: cfg.botUin || '', expireIn: 900 };
}));

app.delete('/chat/me/qq/bind', route(async c => {
	const user = requireUser(c);
	await unbind(c, user.userId);
	return { unbound: true };
}));

app.get('/chat/admin/qq', route(async c => {
	adminOnly(c);
	const cfg = await qqConfig(c);
	return {
		appId: cfg.appId,
		botUin: cfg.botUin,
		hasSecret: Boolean(cfg.appSecret),
		hasBotSecret: Boolean(cfg.botSecret)
	};
}));

app.post('/chat/admin/qq', route(async c => {
	adminOnly(c);
	const body = await json(c);
	const pairs = [];
	if (body.appId !== undefined) pairs.push(['qq_app_id', clampStr(body.appId, 40)]);
	if (body.appSecret) pairs.push(['qq_app_secret', clampStr(body.appSecret, 120)]);
	if (body.botSecret) pairs.push(['qq_bot_secret', clampStr(body.botSecret, 120)]);
	if (body.botUin !== undefined) pairs.push(['qq_bot_uin', clampStr(body.botUin, 20)]);
	for (const [k, v] of pairs) {
		await db.run(c,
			'INSERT INTO chat_setting (k, v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
	}
	resetTokenCache();
	return { saved: true };
}));

app.post('/chat/admin/qq/test', route(async c => {
	adminOnly(c);
	const signed = await selfCheckSign(c);
	const token = await getAccessToken(c);
	const res = await fetch('https://api.sgroup.qq.com/users/@me', {
		headers: { Authorization: `QQBot ${token}` },
		signal: AbortSignal.timeout(8000)
	});
	const data = await res.json().catch(() => ({}));
	return {
		ok: res.ok,
		name: data.username || '',
		id: data.id || '',
		// 回调验证能否通过，取决于 BotSecret 是否配好且签名链正确
		callbackReady: Boolean(signed.ok),
		secretLen: signed.secretLen || 0,
		secretReason: signed.reason || ''
	};
}));

/**
 * QQ 开放平台回调。
 * 不走登录鉴权：靠 Ed25519 签名（BotSecret）校验来源。
 * 需要在开放平台把回调地址填成 /api/chat/qq/webhook 并订阅 C2C 事件。
 */
app.post('/chat/qq/webhook', async c => {
	const raw = await c.req.text();
	const signature = c.req.header('x-signature-ed25519');
	const timestamp = c.req.header('x-signature-timestamp');

	try {
		await ensureSchema(c);
	} catch (e) {
		return c.json({ code: 500, message: 'db not ready' }, 500);
	}

	const verdict = await verifyCallback(c, signature, timestamp, raw);
	if (!verdict.ok) {
		console.warn('[qq] 签名校验失败', verdict.reason || '');
		return c.json({ code: 401, message: 'invalid signature' }, 401);
	}

	let payload = {};
	try { payload = JSON.parse(raw); } catch { return c.json({ code: 400 }, 400); }

	// 回调地址验证
	if (payload.op === 13) {
		try {
			const signature2 = await signPlainToken(c, payload.d.plain_token, payload.d.event_ts);
			return c.json({ plain_token: payload.d.plain_token, signature: signature2 });
		} catch (e) {
			return c.json({ code: 500, message: e.message }, 500);
		}
	}

	// 用户打开了「允许主动发送」
	if (payload.t === 'C2C_MSG_RECEIVE') {
		return c.json({ code: 0 });
	}

	// 用户私聊机器人
	if (payload.t === 'C2C_MESSAGE_CREATE') {
		const d = payload.d || {};
		const openid = (d.author && (d.author.user_openid || d.author.id)) || '';
		const content = String(d.content || '').trim();
		const msgId = d.id;
		if (!openid) return c.json({ code: 0 });

		const m = content.match(/(\d{6})/);
		if (m) {
			const bound = await bindByCode(c, openid, m[1]);
			await sendQQPrivate(c, openid,
				bound
					? '绑定成功 ✅ 群里有新消息会在这里提醒你。'
					: '绑定码无效或已过期，回聊天页左下角 🔔 重新生成。',
				msgId);
		} else {
			await sendQQPrivate(c, openid,
				'发送 6 位绑定码即可绑定。绑定码在聊天页左下角 🔔 里生成。', msgId);
		}
		return c.json({ code: 0 });
	}

	return c.json({ code: 0 });
});

// ---------------------------------------------------------------- 机器人

app.get('/chat/bots', route(async c => {
	requireUser(c);
	return await chatService.listBots(c, true);
}));

app.post('/chat/bot/hook', route(async c => {
	const secret = clampStr(c.req.header('x-bot-secret') || '', 100);
	const msg = await inboundFromQQ(c, await json(c), secret);
	if (!msg) throw new BizError('无效的机器人密钥或参数', 401);
	return msg;
}));

app.get('/chat/admin/bots', route(async c => {
	adminOnly(c);
	return await chatService.listBots(c, false);
}));

app.post('/chat/admin/bots', route(async c => {
	const user = adminOnly(c);
	return await chatService.createBot(c, await json(c), user.userId);
}));

app.delete('/chat/admin/bots/:id', route(async c => {
	const user = adminOnly(c);
	return await chatService.deleteBot(c, c.req.param('id'), user.userId);
}));

app.post('/chat/admin/bots/:id/test', route(async c => {
	adminOnly(c);
	const bot = await db.first(c, 'SELECT * FROM chat_bot WHERE id = ?', c.req.param('id'));
	if (!bot) throw new BizError('机器人不存在', 404);
	return await callOneBot(bot, `【关注塔菲喵】机器人 ${bot.name} 连接测试成功 ✅`);
}));

app.get('/chat/admin/bot-queue', route(async c => {
	adminOnly(c);
	return await chatService.botQueue(c, c.req.query('convId'));
}));

app.get('/chat/admin/settings', route(async c => {
	adminOnly(c);
	return await chatService.getSettings(c);
}));

app.post('/chat/admin/settings', route(async c => {
	const user = adminOnly(c);
	return await chatService.saveSettings(c, await json(c), user.userId);
}));

// ---------------------------------------------------------------- 管理后台

app.get('/chat/admin/stats', route(async c => {
	adminOnly(c);
	return await chatService.adminStats(c);
}));

app.get('/chat/admin/users', route(async c => {
	adminOnly(c);
	return await chatService.adminUsers(c, c.req.query('q'));
}));

app.post('/chat/admin/users/:id', route(async c => {
	const user = adminOnly(c);
	return await chatService.adminSetUser(c, user.email, c.req.param('id'), await json(c));
}));

app.get('/chat/admin/groups', route(async c => {
	adminOnly(c);
	return await chatService.adminGroups(c, c.req.query('q'));
}));

app.post('/chat/admin/groups/:id', route(async c => {
	const user = adminOnly(c);
	return await chatService.adminSetGroup(c, c.req.param('id'), await json(c), user.email);
}));

app.get('/chat/admin/reports', route(async c => {
	adminOnly(c);
	return await chatService.adminReports(c);
}));

app.post('/chat/admin/reports/:id', route(async c => {
	adminOnly(c);
	return await chatService.adminSetReport(c, Number(c.req.param('id')), await json(c));
}));

app.get('/chat/admin/audit', route(async c => {
	adminOnly(c);
	return await chatService.adminAudit(c);
}));

// ---------------------------------------------------------------- 定时兜底

export async function pumpOnCron(env) {
	const fake = {
		env,
		executionCtx: { waitUntil: p => p },
		req: { method: 'CRON', path: '/chat' }
	};
	try {
		await ensureSchema(fake);
		await pumpBots(fake);
	} catch (e) {
		console.error('[chat] cron', e && e.message);
	}
}

export default app;
