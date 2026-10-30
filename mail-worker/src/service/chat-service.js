/**
 * 聊天组业务逻辑（D1 + KV + R2）
 *
 * 身份：chat_*.user_id 是数字，对应 D1 `user.user_id`；对外输出时换成 email，
 *      前端沿用 `id` 字段即可，不需要区分是邮箱还是编号。
 */

import BizError from '../error/biz-error';
import {
	db, now, uid, shortId, clampStr, oneOf, toInt, sha256Hex,
	convRow, membership, isMemberOf, guestReadable,
	hydrateUsers, getProfile, getProfiles, setProfile, audit, rateLimit, countSince,
	safeParse, previewOf, putBlob, getBlob, mimeOf, blobExtFor, sniffImage, assertR2
} from './chat-core';

const ADMIN_EMAIL_FALLBACK = 'admin@crazychaos.top';

// ---------------------------------------------------------------- 用户解析

/** 前端传的 id 可能是邮箱，也可能是数字 uid */
async function lookupUser(c, raw) {
	const v = clampStr(String(raw || ''), 200).toLowerCase();
	if (!v) return null;
	if (/^\d{1,12}$/.test(v)) {
		return await db.first(c, 'SELECT user_id, email, nickname FROM user WHERE user_id = ?', Number(v));
	}
	return await db.first(c, 'SELECT user_id, email, nickname FROM user WHERE LOWER(email) = ?', v);
}

/** 把 email / uid 统一换成数字 user_id，找不到抛 404 */
async function requireUserId(c, raw, message = '用户不存在') {
	const u = await lookupUser(c, raw);
	if (!u) throw new BizError(message, 404);
	return Number(u.user_id);
}

// ---------------------------------------------------------------- 会话摘要

/**
 * 批量组装会话摘要，避免 N+1。
 * viewer 为 null 时表示游客（不查未读、不查成员身份）。
 */
async function buildSummaries(c, convs, viewerId) {
	if (!convs.length) return [];
	const ids = convs.map(x => x.id);
	const ph = ids.map(() => '?').join(',');

	const [lastRows, countRows, pendingRows, myRows, readRows] = await Promise.all([
		db.all(c, `SELECT m.conv_id, m.id, m.sender_id, m.kind, m.body, m.created_at
			FROM chat_message m
			JOIN (SELECT conv_id, MAX(id) AS mid FROM chat_message
				WHERE conv_id IN (${ph}) AND deleted = 0 GROUP BY conv_id) t ON t.mid = m.id`, ...ids),
		db.all(c, `SELECT conv_id, COUNT(*) AS c FROM chat_member
			WHERE conv_id IN (${ph}) AND status = 'active' GROUP BY conv_id`, ...ids),
		db.all(c, `SELECT conv_id, COUNT(*) AS c FROM chat_member
			WHERE conv_id IN (${ph}) AND status = 'pending' GROUP BY conv_id`, ...ids),
		viewerId
			? db.all(c, `SELECT * FROM chat_member WHERE user_id = ? AND conv_id IN (${ph})`, viewerId, ...ids)
			: Promise.resolve([]),
		viewerId
			? db.all(c, `SELECT conv_id, last_id FROM chat_read WHERE user_id = ? AND conv_id IN (${ph})`, viewerId, ...ids)
			: Promise.resolve([])
	]);

	// 未读：按每个会话自己的 last_id 统计（没有已读记录的会话视作 last_id = 0）
	let unreadRows = [];
	if (viewerId) {
		unreadRows = await db.all(c, `
			SELECT m.conv_id, COUNT(*) AS c
			FROM chat_message m
			LEFT JOIN chat_read r ON r.conv_id = m.conv_id AND r.user_id = ?
			WHERE m.conv_id IN (${ph}) AND m.id > COALESCE(r.last_id, 0)
				AND m.sender_id <> ? AND m.deleted = 0
			GROUP BY m.conv_id`, viewerId, ...ids, viewerId);
	}

	// 私聊对方
	const dmIds = convs.filter(x => x.type === 'dm').map(x => x.id);
	let peerRows = [];
	if (dmIds.length) {
		const ph2 = dmIds.map(() => '?').join(',');
		peerRows = await db.all(c,
			`SELECT conv_id, user_id FROM chat_member WHERE conv_id IN (${ph2}) AND user_id <> ?`,
			...dmIds, viewerId || 0);
	}

	// 一次性补齐所有涉及的用户资料
	const userIds = [
		...lastRows.map(r => r.sender_id),
		...peerRows.map(r => r.user_id),
		...convs.map(x => x.owner_id)
	];
	const users = await hydrateUsers(c, userIds);

	const lastMap = new Map(lastRows.map(r => [r.conv_id, r]));
	const countMap = new Map(countRows.map(r => [r.conv_id, Number(r.c)]));
	const pendingMap = new Map(pendingRows.map(r => [r.conv_id, Number(r.c)]));
	const myMap = new Map(myRows.map(r => [r.conv_id, r]));
	const readMap = new Map(readRows.map(r => [r.conv_id, Number(r.last_id)]));
	const unreadMap = new Map(unreadRows.map(r => [r.conv_id, Number(r.c)]));
	const peerMap = new Map(peerRows.map(r => [r.conv_id, Number(r.user_id)]));

	return convs.map(conv => {
		const m = myMap.get(conv.id) || null;
		const last = lastMap.get(conv.id) || null;
		const peerId = peerMap.get(conv.id);
		const peer = peerId ? users.get(peerId) : null;
		const owner = users.get(Number(conv.owner_id));

		const name = conv.name
			|| (conv.type === 'dm' ? (peer ? peer.nickname : '私聊') : '未命名群组');

		return {
			id: conv.id,
			type: conv.type,
			name,
			description: conv.description || '',
			avatar: conv.avatar || '',
			notifyBotId: conv.notify_bot_id || '',
			visibility: conv.visibility,
			joinMode: conv.join_mode,
			encMode: conv.enc_mode,
			ownerId: owner ? owner.id : String(conv.owner_id || ''),
			archived: Number(conv.archived) === 1,
			locked: Number(conv.locked) === 1,
			createdAt: conv.created_at,
			updatedAt: conv.updated_at,
			memberCount: countMap.get(conv.id) || 0,
			pendingCount: m && (m.role === 'owner' || m.role === 'admin')
				? (pendingMap.get(conv.id) || 0) : 0,
			myRole: m ? m.role : null,
			myStatus: m ? m.status : null,
			unread: viewerId ? (unreadMap.get(conv.id) || 0) : 0,
			peer: conv.type === 'dm' ? peer : null,
			lastMessage: last ? {
				id: last.id,
				senderId: last.sender_id,
				kind: last.kind,
				preview: previewOf(last, conv),
				createdAt: last.created_at
			} : null
		};
	});
}

const summaryOne = async (c, conv, viewerId) => (await buildSummaries(c, [conv], viewerId))[0];

// ---------------------------------------------------------------- 会话

export const chatService = {

	// ---- 我的会话列表
	async listMine(c, viewerId) {
		const rows = await db.all(c, `
			SELECT c.* FROM chat_conversation c
			JOIN chat_member m ON m.conv_id = c.id AND m.user_id = ? AND m.status = 'active'
			WHERE c.archived = 0
			ORDER BY c.updated_at DESC LIMIT 200`, viewerId);
		return buildSummaries(c, rows, viewerId);
	},

	// ---- 发现群组（游客可看；私密群只露名字）
	async discover(c, viewerId, kw, limit) {
		const key = clampStr(kw || '', 40);
		const lim = Math.min(toInt(limit, 30) || 30, 60);
		const rows = key
			? await db.all(c, `SELECT * FROM chat_conversation WHERE type = 'group' AND archived = 0
				AND (name LIKE ? OR (visibility = 'public' AND description LIKE ?))
				ORDER BY updated_at DESC LIMIT ?`, `%${key}%`, `%${key}%`, lim)
			: await db.all(c, `SELECT * FROM chat_conversation WHERE type = 'group' AND archived = 0
				ORDER BY updated_at DESC LIMIT ?`, lim);

		const list = await buildSummaries(c, rows, viewerId);
		return list.map((s, i) => {
			const conv = rows[i];
			if (conv.visibility === 'private' && !(s.myStatus === 'active')) {
				// 私密群只留名字，其余一律抹掉
				return { ...s, description: '', lastMessage: null, memberCount: 0, unread: 0 };
			}
			return s;
		});
	},

	// ---- 会话详情
	async detail(c, convId, viewerId) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const m = await membership(c, conv.id, viewerId);
		if (conv.type === 'dm' && !(m && m.status === 'active')) throw new BizError('无权访问该会话', 403);
		if (Number(conv.archived) === 1 && !(m && m.status === 'active')) throw new BizError('会话不存在', 404);

		const viewerIsMember = Boolean(m && m.status === 'active');
		let members = [];
		if (viewerIsMember) {
			const rows = await db.all(c, `
				SELECT mem.user_id, mem.role, mem.status, mem.joined_at, mem.qq,
					u.email, u.nickname
				FROM chat_member mem JOIN user u ON u.user_id = mem.user_id
				WHERE mem.conv_id = ? AND mem.status IN ('active','pending')
				ORDER BY mem.joined_at ASC`, conv.id);
			const profiles = await getProfiles(c, rows.map(r => Number(r.user_id)));
			members = rows.map(r => ({
				id: String(r.email).toLowerCase(),
				uid: Number(r.user_id),
				avatar: (profiles.get(Number(r.user_id)) || {}).avatar || '',
				nickname: r.nickname || String(r.email).split('@')[0],
				role: r.role,
				status: r.status,
				joinedAt: r.joined_at
			}));
		}
		return { conversation: await summaryOne(c, conv, viewerId), members };
	},

	// ---- 建群
	async createGroup(c, user, body) {
		const madeRecently = await countSince(c,
			'SELECT COUNT(*) AS c FROM chat_conversation WHERE owner_id = ? AND created_at > ?',
			user.userId, now() - 60_000);
		if (madeRecently >= 5) throw new BizError('创建太频繁，稍后再试', 429);
		const name = clampStr(body.name, 24);
		if (!name) throw new BizError('群名称不能为空', 400);
		if (oneOf(body.type, ['group', 'dm'], 'group') === 'dm') throw new BizError('请使用私聊接口', 400);

		const visibility = oneOf(body.visibility, ['public', 'private'], 'public');
		let joinMode = oneOf(body.joinMode, ['open', 'invite', 'approval'], 'approval');
		let encMode = oneOf(body.encMode, ['plain', 'e2ee'], 'e2ee');
		// 私密群强制「邀请码 + 端到端」
		if (visibility === 'private') { joinMode = 'invite'; encMode = 'e2ee'; }

		const id = uid();
		const t = now();
		await db.run(c, `INSERT INTO chat_conversation
			(id, type, name, description, visibility, join_mode, enc_mode, owner_id, created_at, updated_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`,
			id, 'group', name, clampStr(body.description, 200), visibility, joinMode, encMode, user.userId, t, t);
		await db.run(c, `INSERT INTO chat_member (conv_id, user_id, role, status, joined_at)
			VALUES (?,?,?,?,?)`, id, user.userId, 'owner', 'active', t);
		await audit(c, user.userId, 'group.create', id, { name, visibility, joinMode, encMode });
		return summaryOne(c, await convRow(c, id), user.userId);
	},

	// ---- 开私聊（幂等）
	async openDM(c, user, body) {
		const target = await requireUserId(c, body.userId, '对方尚未使用过聊天组');
		if (target === user.userId) throw new BizError('无效的聊天对象', 400);
		const pair = [user.userId, target].map(String).sort().join('|');
		const id = 'dm_' + (await sha256Hex(pair)).slice(0, 24);
		let conv = await convRow(c, id);
		const t = now();
		if (!conv) {
			await db.run(c, `INSERT INTO chat_conversation
				(id, type, name, description, visibility, join_mode, enc_mode, owner_id, created_at, updated_at)
				VALUES (?,?,?,?,?,?,?,?,?,?)`,
				id, 'dm', '', '', 'private', 'invite', 'e2ee', user.userId, t, t);
			await db.run(c, `INSERT INTO chat_member (conv_id, user_id, role, status, joined_at)
				VALUES (?,?,?,?,?)`, id, user.userId, 'owner', 'active', t);
			await db.run(c, `INSERT INTO chat_member (conv_id, user_id, role, status, joined_at)
				VALUES (?,?,?,?,?)`, id, target, 'member', 'active', t);
			conv = await convRow(c, id);
		}
		return summaryOne(c, conv, user.userId);
	},

	// ---- 改群资料
	async updateConversation(c, user, convId, body, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (conv.type === 'dm') throw new BizError('私聊不可修改', 400);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && m.role === 'owner')) throw new BizError('只有群主可以修改', 403);

		const name = body.name !== undefined ? clampStr(body.name, 24) : conv.name;
		const desc = body.description !== undefined ? clampStr(body.description, 200) : conv.description;
		const visibility = body.visibility ? oneOf(body.visibility, ['public', 'private'], conv.visibility) : conv.visibility;
		const joinMode = body.joinMode ? oneOf(body.joinMode, ['open', 'invite', 'approval'], conv.join_mode) : conv.join_mode;

		let avatar = conv.avatar || '';
		if (body.avatar !== undefined) {
			const raw = clampStr(body.avatar, 400);
			const builtin = /^\/123\/emoji_([1-9]|1\d|2[0-4])\.(webp|avif)$/.test(raw);
			const uploaded = /^\/api\/chat\/avatar\/[A-Za-z0-9._-]{1,80}$/.test(raw);
			const remote = raw === '' || (raw.startsWith('https://') && raw.length <= 300 && !/[\s"']/.test(raw));
			if (!builtin && !uploaded && !remote) throw new BizError('头像格式不支持', 400);
			avatar = raw;
		}

		await db.run(c, `UPDATE chat_conversation
			SET name = ?, description = ?, visibility = ?, join_mode = ?, avatar = ?, updated_at = ?
			WHERE id = ?`, name, desc, visibility, joinMode, avatar, now(), conv.id);
		await audit(c, user.userId, 'group.update', conv.id, { name, visibility, joinMode });
		return summaryOne(c, await convRow(c, conv.id), user.userId);
	},

	// ---- 解散
	async archive(c, user, convId, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (conv.type === 'dm') throw new BizError('私聊不可解散', 400);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && m.role === 'owner')) throw new BizError('只有群主可以解散', 403);
		await db.run(c, 'UPDATE chat_conversation SET archived = 1, updated_at = ? WHERE id = ?', now(), conv.id);
		await audit(c, user.userId, 'group.archive', conv.id, { byAdmin: Boolean(isAdmin) });
		return { archived: true };
	},

	// ---- 加入
	async join(c, user, convId, body) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (conv.type !== 'group') throw new BizError('无法加入该会话', 400);
		if (Number(conv.archived) === 1) throw new BizError('群组已解散', 400);
		if (Number(conv.locked) === 1) throw new BizError('群组已被管理员锁定', 403);

		const existing = await membership(c, conv.id, user.userId);
		if (existing && existing.status === 'active') return { status: 'active' };
		if (existing && existing.status === 'pending') return { status: 'pending' };
		if (existing && existing.status === 'banned') throw new BizError('你已被移出该群', 403);

		let status = 'active';
		if (conv.join_mode === 'invite') {
			const code = clampStr(body.code, 64).toUpperCase();
			const inv = code
				? await db.first(c, 'SELECT * FROM chat_invite WHERE code = ? AND conv_id = ?', code, conv.id)
				: null;
			if (!inv) throw new BizError('邀请码无效', 403);
			if (Number(inv.expires_at) && Number(inv.expires_at) < now()) throw new BizError('邀请码已过期', 403);
			if (Number(inv.max_uses) && Number(inv.uses) >= Number(inv.max_uses)) throw new BizError('邀请码已用完', 403);
			await db.run(c, 'UPDATE chat_invite SET uses = uses + 1 WHERE code = ?', code);
			status = conv.visibility === 'private' ? 'pending' : 'active';
		} else if (conv.join_mode === 'approval') {
			status = 'pending';
		}

		if (existing) {
			await db.run(c, 'UPDATE chat_member SET status = ?, joined_at = ? WHERE conv_id = ? AND user_id = ?',
				status, now(), conv.id, user.userId);
		} else {
			await db.run(c, 'INSERT INTO chat_member (conv_id, user_id, role, status, joined_at) VALUES (?,?,?,?,?)',
				conv.id, user.userId, 'member', status, now());
		}
		await audit(c, user.userId, 'group.join', conv.id, { status });
		return { status, conversation: await summaryOne(c, await convRow(c, conv.id), user.userId) };
	},

	// ---- 待审批列表
	async pendingList(c, user, convId, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && (m.role === 'owner' || m.role === 'admin'))) throw new BizError('权限不足', 403);
		const rows = await db.all(c, `
			SELECT mem.user_id, mem.joined_at, u.email, u.nickname
			FROM chat_member mem JOIN user u ON u.user_id = mem.user_id
			WHERE mem.conv_id = ? AND mem.status = 'pending' ORDER BY mem.joined_at ASC`, conv.id);
		return rows.map(r => ({
			id: String(r.email).toLowerCase(),
			uid: Number(r.user_id),
			nickname: r.nickname || String(r.email).split('@')[0],
			requestedAt: r.joined_at
		}));
	},

	// ---- 审批
	async review(c, user, convId, body, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && (m.role === 'owner' || m.role === 'admin'))) throw new BizError('权限不足', 403);
		const target = await requireUserId(c, body.userId);
		const action = oneOf(body.action, ['approve', 'reject'], 'approve');
		const tm = await membership(c, conv.id, target);
		if (!tm || tm.status !== 'pending') throw new BizError('没有待审批的申请', 404);
		if (action === 'approve') {
			await db.run(c, `UPDATE chat_member SET status = 'active', joined_at = ? WHERE conv_id = ? AND user_id = ?`,
				now(), conv.id, target);
		} else {
			await db.run(c, 'DELETE FROM chat_member WHERE conv_id = ? AND user_id = ?', conv.id, target);
		}
		await audit(c, user.userId, 'group.' + action, conv.id, { target });
		return { action, userId: String(body.userId) };
	},

	// ---- 群内直接加人
	async addMember(c, user, convId, body, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (conv.type !== 'group') throw new BizError('只能往群组加人', 400);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && (m.role === 'owner' || m.role === 'admin'))) throw new BizError('权限不足', 403);

		const target = await requireUserId(c, body.userId, '对方还没注册过账号，无法添加');
		if (target === user.userId) throw new BizError('无效的成员', 400);
		const prof = await getProfile(c, target);
		if (Number(prof.banned) === 1) throw new BizError('该账号已被封禁', 400);

		const exist = await membership(c, conv.id, target);
		if (exist && exist.status === 'active') throw new BizError('对方已经在群里了', 400);
		if (exist) {
			await db.run(c, `UPDATE chat_member SET status = 'active', joined_at = ? WHERE conv_id = ? AND user_id = ?`,
				now(), conv.id, target);
		} else {
			await db.run(c, 'INSERT INTO chat_member (conv_id, user_id, role, status, joined_at) VALUES (?,?,?,?,?)',
				conv.id, target, 'member', 'active', now());
		}
		await audit(c, user.userId, 'group.add_member', conv.id, { target });
		const u = await hydrateUsers(c, [target]);
		const info = u.get(target);
		return { added: info.id, nickname: info.nickname, uid: target, needKeys: conv.enc_mode === 'e2ee' };
	},

	// ---- 移出
	async kick(c, user, convId, body, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && (m.role === 'owner' || m.role === 'admin'))) throw new BizError('权限不足', 403);
		const target = await requireUserId(c, body.userId);
		if (target === Number(conv.owner_id)) throw new BizError('不能移出群主', 400);
		const tm = await membership(c, conv.id, target);
		if (!tm) throw new BizError('该用户不在群内', 404);
		if (m && m.role === 'admin' && tm.role === 'admin') throw new BizError('不能移出其他管理员', 403);
		await db.run(c, `UPDATE chat_member SET status = 'banned' WHERE conv_id = ? AND user_id = ?`, conv.id, target);
		await db.run(c, 'DELETE FROM chat_group_key WHERE conv_id = ? AND user_id = ?', conv.id, target);
		await audit(c, user.userId, 'group.kick', conv.id, { target });
		return { removed: String(target) };
	},

	// ---- 设管理员
	async setRole(c, user, convId, targetRaw, body, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (Number(conv.owner_id) !== user.userId && !isAdmin) throw new BizError('只有群主可以设置管理', 403);
		const target = await requireUserId(c, targetRaw);
		const role = oneOf(body.role, ['admin', 'member'], 'member');
		if (target === Number(conv.owner_id)) throw new BizError('不能修改群主角色', 400);
		await db.run(c, 'UPDATE chat_member SET role = ? WHERE conv_id = ? AND user_id = ? AND status = ?',
			role, conv.id, target, 'active');
		await audit(c, user.userId, 'group.role', conv.id, { target, role });
		return { userId: String(target), role };
	},

	// ---- 退群
	async leave(c, user, convId) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (Number(conv.owner_id) === user.userId) throw new BizError('群主请先转让或解散群组', 400);
		await db.run(c, 'DELETE FROM chat_member WHERE conv_id = ? AND user_id = ?', conv.id, user.userId);
		await db.run(c, 'DELETE FROM chat_group_key WHERE conv_id = ? AND user_id = ?', conv.id, user.userId);
		return { left: true };
	},

	// ---- 邀请码
	async createInvite(c, user, convId, body, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && (m.role === 'owner' || m.role === 'admin'))) throw new BizError('权限不足', 403);
		const code = shortId(8).toUpperCase().slice(0, 12);
		const ttlHours = Math.max(0, Math.min(720, toInt(body.ttlHours, 0)));
		const maxUses = Math.max(0, Math.min(1000, toInt(body.maxUses, 0)));
		await db.run(c, `INSERT INTO chat_invite (code, conv_id, created_by, created_at, expires_at, max_uses, uses)
			VALUES (?,?,?,?,?,?,0)`,
			code, conv.id, user.userId, now(), ttlHours ? now() + ttlHours * 3600_000 : 0, maxUses);
		await audit(c, user.userId, 'invite.create', conv.id, { code, maxUses });
		return { code, expiresIn: ttlHours * 3600, maxUses };
	},

	async listInvites(c, user, convId, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && (m.role === 'owner' || m.role === 'admin'))) throw new BizError('权限不足', 403);
		const rows = await db.all(c, 'SELECT * FROM chat_invite WHERE conv_id = ? ORDER BY created_at DESC LIMIT 50', conv.id);
		return rows.map(r => ({
			code: r.code, createdAt: r.created_at, expiresAt: r.expires_at,
			maxUses: r.max_uses, uses: r.uses
		}));
	},

	// ---------------------------------------------------------------- 消息

	async messages(c, convId, viewerId, opts = {}) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const readable = guestReadable(conv) || await isMemberOf(c, conv.id, viewerId);
		if (!readable) throw new BizError('无权读取该会话', 403);

		const limit = Math.min(toInt(opts.limit, 40) || 40, 100);
		const after = toInt(opts.after, 0);
		const before = toInt(opts.before, 0) || Number.MAX_SAFE_INTEGER;

		const rows = after
			? await db.all(c, `
				SELECT m.id, m.sender_id, m.kind, m.body, m.created_at, u.email, u.nickname
				FROM chat_message m LEFT JOIN user u ON u.user_id = m.sender_id
				WHERE m.conv_id = ? AND m.id > ? AND m.deleted = 0
				ORDER BY m.id ASC LIMIT ?`, conv.id, after, limit)
			: (await db.all(c, `
				SELECT m.id, m.sender_id, m.kind, m.body, m.created_at, u.email, u.nickname
				FROM chat_message m LEFT JOIN user u ON u.user_id = m.sender_id
				WHERE m.conv_id = ? AND m.id < ? AND m.deleted = 0
				ORDER BY m.id DESC LIMIT ?`, conv.id, before, limit)).reverse();

		const profiles = await getProfiles(c, rows.map(r => Number(r.sender_id)));
		return {
			encMode: conv.enc_mode,
			messages: rows.map(r => ({
				id: r.id,
				senderId: r.sender_id,
				senderEmail: r.email ? String(r.email).toLowerCase() : '',
				senderName: r.nickname || (r.email ? String(r.email).split('@')[0] : '用户' + r.sender_id),
				senderAvatar: (profiles.get(Number(r.sender_id)) || {}).avatar || '',
				senderUid: Number(r.sender_id),
				kind: r.kind,
				body: safeParse(r.body),
				createdAt: r.created_at
			}))
		};
	},

	async sendMessage(c, user, convId, body) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (Number(conv.archived) === 1) throw new BizError('群组已解散', 400);
		const me = await membership(c, conv.id, user.userId);
		if (!me || me.status !== 'active') {
			if (me && me.status === 'pending') throw new BizError('入群申请待审批，暂时无法发言', 403);
			throw new BizError('你还不是该群成员', 403);
		}
		if (Number(me.muted) === 1) throw new BizError('你已被禁言', 403);
		const sentRecently = await countSince(c,
			'SELECT COUNT(*) AS c FROM chat_message WHERE sender_id = ? AND created_at > ?',
			user.userId, now() - 15_000);
		if (sentRecently >= 20) throw new BizError('发送太快了，休息一下', 429);

		const kind = oneOf(body.kind, ['text', 'image'], 'text');
		const bodyRaw = body.body;
		let payload;

		if (kind === 'image') {
			const obj = (bodyRaw && typeof bodyRaw === 'object') ? bodyRaw : {};
			const key = clampStr(obj.key, 300);
			if (!key || key.indexOf(conv.id + '/') !== 0) throw new BizError('图片引用不合法', 400);
			const iv = clampStr(obj.iv, 64);
			if (conv.enc_mode === 'e2ee' && !iv) throw new BizError('加密群必须带上图片的 iv', 400);
			payload = JSON.stringify({
				key, iv,
				w: Math.max(0, Math.min(8000, toInt(obj.w, 0))),
				h: Math.max(0, Math.min(8000, toInt(obj.h, 0))),
				enc: conv.enc_mode === 'e2ee'
			});
		} else if (conv.enc_mode === 'e2ee') {
			if (!bodyRaw || typeof bodyRaw !== 'object'
				|| typeof bodyRaw.ct !== 'string' || typeof bodyRaw.iv !== 'string') {
				throw new BizError('加密群组必须提交密文', 400);
			}
			if (bodyRaw.ct.length > 24_000) throw new BizError('消息过长', 413);
			payload = JSON.stringify({ iv: bodyRaw.iv.slice(0, 64), ct: bodyRaw.ct.slice(0, 24_000) });
		} else {
			const text = clampStr(bodyRaw && bodyRaw.text ? bodyRaw.text : (typeof bodyRaw === 'string' ? bodyRaw : ''), 2000);
			if (!text) throw new BizError('消息不能为空', 400);
			payload = JSON.stringify({ text });
		}

		const t = now();
		const info = await db.run(c, `INSERT INTO chat_message (conv_id, sender_id, kind, body, created_at)
			VALUES (?,?,?,?,?)`, conv.id, user.userId, kind, payload, t);
		const id = Number(info.meta?.last_row_id || info.meta?.lastRowId || 0);
		await db.run(c, 'UPDATE chat_conversation SET updated_at = ? WHERE id = ?', t, conv.id);
		await db.run(c, `INSERT INTO chat_read (conv_id, user_id, last_id) VALUES (?,?,?)
			ON CONFLICT(conv_id, user_id) DO UPDATE SET last_id = excluded.last_id`, conv.id, user.userId, id);

		const prof = await getProfile(c, user.userId);
		return {
			id,
			convId: conv.id,
			senderId: user.userId,
			senderEmail: user.email,
			senderName: user.nickname || user.email.split('@')[0],
			senderAvatar: prof.avatar || '',
			senderUid: user.userId,
			kind,
			body: safeParse(payload),
			createdAt: t
		};
	},

	async markRead(c, user, convId, body) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const id = toInt(body.id, 0);
		if (!id) throw new BizError('缺少消息 id', 400);
		await db.run(c, `INSERT INTO chat_read (conv_id, user_id, last_id) VALUES (?,?,?)
			ON CONFLICT(conv_id, user_id) DO UPDATE SET last_id = MAX(last_id, excluded.last_id)`,
			conv.id, user.userId, id);
		return { read: id };
	},

	// ---------------------------------------------------------------- 群密钥

	async myKey(c, user, convId) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (!await isMemberOf(c, conv.id, user.userId)) throw new BizError('仅成员可获取密钥', 403);
		const row = await db.first(c, 'SELECT wrapped, updated_at FROM chat_group_key WHERE conv_id = ? AND user_id = ?',
			conv.id, user.userId);
		return { wrapped: row ? row.wrapped : null, updatedAt: row ? row.updated_at : 0 };
	},

	async keyMembers(c, user, convId) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (!await isMemberOf(c, conv.id, user.userId)) throw new BizError('仅成员可查看', 403);
		const rows = await db.all(c, `
			SELECT mem.user_id, u.email, u.nickname,
				(SELECT COUNT(*) FROM chat_group_key g WHERE g.conv_id = mem.conv_id AND g.user_id = mem.user_id) AS has
			FROM chat_member mem JOIN user u ON u.user_id = mem.user_id
			WHERE mem.conv_id = ? AND mem.status = 'active'`, conv.id);
		const profiles = await getProfiles(c, rows.map(r => Number(r.user_id)));
		return rows.map(r => ({
			userId: String(r.email).toLowerCase(),
			uid: Number(r.user_id),
			nickname: r.nickname || String(r.email).split('@')[0],
			hasKey: Number(r.has) > 0,
			pubKey: (profiles.get(Number(r.user_id)) || {}).pubKey || null
		}));
	},

	async putKey(c, user, convId, body) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (!await isMemberOf(c, conv.id, user.userId)) throw new BizError('仅成员可分发密钥', 403);
		const target = await requireUserId(c, body.userId);
		const wrapped = clampStr(body.wrapped, 20_000);
		if (!wrapped) throw new BizError('缺少参数', 400);
		if (!await isMemberOf(c, conv.id, target)) throw new BizError('目标用户不在群内', 400);
		await db.run(c, `INSERT INTO chat_group_key (conv_id, user_id, wrapped, updated_at) VALUES (?,?,?,?)
			ON CONFLICT(conv_id, user_id) DO UPDATE SET wrapped = excluded.wrapped, updated_at = excluded.updated_at`,
			conv.id, target, wrapped, now());
		return { delivered: String(target) };
	},

	// ---------------------------------------------------------------- 举报

	async report(c, user, body) {
		const convId = clampStr(body.convId, 64);
		const reason = clampStr(body.reason, 300);
		if (!convId || !reason) throw new BizError('缺少参数', 400);
		const reportedRecently = await countSince(c,
			'SELECT COUNT(*) AS c FROM chat_report WHERE reporter_id = ? AND created_at > ?',
			user.userId, now() - 300_000);
		if (reportedRecently >= 5) throw new BizError('举报过于频繁', 429);
		await db.run(c, 'INSERT INTO chat_report (conv_id, msg_id, reporter_id, reason, created_at) VALUES (?,?,?,?,?)',
			convId, toInt(body.msgId, 0), user.userId, reason, now());
		return { reported: true };
	},

	// ---------------------------------------------------------------- 搜索人

	async searchUsers(c, me, kw) {
		const key = clampStr(kw, 60);
		if (!key) return [];
		const isNum = /^\d{1,12}$/.test(key);
		if (!isNum && key.length < 2) return [];
		let rows;
		if (isNum) {
			rows = await db.all(c, `SELECT user_id, email, nickname FROM user
				WHERE is_del = 0 AND user_id <> ? AND (user_id = ? OR email LIKE ? OR nickname LIKE ?)
				ORDER BY (user_id = ?) DESC, active_time DESC LIMIT 20`,
				me.userId, Number(key), `%${key}%`, `%${key}%`, Number(key));
		} else {
			rows = await db.all(c, `SELECT user_id, email, nickname FROM user
				WHERE is_del = 0 AND user_id <> ? AND (email LIKE ? OR nickname LIKE ?)
				ORDER BY active_time DESC LIMIT 20`,
				me.userId, `%${key}%`, `%${key}%`);
		}
		const profiles = await getProfiles(c, rows.map(r => Number(r.user_id)));
		return rows.map(r => {
			const prof = profiles.get(Number(r.user_id)) || {};
			return {
				id: String(r.email).toLowerCase(),
				uid: Number(r.user_id),
				nickname: r.nickname || String(r.email).split('@')[0],
				avatar: prof.avatar || '',
				banned: Number(prof.banned) === 1
			};
		}).filter(u => !u.banned).map(({ banned, ...rest }) => rest);
	},

	// ---------------------------------------------------------------- 管理后台

	async adminStats(c) {
		const one = async (sql, ...args) => Number((await db.first(c, sql, ...args))?.c || 0);
		const [users, groups, publicGroups, e2eeGroups, messages, recent, pending, reports] = await Promise.all([
			one('SELECT COUNT(*) AS c FROM user WHERE is_del = 0'),
			one("SELECT COUNT(*) AS c FROM chat_conversation WHERE type = 'group' AND archived = 0"),
			one("SELECT COUNT(*) AS c FROM chat_conversation WHERE type = 'group' AND visibility = 'public' AND enc_mode = 'plain' AND archived = 0"),
			one("SELECT COUNT(*) AS c FROM chat_conversation WHERE enc_mode = 'e2ee' AND archived = 0"),
			one('SELECT COUNT(*) AS c FROM chat_message WHERE deleted = 0'),
			one('SELECT COUNT(*) AS c FROM chat_message WHERE deleted = 0 AND created_at > ?', now() - 86400_000),
			one("SELECT COUNT(*) AS c FROM chat_member WHERE status = 'pending'"),
			one("SELECT COUNT(*) AS c FROM chat_report WHERE status = 'open'")
		]);
		const bans = await this.countBanned(c);
		return {
			users, groups, publicGroups, e2eeGroups, messages, messages24h: recent,
			pending, reports, online: 0, bans, version: '2.0.0 (workers)'
		};
	},

	async countBanned(c) {
		const row = await db.first(c, 'SELECT COUNT(*) AS c FROM chat_profile WHERE banned = 1');
		return Number((row && row.c) || 0);
	},

	async adminUsers(c, kw) {
		const key = clampStr(kw, 60);
		const rows = key
			? await db.all(c, `SELECT user_id, email, nickname, create_time, active_time FROM user
				WHERE is_del = 0 AND (email LIKE ? OR nickname LIKE ?) ORDER BY active_time DESC LIMIT 100`,
				`%${key}%`, `%${key}%`)
			: await db.all(c, `SELECT user_id, email, nickname, create_time, active_time FROM user
				WHERE is_del = 0 ORDER BY active_time DESC LIMIT 100`);
		const profiles = await getProfiles(c, rows.map(r => Number(r.user_id)));
		return rows.map(r => {
			const prof = profiles.get(Number(r.user_id)) || {};
			return {
				id: String(r.email).toLowerCase(),
				uid: Number(r.user_id),
				nickname: r.nickname || String(r.email).split('@')[0],
				avatar: prof.avatar || '',
				qq: prof.qq || '',
				banned: Number(prof.banned) === 1,
				hasKey: Boolean(prof.pubKey),
				createdAt: r.create_time,
				lastSeen: r.active_time
			};
		});
	},

	async adminSetUser(c, adminEmail, targetRaw, body) {
		const target = await requireUserId(c, targetRaw);
		const prof = await getProfile(c, target);
		if (body.banned !== undefined) {
			await setProfile(c, target, { banned: body.banned ? 1 : 0 });
		}
		await audit(c, 0, 'admin.user.update', String(target), { ...body, by: adminEmail });
		return { ...prof, ...(body.banned !== undefined ? { banned: body.banned ? 1 : 0 } : {}) };
	},

	async adminGroups(c, kw) {
		const key = clampStr(kw, 60);
		const rows = key
			? await db.all(c, `SELECT * FROM chat_conversation WHERE type = 'group'
				AND (name LIKE ? OR CAST(owner_id AS TEXT) LIKE ?) ORDER BY updated_at DESC LIMIT 100`,
				`%${key}%`, `%${key}%`)
			: await db.all(c, `SELECT * FROM chat_conversation WHERE type = 'group'
				ORDER BY updated_at DESC LIMIT 100`);
		return buildSummaries(c, rows, null);
	},

	async adminSetGroup(c, convId, body, adminEmail) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('群组不存在', 404);
		if (body.locked !== undefined) {
			await db.run(c, 'UPDATE chat_conversation SET locked = ? WHERE id = ?', body.locked ? 1 : 0, conv.id);
		}
		if (body.archived !== undefined) {
			await db.run(c, 'UPDATE chat_conversation SET archived = ? WHERE id = ?', body.archived ? 1 : 0, conv.id);
		}
		await audit(c, 0, 'admin.group.update', conv.id, { ...body, by: adminEmail });
		return summaryOne(c, await convRow(c, conv.id), null);
	},

	async adminReports(c) {
		const rows = await db.all(c, 'SELECT * FROM chat_report ORDER BY created_at DESC LIMIT 100');
		const out = [];
		for (const r of rows) {
			const msg = r.msg_id
				? await db.first(c, 'SELECT id, conv_id, sender_id, kind, body, created_at FROM chat_message WHERE id = ?', r.msg_id)
				: null;
			const conv = r.conv_id ? await convRow(c, r.conv_id) : null;
			out.push({
				id: r.id, convId: r.conv_id, msgId: r.msg_id, reporter: r.reporter_id,
				reason: r.reason, status: r.status, createdAt: r.created_at,
				messagePreview: msg ? previewOf(msg, conv || { enc_mode: 'plain' }) : null
			});
		}
		return out;
	},

	async adminSetReport(c, id, body) {
		const status = oneOf(body.status, ['open', 'resolved', 'dismissed'], 'resolved');
		await db.run(c, 'UPDATE chat_report SET status = ? WHERE id = ?', status, id);
		if (body.deleteMessage && body.msgId) {
			await db.run(c, 'UPDATE chat_message SET deleted = 1 WHERE id = ?', toInt(body.msgId, 0));
		}
		return { id, status };
	},

	async adminAudit(c) {
		return await db.all(c, 'SELECT * FROM chat_audit ORDER BY id DESC LIMIT 200');
	},

	// ---- 机器人
	async listBots(c, enabledOnly) {
		const rows = enabledOnly
			? await db.all(c, 'SELECT id, name, kind FROM chat_bot WHERE enabled = 1 ORDER BY created_at ASC')
			: await db.all(c, 'SELECT * FROM chat_bot ORDER BY created_at DESC');
		return enabledOnly ? rows : rows.map(r => ({
			id: r.id, name: r.name, kind: r.kind, endpoint: r.endpoint,
			qqGroupId: r.qq_group_id, convId: r.conv_id, enabled: Number(r.enabled) === 1,
			secretHint: r.secret ? r.secret.slice(0, 4) + '…' : '', createdAt: r.created_at
		}));
	},

	async createBot(c, body, actorId) {
		const name = clampStr(body.name, 32);
		const endpoint = clampStr(body.endpoint, 300);
		if (!name || !/^https?:\/\//.test(endpoint)) throw new BizError('名称或回调地址不合法', 400);
		const id = uid();
		const secret = shortId(24);
		await db.run(c, `INSERT INTO chat_bot (id, name, kind, endpoint, token, secret, qq_group_id, conv_id, enabled, created_at)
			VALUES (?,?,?,?,?,?,?,?,?,?)`,
			id, name, oneOf(body.kind, ['onebot'], 'onebot'), endpoint,
			clampStr(body.token, 200), secret, clampStr(body.qqGroupId, 32),
			clampStr(body.convId, 64), body.enabled === false ? 0 : 1, now());
		await audit(c, actorId, 'admin.bot.create', id, { name, endpoint });
		return { id, name, secret, endpoint };
	},

	async deleteBot(c, id, actorId) {
		await db.run(c, 'DELETE FROM chat_bot WHERE id = ?', id);
		await db.run(c, 'DELETE FROM chat_bot_queue WHERE bot_id = ?', id);
		await audit(c, actorId, 'admin.bot.delete', id, {});
		return { deleted: true };
	},

	async getSettings(c) {
		const row = await db.first(c, "SELECT v FROM chat_setting WHERE k = 'default_bot_id'");
		return { defaultBotId: row ? row.v : '' };
	},

	async saveSettings(c, body, actorId) {
		const botId = clampStr(body.defaultBotId, 64);
		if (botId) {
			const bot = await db.first(c, 'SELECT id FROM chat_bot WHERE id = ?', botId);
			if (!bot) throw new BizError('机器人不存在', 400);
		}
		await db.run(c, `INSERT INTO chat_setting (k, v) VALUES ('default_bot_id', ?)
			ON CONFLICT(k) DO UPDATE SET v = excluded.v`, botId);
		await audit(c, actorId, 'admin.settings', 'default_bot_id', { botId });
		return { defaultBotId: botId };
	},

	async botQueue(c, convId) {
		const key = clampStr(convId, 64);
		const rows = key
			? await db.all(c, 'SELECT * FROM chat_bot_queue WHERE conv_id = ? ORDER BY id DESC LIMIT 30', key)
			: await db.all(c, 'SELECT * FROM chat_bot_queue ORDER BY id DESC LIMIT 30');
		return rows.map(r => ({
			id: r.id, convId: r.conv_id, botId: r.bot_id, msgId: r.msg_id,
			payload: safeParse(r.payload), status: r.status, attempts: r.attempts,
			createdAt: r.created_at
		}));
	},

	// ---- 群级绑定（机器人 / 我的 QQ）
	async bindNotify(c, user, convId, body, isAdmin) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const m = await membership(c, conv.id, user.userId);
		if (!isAdmin && !(m && m.role === 'owner')) throw new BizError('只有群主可以设置', 403);
		const botId = clampStr(body.botId, 64);
		if (botId) {
			const bot = await db.first(c, 'SELECT id FROM chat_bot WHERE id = ? AND enabled = 1', botId);
			if (!bot) throw new BizError('机器人不存在或已停用', 400);
		}
		await db.run(c, 'UPDATE chat_conversation SET notify_bot_id = ?, updated_at = ? WHERE id = ?',
			botId, now(), conv.id);
		await audit(c, user.userId, 'group.notify', conv.id, { botId });
		return { notifyBotId: botId };
	},

	async getMyQQ(c, user, convId) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		const m = await membership(c, conv.id, user.userId);
		return { qq: m ? (m.qq || '') : '' };
	},

	async setMyQQ(c, user, convId, body) {
		const conv = await convRow(c, convId);
		if (!conv) throw new BizError('会话不存在', 404);
		if (!await isMemberOf(c, conv.id, user.userId)) throw new BizError('仅群成员可绑定', 403);
		const qq = clampStr(body.qq, 20);
		if (qq !== '' && !/^\d{5,12}$/.test(qq)) throw new BizError('QQ 号格式不正确', 400);
		await db.run(c, 'UPDATE chat_member SET qq = ? WHERE conv_id = ? AND user_id = ?', qq, conv.id, user.userId);
		return { qq };
	}
};

export default chatService;
