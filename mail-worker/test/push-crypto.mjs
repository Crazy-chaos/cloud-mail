/**
 * Web Push 加密自检（RFC 8291 / 8292）
 *
 * 用 RFC 附录 A 的测试向量跑一遍「加密 → 解密」，并校验 VAPID JWT 签名。
 * 这样不用真的发到浏览器就能确认字节层面是对的。
 *
 * 运行：node test/push-crypto.mjs
 */

import crypto from 'node:crypto';

const te = new TextEncoder();
const td = new TextDecoder();

const b64uToBytes = s => {
	const t = String(s).replace(/-/g, '+').replace(/_/g, '/');
	const pad = t.length % 4 ? '='.repeat(4 - (t.length % 4)) : '';
	const bin = Buffer.from(t + pad, 'base64');
	return new Uint8Array(bin);
};
const bytesToB64u = b => Buffer.from(b).toString('base64url');
const concat = (...arrs) => {
	const total = arrs.reduce((n, a) => n + a.length, 0);
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrs) { out.set(a, off); off += a.length; }
	return out;
};

// 与 chat-push.js 完全一致的实现（修复后的版本）
async function hkdf(ikm, salt, info, len) {
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	const infoBytes = typeof info === 'string' ? te.encode(info) : info;
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt, info: infoBytes }, key, len * 8);
	return new Uint8Array(bits);
}

async function deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt) {
	const prkInfo = concat(te.encode('WebPush: info\0'), uaPublic, asPublic);
	const prk = await hkdf(ecdhSecret, authSecret, prkInfo, 32);
	const cek = await hkdf(prk, salt, 'Content-Encoding: aes128gcm\0', 16);
	const nonce = await hkdf(prk, salt, 'Content-Encoding: nonce\0', 12);
	return { prk, cek, nonce };
}

async function encryptPayloadWith(payload, uaPublic, authSecret, asKeys, salt) {
	const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
	const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

	const { cek, nonce } = await deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);

	const plaintext = concat(payload, new Uint8Array([2]));
	const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, plaintext));

	const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, 4096);
	header[20] = asPublic.length;
	header.set(asPublic, 21);

	return { body: concat(header, ciphertext), asPublic };
}

// 模拟浏览器端解密
async function decryptAsUserAgent(body, uaPrivate, uaPublic, authSecret) {
	const salt = body.slice(0, 16);
	const idlen = body[20];
	const asPublic = body.slice(21, 21 + idlen);
	const ciphertext = body.slice(21 + idlen);

	const jwk = {
		kty: 'EC', crv: 'P-256',
		x: bytesToB64u(uaPublic.slice(1, 33)),
		y: bytesToB64u(uaPublic.slice(33, 65)),
		d: bytesToB64u(uaPrivate)
	};
	const uaKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
	const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const ecdhSecret = new Uint8Array(
		await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, uaKey, 256));

	const { cek, nonce } = await deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);
	const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
	const plain = new Uint8Array(await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext));
	// 末尾 0x02 是单记录分隔符
	return plain.slice(0, plain.length - 1);
}

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name, extra === undefined ? '' : String(extra).slice(0, 200)); }
};

(async () => {
	console.log('== RFC 8291 附录 A 测试向量 ==');
	const ua_public = b64uToBytes('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
	const ua_private = b64uToBytes('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
	const as_private = b64uToBytes('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
	const as_public = b64uToBytes('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
	const auth_secret = b64uToBytes('BTBZMqHH6r4Tts7J_aSIgg');
	const salt = b64uToBytes('DGv6ra1nlYgDCS1FRnbzlw');

	// 用 Node 标准实现算一遍，确认公式
	const ecdh = crypto.createECDH('prime256v1');
	ecdh.setPrivateKey(Buffer.from(as_private));
	const nodeSecret = ecdh.computeSecret(Buffer.from(ua_public));
	const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(ua_public), Buffer.from(as_public)]);
	const nodeIKM = crypto.hkdfSync('sha256', nodeSecret, Buffer.from(auth_secret), keyInfo, 32);
	check('IKM 与 RFC 一致',
		bytesToB64u(new Uint8Array(nodeIKM)) === 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
		bytesToB64u(new Uint8Array(nodeIKM)));
	const nodeCEK = crypto.hkdfSync('sha256', Buffer.from(nodeIKM), Buffer.from(salt), Buffer.from('Content-Encoding: aes128gcm\0'), 16);
	check('CEK 与 RFC 一致', bytesToB64u(new Uint8Array(nodeCEK)) === 'oIhVW04MRdy2XN9CiKLxTg', bytesToB64u(new Uint8Array(nodeCEK)));

	// 复刻 Worker 的 WebCrypto 实现（as_public 用 fixed 值，避免生成随机密钥对）
	const asPublicFixed = as_public;
	const asPrivateJwk = {
		kty: 'EC', crv: 'P-256',
		x: bytesToB64u(as_public.slice(1, 33)),
		y: bytesToB64u(as_public.slice(33, 65)),
		d: bytesToB64u(as_private)
	};
	const asKey = await crypto.subtle.importKey('jwk', asPrivateJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
	const uaKey = await crypto.subtle.importKey('raw', ua_public, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
	const webSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKey, 256));
	check('WebCrypto 派生的共享密钥与 Node 一致',
		Buffer.from(webSecret).equals(Buffer.from(nodeSecret)));

	const { cek, nonce } = await deriveKeys(webSecret, auth_secret, ua_public, asPublicFixed, salt);
	check('WebCrypto 算出同一个 CEK', bytesToB64u(cek) === 'oIhVW04MRdy2XN9CiKLxTg', bytesToB64u(cek));
	check('WebCrypto 算出同一个 NONCE', bytesToB64u(nonce) === '4h_95klXJ5E_qnoN', bytesToB64u(nonce));

	console.log('== 加密 → 解密往返 ==');
	const payload = te.encode('When I grow up, I want to be a watermelon');

	// 随机生成 UA 密钥，模拟真实订阅
	const uaPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const uaPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', uaPair.publicKey));
	const uaPrivRaw = new Uint8Array((await crypto.subtle.exportKey('jwk', uaPair.privateKey)).d
		? b64uToBytes((await crypto.subtle.exportKey('jwk', uaPair.privateKey)).d)
		: []);
	const asPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
	const authSecret = crypto.getRandomValues(new Uint8Array(16));
	const randomSalt = crypto.getRandomValues(new Uint8Array(16));

	const { body, asPublic } = await encryptPayloadWith(payload, uaPubRaw, authSecret, asPair, randomSalt);
	check('请求体 = header(86) + 密文(明文+1+16)', body.length === 86 + payload.length + 1 + 16, body.length);
	check('header 里的 idlen 是 65', body[20] === 65, body[20]);
	check('header 里的 rs 是 4096', new DataView(body.buffer, body.byteOffset).getUint32(16) === 4096);
	check('header 里的公钥与发送方一致', Buffer.from(body.slice(21, 86)).equals(Buffer.from(asPublic)));

	const decrypted = await decryptAsUserAgent(body, uaPrivRaw, uaPubRaw, authSecret);
	check('浏览器端能解回原文', td.decode(decrypted) === 'When I grow up, I want to be a watermelon', td.decode(decrypted));

	console.log('== VAPID JWT (ES256) ==');
	const vapidKeys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
	const vapidPub = new Uint8Array(await crypto.subtle.exportKey('raw', vapidKeys.publicKey));

	const headerB64 = bytesToB64u(te.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
	const payloadB64 = bytesToB64u(te.encode(JSON.stringify({
		aud: 'https://fcm.googleapis.com',
		exp: Math.floor(Date.now() / 1000) + 3600,
		sub: 'mailto:admin@crazychaos.top'
	})));
	const signingInput = te.encode(`${headerB64}.${payloadB64}`);
	const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, vapidKeys.privateKey, signingInput));

	check('ES256 签名是 64 字节（r||s，不是 DER）', sig.length === 64, sig.length);
	const verifyKey = await crypto.subtle.importKey('raw', vapidPub, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
	const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, signingInput);
	check('签名可被公钥验证通过', valid);

	console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
	process.exit(fail ? 1 : 0);
})();
