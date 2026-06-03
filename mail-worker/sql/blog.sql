-- Run after the main `/api/init/{jwt_secret}` database initialization.

CREATE TABLE IF NOT EXISTS blog_post (
	post_id INTEGER PRIMARY KEY AUTOINCREMENT,
	slug TEXT NOT NULL UNIQUE,
	title TEXT NOT NULL,
	summary TEXT NOT NULL DEFAULT '',
	cover_key TEXT NOT NULL DEFAULT '',
	content_key TEXT NOT NULL DEFAULT '',
	category TEXT NOT NULL DEFAULT '',
	tags TEXT NOT NULL DEFAULT '[]',
	status TEXT NOT NULL DEFAULT 'draft',
	view_count INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	published_at TEXT,
	user_id INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_blog_post_slug ON blog_post(slug);
CREATE INDEX IF NOT EXISTS idx_blog_post_status_published ON blog_post(status, published_at);

INSERT INTO perm (name, perm_key, pid, type, sort)
SELECT '博客管理', 'blog:manage', 17, 2, 8
WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_key = 'blog:manage');

INSERT INTO perm (name, perm_key, pid, type, sort)
SELECT '管理自己博客', 'blog:manage_own', 17, 2, 9
WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_key = 'blog:manage_own');
