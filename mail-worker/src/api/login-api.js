import app from '../hono/hono';
import loginService from '../service/login-service';
import result from '../model/result';
import userContext from '../security/user-context';
import constant from '../const/constant';

function authCookie(token, maxAge = constant.TOKEN_EXPIRE) {
	return `token=${encodeURIComponent(token)}; Domain=.crazychaos.top; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

app.post('/login', async (c) => {
	const token = await loginService.login(c, await c.req.json());
	c.header('Set-Cookie', authCookie(token));
	return c.json(result.ok({ token: token }));
});

app.post('/register', async (c) => {
	const jwt = await loginService.register(c, await c.req.json());
	return c.json(result.ok(jwt));
});

app.delete('/logout', async (c) => {
	await loginService.logout(c, userContext.getUserId(c));
	c.header('Set-Cookie', authCookie('', 0));
	return c.json(result.ok());
});

