import BizError from '../error/biz-error';
import fileUtils from '../utils/file-utils';
import permService from './perm-service';

const TABLE_SQL = `
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
)`;

function bindMaybe(statement, params) {
	return params.length ? statement.bind(...params) : statement;
}

const blogService = {
	async ensureTables(c) {
		await c.env.db.prepare(TABLE_SQL).run();
		try {
			await c.env.db.prepare('ALTER TABLE blog_post ADD COLUMN user_id INTEGER DEFAULT 0').run();
		} catch (e) {
			// column already exists
		}
		await c.env.db.prepare('CREATE INDEX IF NOT EXISTS idx_blog_post_slug ON blog_post(slug)').run();
		await c.env.db.prepare('CREATE INDEX IF NOT EXISTS idx_blog_post_status_published ON blog_post(status, published_at)').run();
		await this.ensurePerm(c);
	},

	async ensurePerm(c) {
		try {
			await c.env.db.prepare(`
				INSERT INTO perm (name, perm_key, pid, type, sort)
				SELECT '博客管理', 'blog:manage', 17, 2, 8
				WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_key = 'blog:manage')
			`).run();
			await c.env.db.prepare(`
				INSERT INTO perm (name, perm_key, pid, type, sort)
				SELECT '管理自己博客', 'blog:manage_own', 17, 2, 9
				WHERE NOT EXISTS (SELECT 1 FROM perm WHERE perm_key = 'blog:manage_own')
			`).run();
		} catch (error) {
			console.warn('skip blog perm init', error.message);
		}
	},

	async list(c) {
		await this.ensureTables(c);
		const page = Math.max(Number(c.req.query('page') || 1), 1);
		const pageSize = Math.min(Math.max(Number(c.req.query('pageSize') || 10), 1), 50);
		const category = c.req.query('category') || '';
		const tag = c.req.query('tag') || '';
		const q = String(c.req.query('q') || '').trim();
		const offset = (page - 1) * pageSize;

		const filters = ['status = ?'];
		const params = ['published'];

		if (category) {
			filters.push('category = ?');
			params.push(category);
		}

		if (tag) {
			filters.push('tags LIKE ?');
			params.push(`%"${tag.replaceAll('"', '""')}"%`);
		}

		if (q) {
			filters.push('(title LIKE ? OR summary LIKE ? OR category LIKE ? OR tags LIKE ?)');
			const keyword = `%${q}%`;
			params.push(keyword, keyword, keyword, keyword);
		}

		const where = filters.join(' AND ');
		const countRow = await c.env.db
			.prepare(`SELECT COUNT(*) AS total FROM blog_post WHERE ${where}`)
			.bind(...params)
			.first();

		const rows = await c.env.db
			.prepare(`
				SELECT post_id, slug, title, summary, cover_key, category, tags, view_count, created_at, updated_at, published_at
				FROM blog_post
				WHERE ${where}
				ORDER BY COALESCE(published_at, created_at) DESC, post_id DESC
				LIMIT ? OFFSET ?
			`)
			.bind(...params, pageSize, offset)
			.all();

		return {
			page,
			pageSize,
			total: countRow?.total || 0,
			list: (rows.results || []).map(row => this.toPublicPost(c, row))
		};
	},

	async adminList(c) {
		await this.ensureTables(c);
		await this.assertCanManage(c);
		const page = Math.max(Number(c.req.query('page') || 1), 1);
		const pageSize = Math.min(Math.max(Number(c.req.query('pageSize') || 20), 1), 100);
		const status = c.req.query('status') || '';
		const q = String(c.req.query('q') || '').trim();
		const offset = (page - 1) * pageSize;
		const filters = [];
		const params = [];

		if (status) {
			filters.push('status = ?');
			params.push(status);
		}

		if (q) {
			filters.push('(title LIKE ? OR summary LIKE ? OR category LIKE ? OR tags LIKE ?)');
			const keyword = `%${q}%`;
			params.push(keyword, keyword, keyword, keyword);
		}

		const user = c.get('user');
		const permKeys = user ? await permService.userPermKeys(c, user.userId) : [];
		const isSuperAdmin = user && user.email === c.env.admin;
		const canManageAll = isSuperAdmin || permKeys.includes('blog:manage') || permKeys.includes('*');

		if (!canManageAll && permKeys.includes('blog:manage_own') && user) {
			filters.push('user_id = ?');
			params.push(user.userId);
		}

		const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
		const countStmt = c.env.db.prepare(`SELECT COUNT(*) AS total FROM blog_post ${where}`);
		const countRow = await bindMaybe(countStmt, params).first();

		const listStmt = c.env.db.prepare(`
			SELECT post_id, slug, title, summary, cover_key, content_key, category, tags, status, view_count, created_at, updated_at, published_at
			FROM blog_post
			${where}
			ORDER BY updated_at DESC, post_id DESC
			LIMIT ? OFFSET ?
		`);
		const rows = await listStmt.bind(...params, pageSize, offset).all();

		return {
			page,
			pageSize,
			total: countRow?.total || 0,
			list: (rows.results || []).map(row => ({
				...this.toPublicPost(c, row),
				status: row.status,
				contentKey: row.content_key || ''
			}))
		};
	},

	async detail(c, slug) {
		await this.ensureTables(c);
		const row = await c.env.db
			.prepare(`
				SELECT post_id, slug, title, summary, cover_key, content_key, category, tags, status, view_count, created_at, updated_at, published_at
				FROM blog_post
				WHERE slug = ? AND status = 'published'
			`)
			.bind(slug)
			.first();

		if (!row) {
			throw new BizError('Post not found', 404);
		}

		await c.env.db
			.prepare('UPDATE blog_post SET view_count = view_count + 1 WHERE post_id = ?')
			.bind(row.post_id)
			.run();

		row.view_count += 1;
		return {
			...this.toPublicPost(c, row),
			content: await this.readContent(c, row.content_key),
			contentKey: row.content_key || ''
		};
	},

	async rss(c) {
		await this.ensureTables(c);
		const rows = await c.env.db
			.prepare(`
				SELECT slug, title, summary, category, tags, view_count, created_at, updated_at, published_at
				FROM blog_post
				WHERE status = 'published'
				ORDER BY COALESCE(published_at, created_at) DESC, post_id DESC
				LIMIT 30
			`)
			.all();

		const siteUrl = 'https://www.crazychaos.top/blog/';
		const items = (rows.results || []).map((row) => {
			const link = `${siteUrl}?post=${encodeURIComponent(row.slug)}`;
			const pubDate = this.rssDate(row.published_at || row.created_at || row.updated_at);
			return `
		<item>
			<title>${this.escapeXml(row.title)}</title>
			<link>${this.escapeXml(link)}</link>
			<guid isPermaLink="true">${this.escapeXml(link)}</guid>
			<description>${this.escapeXml(row.summary || '')}</description>
			${row.category ? `<category>${this.escapeXml(row.category)}</category>` : ''}
			<pubDate>${pubDate}</pubDate>
		</item>`;
		}).join('');

		return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
	<channel>
		<title>CrazyChaos Blog</title>
		<link>${siteUrl}</link>
		<description>Notes, updates and posts from CrazyChaos.</description>
		<language>zh-CN</language>
		<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
	</channel>
</rss>`;
	},

	async save(c, payload) {
		await this.ensureTables(c);
		await this.assertCanManage(c);

		const slug = this.cleanSlug(payload.slug);
		const title = String(payload.title || '').trim();
		if (!slug) throw new BizError('Slug is required', 400);
		if (!title) throw new BizError('Title is required', 400);

		const allowed = await this.canManagePost(c, slug);
		if (!allowed) {
			throw new BizError('Permission denied to manage this blog post', 403);
		}

		const oldRow = await c.env.db
			.prepare('SELECT content_key FROM blog_post WHERE slug = ?')
			.bind(slug)
			.first();

		let contentKey = String(payload.contentKey || payload.content_key || oldRow?.content_key || '').trim();
		const content = typeof payload.content === 'string' ? payload.content : null;
		if (content !== null) {
			contentKey = `blog/posts/${slug}.md`;
			await this.putBlogObject(c, contentKey, content, {
				contentType: 'text/markdown; charset=utf-8',
				cacheControl: 'public, max-age=60'
			});
		}

		const status = payload.status === 'published' ? 'published' : 'draft';
		const now = new Date().toISOString();
		const publishedAt = status === 'published'
			? (payload.publishedAt || payload.published_at || now)
			: (payload.publishedAt || payload.published_at || null);
		const tags = this.stringifyTags(payload.tags);

		const user = c.get('user');

		await c.env.db
			.prepare(`
				INSERT INTO blog_post (slug, title, summary, cover_key, content_key, category, tags, status, created_at, updated_at, published_at, user_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(slug) DO UPDATE SET
					title = excluded.title,
					summary = excluded.summary,
					cover_key = excluded.cover_key,
					content_key = excluded.content_key,
					category = excluded.category,
					tags = excluded.tags,
					status = excluded.status,
					updated_at = excluded.updated_at,
					published_at = excluded.published_at
			`)
			.bind(
				slug,
				title,
				String(payload.summary || '').trim(),
				String(payload.coverKey || payload.cover_key || '').trim(),
				contentKey,
				String(payload.category || '').trim(),
				tags,
				status,
				now,
				now,
				publishedAt,
				user?.userId || 0
			)
			.run();

		return await this.adminDetail(c, slug);
	},

	async upload(c, payload) {
		await this.ensureTables(c);
		await this.assertCanManage(c);

		const content = String(payload.content || '');
		const filename = String(payload.filename || 'cover').trim();
		const contentType = String(payload.contentType || '').trim();
		const maxSize = 5 * 1024 * 1024;
		const mime = contentType || this.detectDataUrlMime(content);

		if (!content) throw new BizError('File content is required', 400);
		if (!/^image\/(png|jpe?g|webp|gif|avif)$/i.test(mime)) {
			throw new BizError('Only image files are supported', 400);
		}

		const data = fileUtils.base64ToDataStr(content);
		const buff = fileUtils.base64ToUint8Array(data);
		if (buff.byteLength > maxSize) {
			throw new BizError('Image must be smaller than 5MB', 400);
		}

		const ext = this.coverExt(filename, mime);
		const key = `blog/covers/${await fileUtils.getBuffHash(buff)}${ext}`;
		await this.putBlogObject(c, key, buff, {
			contentType: mime,
			cacheControl: 'public, max-age=31536000',
			contentDisposition: `inline; filename="${filename.replaceAll('"', '')}"`
		});

		return {
			key,
			url: this.objectUrl(c, key)
		};
	},

	async adminDetail(c, slug) {
		await this.ensureTables(c);
		await this.assertCanManage(c);
		const row = await c.env.db
			.prepare(`
				SELECT post_id, slug, title, summary, cover_key, content_key, category, tags, status, view_count, created_at, updated_at, published_at, user_id
				FROM blog_post
				WHERE slug = ?
			`)
			.bind(slug)
			.first();

		if (!row) {
			throw new BizError('Post not found', 404);
		}

		const user = c.get('user');
		const isSuperAdmin = user && user.email === c.env.admin;
		const permKeys = user ? await permService.userPermKeys(c, user.userId) : [];
		const canManageAll = isSuperAdmin || permKeys.includes('blog:manage') || permKeys.includes('*');

		if (!canManageAll && permKeys.includes('blog:manage_own')) {
			if (row.user_id !== user.userId) {
				throw new BizError('Permission denied to view this blog post', 403);
			}
		}

		return {
			...this.toPublicPost(c, row),
			status: row.status,
			content: await this.readContent(c, row.content_key),
			contentKey: row.content_key || ''
		};
	},

	async delete(c, slug) {
		await this.ensureTables(c);
		await this.assertCanManage(c);

		const allowed = await this.canManagePost(c, slug);
		if (!allowed) {
			throw new BizError('Permission denied to delete this blog post', 403);
		}

		const row = await c.env.db
			.prepare('SELECT content_key FROM blog_post WHERE slug = ?')
			.bind(slug)
			.first();

		await c.env.db.prepare('DELETE FROM blog_post WHERE slug = ?').bind(slug).run();

		if (row?.content_key) {
			await this.deleteBlogObject(c, row.content_key);
		}
	},

	async readContent(c, key) {
		if (!key) return '';
		const obj = await this.getBlogObject(c, key);
		if (!obj) return '';
		return await obj.text();
	},

	assertR2(c) {
		if (!c.env.r2) {
			throw new BizError('R2 bucket is not bound', 502);
		}
	},

	async putBlogObject(c, key, content, metadata) {
		this.assertR2(c);
		await c.env.r2.put(key, content, {
			httpMetadata: { ...metadata }
		});
	},

	async getBlogObject(c, key) {
		this.assertR2(c);
		return await c.env.r2.get(key);
	},

	async deleteBlogObject(c, key) {
		this.assertR2(c);
		await c.env.r2.delete(key);
	},

	toPublicPost(c, row) {
		return {
			postId: row.post_id,
			slug: row.slug,
			title: row.title,
			summary: row.summary || '',
			category: row.category || '',
			tags: this.parseTags(row.tags),
			coverKey: row.cover_key || '',
			coverUrl: this.objectUrl(c, row.cover_key),
			viewCount: row.view_count || 0,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			publishedAt: row.published_at
		};
	},

	objectUrl(c, key) {
		if (!key) return '';
		const origin = new URL(c.req.url).origin;
		return `${origin}/api/oss/${key}`;
	},

	parseTags(tags) {
		try {
			const value = JSON.parse(tags || '[]');
			return Array.isArray(value) ? value.map(String) : [];
		} catch {
			return [];
		}
	},

	stringifyTags(tags) {
		if (Array.isArray(tags)) {
			return JSON.stringify(tags.map(tag => String(tag).trim()).filter(Boolean));
		}
		if (typeof tags === 'string' && tags.trim()) {
			return JSON.stringify(tags.split(',').map(tag => tag.trim()).filter(Boolean));
		}
		return '[]';
	},

	cleanSlug(slug) {
		return String(slug || '')
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
			.replace(/^-+|-+$/g, '');
	},

	detectDataUrlMime(content) {
		const match = String(content || '').match(/^data:([^;]+);base64,/);
		return match ? match[1] : '';
	},

	coverExt(filename, mime) {
		const ext = fileUtils.getExtFileName(filename).toLowerCase();
		if (ext && ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'].includes(ext)) return ext;
		const map = {
			'image/png': '.png',
			'image/jpeg': '.jpg',
			'image/jpg': '.jpg',
			'image/webp': '.webp',
			'image/gif': '.gif',
			'image/avif': '.avif'
		};
		return map[mime.toLowerCase()] || '.png';
	},

	rssDate(value) {
		const date = new Date(value || Date.now());
		return Number.isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
	},

	escapeXml(value = '') {
		return String(value)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&apos;');
	},

	async assertCanManage(c) {
		const user = c.get('user');
		if (!user) {
			throw new BizError('Only admin can manage blog posts', 403);
		}
		if (user.email === c.env.admin) return;

		const permKeys = await permService.userPermKeys(c, user.userId);
		if (!permKeys.includes('blog:manage') && !permKeys.includes('blog:manage_own') && !permKeys.includes('*')) {
			throw new BizError('Only admin can manage blog posts', 403);
		}
	},

	async canManagePost(c, slug) {
		const user = c.get('user');
		if (!user) return false;
		if (user.email === c.env.admin) return true;

		const permKeys = await permService.userPermKeys(c, user.userId);
		if (permKeys.includes('blog:manage') || permKeys.includes('*')) {
			return true;
		}
		if (permKeys.includes('blog:manage_own')) {
			if (!slug) return true;
			const oldRow = await c.env.db
				.prepare('SELECT user_id FROM blog_post WHERE slug = ?')
				.bind(slug)
				.first();
			if (!oldRow) return true;
			return oldRow.user_id === user.userId;
		}
		return false;
	}
};

export default blogService;
