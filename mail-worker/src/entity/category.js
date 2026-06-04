import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const category = sqliteTable('categories', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	icon: text('icon'),
	sortOrder: integer('sort_order').default(0)
});

export default category;
