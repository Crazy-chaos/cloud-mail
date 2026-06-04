import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';

export const toolTag = sqliteTable('tool_tags', {
	toolId: text('tool_id').notNull(),
	tagId: text('tag_id').notNull()
}, (table) => ({
	pk: primaryKey({ columns: [table.toolId, table.tagId] })
}));

export default toolTag;
