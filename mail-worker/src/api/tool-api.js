import app from '../hono/hono';
import result from '../model/result';
import toolService from '../service/tool-service';

// Safe JSON parser helper
async function getJson(c) {
	try {
		return await c.req.json();
	} catch {
		return {};
	}
}

// ----------------------------------------------------
// Public Tools Endpoints
// ----------------------------------------------------

// Get list of tools (with pagination, filtering, searching)
app.get('/tools', async (c) => {
	const data = await toolService.list(c);
	return c.json(result.ok(data));
});

// Get categories and tags
app.get('/tools/meta', async (c) => {
	const data = await toolService.meta(c);
	return c.json(result.ok(data));
});

// Get details of a tool by ID or slug
app.get('/tools/:id', async (c) => {
	const data = await toolService.detail(c, c.req.param('id'));
	return c.json(result.ok(data));
});

// Download/View a resource (checks permission, increments download_count)
app.get('/tools/:id/download', async (c) => {
	return await toolService.download(c, c.req.param('id'));
});

// ----------------------------------------------------
// Admin Tools Endpoints (Requires tools:manage or * permissions)
// ----------------------------------------------------

// Create a new tool
app.post('/admin/tools', async (c) => {
	const data = await toolService.save(c, await getJson(c));
	return c.json(result.ok(data));
});

// Edit an existing tool
app.put('/admin/tools/:id', async (c) => {
	const payload = await getJson(c);
	payload.id = c.req.param('id');
	const data = await toolService.save(c, payload);
	return c.json(result.ok(data));
});

// Delete a tool
app.delete('/admin/tools/:id', async (c) => {
	await toolService.delete(c, c.req.param('id'));
	return c.json(result.ok(true));
});

// Upload resource/file to R2 (Multipart base64 or JSON)
app.post('/admin/tools/upload', async (c) => {
	const data = await toolService.upload(c, await getJson(c));
	return c.json(result.ok(data));
});

// ----------------------------------------------------
// Admin Categories & Tags Endpoints
// ----------------------------------------------------

// Create/Update category
app.post('/admin/categories', async (c) => {
	const data = await toolService.saveCategory(c, await getJson(c));
	return c.json(result.ok(data));
});

// Delete category
app.delete('/admin/categories/:id', async (c) => {
	await toolService.deleteCategory(c, c.req.param('id'));
	return c.json(result.ok(true));
});

// Create tag
app.post('/admin/tags', async (c) => {
	const data = await toolService.saveTag(c, await getJson(c));
	return c.json(result.ok(data));
});

// Delete tag
app.delete('/admin/tags/:id', async (c) => {
	await toolService.deleteTag(c, c.req.param('id'));
	return c.json(result.ok(true));
});
