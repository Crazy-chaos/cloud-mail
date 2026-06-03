import r2Service from '../service/r2-service';
import app from '../hono/hono';

app.get('/oss/*', async (c) => {
	const key = c.req.path.split('/oss/')[1];
	const obj = key.startsWith('blog/') && c.env.r2
		? await c.env.r2.get(key)
		: await r2Service.getObj(c, key);
	if (!obj) {
		return c.notFound();
	}
	return new Response(obj.body, {
		headers: {
			'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
			'Content-Disposition': obj.httpMetadata?.contentDisposition || 'inline',
			'Cache-Control': obj.httpMetadata?.cacheControl || 'public, max-age=300'
		}
	});
});


