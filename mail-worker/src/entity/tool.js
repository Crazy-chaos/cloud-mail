import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const tool = sqliteTable('tools', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	slug: text('slug').notNull().unique(),
	description: text('description').default(''),
	type: text('type').notNull(),
	coverUrl: text('cover_url').default(''),
	contentUrl: text('content_url').default(''),
	downloadUrl: text('download_url').default(''),
	version: text('version').default(''),
	changelog: text('changelog').default(''),
	categoryId: text('category_id'),
	visibility: text('visibility').default('public').notNull(),
	requiredRole: text('required_role').default(''),
	isFeatured: integer('is_featured').default(0),
	isPinned: integer('is_pinned').default(0),
	viewCount: integer('view_count').default(0),
	downloadCount: integer('download_count').default(0),
	status: text('status').default('published').notNull(),
	createdBy: text('created_by'),
	createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').default(sql`CURRENT_TIMESTAMP`)
});

export default tool;
