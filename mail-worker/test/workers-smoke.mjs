/**
 * Worker 版聊天接口回归测试（针对本地 wrangler dev）
 *
 * 用法：
 *   1) npx wrangler dev -c wrangler.check.toml --port 8799 --local --persist-to .wrangler/teststate
 *   2) node test/workers-smoke.mjs
 *
 * token 由 scripts/mk-token.mjs 生成（HS256 + 本地 jwt_secret）。
 */

import { createHmac } from 'node:crypto';

const BASE = process.env.BASE || 'http://127.0.0.1:8799/api';
const SECRET = process.env.JWT_SECRET || 'local-test-secret-please-change';

const b64u = input => Buffer.from(input).toString('base64url');
function makeToken(userId, token) {
	const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
	const payload = b64u(JSON.stringify({ userId, token, iat: Math.floor(Date.now() / 1000) }));
	const data = `${header}.${payload}`;
	const sig = createHmac('sha256', SECRET).update(data).digest('base64url');
	return `${data}.${sig}`;
}

const A = makeToken(2, 'tok-alice');
const B = makeToken(3, 'tok-bob');
const ADM = makeToken(1, 'tok-admin');

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
	if (cond) { pass++; console.log('  ok   ' + name); }
	else { fail++; console.log('  FAIL ' + name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 220)); }
};

async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
	const res = await fetch(BASE + path, {
		method,
		headers: {
			...(token ? { Authorization: token } : {}),
			...(body ? { 'Content-Type': 'application/json' } : {}),
			...headers
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const text = await res.text();
	let data = null;
	try { data = JSON.parse(text); } catch { /* ignore */ }
	return { status: res.status, data, headers: res.headers };
}

const png = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64'
);

(async () => {
	console.log('== 基础 ==');
	let r = await api('/chat/health');
	check('健康检查', r.status === 200 && r.data?.data?.d1 && r.data?.data?.r2, r.data);

	r = await api('/chat/public/groups');
	check('游客能看群列表', r.status === 200 && Array.isArray(r.data?.data), r.status);

	r = await api('/chat/me');
	check('未登录访问 /me 返回 401', r.status === 401, r.status);

	r = await api('/chat/me', { token: A });
	check('登录后拿到用户', r.status === 200 && r.data?.data?.user?.id === 'alice@crazychaos.top', r.data);
	const uidA = r.data?.data?.user?.uid;
	check('uid 直接来自 D1 的 user_id', uidA === 2, uidA);
	check('非管理员看不到后台标记', r.data?.data?.isAdmin === false, r.data?.data?.isAdmin);

	r = await api('/chat/me', { headers: { Cookie: 'token=' + A } });
	check('全站 cookie 也能认出身份', r.status === 200 && r.data?.data?.user?.uid === 2, r.status);

	r = await api('/chat/me', { headers: { Cookie: 'token=bogus' } });
	check('假 cookie 被拒', r.status === 401, r.status);

	console.log('== 群组 ==');
	r = await api('/chat/conversations', { token: A, method: 'POST', body: { name: '塔菲公开群', description: '测试', visibility: 'public', joinMode: 'open', encMode: 'plain' } });
	const gid = r.data?.data?.id;
	check('建公开明文群', r.status === 200 && Boolean(gid), r.data);
	check('建群者自动成为群主', r.data?.data?.myRole === 'owner', r.data?.data?.myRole);

	r = await api('/chat/conversations', { token: A, method: 'POST', body: { name: '私密群', visibility: 'private', joinMode: 'open', encMode: 'plain' } });
	const pid = r.data?.data?.id;
	check('私密群创建成功', r.status === 200 && Boolean(pid), r.data);
	check('私密群统一明文存储', r.data?.data?.encMode === 'plain', r.data?.data?.encMode);
	check('私密群强制邀请码', r.data?.data?.joinMode === 'invite', r.data?.data?.joinMode);

	r = await api('/chat/public/groups');
	const pub = (r.data?.data || []).find(g => g.id === gid);
	check('公开群出现在发现页', Boolean(pub), r.data?.data?.length);
	const priv = (r.data?.data || []).find(g => g.id === pid);
	check('私密群也露名字', Boolean(priv), r.data?.data?.length);
	check('私密群简介/人数/消息全部隐藏', priv && priv.description === '' && priv.memberCount === 0 && priv.lastMessage === null, priv);

	r = await api(`/chat/conversations/${gid}`);
	check('游客能看公开群详情', r.status === 200 && r.data?.data?.conversation?.name === '塔菲公开群', r.status);
	check('游客看不到成员名单', (r.data?.data?.members || []).length === 0, r.data?.data?.members);

	r = await api(`/chat/conversations/${pid}`);
	check('游客能看私密群元信息', r.status === 200 && r.data?.data?.conversation?.name === '私密群', r.status);
	r = await api(`/chat/conversations/${pid}/messages`);
	check('游客读不到私密群消息', r.status === 403, r.status);

	console.log('== 消息 ==');
	r = await api(`/chat/conversations/${gid}/messages`, { method: 'POST', body: { body: { text: '游客不能发' } } });
	check('未登录不能发消息', r.status === 401, r.status);

	r = await api(`/chat/conversations/${gid}/messages`, { token: A, method: 'POST', body: { kind: 'text', body: { text: '今晚八点开黑' } } });
	const m1 = r.data?.data?.id;
	check('群主发消息', r.status === 200 && Boolean(m1), r.data);

	r = await api(`/chat/conversations/${gid}/messages`);
	check('游客能读公开群消息', r.status === 200 && (r.data?.data?.messages || []).length === 1, r.data?.data?.messages?.length);
	check('消息带发送者昵称与 UID', r.data?.data?.messages?.[0]?.senderName === '爱丽丝'
		&& r.data?.data?.messages?.[0]?.senderUid === 2, r.data?.data?.messages?.[0]);

	r = await api(`/chat/conversations/${gid}/join`, { token: B, method: 'POST', body: {} });
	check('自由加入的群直接生效', r.data?.data?.status === 'active', r.data);

	// 刚进群时，A 发的那条应算未读（发言会自动标已读，所以要在这之前断言）
	r = await api('/chat/conversations', { token: B });
	const convB = (r.data?.data || []).find(c => c.id === gid);
	check('B 的会话列表里有这个群', Boolean(convB), r.data?.data?.length);
	check('B 有未读数', convB && convB.unread >= 1, convB && convB.unread);

	r = await api(`/chat/conversations/${gid}/messages`, { token: B, method: 'POST', body: { kind: 'text', body: { text: '收到' } } });
	const m2 = r.data?.data?.id;
	check('普通成员能发言', r.status === 200, r.status);

	r = await api(`/chat/conversations/${gid}/messages?after=${m1}`, { token: B });
	check('增量拉取只返回新消息', (r.data?.data?.messages || []).length === 1
		&& r.data?.data?.messages[0].id === m2, r.data?.data?.messages?.length);

	r = await api(`/chat/conversations/${gid}/read`, { token: B, method: 'POST', body: { id: m2 } });
	check('标记已读', r.status === 200, r.status);
	r = await api('/chat/conversations', { token: B });
	check('已读后未读归零', (r.data?.data || []).find(c => c.id === gid)?.unread === 0, r.status);

	console.log('== 私密群审批 ==');
	r = await api(`/chat/conversations/${pid}/join`, { token: B, method: 'POST', body: {} });
	check('没有邀请码进不去', r.status === 403, r.status);

	r = await api(`/chat/conversations/${pid}/invites`, { token: A, method: 'POST', body: { ttlHours: 24 } });
	const code = r.data?.data?.code;
	check('群主生成邀请码', Boolean(code), r.data);

	r = await api(`/chat/conversations/${pid}/join`, { token: B, method: 'POST', body: { code } });
	check('凭邀请码进入待审批', r.data?.data?.status === 'pending', r.data?.data?.status);

	r = await api(`/chat/conversations/${pid}/messages`, { token: B });
	check('待审批读不到消息', r.status === 403, r.status);

	r = await api(`/chat/conversations/${pid}/requests`, { token: A });
	check('群主看到待审批列表', (r.data?.data || []).some(x => x.uid === 3), r.data?.data);

	r = await api(`/chat/conversations/${pid}/requests`, { token: A, method: 'POST', body: { userId: 'bob@crazychaos.top', action: 'approve' } });
	check('审批通过', r.data?.data?.action === 'approve', r.data);

	r = await api(`/chat/conversations/${pid}/messages`, { token: B });
	check('通过后可以读消息', r.status === 200, r.status);

	r = await api(`/chat/conversations/${pid}/messages`, { token: B, method: 'POST', body: { kind: 'text', body: { text: '私密群也能直接发明文' } } });
	check('私密群发明文消息成功', r.status === 200, r.status);

	r = await api(`/chat/conversations/${pid}/messages`, { token: B });
	const lastMsg = (r.data?.data?.messages || []).slice(-1)[0];
	check('消息以明文保存，成员读得到原文', lastMsg?.body?.text === '私密群也能直接发明文', lastMsg?.body);

	console.log('== 群密钥 ==');
	r = await api(`/chat/conversations/${pid}/keys`, { token: A, method: 'POST', body: { userId: 'alice@crazychaos.top', wrapped: 'wrapped-for-alice' } });
	check('分发包裹后的群密钥', r.status === 200, r.data);
	r = await api(`/chat/conversations/${pid}/keys/me`, { token: A });
	check('取回自己的群密钥', r.data?.data?.wrapped === 'wrapped-for-alice', r.data?.data);
	r = await api(`/chat/conversations/${pid}/keys/members`, { token: A });
	const km = (r.data?.data || []);
	check('密钥名单列出成员与缺失状态', km.length === 2 && km.some(x => x.hasKey) && km.every(x => 'pubKey' in x), km);
	r = await api(`/chat/conversations/${pid}/keys`, { token: A, method: 'POST', body: { userId: 'nobody@x.com', wrapped: 'w' } });
	check('不能给群外用户发密钥', r.status === 404, r.status);

	console.log('== 图片 ==');
	let up = await fetch(BASE + `/chat/upload?conv=${gid}`, {
		method: 'POST', headers: { Authorization: A, 'Content-Type': 'image/png' }, body: png
	});
	let upD = await up.json();
	const imgKey = upD.data?.key || '';
	check('明文群上传图片', up.status === 200 && imgKey.startsWith(gid + '/'), upD);
	let got = await fetch(BASE + '/chat/blob/' + imgKey);
	check('游客能看公开群图片', got.status === 200 && got.headers.get('content-type') === 'image/png', got.status);

	r = await api(`/chat/conversations/${gid}/messages`, { token: A, method: 'POST', body: { kind: 'image', body: { key: imgKey, w: 1, h: 1 } } });
	check('图片消息写入成功', r.status === 200 && r.data?.data?.kind === 'image', r.data?.data?.kind);

	r = await api(`/chat/conversations/${gid}/messages`, { token: A, method: 'POST', body: { kind: 'image', body: { key: pid + '/x.png' } } });
	check('引用别的群的图片被拒', r.status === 400, r.status);

	up = await fetch(BASE + `/chat/upload?conv=${gid}`, {
		method: 'POST', headers: { Authorization: A, 'Content-Type': 'image/png' }, body: Buffer.from('not an image')
	});
	check('非图片内容被拒', up.status === 400, up.status);

	up = await fetch(BASE + `/chat/upload?conv=${gid}`, {
		method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png
	});
	check('未登录不能上传', up.status === 401, up.status);

	up = await fetch(BASE + `/chat/upload?conv=${pid}`, {
		method: 'POST', headers: { Authorization: A, 'Content-Type': 'image/png' }, body: png
	});
	const privKey = (await up.json()).data?.key || '';
	check('私密群上传图片', up.status === 200 && privKey.startsWith(pid + '/'), up.status);
	got = await fetch(BASE + '/chat/blob/' + privKey);
	check('游客读不到私密群图片', got.status === 403, got.status);
	got = await fetch(BASE + '/chat/blob/' + privKey, { headers: { Authorization: A } });
	check('成员能读私密群图片', got.status === 200, got.status);

	console.log('== 头像与找人 ==');
	up = await fetch(BASE + '/chat/me/avatar/upload', {
		method: 'POST', headers: { Authorization: B, 'Content-Type': 'image/png' }, body: png
	});
	const avD = await up.json();
	const avPath = avD.data?.avatar || '';
	check('上传头像', up.status === 200 && /^\/api\/chat\/avatar\/.+\.png$/.test(avPath), avD);
	got = await fetch(BASE.replace(/\/api$/, '') + avPath);
	check('能读回头像', got.status === 200, got.status);

	r = await api('/chat/me/avatar', { token: B, method: 'POST', body: { avatar: avPath } });
	check('把上传结果设为头像', r.data?.data?.avatar === avPath, r.data?.data?.avatar);
	r = await api('/chat/me/avatar', { token: B, method: 'POST', body: { avatar: 'javascript:alert(1)' } });
	check('非法头像被拒', r.status === 400, r.status);

	r = await api('/chat/users/search?q=3', { token: A });
	check('按 uid 搜到人', (r.data?.data || []).some(u => u.uid === 3), r.data?.data);
	r = await api('/chat/users/search?q=bob', { token: A });
	const bobRow = (r.data?.data || []).find(u => u.uid === 3);
	check('按邮箱/昵称搜到人', Boolean(bobRow), r.data?.data);
	check('搜索结果带头像', bobRow && bobRow.avatar === avPath, bobRow && bobRow.avatar);

	r = await api('/chat/me/keys', { token: B, method: 'POST', body: { pubKey: 'PUBKEY-B', keyBackup: 'enc-backup' } });
	check('保存公钥与备份', r.data?.data?.saved === true, r.data);
	r = await api('/chat/users/uid:3/pubkey'.replace('uid:', ''), { token: A });
	check('取对方公钥', r.data?.data?.pubKey === 'PUBKEY-B', r.data?.data);
	r = await api('/chat/me/keybackup', { token: B });
	check('取回密钥备份', r.data?.data?.keyBackup === 'enc-backup', r.data?.data);

	console.log('== 私聊 ==');
	r = await api('/chat/dm', { token: A, method: 'POST', body: { userId: 'bob@crazychaos.top' } });
	const dmid = r.data?.data?.id;
	check('建立私聊', r.status === 200 && String(dmid).startsWith('dm_'), dmid);
	check('私聊统一明文存储', r.data?.data?.encMode === 'plain', r.data?.data?.encMode);
	check('私聊带对方资料', r.data?.data?.peer?.uid === 3, r.data?.data?.peer);
	r = await api('/chat/dm', { token: A, method: 'POST', body: { userId: 'bob@crazychaos.top' } });
	check('重复开私聊返回同一个会话', r.data?.data?.id === dmid, r.data?.data?.id);
	r = await api(`/chat/conversations/${dmid}`, { token: B });
	check('对方也能进私聊', r.status === 200, r.status);
	r = await api(`/chat/conversations/${dmid}`, { token: ADM });
	check('无关用户进不了私聊', r.status === 403, r.status);

	console.log('== 加人与权限 ==');
	r = await api(`/chat/conversations/${gid}/members`, { token: A, method: 'POST', body: { userId: 'bob@crazychaos.top' } });
	check('重复加人给出提示', r.status === 400, r.status);
	r = await api(`/chat/conversations/${gid}/members`, { token: B, method: 'POST', body: { userId: 'alice@crazychaos.top' } });
	check('普通成员不能拉人', r.status === 403, r.status);
	r = await api(`/chat/conversations/${gid}`, { token: B, method: 'PATCH', body: { avatar: '/123/emoji_9.avif' } });
	check('非群主不能改群资料', r.status === 403, r.status);
	r = await api(`/chat/conversations/${gid}`, { token: A, method: 'PATCH', body: { avatar: '/123/emoji_9.avif' } });
	check('群主改群头像', r.data?.data?.avatar === '/123/emoji_9.avif', r.data?.data?.avatar);
	r = await api(`/chat/conversations/${gid}`, { token: A, method: 'PATCH', body: { avatar: 'javascript:1' } });
	check('非法群头像被拒', r.status === 400, r.status);
	r = await api(`/chat/conversations/${gid}/kick`, { token: A, method: 'POST', body: { userId: 'alice@crazychaos.top' } });
	check('不能移出群主', r.status === 400, r.status);

	console.log('== 管理后台 ==');
	r = await api('/chat/admin/stats', { token: A });
	check('普通用户进不了后台', r.status === 403, r.status);
	r = await api('/chat/admin/stats', { token: ADM });
	check('管理员看统计', r.status === 200 && r.data?.data?.groups >= 2, r.data?.data);
	r = await api('/chat/admin/users', { token: ADM });
	check('管理员看用户列表', Array.isArray(r.data?.data) && r.data.data.length >= 3, r.data?.data?.length);
	r = await api('/chat/admin/groups', { token: ADM });
	check('管理员看群列表', Array.isArray(r.data?.data) && r.data.data.length >= 2, r.data?.data?.length);
	r = await api('/chat/admin/audit', { token: ADM });
	check('操作日志有记录', Array.isArray(r.data?.data) && r.data.data.length > 0, r.data?.data?.length);

	r = await api('/chat/admin/users/3', { token: ADM, method: 'POST', body: { banned: true } });
	check('封禁用户', r.data?.data?.banned === 1, r.data);
	r = await api('/chat/me', { token: B });
	check('被封禁后不能使用', r.status === 403, r.status);
	await api('/chat/admin/users/3', { token: ADM, method: 'POST', body: { banned: false } });
	r = await api('/chat/me', { token: B });
	check('解封后恢复', r.status === 200, r.status);

	console.log('== 机器人 ==');
	r = await api('/chat/admin/bots', { token: ADM, method: 'POST', body: { name: '通知姬', endpoint: 'http://127.0.0.1:9/onebot' } });
	const botId = r.data?.data?.id;
	check('创建机器人', Boolean(botId), r.data);
	r = await api('/chat/admin/settings', { token: ADM, method: 'POST', body: { defaultBotId: botId } });
	check('设为站点默认机器人', r.data?.data?.defaultBotId === botId, r.data?.data);
	r = await api('/chat/bots', { token: A });
	check('普通用户能读到可用机器人', Array.isArray(r.data?.data), r.data);

	r = await api('/chat/me/qq', { token: B, method: 'POST', body: { qq: '1234567' } });
	check('绑定个人 QQ', r.data?.data?.qq === '1234567', r.data);
	r = await api(`/chat/conversations/${gid}/messages`, { token: A, method: 'POST', body: { kind: 'text', body: { text: '触发一次提醒' } } });
	check('发消息不报错', r.status === 200, r.status);
	await new Promise(res => setTimeout(res, 1200));
	r = await api(`/chat/admin/bot-queue?convId=${gid}`, { token: ADM });
	const qrow = (r.data?.data || [])[0];
	check('提醒进入队列', Boolean(qrow), r.data?.data);
	check('提醒里带 QQ 号', qrow && qrow.payload?.userId === '1234567', qrow && qrow.payload);
	check('私聊提醒不带正文', qrow && !String(qrow.payload?.text || '').includes('触发一次提醒'), qrow && qrow.payload?.text);

	console.log('== 免打扰 ==');
	r = await api(`/chat/conversations/${gid}/mute`, { token: B, method: 'POST', body: { muted: true } });
	check('开启免打扰', r.data?.data?.muted === true, r.data);
	r = await api('/chat/conversations', { token: B });
	const gMuted = (r.data?.data || []).find(c => c.id === gid);
	check('摘要里带 muted 标记', gMuted && gMuted.muted === true, gMuted?.muted);
	r = await api(`/chat/conversations/${gid}/messages`, { token: A, method: 'POST', body: { kind: 'text', body: { text: '免打扰期间的内容' } } });
	const mutedMsgId = r.data?.data?.id;
	await new Promise(res => setTimeout(res, 1200));
	r = await api(`/chat/admin/bot-queue?convId=${gid}`, { token: ADM });
	check('免打扰后不再进提醒队列', (r.data?.data || []).every(x => !(x.msgId === mutedMsgId && x.payload?.userId === '1234567')), mutedMsgId);
	r = await api(`/chat/conversations/${gid}/mute`, { token: B, method: 'POST', body: { muted: false } });
	check('关闭免打扰', r.data?.data?.muted === false, r.data);
	r = await api(`/chat/conversations/${gid}/messages`, { token: A, method: 'POST', body: { kind: 'text', body: { text: '解除后能收到' } } });
	const unmutedMsgId = r.data?.data?.id;
	await new Promise(res => setTimeout(res, 1200));
	r = await api(`/chat/admin/bot-queue?convId=${gid}`, { token: ADM });
	check('解除免打扰后恢复提醒', (r.data?.data || []).some(x => x.msgId === unmutedMsgId && x.payload?.userId === '1234567'), unmutedMsgId);
	r = await api(`/chat/conversations/${gid}/mute`, { method: 'POST', body: { muted: true } });
	check('游客不能设置免打扰', r.status === 401, r.status);

	console.log('== 举报 ==');
	r = await api('/chat/reports', { token: B, method: 'POST', body: { convId: gid, msgId: m1, reason: '测试举报' } });
	check('提交举报', r.data?.data?.reported === true, r.data);
	r = await api('/chat/admin/reports', { token: ADM });
	check('管理员看举报', (r.data?.data || []).length >= 1, r.data?.data?.length);

	console.log('== 解散 ==');
	r = await api(`/chat/conversations/${gid}`, { token: A, method: 'DELETE' });
	check('群主解散群', r.data?.data?.archived === true, r.data);
	r = await api(`/chat/conversations/${gid}/messages`);
	check('解散后游客也读不到', r.status === 403 || r.status === 404, r.status);

	console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
	process.exit(fail ? 1 : 0);
})();
