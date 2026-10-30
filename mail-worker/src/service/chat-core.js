/**
 * 聊天组底层：D1 / KV / R2 访问、身份解析、权限判断。
 *
 * 身份来源只有一个：D1 的 `user` 表（cloud-mail 原有账号表）。
 * 本文件不会写入任何账号字段；聊天自己的资料（头像、QQ、公钥）放在 KV。
 */

import BizError from '../error/biz-error';
import { DDL, SCHEMA_VERSION } from './chat-schema';

// ---------------------------------------------------------------- 基础工具

export const now = () => Date.now();
export const uid = () => crypto.randomUUID();
export const shortId = (bytes = 12) =>
	Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
		.map(b => b.toString(16).padStart(2, '0')).join('');
export const clampStr = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
export const toInt = (v, fallback = 0) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.trunc(n) : fallback;
};

export async function sha256Hex(input) {
	const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
	const buf = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------- D1

export const db = {
	async all(c, sql, ...args) {
		const stmt = c.env.db.prepare(sql);
		const res = await (args.length ? stmt.bind(...args) : stmt).all();
		return res.results || [];
	},
	async first(c, sql, ...args) {
		const stmt = c.env.db.prepare(sql);
		return (args.length ? stmt.bind(...args) : stmt).first();
	},
	async run(c, sql, ...args) {
		const stmt = c.env.db.prepare(sql);
		return (args.length ? stmt.bind(...args) : stmt).run();
	}
};

// 冷启动执行一次建表（幂等），isolate 内复用内存标记
let schemaReady = false;
export async function ensureSchema(c) {
	if (schemaReady) return;
	await c.env.db.batch(DDL.map(sql => c.env.db.prepare(sql)));

	// 老库补列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加字段）
	const profileCols = (await c.env.db.prepare('PRAGMA table_info(chat_profile)').all()).results.map(r => r.name);
	for (const [col, ddl] of [
		['qq_openid', "qq_openid TEXT NOT NULL DEFAULT ''"],
		['qq_bind_code', "qq_bind_code TEXT NOT NULL DEFAULT ''"],
		['qq_bind_at', 'qq_bind_at INTEGER NOT NULL DEFAULT 0']
	]) {
		if (!profileCols.includes(col)) {
			await c.env.db.prepare(`ALTER TABLE chat_profile ADD COLUMN ${ddl}`).run();
		}
	}

	// 一次性迁移：端到端加密已下线，历史会话统一转明文。
	// 旧密文本身解不开了，但新消息可以正常收发。
	const flag = await c.env.db.prepare("SELECT v FROM chat_setting WHERE k = 'migrated_plain'").first();
	if (!flag) {
		await c.env.db.prepare("UPDATE chat_conversation SET enc_mode = 'plain' WHERE enc_mode = 'e2ee'").run();
		await c.env.db.prepare("INSERT OR REPLACE INTO chat_setting (k, v) VALUES ('migrated_plain', '1')").run();
	}

	schemaReady = true;
}

// ---------------------------------------------------------------- 身份

/** 当前登录用户（可选）。security 中间件已把 user 放进上下文。 */
export function currentUser(c) {
	const u = c.get('user');
	if (!u || !u.userId) return null;
	return {
		userId: Number(u.userId),
		email: String(u.email || '').toLowerCase(),
		nickname: clampStr(u.nickname || u.name || '', 32),
		permKeys: Array.isArray(u.permKeys) ? u.permKeys : []
	};
}

export function requireUser(c) {
	const u = currentUser(c);
	if (!u) throw new BizError('请先登录', 401);
	return u;
}

/** 站点管理员：环境变量里配的管理员邮箱，或拥有 * 权限 */
export function isSiteAdmin(c, user) {
	const u = user || currentUser(c);
	if (!u) return false;
	const adminEmail = String(c.env.admin || '').toLowerCase();
	return (adminEmail && u.email === adminEmail) || u.permKeys.includes('*');
}

/** 站内 uid 就是 D1 user 表的主键，绝不自增 */
export const uidOf = user => (user ? Number(user.userId) : null);

// ---------------------------------------------------------------- 聊天资料（D1）

/**
 * 头像 / QQ / 公钥 / 备份 / 封禁 —— 邮箱系统的 user 表里没有，但也不能放 KV：
 * 免费版 KV 每天只有 1000 次写入，而这些字段会随每次改头像、每次发提醒被写。
 * 放 D1 后可以一条 SQL 批量取，且不占 KV 额度。
 */
const emptyProfile = () => ({
	avatar: '', qq: '', qqOpenid: '',
	pubKey: null, keyBackup: null, keyUpdatedAt: 0, banned: 0
});

function normalizeProfile(row) {
	if (!row) return emptyProfile();
	return {
		avatar: row.avatar || '',
		qq: row.qq || '',
		qqOpenid: row.qq_openid || '',
		pubKey: row.pub_key || null,
		keyBackup: row.key_backup || null,
		keyUpdatedAt: Number(row.key_updated_at) || 0,
		banned: Number(row.banned) || 0
	};
}

/** 批量取，避免会话列表 / 消息列表里逐条查 */
export async function getProfiles(c, userIds) {
	const uniq = [...new Set((userIds || []).filter(Boolean).map(Number).filter(n => n > 0))];
	const map = new Map();
	if (!uniq.length) return map;
	const ph = uniq.map(() => '?').join(',');
	const rows = await db.all(c, `SELECT * FROM chat_profile WHERE user_id IN (${ph})`, ...uniq);
	const byId = new Map(rows.map(r => [Number(r.user_id), normalizeProfile(r)]));
	for (const id of uniq) map.set(id, byId.get(id) || emptyProfile());
	return map;
}

export async function getProfile(c, userId) {
	const id = Number(userId);
	if (!id) return emptyProfile();
	const map = await getProfiles(c, [id]);
	return map.get(id) || emptyProfile();
}

export async function setProfile(c, userId, patch) {
	const cur = await getProfile(c, userId);
	const next = { ...cur, ...patch };
	await db.run(c, `INSERT INTO chat_profile
		(user_id, avatar, qq, qq_openid, pub_key, key_backup, key_updated_at, banned, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT(user_id) DO UPDATE SET
			avatar = excluded.avatar,
			qq = excluded.qq,
			qq_openid = excluded.qq_openid,
			pub_key = excluded.pub_key,
			key_backup = excluded.key_backup,
			key_updated_at = excluded.key_updated_at,
			banned = excluded.banned,
			updated_at = excluded.updated_at`,
		Number(userId), next.avatar || '', next.qq || '', next.qqOpenid || '',
		next.pubKey || null, next.keyBackup || null,
		next.keyUpdatedAt || 0, next.banned || 0, now());
	return next;
}

// ---------------------------------------------------------------- R2

const CONTENT_TYPES = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
	webp: 'image/webp', gif: 'image/gif', bin: 'application/octet-stream'
};

export const mimeOf = name => {
	const ext = String(name).split('.').pop().toLowerCase();
	return CONTENT_TYPES[ext] || 'application/octet-stream';
};

export function assertR2(c) {
	if (!c.env.r2) throw new BizError('R2 未绑定，无法存取文件', 502);
}

export async function putBlob(c, key, bytes, contentType) {
	assertR2(c);
	await c.env.r2.put('chat/' + key, bytes, {
		httpMetadata: { contentType, cacheControl: 'private, max-age=31536000, immutable' }
	});
	return key;
}

export async function getBlob(c, key) {
	assertR2(c);
	return await c.env.r2.get('chat/' + key);
}

export async function deleteBlob(c, key) {
	assertR2(c);
	await c.env.r2.delete('chat/' + key);
}

/** 按魔数判断真实图片类型，改后缀骗不过 */
export function sniffImage(bytes) {
	if (!bytes || bytes.length < 12) return null;
	const head = bytes.subarray ? bytes.subarray(0, 12) : new Uint8Array(bytes.slice(0, 12));
	if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
	const tag = (from, to) => new TextDecoder('ascii').decode(head.subarray(from, to));
	if (tag(0, 4) === 'RIFF' && tag(8, 12) === 'WEBP') return 'webp';
	if (tag(0, 3) === 'GIF') return 'gif';
	return null;
}

export function blobExtFor(contentType) {
	const t = String(contentType || '').toLowerCase();
	if (t.startsWith('image/png')) return 'png';
	if (t.startsWith('image/webp')) return 'webp';
	if (t.startsWith('image/gif')) return 'gif';
	if (t.startsWith('image/jpeg') || t.startsWith('image/jpg')) return 'jpg';
	return 'bin'; // 端到端加密后的密文，服务器不知道是什么图
}

// ---------------------------------------------------------------- 限流（D1）

/**
 * 高频动作（发消息、建群、举报）直接数业务表，不额外写任何东西；
 * 低频动作（上传图片/头像）才写 chat_throttle。
 */
export async function rateLimit(c, bucket, limit, windowSec) {
	const since = now() - windowSec * 1000;
	const row = await db.first(c, 'SELECT COUNT(*) AS c FROM chat_throttle WHERE bucket = ? AND ts > ?', bucket, since);
	if (Number((row && row.c) || 0) >= limit) return false;
	await db.run(c, 'INSERT INTO chat_throttle (bucket, ts) VALUES (?,?)', bucket, now());
	if (Math.random() < 0.05) {
		await db.run(c, 'DELETE FROM chat_throttle WHERE ts < ?', now() - 24 * 3600_000);
	}
	return true;
}

/** 用 COUNT(*) 判断窗口内是否超限，不产生写入 */
export async function countSince(c, sql, ...args) {
	const row = await db.first(c, sql, ...args);
	return Number((row && row.c) || 0);
}

// ---------------------------------------------------------------- 审计

export async function audit(c, actorId, action, target, meta) {
	try {
		await db.run(c,
			'INSERT INTO chat_audit (actor, action, target, meta, created_at) VALUES (?,?,?,?,?)',
			Number(actorId) || 0, action || '', String(target || ''),
			meta ? JSON.stringify(meta).slice(0, 800) : '', now());
	} catch {
		/* 审计失败不影响主流程 */
	}
}

// ---------------------------------------------------------------- 会话读写

export const convRow = (c, id) => db.first(c, 'SELECT * FROM chat_conversation WHERE id = ?', String(id || ''));

export const membership = (c, convId, userId) =>
	userId ? db.first(c, 'SELECT * FROM chat_member WHERE conv_id = ? AND user_id = ?', convId, Number(userId)) : null;

export async function isMemberOf(c, convId, userId) {
	const m = await membership(c, convId, userId);
	return Boolean(m && m.status === 'active');
}

/** 游客可读：公开群 + 明文 + 未解散 */
export const guestReadable = conv =>
	Boolean(conv) && conv.type === 'group' && conv.visibility === 'public'
	&& conv.enc_mode === 'plain' && Number(conv.archived) === 0;

/** 一次性把一组 user_id 补成 { id(email), uid, nickname, avatar } */
export async function hydrateUsers(c, ids) {
	const uniq = [...new Set(ids.filter(v => Number(v) > 0).map(Number))];
	if (!uniq.length) return new Map();
	const placeholders = uniq.map(() => '?').join(',');
	const rows = await db.all(c,
		`SELECT user_id, email, nickname FROM user WHERE user_id IN (${placeholders})`, ...uniq);
	const profiles = await getProfiles(c, uniq);
	const map = new Map();
	for (const id of uniq) {
		const r = rows.find(x => Number(x.user_id) === id);
		const p = profiles.get(id) || emptyProfile();
		map.set(id, {
			uid: id,
			id: r ? String(r.email).toLowerCase() : 'user-' + id,
			nickname: (r && r.nickname) || (r ? String(r.email).split('@')[0] : '用户' + id),
			avatar: p.avatar || ''
		});
	}
	return map;
}

export function safeParse(s) {
	try {
		return JSON.parse(s);
	} catch {
		return { text: String(s).slice(0, 4000) };
	}
}

export function previewOf(msg, conv) {
	try {
		const body = JSON.parse(msg.body);
		if (msg.kind === 'image') return conv.enc_mode === 'e2ee' ? '[加密图片]' : '[图片]';
		if (conv.enc_mode === 'e2ee') return '[加密消息]';
		if (typeof body.text === 'string') return body.text.slice(0, 80);
		return '[消息]';
	} catch {
		return '[消息]';
	}
}
