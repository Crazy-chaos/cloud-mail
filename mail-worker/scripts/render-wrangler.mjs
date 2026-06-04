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

// Helper to get environment variable case-insensitively
const getEnv = (key) => process.env[key] || process.env[key.toLowerCase()];

const required = [
	'ADMIN',
	'JWT_SECRET',
	'D1_DATABASE_ID',
	'KV_NAMESPACE_ID',
	'R2_BUCKET_NAME'
];

const missing = required.filter((key) => !getEnv(key));
if (missing.length) {
	console.error(`Missing required environment variables: ${missing.join(', ')}`);
	process.exit(1);
}

const name = getEnv('NAME') || 'cloud-mail';
const customDomain = getEnv('CUSTOM_DOMAIN') || '';
const domain = getEnv('DOMAIN') || '[]';
const aiModel = getEnv('AI_MODEL') || '@cf/meta/llama-3.1-8b-instruct';
const analysisCache = getEnv('ANALYSIS_CACHE') || 'false';
const projectLink = getEnv('PROJECT_LINK') || '';
const linuxdoClientId = getEnv('LINUXDO_CLIENT_ID') || '';
const linuxdoClientSecret = getEnv('LINUXDO_CLIENT_SECRET') || '';
const linuxdoCallbackUrl = getEnv('LINUXDO_CALLBACK_URL') || '';
const linuxdoSwitch = getEnv('LINUXDO_SWITCH') || '';
const turnstileSiteKey = getEnv('TURNSTILE_SITE_KEY') || '';
const turnstileSecretKey = getEnv('TURNSTILE_SECRET_KEY') || '';
const cfEmail = String(getEnv('CF_EMAIL') || getEnv('CLOUDFLARE_EMAIL') || '').toLowerCase() === 'true';

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
	`database_id = ${q(getEnv('D1_DATABASE_ID'))}`,
	'',
	'[[kv_namespaces]]',
	'binding = "kv"',
	`id = ${q(getEnv('KV_NAMESPACE_ID'))}`,
	'',
	'[[r2_buckets]]',
	'binding = "r2"',
	`bucket_name = ${q(getEnv('R2_BUCKET_NAME'))}`,
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
	`admin = ${q(getEnv('ADMIN'))}`,
	`jwt_secret = ${q(getEnv('JWT_SECRET'))}`,
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
