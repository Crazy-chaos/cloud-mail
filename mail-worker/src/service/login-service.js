import BizError from '../error/biz-error';
import userService from './user-service';
import emailUtils from '../utils/email-utils';
import { isDel, settingConst, userConst } from '../const/entity-const';
import JwtUtils from '../utils/jwt-utils';
import { v4 as uuidv4 } from 'uuid';
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import userContext from '../security/user-context';
import verifyUtils from '../utils/verify-utils';
import accountService from './account-service';
import settingService from './setting-service';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import turnstileService from './turnstile-service';
import roleService from './role-service';
import regKeyService from './reg-key-service';
import dayjs from 'dayjs';
import { toUtc } from '../utils/date-uitil';
import { t } from '../i18n/i18n.js';
import verifyRecordService from './verify-record-service';

const LOGIN_FAIL_LIMIT = 5;
const LOGIN_IP_FAIL_LIMIT = 30;
const LOGIN_LOCK_SECONDS = 15 * 60;

const loginService = {

	async register(c, params, oauth = false) {

		const { email, password, token, code } = params;

		let { regKey, register, registerVerify, regVerifyCount, minEmailPrefix, emailPrefixFilter } = await settingService.query(c)

		if (oauth) {
			registerVerify = settingConst.registerVerify.CLOSE;
			register = settingConst.register.OPEN;
		}

		if (register === settingConst.register.CLOSE) {
			throw new BizError(t('regDisabled'));
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix } ));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content)))  {
			throw new BizError(t('banEmailPrefix'));
		}

		if (emailUtils.getName(email).length > 64) {
			throw new BizError(t('emailLengthLimit'));
		}

		if (password.length > 30) {
			throw new BizError(t('pwdLengthLimit'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		let type = null;
		let regKeyId = 0

		if (regKey === settingConst.regKey.OPEN) {
			const result = await this.handleOpenRegKey(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		if (regKey === settingConst.regKey.OPTIONAL) {
			const result = await this.handleOpenOptional(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		let defType = null

		if (!type) {
			const roleRow = await roleService.selectDefaultRole(c);
			defType = roleRow.roleId
		}


		const roleRow = await roleService.selectById(c, type || defType);

		if(!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {

			if (type) {
				throw new BizError(t('noDomainPermRegKey'),403)
			}

			if (defType) {
				throw new BizError(t('noDomainPermReg'),403)
			}

		}

		let regVerifyOpen = false

		if (registerVerify === settingConst.registerVerify.OPEN) {
			regVerifyOpen = true
			await turnstileService.verify(c,token)
		}

		if (registerVerify === settingConst.registerVerify.COUNT) {
			regVerifyOpen = await verifyRecordService.isOpenRegVerify(c, regVerifyCount);
			if (regVerifyOpen) {
				await turnstileService.verify(c,token)
			}
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		const userId = await userService.insert(c, { email, regKeyId,password: hash, salt, type: type || defType });

		await accountService.insert(c, { userId: userId, email, name: emailUtils.getName(email) });

		await userService.updateUserInfo(c, userId, true);

		if (regKey !== settingConst.regKey.CLOSE && type) {
			await regKeyService.reduceCount(c, code, 1);
		}

		if (registerVerify === settingConst.registerVerify.COUNT && !regVerifyOpen) {
			const row = await verifyRecordService.increaseRegCount(c);
			return {regVerifyOpen: row.count >= regVerifyCount}
		}

		return {regVerifyOpen}

	},

	async registerVerify() {

	},

	async handleOpenRegKey(c, regKey, code) {

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			throw new BizError(t('notExistRegKey'));
		}

		if (regKeyRow.count <= 0) {
			throw new BizError(t('noRegKeyCount'));
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day')
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (expireTime.isBefore(today)) {
			throw new BizError(t('regKeyExpire'));
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async handleOpenOptional(c, regKey, code) {

		if (!code) {
			return null
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			return null
		}

		const today = toUtc().tz('Asia/Shanghai').startOf('day')
		const expireTime = toUtc(regKeyRow.expireTime).tz('Asia/Shanghai').startOf('day');

		if (regKeyRow.count <= 0 || expireTime.isBefore(today)) {
			return null
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async login(c, params, noVerifyPwd = false) {

		const { email, password, token } = params;

		if ((!email || !password) && !noVerifyPwd) {
			throw new BizError(t('emailAndPwdEmpty'));
		}

		if (!noVerifyPwd) {
			await turnstileService.verify(c, token);
			await this.checkLoginThrottle(c, email);
		}

		let userRow = null;

		try {
			userRow = await userService.selectByEmailIncludeDel(c, email);

			if (!userRow) {
				throw new BizError(t('notExistUser'));
			}

			if(userRow.isDel === isDel.DELETE) {
				throw new BizError(t('isDelUser'));
			}

			if(userRow.status === userConst.status.BAN) {
				throw new BizError(t('isBanUser'));
			}

			if (!await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password) && !noVerifyPwd) {
				throw new BizError(t('IncorrectPwd'));
			}
		} catch (e) {
			if (!noVerifyPwd) {
				await this.recordLoginFailure(c, email);
			}
			throw e;
		}

		if (!noVerifyPwd) {
			await this.clearLoginFailure(c, email);
		}

		const uuid = uuidv4();
		const jwt = await JwtUtils.generateToken(c,{ userId: userRow.userId, token: uuid });

		let authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userRow.userId, { type: 'json' });

		if (authInfo && (authInfo.user.email === userRow.email)) {

			if (authInfo.tokens.length > 10) {
				authInfo.tokens.shift();
			}

			authInfo.tokens.push(uuid);

		} else {

			authInfo = {
				tokens: [],
				user: userRow,
				refreshTime: dayjs().toISOString()
			};

			authInfo.tokens.push(uuid);

		}

		await userService.updateUserInfo(c, userRow.userId);

		await c.env.kv.put(KvConst.AUTH_INFO + userRow.userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		return jwt;
	},

	getLoginClientIp(c) {
		return c.req.header('CF-Connecting-IP')
			|| c.req.header('X-Forwarded-For')?.split(',')[0]?.trim()
			|| c.req.header('X-Real-IP')
			|| 'unknown';
	},

	getLoginThrottleKeys(c, email) {
		const normalizedEmail = String(email || '').trim().toLowerCase();
		const ip = this.getLoginClientIp(c);
		return {
			pairKey: `${KvConst.LOGIN_FAIL_PAIR}${encodeURIComponent(ip)}:${encodeURIComponent(normalizedEmail)}`,
			ipKey: `${KvConst.LOGIN_FAIL_IP}${encodeURIComponent(ip)}`
		};
	},

	getLoginLockError(record) {
		const now = Date.now();
		const minutes = Math.max(1, Math.ceil(((record?.lockedUntil || now) - now) / 60000));
		return new BizError(t('loginLocked', { minutes }), 429);
	},

	async checkLoginThrottle(c, email) {
		const { pairKey, ipKey } = this.getLoginThrottleKeys(c, email);
		const [pairRecord, ipRecord] = await Promise.all([
			c.env.kv.get(pairKey, { type: 'json' }),
			c.env.kv.get(ipKey, { type: 'json' })
		]);
		const now = Date.now();

		if (pairRecord?.lockedUntil > now) {
			throw this.getLoginLockError(pairRecord);
		}

		if (ipRecord?.lockedUntil > now) {
			throw this.getLoginLockError(ipRecord);
		}
	},

	async recordLoginFailure(c, email) {
		const { pairKey, ipKey } = this.getLoginThrottleKeys(c, email);
		const now = Date.now();
		const [pairRecord, ipRecord] = await Promise.all([
			c.env.kv.get(pairKey, { type: 'json' }),
			c.env.kv.get(ipKey, { type: 'json' })
		]);

		const nextPairRecord = this.nextLoginFailureRecord(pairRecord, LOGIN_FAIL_LIMIT, now);
		const nextIpRecord = this.nextLoginFailureRecord(ipRecord, LOGIN_IP_FAIL_LIMIT, now);

		await Promise.all([
			c.env.kv.put(pairKey, JSON.stringify(nextPairRecord), { expirationTtl: LOGIN_LOCK_SECONDS }),
			c.env.kv.put(ipKey, JSON.stringify(nextIpRecord), { expirationTtl: LOGIN_LOCK_SECONDS })
		]);
	},

	nextLoginFailureRecord(record, limit, now) {
		const count = (record?.count || 0) + 1;
		return {
			count,
			lockedUntil: count >= limit ? now + LOGIN_LOCK_SECONDS * 1000 : 0
		};
	},

	async clearLoginFailure(c, email) {
		const { pairKey, ipKey } = this.getLoginThrottleKeys(c, email);
		await Promise.all([
			c.env.kv.delete(pairKey),
			c.env.kv.delete(ipKey)
		]);
	},

	async logout(c, userId) {
		const token = await userContext.getToken(c);
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		if (!authInfo || !token) {
			return;
		}
		const index = authInfo.tokens.findIndex(item => item === token);
		if (index > -1) {
			authInfo.tokens.splice(index, 1);
			await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		}
	}

};

export default loginService;
