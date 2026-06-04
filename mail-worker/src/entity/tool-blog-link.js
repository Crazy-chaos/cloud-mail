import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

export const toolBlogLink = sqliteTable('tool_blog_links', {
	toolId: text('tool_id').notNull(),
	blogId: text('blog_id').notNull()
}, (table) => ({
	pk: primaryKey({ columns: [table.toolId, table.blogId] })
}));

export default toolBlogLink;
