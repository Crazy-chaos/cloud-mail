import JwtUtils from '../utils/jwt-utils';
import constant from '../const/constant';

const userContext = {
	getUserId(c) {
		return c.get('user').userId;
	},

	getUser(c) {
		return c.get('user');
	},

	async getToken(c) {
		const headerToken = c.req.header(constant.TOKEN_HEADER);
		const jwt = (headerToken && headerToken !== 'null' && headerToken !== 'undefined')
			? headerToken
			: getCookie(c, constant.TOKEN_COOKIE);
		const result = await JwtUtils.verifyToken(c,jwt);
		return result?.token;
	},
};

function getCookie(c, name) {
	const cookie = c.req.header('Cookie') || '';
	const item = cookie
		.split(';')
		.map(value => value.trim())
		.find(value => value.startsWith(`${name}=`));

	return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

export default userContext;
