/**
 * Web Push（VAPID + aes128gcm），全部用 Workers 原生 WebCrypto 实现，无第三方依赖。
 *
 * 参考 RFC 8291（消息加密）与 RFC 8292（VAPID）。
 * 私钥存 KV（chat:vapid），首次调用自动生成。
 */

import { db, now } from './chat-core';

const VAPID_KV_KEY = 'chat:vapid';
const VAPID_SUB = 'mailto:admin@crazychaos.top';
const RECORD_SIZE = 4096;

const te = new TextEncoder();

// ---------------------------------------------------------------- base64url

export function b64uEncode(bytes) {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let bin = '';
	for (const b of arr) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
	const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
	const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
	const bin = atob(s + pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

const concat = (...arrays) => {
	const total = arrays.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrays) { out.set(a, off); off += a.length; }
	return out;
};

async function hkdf(ikm, salt, info, len) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, key, len * 8);
	return new Uint8Array(bits);
}

// ---------------------------------------------------------------- VAPID 密钥

let localKeys = null;

export async function loadVapid(c) {
	if (localKeys) return localKeys;
	const cached = await c.env.kv.get(VAPID_KV_KEY, { type: 'json' });
	if (cached && cached.privateJwk) {
		localKeys = cached;
		return cached;
	}
	const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
	const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
	const data = { privateJwk, publicB64u: b64uEncode(publicRaw) };
	await c.env.kv.put(VAPID_KV_KEY, JSON.stringify(data));
	localKeys = data;
	return data;
}

const importVapidKey = jwk =>
	crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);

function vapidHeader(privateJwk, publicB64u, endpoint) {
	return (async () => {
		const aud = new URL(endpoint).origin;
		const header = b64uEncode(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
		const payload = b64uEncode(te.encode(JSON.stringify({
			aud,
			exp: Math.floor(now() / 1000) + 12 * 3600,
			sub: VAPID_SUB
		})));
		const signingInput = te.encode(`${header}.${payload}`);
		const key = await importVapidKey(privateJwk);
		const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput));
		const jwt = `${header}.${payload}.${b64uEncode(sig)}`;
		return `vapid t=${jwt}, k=${publicB64u}`;
	})();
}

// ---------------------------------------------------------------- 加密

/**
 * RFC 8291：把 payload 加密成 aes128gcm 请求体
 * @param {Uint8Array} payload 明文
 * @param {string} p256dh 客户端公钥（base64url, 65 字节）
 * @param {string} auth 授权密钥（base64url, 16 字节）
 */
export async function encryptPayload(payload, p256dh, auth) {
	const uaPublic = b64uDecode(p256dh);
	const authSecret = b64uDecode(auth);

	const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

	const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

	// PRK = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public)
	const prkInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
	const prk = await hkdf(ecdhSecret, authSecret, prkInfo, 32);

	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(prk, salt, 'Content-Encoding: aes128gcm\0', 16);
	const nonce = await hkdf(prk, salt, 'Content-Encoding: nonce\0', 12);

	// aes128gcm 的明文末尾必须有 0x02 分隔符（单条记录）
	const plaintext = concat(payload, new Uint8Array([2]));
	const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext));

	// header: salt(16) | rs(4, big-endian) | idlen(1) | keyid(as_public)
	const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = asPublic.length;
	header.set(asPublic, 21);

	return concat(header, ciphertext);
}

// ---------------------------------------------------------------- 发送

export async function sendPush(c, sub, payload) {
	const vapid = await loadVapid(c);
	const body = await encryptPayload(te.encode(JSON.stringify(payload)), sub.p256dh, sub.auth);
	const authorization = await vapidHeader(vapid.privateJwk, vapid.publicB64u, sub.endpoint);

	try {
		const res = await fetch(sub.endpoint, {
			method: 'POST',
			headers: {
				Authorization: authorization,
				'Content-Encoding': 'aes128gcm',
				'Content-Type': 'application/octet-stream',
				TTL: '86400',
				Urgency: 'normal'
			},
			body,
			signal: AbortSignal.timeout(8000)
		});
		return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
	} catch (e) {
		return { ok: false, message: e.message, gone: false };
	}
}

/** 给一批用户推送；失效订阅顺手清掉 */
export async function pushToUsers(c, userIds, payload) {
	const ids = [...new Set(userIds.map(Number).filter(Boolean))];
	if (!ids.length) return;
	const ph = ids.map(() => '?').join(',');
	const subs = await db.all(c, `SELECT * FROM chat_push_sub WHERE user_id IN (${ph})`, ...ids);
	for (const sb of subs) {
		const r = await sendPush(c, sb, payload);
		if (r.gone) {
			await db.run(c, 'DELETE FROM chat_push_sub WHERE endpoint = ?', sb.endpoint);
		}
	}
}
