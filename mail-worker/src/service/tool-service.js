import BizError from '../error/biz-error';
import fileUtils from '../utils/file-utils';
import r2Service from './r2-service';
import jwtUtils from '../utils/jwt-utils';
import constant from '../const/constant';
import KvConst from '../const/kv-const';
import permService from './perm-service';

const toolService = {
	async currentUserOptional(c) {
		const cached = c.get('user');
		if (cached) return cached;

		const headerToken = c.req.header(constant.TOKEN_HEADER);
		const jwt = (headerToken && headerToken !== 'null' && headerToken !== 'undefined')
			? headerToken
			: this.getCookie(c, constant.TOKEN_COOKIE);

		if (!jwt) return null;
		const verifyResult = await jwtUtils.verifyToken(c, jwt);
		if (!verifyResult) return null;

		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + verifyResult.userId, { type: 'json' });
		if (!authInfo || !authInfo.tokens.includes(verifyResult.token)) {
			return null;
		}
		return authInfo.user || null;
	},

	getCookie(c, name) {
		const cookie = c.req.header('Cookie') || '';
		const item = cookie
			.split(';')
			.map(value => value.trim())
			.find(value => value.startsWith(`${name}=`));
		return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
	},

	async isUserAdmin(c, user) {
		if (!user) return false;
		if (user.email === c.env.admin) return true;
		const permKeys = await permService.userPermKeys(c, user.userId);
		return permKeys.includes('tools:manage') || permKeys.includes('*');
	},

	async assertCanManage(c) {
		const user = await this.currentUserOptional(c);
		if (!user) {
			throw new BizError('Login required', 401);
		}
		const isAdmin = await this.isUserAdmin(c, user);
		if (!isAdmin) {
			throw new BizError('Permission denied', 403);
		}
	},

	async list(c) {
		const currentUser = await this.currentUserOptional(c);
		const isAdmin = await this.isUserAdmin(c, currentUser);

		const page = Math.max(Number(c.req.query('page') || 1), 1);
		const pageSize = Math.min(Math.max(Number(c.req.query('pageSize') || 12), 1), 100);
		const offset = (page - 1) * pageSize;

		const categoryId = c.req.query('category_id') || '';
		const tagId = c.req.query('tag_id') || '';
		const q = String(c.req.query('q') || '').trim();
		const sort = c.req.query('sort') || 'newest';

		const filters = [];
		const params = [];

		if (!isAdmin) {
			filters.push("t.status IN ('published', 'archived')");
			if (!currentUser) {
				filters.push("t.visibility = 'public'");
			} else {
				// Retrieve user's role key and name
				const roleRow = await c.env.db
					.prepare('SELECT r.key, r.name FROM user u LEFT JOIN role r ON r.role_id = u.type WHERE u.user_id = ?')
					.bind(currentUser.userId)
					.first();
				const roleKey = roleRow?.key || '';
				const roleName = roleRow?.name || '';

				filters.push(`(
					t.visibility = 'public' OR 
					t.visibility = 'login' OR 
					(t.visibility = 'role' AND (
						t.required_role = '' OR 
						t.required_role LIKE ? OR 
						t.required_role LIKE ?
					))
				)`);
				params.push(`%${roleKey}%`, `%${roleName}%`);
			}
		}

		if (categoryId) {
			filters.push('t.category_id = ?');
			params.push(categoryId);
		}

		if (tagId) {
			filters.push('t.id IN (SELECT tool_id FROM tool_tags WHERE tag_id = ?)');
			params.push(tagId);
		}

		if (q) {
			filters.push('(t.title LIKE ? OR t.description LIKE ? OR t.id IN (SELECT tool_id FROM tool_tags tt JOIN tags tg ON tg.id = tt.tag_id WHERE tg.name LIKE ?))');
			const keyword = `%${q}%`;
			params.push(keyword, keyword, keyword);
		}

		const whereClause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

		// Determine sorting order
		let orderBy = 't.is_pinned DESC, t.is_featured DESC, t.created_at DESC';
		if (sort === 'hot') {
			orderBy = 't.is_pinned DESC, t.view_count DESC, t.download_count DESC';
		} else if (sort === 'newest') {
			orderBy = 't.is_pinned DESC, t.created_at DESC';
		}

		const countRow = await c.env.db
			.prepare(`SELECT COUNT(*) AS total FROM tools t ${whereClause}`)
			.bind(...params)
			.first();

		const rows = await c.env.db
			.prepare(`
				SELECT t.*, c.name AS category_name, c.icon AS category_icon
				FROM tools t
				LEFT JOIN categories c ON c.id = t.category_id
				${whereClause}
				ORDER BY ${orderBy}
				LIMIT ? OFFSET ?
			`)
			.bind(...params, pageSize, offset)
			.all();

		const list = [];
		for (const row of rows.results || []) {
			const tags = await this.getToolTags(c, row.id);
			const blogs = await this.getToolBlogs(c, row.id);
			list.push(this.mapToolRow(c, row, tags, blogs));
		}

		return {
			page,
			pageSize,
			total: countRow?.total || 0,
			list
		};
	},

	async detail(c, idOrSlug) {
		const currentUser = await this.currentUserOptional(c);
		const isAdmin = await this.isUserAdmin(c, currentUser);

		const row = await c.env.db
			.prepare(`
				SELECT t.*, c.name AS category_name, c.icon AS category_icon
				FROM tools t
				LEFT JOIN categories c ON c.id = t.category_id
				WHERE t.id = ? OR t.slug = ?
			`)
			.bind(idOrSlug, idOrSlug)
			.first();

		if (!row) {
			throw new BizError('Resource not found', 404);
		}

		// Perform visibility check
		if (!isAdmin) {
			if (row.status !== 'published' && row.status !== 'archived') {
				throw new BizError('Resource is not available', 403);
			}

			if (row.visibility === 'login' && !currentUser) {
				throw new BizError('Login required to view this resource', 401);
			}

			if (row.visibility === 'role') {
				if (!currentUser) {
					throw new BizError('Login required to view this resource', 401);
				}
				const roleRow = await c.env.db
					.prepare('SELECT r.key, r.name FROM user u LEFT JOIN role r ON r.role_id = u.type WHERE u.user_id = ?')
					.bind(currentUser.userId)
					.first();
				const roleKey = roleRow?.key || '';
				const roleName = roleRow?.name || '';
				const allowedRoles = (row.required_role || '').split(',').map(r => r.trim().toLowerCase());
				const matches = allowedRoles.some(r => r && (r === roleKey.toLowerCase() || r === roleName.toLowerCase()));
				if (!matches && allowedRoles.length > 0 && row.required_role !== '') {
					throw new BizError('Permission denied: Insufficient role permissions', 403);
				}
			}
		}

		// Increment view count asynchronously
		c.executionCtx?.waitUntil(
			c.env.db.prepare('UPDATE tools SET view_count = view_count + 1 WHERE id = ?').bind(row.id).run()
		);
		row.view_count += 1;

		const tags = await this.getToolTags(c, row.id);
		const blogs = await this.getToolBlogs(c, row.id);
		return this.mapToolRow(c, row, tags, blogs);
	},

	async download(c, id) {
		const currentUser = await this.currentUserOptional(c);
		const isAdmin = await this.isUserAdmin(c, currentUser);

		const row = await c.env.db
			.prepare('SELECT * FROM tools WHERE id = ?')
			.bind(id)
			.first();

		if (!row) {
			throw new BizError('Resource not found', 404);
		}

		if (!isAdmin) {
			if (row.status !== 'published' && row.status !== 'archived') {
				throw new BizError('Resource is not available', 403);
			}
			if (row.status === 'archived') {
				throw new BizError('Resource has been archived and is not downloadable', 403);
			}

			if (row.visibility === 'login' && !currentUser) {
				throw new BizError('Login required to download this resource', 401);
			}

			if (row.visibility === 'role') {
				if (!currentUser) {
					throw new BizError('Login required to download this resource', 401);
				}
				const roleRow = await c.env.db
					.prepare('SELECT r.key, r.name FROM user u LEFT JOIN role r ON r.role_id = u.type WHERE u.user_id = ?')
					.bind(currentUser.userId)
					.first();
				const roleKey = roleRow?.key || '';
				const roleName = roleRow?.name || '';
				const allowedRoles = (row.required_role || '').split(',').map(r => r.trim().toLowerCase());
				const matches = allowedRoles.some(r => r && (r === roleKey.toLowerCase() || r === roleName.toLowerCase()));
				if (!matches && allowedRoles.length > 0 && row.required_role !== '') {
					throw new BizError('Permission denied', 403);
				}
			}
		}

		let path = row.download_url || row.content_url;
		if (!path) {
			throw new BizError('No downloadable file linked to this resource', 400);
		}

		// Increment download count
		c.executionCtx?.waitUntil(
			c.env.db.prepare('UPDATE tools SET download_count = download_count + 1 WHERE id = ?').bind(row.id).run()
		);

		// If it's an external link, redirect directly
		if (/^(https?:)?\/\//i.test(path)) {
			return c.redirect(path);
		}

		// Otherwise fetch from R2
		const fileObj = await r2Service.getObj(c, path);
		if (!fileObj) {
			throw new BizError('File not found in storage', 404);
		}

		const filename = path.split('/').pop() || 'download';
		const isHtml = row.type === 'html';

		return new Response(fileObj.body, {
			headers: {
				'Content-Type': fileObj.httpMetadata?.contentType || (isHtml ? 'text/html; charset=utf-8' : 'application/octet-stream'),
				'Content-Disposition': isHtml ? 'inline' : `attachment; filename="${encodeURIComponent(filename)}"`,
				'Cache-Control': 'public, max-age=300'
			}
		});
	},

	async save(c, payload) {
		await this.assertCanManage(c);

		const id = payload.id || crypto.randomUUID();
		const title = String(payload.title || '').trim();
		let slug = String(payload.slug || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
		
		if (!title) throw new BizError('Title is required', 400);
		if (!slug) {
			slug = title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
		}
		if (!slug) slug = 'tool-' + Date.now();

		const type = payload.type || 'file'; // html, software, file, link
		const description = String(payload.description || '').trim();
		const coverUrl = String(payload.coverUrl || payload.cover_url || '').trim();
		const contentUrl = String(payload.contentUrl || payload.content_url || '').trim();
		const downloadUrl = String(payload.downloadUrl || payload.download_url || '').trim();
		const version = String(payload.version || '').trim();
		const changelog = String(payload.changelog || '').trim();
		const categoryId = payload.categoryId || payload.category_id || null;
		const visibility = payload.visibility || 'public'; // public, login, role
		const requiredRole = String(payload.requiredRole || payload.required_role || '').trim();
		const isFeatured = payload.isFeatured || payload.is_featured ? 1 : 0;
		const isPinned = payload.isPinned || payload.is_pinned ? 1 : 0;
		const status = payload.status || 'published'; // draft, published, hidden, archived

		const now = new Date().toISOString();

		// Save tool to database
		await c.env.db
			.prepare(`
				INSERT INTO tools (
					id, title, slug, description, type, cover_url, content_url, download_url,
					version, changelog, category_id, visibility, required_role, is_featured, is_pinned, status,
					created_by, created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					title = excluded.title,
					slug = excluded.slug,
					description = excluded.description,
					type = excluded.type,
					cover_url = excluded.cover_url,
					content_url = excluded.content_url,
					download_url = excluded.download_url,
					version = excluded.version,
					changelog = excluded.changelog,
					category_id = excluded.category_id,
					visibility = excluded.visibility,
					required_role = excluded.required_role,
					is_featured = excluded.is_featured,
					is_pinned = excluded.is_pinned,
					status = excluded.status,
					updated_at = excluded.updated_at
			`)
			.bind(
				id, title, slug, description, type, coverUrl, contentUrl, downloadUrl,
				version, changelog, categoryId, visibility, requiredRole, isFeatured, isPinned, status,
				c.get('user')?.email || '', now, now
			)
			.run();

		// Sync tags
		await c.env.db.prepare('DELETE FROM tool_tags WHERE tool_id = ?').bind(id).run();
		const tagNames = Array.isArray(payload.tags) ? payload.tags : [];
		for (const rawName of tagNames) {
			const name = String(rawName).trim();
			if (!name) continue;

			let tagRow = await c.env.db.prepare('SELECT id FROM tags WHERE name = ?').bind(name).first();
			let tagId = tagRow?.id;
			if (!tagId) {
				tagId = crypto.randomUUID();
				await c.env.db.prepare('INSERT INTO tags (id, name) VALUES (?, ?)').bind(tagId, name).run();
			}
			await c.env.db.prepare('INSERT INTO tool_tags (tool_id, tag_id) VALUES (?, ?)').bind(id, tagId).run();
		}

		// Sync blog links
		await c.env.db.prepare('DELETE FROM tool_blog_links WHERE tool_id = ?').bind(id).run();
		const blogIds = Array.isArray(payload.relatedBlogs || payload.blog_ids) 
			? (payload.relatedBlogs || payload.blog_ids) 
			: [];
		for (const rawBlogId of blogIds) {
			const blogId = String(rawBlogId).trim();
			if (!blogId) continue;
			await c.env.db.prepare('INSERT INTO tool_blog_links (tool_id, blog_id) VALUES (?, ?)').bind(id, blogId).run();
		}

		return await this.detail(c, id);
	},

	async delete(c, id) {
		await this.assertCanManage(c);

		// Get urls/paths to delete R2 objects
		const row = await c.env.db.prepare('SELECT cover_url, content_url, download_url FROM tools WHERE id = ?').bind(id).first();
		if (!row) {
			throw new BizError('Resource not found', 404);
		}

		// Delete R2 objects if they reside locally
		for (const key of [row.cover_url, row.content_url, row.download_url]) {
			if (key && !/^(https?:)?\/\//i.test(key)) {
				try {
					await r2Service.delete(c, key);
				} catch (err) {
					console.warn('Failed to delete R2 object:', key, err.message);
				}
			}
		}

		// Delete database references
		await c.env.db.prepare('DELETE FROM tools WHERE id = ?').bind(id).run();
		await c.env.db.prepare('DELETE FROM tool_tags WHERE tool_id = ?').bind(id).run();
		await c.env.db.prepare('DELETE FROM tool_blog_links WHERE tool_id = ?').bind(id).run();
		
		return true;
	},

	async upload(c, payload) {
		await this.assertCanManage(c);
		const content = String(payload.content || ''); // base64
		const filename = String(payload.filename || 'file').trim();
		const contentType = String(payload.contentType || 'application/octet-stream').trim();
		const maxSize = 100 * 1024 * 1024; // 100MB limit

		if (!content) throw new BizError('File content is required', 400);

		const data = fileUtils.base64ToDataStr(content);
		const buff = fileUtils.base64ToUint8Array(data);
		if (buff.byteLength > maxSize) {
			throw new BizError('File size exceeds 100MB limit', 400);
		}

		const ext = fileUtils.getExtFileName(filename).toLowerCase();
		const uuidStr = crypto.randomUUID();
		let key = '';
		if (contentType.startsWith('image/')) {
			key = `tools/covers/${uuidStr}${ext}`;
		} else if (contentType === 'text/html') {
			key = `tools/htmls/${uuidStr}.html`;
		} else {
			key = `tools/files/${uuidStr}/${filename}`;
		}

		await r2Service.putObj(c, key, buff, {
			contentType: contentType,
			cacheControl: 'public, max-age=31536000',
			contentDisposition: contentType === 'text/html' ? 'inline' : `attachment; filename="${encodeURIComponent(filename)}"`
		});

		return {
			key,
			url: this.objectUrl(c, key)
		};
	},

	// Meta APIs for Categories & Tags
	async meta(c) {
		const categories = await c.env.db.prepare('SELECT * FROM categories ORDER BY sort_order ASC, name ASC').all();
		const tags = await c.env.db.prepare('SELECT * FROM tags ORDER BY name ASC').all();
		return {
			categories: categories.results || [],
			tags: tags.results || []
		};
	},

	async saveCategory(c, payload) {
		await this.assertCanManage(c);
		const id = payload.id || crypto.randomUUID();
		const name = String(payload.name || '').trim();
		const icon = String(payload.icon || '').trim();
		const sortOrder = Number(payload.sortOrder || payload.sort_order || 0);

		if (!name) throw new BizError('Category name is required', 400);

		await c.env.db
			.prepare(`
				INSERT INTO categories (id, name, icon, sort_order)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(id) DO UPDATE SET
					name = excluded.name,
					icon = excluded.icon,
					sort_order = excluded.sort_order
			`)
			.bind(id, name, icon, sortOrder)
			.run();

		return await c.env.db.prepare('SELECT * FROM categories WHERE id = ?').bind(id).first();
	},

	async deleteCategory(c, id) {
		await this.assertCanManage(c);
		// Check if tools are using this category
		const countRow = await c.env.db.prepare('SELECT COUNT(*) as total FROM tools WHERE category_id = ?').bind(id).first();
		if (countRow?.total > 0) {
			throw new BizError('Cannot delete category: it is still linked to resources', 400);
		}
		await c.env.db.prepare('DELETE FROM categories WHERE id = ?').bind(id).run();
		return true;
	},

	async saveTag(c, payload) {
		await this.assertCanManage(c);
		const id = payload.id || crypto.randomUUID();
		const name = String(payload.name || '').trim();

		if (!name) throw new BizError('Tag name is required', 400);

		await c.env.db
			.prepare(`
				INSERT INTO tags (id, name)
				VALUES (?, ?)
				ON CONFLICT(id) DO UPDATE SET name = excluded.name
			`)
			.bind(id, name)
			.run();

		return await c.env.db.prepare('SELECT * FROM tags WHERE id = ?').bind(id).first();
	},

	async deleteTag(c, id) {
		await this.assertCanManage(c);
		await c.env.db.prepare('DELETE FROM tags WHERE id = ?').bind(id).run();
		await c.env.db.prepare('DELETE FROM tool_tags WHERE tag_id = ?').bind(id).run();
		return true;
	},

	// Helper utilities
	async getToolTags(c, toolId) {
		const rows = await c.env.db
			.prepare(`
				SELECT t.id, t.name 
				FROM tags t
				JOIN tool_tags tt ON tt.tag_id = t.id
				WHERE tt.tool_id = ?
			`)
			.bind(toolId)
			.all();
		return (rows.results || []).map(r => r.name);
	},

	async getToolBlogs(c, toolId) {
		const rows = await c.env.db
			.prepare(`
				SELECT b.slug, b.title 
				FROM blog_post b
				JOIN tool_blog_links tbl ON tbl.blog_id = b.slug OR tbl.blog_id = CAST(b.post_id AS TEXT)
				WHERE tbl.tool_id = ?
			`)
			.bind(toolId)
			.all();
		return rows.results || [];
	},

	mapToolRow(c, row, tags = [], blogs = []) {
		return {
			id: row.id,
			title: row.title,
			slug: row.slug,
			description: row.description || '',
			type: row.type,
			coverUrl: row.cover_url ? (row.cover_url.startsWith('http') ? row.cover_url : this.objectUrl(c, row.cover_url)) : '',
			coverKey: row.cover_url || '',
			contentUrl: row.content_url ? (row.content_url.startsWith('http') ? row.content_url : this.objectUrl(c, row.content_url)) : '',
			contentKey: row.content_url || '',
			downloadUrl: row.download_url ? (row.download_url.startsWith('http') ? row.download_url : this.objectUrl(c, row.download_url)) : '',
			downloadKey: row.download_url || '',
			version: row.version || '',
			changelog: row.changelog || '',
			categoryId: row.category_id || '',
			category: row.category_name ? {
				id: row.category_id,
				name: row.category_name,
				icon: row.category_icon || ''
			} : null,
			visibility: row.visibility || 'public',
			requiredRole: row.required_role || '',
			isFeatured: Boolean(row.is_featured),
			isPinned: Boolean(row.is_pinned),
			viewCount: row.view_count || 0,
			downloadCount: row.download_count || 0,
			status: row.status || 'published',
			createdBy: row.created_by || '',
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			tags,
			relatedBlogs: blogs
		};
	},

	objectUrl(c, key) {
		if (!key) return '';
		const origin = new URL(c.req.url).origin;
		return `${origin}/api/oss/${key}`;
	}
};

export default toolService;
