/**
 * 聊天组的表结构（D1）
 *
 * 设计原则：
 * 1) 账号信息不复制。邮箱 / 昵称 / userId 一律实时查 D1 的 `user` 表（cloud-mail 原有表）。
 *    这里只存聊天自己的数据，member / message 用 INTEGER user_id 关联到 `user.user_id`。
 * 2) 二进制一律进 R2（图片、加密图片、上传的头像），D1 只存引用。
 * 3) 所有 DDL 幂等，isolate 冷启动时批量执行一次即可。
 */

export const SCHEMA_VERSION = 'chat-v1';

export const DDL = [
	`CREATE TABLE IF NOT EXISTS chat_conversation (
		id            TEXT PRIMARY KEY,
		type          TEXT NOT NULL DEFAULT 'group',
		name          TEXT NOT NULL DEFAULT '',
		description   TEXT NOT NULL DEFAULT '',
		avatar        TEXT NOT NULL DEFAULT '',
		visibility    TEXT NOT NULL DEFAULT 'public',
		join_mode     TEXT NOT NULL DEFAULT 'open',
		enc_mode      TEXT NOT NULL DEFAULT 'plain',
		owner_id      INTEGER NOT NULL DEFAULT 0,
		archived      INTEGER NOT NULL DEFAULT 0,
		locked        INTEGER NOT NULL DEFAULT 0,
		notify_bot_id TEXT NOT NULL DEFAULT '',
		created_at    INTEGER NOT NULL,
		updated_at    INTEGER NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS idx_chat_conv_public ON chat_conversation (type, archived, updated_at)`,

	`CREATE TABLE IF NOT EXISTS chat_member (
		conv_id   TEXT NOT NULL,
		user_id   INTEGER NOT NULL,
		role      TEXT NOT NULL DEFAULT 'member',
		status    TEXT NOT NULL DEFAULT 'active',
		qq        TEXT NOT NULL DEFAULT '',
		muted     INTEGER NOT NULL DEFAULT 0,
		joined_at INTEGER NOT NULL,
		PRIMARY KEY (conv_id, user_id)
	)`,

	`CREATE INDEX IF NOT EXISTS idx_chat_member_user ON chat_member (user_id, status)`,
	`CREATE INDEX IF NOT EXISTS idx_chat_member_conv ON chat_member (conv_id, status)`,

	`CREATE TABLE IF NOT EXISTS chat_message (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		conv_id    TEXT NOT NULL,
		sender_id  INTEGER NOT NULL,
		kind       TEXT NOT NULL DEFAULT 'text',
		body       TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		deleted    INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_message (conv_id, id)`,

	`CREATE TABLE IF NOT EXISTS chat_group_key (
		conv_id    TEXT NOT NULL,
		user_id    INTEGER NOT NULL,
		wrapped    TEXT NOT NULL,
		updated_at INTEGER NOT NULL,
		PRIMARY KEY (conv_id, user_id)
	)`,

	`CREATE TABLE IF NOT EXISTS chat_read (
		conv_id TEXT NOT NULL,
		user_id INTEGER NOT NULL,
		last_id INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (conv_id, user_id)
	)`,

	`CREATE TABLE IF NOT EXISTS chat_invite (
		code       TEXT PRIMARY KEY,
		conv_id    TEXT NOT NULL,
		created_by INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		expires_at INTEGER NOT NULL DEFAULT 0,
		max_uses   INTEGER NOT NULL DEFAULT 0,
		uses       INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE INDEX IF NOT EXISTS idx_chat_invite_conv ON chat_invite (conv_id, created_at)`,

	`CREATE TABLE IF NOT EXISTS chat_report (
		id          INTEGER PRIMARY KEY AUTOINCREMENT,
		conv_id     TEXT NOT NULL DEFAULT '',
		msg_id      INTEGER NOT NULL DEFAULT 0,
		reporter_id INTEGER NOT NULL DEFAULT 0,
		reason      TEXT NOT NULL DEFAULT '',
		status      TEXT NOT NULL DEFAULT 'open',
		created_at  INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS chat_audit (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		actor      INTEGER NOT NULL DEFAULT 0,
		action     TEXT NOT NULL DEFAULT '',
		target     TEXT NOT NULL DEFAULT '',
		meta       TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS chat_bot (
		id          TEXT PRIMARY KEY,
		name        TEXT NOT NULL,
		kind        TEXT NOT NULL DEFAULT 'onebot',
		endpoint    TEXT NOT NULL,
		token       TEXT NOT NULL DEFAULT '',
		secret      TEXT NOT NULL,
		qq_group_id TEXT NOT NULL DEFAULT '',
		conv_id     TEXT NOT NULL DEFAULT '',
		enabled     INTEGER NOT NULL DEFAULT 1,
		created_at  INTEGER NOT NULL
	)`,

	`CREATE TABLE IF NOT EXISTS chat_bot_queue (
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		bot_id     TEXT NOT NULL DEFAULT '',
		conv_id    TEXT NOT NULL DEFAULT '',
		msg_id     INTEGER NOT NULL DEFAULT 0,
		payload    TEXT NOT NULL DEFAULT '',
		status     TEXT NOT NULL DEFAULT 'pending',
		attempts   INTEGER NOT NULL DEFAULT 0,
		next_at    INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS idx_chat_queue ON chat_bot_queue (status, next_at)`,

	`CREATE TABLE IF NOT EXISTS chat_setting (
		k TEXT PRIMARY KEY,
		v TEXT NOT NULL DEFAULT ''
	)`,

	// 聊天专有资料。账号本身仍在 D1 的 user 表，这里只放邮箱系统没有的字段。
	// 之所以不放 KV：免费版 KV 每天只有 1000 次写入，发消息记账会很快打满。
	`CREATE TABLE IF NOT EXISTS chat_profile (
		user_id        INTEGER PRIMARY KEY,
		avatar         TEXT NOT NULL DEFAULT '',
		qq             TEXT NOT NULL DEFAULT '',
		qq_openid      TEXT NOT NULL DEFAULT '',
		qq_bind_code   TEXT NOT NULL DEFAULT '',
		qq_bind_at     INTEGER NOT NULL DEFAULT 0,
		pub_key        TEXT,
		key_backup     TEXT,
		key_updated_at INTEGER NOT NULL DEFAULT 0,
		banned         INTEGER NOT NULL DEFAULT 0,
		updated_at     INTEGER NOT NULL DEFAULT 0
	)`,

	`CREATE INDEX IF NOT EXISTS idx_chat_profile_banned ON chat_profile (banned)`,

	// 只在低频动作（上传图片/头像）上用的滑动窗口计数
	`CREATE TABLE IF NOT EXISTS chat_throttle (
		bucket TEXT NOT NULL,
		ts     INTEGER NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS idx_chat_throttle ON chat_throttle (bucket, ts)`,

	`CREATE TABLE IF NOT EXISTS chat_push_sub (
		endpoint   TEXT PRIMARY KEY,
		user_id    INTEGER NOT NULL,
		p256dh     TEXT NOT NULL,
		auth       TEXT NOT NULL,
		ua         TEXT NOT NULL DEFAULT '',
		created_at INTEGER NOT NULL
	)`,

	`CREATE INDEX IF NOT EXISTS idx_chat_push_user ON chat_push_sub (user_id)`
];
