import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const tag = sqliteTable('tags', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique()
});

export default tag;
