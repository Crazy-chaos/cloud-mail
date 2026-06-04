import { writeFileSync, existsSync, readFileSync } from 'node:fs';

// Try to load env variables from a local .env file if it exists (for local development)
if (existsSync('.env')) {
	try {
		const envContent = readFileSync('.env', 'utf-8');
		envContent.split(/\r?\n/).forEach((line) => {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) return;
			const equalIndex = trimmed.indexOf('=');
			if (equalIndex === -1) return;
			const key = trimmed.substring(0, equalIndex).trim();
			let value = trimmed.substring(equalIndex + 1).trim();
			// Remove surrounding quotes if present
			if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
				value = value.slice(1, -1);
			}
			if (!process.env[key]) {
				process.env[key] = value;
			}
		});
		console.log('Loaded environment variables from local .env file');
	} catch (err) {
		console.warn('Failed to parse local .env file:', err);
	}
}

const required = [
	'ADMIN',
	'JWT_SECRET',
	'D1_DATABASE_ID',
	'KV_NAMESPACE_ID',
	'R2_BUCKET_NAME'
];

const missing = required.filter((key) => !process.env[key]);
if (missing.length) {
	console.error(`Missing required environment variables: ${missing.join(', ')}`);
	process.exit(1);
}

const name = process.env.NAME || 'cloud-mail';
const customDomain = process.env.CUSTOM_DOMAIN || '';
const domain = process.env.DOMAIN || '[]';
const aiModel = process.env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct';
const analysisCache = process.env.ANALYSIS_CACHE || 'false';
const projectLink = process.env.PROJECT_LINK || '';
const linuxdoClientId = process.env.LINUXDO_CLIENT_ID || '';
const linuxdoClientSecret = process.env.LINUXDO_CLIENT_SECRET || '';
const linuxdoCallbackUrl = process.env.LINUXDO_CALLBACK_URL || '';
const linuxdoSwitch = process.env.LINUXDO_SWITCH || '';
const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || process.env.turnstile_site_key || '';
const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY || process.env.turnstile_secret_key || '';
const cfEmail = String(process.env.CF_EMAIL || process.env.CLOUDFLARE_EMAIL || '').toLowerCase() === 'true';

function q(value) {
	return JSON.stringify(String(value));
}

function rawJsonArray(value, fallback = '[]') {
	try {
		const parsed = JSON.parse(value);
		if (Array.isArray(parsed)) return JSON.stringify(parsed);
	} catch {}
	return fallback;
}

const lines = [
	`name = ${q(name)}`,
	'main = "src/index.js"',
	'compatibility_date = "2025-06-04"',
	'keep_vars = true',
	'',
	'[observability]',
	'enabled = true',
	''
];

if (customDomain) {
	lines.push(
		'[[routes]]',
		`pattern = ${q(customDomain)}`,
		'custom_domain = true',
		''
	);
}

lines.push(
	'[[d1_databases]]',
	'binding = "db"',
	'database_name = "cloudmail"',
	`database_id = ${q(process.env.D1_DATABASE_ID)}`,
	'',
	'[[kv_namespaces]]',
	'binding = "kv"',
	`id = ${q(process.env.KV_NAMESPACE_ID)}`,
	'',
	'[[r2_buckets]]',
	'binding = "r2"',
	`bucket_name = ${q(process.env.R2_BUCKET_NAME)}`,
	'',
	'[ai]',
	'binding = "ai"',
	'',
	'[assets]',
	'binding = "assets"',
	'directory = "./dist"',
	'not_found_handling = "single-page-application"',
	'run_worker_first = true',
	'',
	'[triggers]',
	'crons = ["*/30 * * * *", "0 16 * * *"]',
	'',
	'[vars]',
	`domain = ${rawJsonArray(domain)}`,
	`admin = ${q(process.env.ADMIN)}`,
	`jwt_secret = ${q(process.env.JWT_SECRET)}`,
	`ai_model = ${q(aiModel)}`,
	`analysis_cache = ${q(analysisCache)}`
);

if (projectLink) lines.push(`project_link = ${q(projectLink)}`);
if (turnstileSiteKey) lines.push(`turnstile_site_key = ${q(turnstileSiteKey)}`);
if (turnstileSecretKey) lines.push(`turnstile_secret_key = ${q(turnstileSecretKey)}`);
if (linuxdoClientId && linuxdoClientSecret) {
	lines.push(
		`linuxdo_client_id = ${q(linuxdoClientId)}`,
		`linuxdo_client_secret = ${q(linuxdoClientSecret)}`,
		`linuxdo_callback_url = ${q(linuxdoCallbackUrl)}`,
		`linuxdo_switch = ${q(linuxdoSwitch)}`
	);
}

if (cfEmail) {
	lines.push('', '[[send_email]]', 'name = "email"');
}

lines.push(
	'',
	'[build]',
	'command = "npm --prefix ../mail-vue install --legacy-peer-deps && npm --prefix ../mail-vue run build"',
	''
);

writeFileSync('wrangler.generated.toml', lines.join('\n'));
console.log('Generated wrangler.generated.toml');
