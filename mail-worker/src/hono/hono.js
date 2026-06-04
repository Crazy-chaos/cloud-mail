import { Hono } from 'hono';
const app = new Hono();

import result from '../model/result';
import { cors } from 'hono/cors';

const allowedOrigins = new Set([
	'https://www.crazychaos.top',
	'https://crazychaos.top',
	'http://localhost:5555',
	'http://127.0.0.1:5555'
]);

app.use('*', async (c, next) => {
	if (c.env) {
		c.env = new Proxy(c.env, {
			get(target, prop, receiver) {
				if (typeof prop === 'string') {
					if (prop in target) {
						return Reflect.get(target, prop, receiver);
					}
					const upper = prop.toUpperCase();
					if (upper in target) {
						return Reflect.get(target, upper, receiver);
					}
					const lower = prop.toLowerCase();
					if (lower in target) {
						return Reflect.get(target, lower, receiver);
					}
				}
				return Reflect.get(target, prop, receiver);
			}
		});
	}
	await next();
});

app.use('*', cors({
	origin: (origin) => allowedOrigins.has(origin) ? origin : 'https://www.crazychaos.top',
	credentials: true,
	allowHeaders: ['Content-Type', 'Authorization', 'accept-language'],
	allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	maxAge: 86400
}));

app.onError((err, c) => {
	if (err.name === 'BizError') {
		console.log(err.message);
	} else {
		console.error(err);
	}

	if (err.message === `Cannot read properties of undefined (reading 'get')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'put')`) {
		return c.json(result.fail('KV数据库未绑定 KV database not bound',502));
	}

	if (err.message === `Cannot read properties of undefined (reading 'prepare')`) {
		return c.json(result.fail('D1数据库未绑定 D1 database not bound',502));
	}

	return c.json(result.fail(err.message, err.code));
});

export default app;


