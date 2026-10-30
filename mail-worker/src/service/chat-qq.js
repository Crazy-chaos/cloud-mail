/**
 * QQ 官方机器人（q.qq.com / bot.q.qq.com）
 *
 * 与个人号协议（OneBot）的区别：
 * - 不需要挂进程，腾讯托管
 * - 拿不到真实 QQ 号，只有按机器人隔离的 openid，所以绑定要走「验证码」流程
 * - 主动消息受用户端的「允许主动发送」开关约束
 */

import { db, now } from './chat-core';

const te = new TextEncoder();

let tokenCache = null; // { token, expireAt }
export function resetTokenCache() { tokenCache = null; }

/** 从 D1 读配置，避免把 AppSecret 写进仓库 */
export async function qqConfig(c) {
	const rows = await db.all(c,
		"SELECT k, v FROM chat_setting WHERE k IN ('qq_app_id','qq_app_secret','qq_bot_secret','qq_bot_uin')");
	const map = {};
	for (const r of rows) map[r.k] = r.v;
	return {
		appId: map.qq_app_id || '',
		appSecret: map.qq_app_secret || '',
		botSecret: map.qq_bot_secret || '',
		botUin: map.qq_bot_uin || ''
	};
}

export async function getAccessToken(c) {
	if (tokenCache && tokenCache.expireAt > now() + 120_000) return tokenCache.token;
	const cfg = await qqConfig(c);
	if (!cfg.appId || !cfg.appSecret) throw new Error('未配置 QQ 机器人 AppID / AppSecret');

	const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ appId: cfg.appId, clientSecret: cfg.appSecret })
	});
	const data = await res.json().catch(() => ({}));
	if (!data.access_token) {
		throw new Error('获取 QQ access_token 失败：' + (data.message || ('HTTP ' + res.status)));
	}
	tokenCache = {
		token: data.access_token,
		expireAt: now() + Number(data.expires_in || 7200) * 1000
	};
	return tokenCache.token;
}

/**
 * 给用户发私聊。
 * msgId 是用户那条消息的 id —— 带上就是「被动回复」（60 分钟内有效、免开关）；
 * 不带就是「主动消息」（要求用户没关「允许主动发送」）。
 */
export async function sendQQPrivate(c, openid, content, msgId) {
	if (!openid) return { ok: false, message: '缺少 openid' };
	const token = await getAccessToken(c);
	const body = { content: String(content).slice(0, 900), msg_type: 0 };
	if (msgId) {
		body.msg_id = String(msgId);
		body.msg_seq = 1;
	}
	const res = await fetch(
		`https://api.sgroup.qq.com/v2/users/${encodeURIComponent(openid)}/messages`,
		{
			method: 'POST',
			headers: { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(8000)
		}
	);
	const text = await res.text().catch(() => '');
	if (!res.ok) console.warn('[qq] send', res.status, text.slice(0, 160));
	return { ok: res.ok, status: res.status, detail: text.slice(0, 200) };
}

// ---------------------------------------------------------------- 签名

function hexToBytes(hex) {
	const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
	const out = new Uint8Array(clean.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
	return out;
}

function bytesToHex(bytes) {
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** BotSecret 重复拼接成 32 字节种子，导出 Ed25519 密钥 */
async function seedKey(secret, usage) {
	const repeated = secret.repeat(Math.ceil(32 / secret.length)).slice(0, 32);
	return crypto.subtle.importKey('raw', te.encode(repeated), { name: 'Ed25519' }, false, usage);
}

/** 校验回调签名：签名对象是 timestamp + 原始 body */
export async function verifyCallback(c, signature, timestamp, rawBody) {
	const cfg = await qqConfig(c);
	if (!cfg.botSecret) return { ok: true, skipped: true };
	if (!signature || !timestamp) return { ok: false, reason: 'no-signature' };
	try {
		const key = await seedKey(cfg.botSecret, ['verify']);
		const ok = await crypto.subtle.verify(
			{ name: 'Ed25519' }, key, hexToBytes(signature), te.encode(timestamp + rawBody));
		return { ok };
	} catch (e) {
		return { ok: false, reason: e.message };
	}
}

/** 回调地址验证（op=13）：用同一把种子对 ts + plain_token 签名 */
export async function signPlainToken(c, plainToken, eventTs) {
	const cfg = await qqConfig(c);
	if (!cfg.botSecret) throw new Error('未配置 BotSecret：开放平台 → 开发 → 开发设置 → 机器人密钥');
	const key = await seedKey(cfg.botSecret, ['sign']);
	const sig = await crypto.subtle.sign(
		{ name: 'Ed25519' }, key, te.encode(String(eventTs) + String(plainToken)));
	return bytesToHex(new Uint8Array(sig));
}

/** 签名自检：对固定字符串签名并立即验签，用来确认 BotSecret 可用 */
export async function selfCheckSign(c) {
	const cfg = await qqConfig(c);
	if (!cfg.botSecret) return { ok: false, reason: '未配置 BotSecret' };
	try {
		const signer = await seedKey(cfg.botSecret, ['sign']);
		const verifier = await seedKey(cfg.botSecret, ['verify']);
		const msg = te.encode('1710000000' + 'selftest');
		const sig = await crypto.subtle.sign({ name: 'Ed25519' }, signer, msg);
		const ok = await crypto.subtle.verify({ name: 'Ed25519' }, verifier, sig, msg);
		return { ok, secretLen: cfg.botSecret.length };
	} catch (e) {
		return { ok: false, reason: e.message };
	}
}

// ---------------------------------------------------------------- 绑定

export function genBindCode() {
	const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000;
	return String(n).padStart(6, '0');
}

export async function setBindCode(c, userId) {
	const code = genBindCode();
	await db.run(c,
		`INSERT INTO chat_profile (user_id, qq_bind_code, qq_bind_at, updated_at)
		 VALUES (?,?,?,?)
		 ON CONFLICT(user_id) DO UPDATE SET qq_bind_code = excluded.qq_bind_code,
		   qq_bind_at = excluded.qq_bind_at, updated_at = excluded.updated_at`,
		Number(userId), code, now(), now());
	return code;
}

/** 用户私聊机器人发送绑定码时调用 */
export async function bindByCode(c, openid, code) {
	const clean = String(code || '').replace(/\D/g, '').slice(0, 6);
	if (clean.length !== 6) return null;
	const row = await db.first(c,
		'SELECT user_id, qq_bind_at FROM chat_profile WHERE qq_bind_code = ?', clean);
	if (!row) return null;
	// 绑定码 15 分钟内有效
	if (now() - Number(row.qq_bind_at || 0) > 15 * 60_000) return null;

	await db.run(c,
		`UPDATE chat_profile SET qq_openid = ?, qq_bind_code = '', qq_bind_at = ?, updated_at = ?
		 WHERE user_id = ?`, String(openid), now(), now(), Number(row.user_id));
	return { userId: Number(row.user_id) };
}

export async function unbind(c, userId) {
	await db.run(c,
		`UPDATE chat_profile SET qq_openid = '', qq_bind_code = '', updated_at = ? WHERE user_id = ?`,
		now(), Number(userId));
}
