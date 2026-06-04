import BizError from '../error/biz-error';
import settingService from './setting-service';
import { t } from '../i18n/i18n'

const turnstileService = {

	async verify(c, token) {

		if (!token) {
			throw new BizError(t('emptyBotToken'),400);
		}

		const settingRow = await settingService.query(c)
		const secretKey = c.env.turnstile_secret_key || c.env.TURNSTILE_SECRET_KEY || settingRow.secretKey;

		if (!secretKey) {
			throw new BizError(t('addTurnstileSecret'), 400);
		}

		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: new URLSearchParams({
				secret: secretKey,
				response: token,
				remoteip: c.req.header('cf-connecting-ip')
			})
		});

		const result = await res.json();

		if (!result.success) {
			throw new BizError(t('botVerifyFail'),400)
		}
	}
};

export default turnstileService;
