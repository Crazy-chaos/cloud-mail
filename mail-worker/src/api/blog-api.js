import app from '../hono/hono';
import result from '../model/result';
import blogService from '../service/blog-service';

async function readJsonBody(c) {
	const raw = (await c.req.text()).trim();
	if (!raw) return {};

	const candidates = [raw];
	if (raw.startsWith('null')) {
		const rest = raw.slice(4).trim();
		if (rest.startsWith('{') || rest.startsWith('[')) {
			candidates.push(rest);
		}
	}

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// try next candidate
		}
	}

	return { content: raw };
}

app.get('/blog/list', async (c) => {
	const data = await blogService.list(c);
	return c.json(result.ok(data));
});

app.get('/blog/detail/:slug', async (c) => {
	const data = await blogService.detail(c, c.req.param('slug'));
	return c.json(result.ok(data));
});

app.get('/blog/rss', async (c) => {
	const xml = await blogService.rss(c);
	return new Response(xml, {
		headers: {
			'Content-Type': 'application/rss+xml; charset=utf-8',
			'Cache-Control': 'public, max-age=300'
		}
	});
});

app.get('/blog/comment/:slug', async (c) => {
	const data = await blogService.comments(c, c.req.param('slug'));
	return c.json(result.ok(data));
});

app.post('/blog/comment/:slug', async (c) => {
	const data = await blogService.addComment(c, c.req.param('slug'), await readJsonBody(c));
	return c.json(result.ok(data));
});

app.get('/blog/admin/list', async (c) => {
	const data = await blogService.adminList(c);
	return c.json(result.ok(data));
});

app.get('/blog/post/:slug', async (c) => {
	const data = await blogService.adminDetail(c, c.req.param('slug'));
	return c.json(result.ok(data));
});

app.post('/blog/post', async (c) => {
	const data = await blogService.save(c, await c.req.json());
	return c.json(result.ok(data));
});

app.post('/blog/upload', async (c) => {
	const data = await blogService.upload(c, await c.req.json());
	return c.json(result.ok(data));
});

app.delete('/blog/post/:slug', async (c) => {
	await blogService.delete(c, c.req.param('slug'));
	return c.json(result.ok());
});
