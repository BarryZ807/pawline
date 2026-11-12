import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
const values = { 'env-file': '.env', project: 'pawline_demo', 'web-port': '3000', 'mail-port': '8025', 'database-ui-port': '5555' };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, '');
  if (!(key in values) || !args[i + 1]) throw Error('Use --env-file, --project, --web-port, --mail-port, or --database-ui-port followed by a value.');
  values[key] = args[i + 1];
}
if (!/^pawline_[a-z0-9_]+$/.test(values.project)) throw Error('Project names must start with pawline_ and use lowercase letters, numbers, or underscores.');
const ports = ['web-port', 'mail-port', 'database-ui-port'].map(key => Number(values[key]));
if (ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || new Set(ports).size !== 3) throw Error('Choose three distinct ports between 1024 and 65535.');
const target = values['env-file'];
if (existsSync(target)) { console.log('Existing private configuration retained; no credentials or data were changed.'); process.exit(0); }
mkdirSync('.local', { recursive: true, mode: 0o700 });
mkdirSync(path.dirname(target), { recursive: true });
const secret = () => randomBytes(20).toString('hex');
const password = secret(), staff = secret(), mail = secret();
const credentials = target === '.env' ? '.local/credentials.txt' : '.local/credentials-' + path.basename(target) + '.txt';
if (existsSync(credentials)) throw Error('Private credentials already exist. Restore their matching environment or choose a new environment file; nothing was overwritten.');
const content = `COMPOSE_PROJECT_NAME=${values.project}\nAPP_PUBLIC_ORIGIN=http://127.0.0.1:${ports[0]}\nWEB_PORT=${ports[0]}\nMAIL_PORT=${ports[1]}\nDATABASE_UI_PORT=${ports[2]}\nPOSTGRES_USER=pawline\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=pawline\nDATABASE_URL=postgresql://pawline:${password}@db:5432/pawline\nSTAFF_PASSWORD=${staff}\nMAIL_PASSWORD=${mail}\nSESSION_SECRET=${secret()}\nMEDIA_DIR=/media\nSMTP_HOST=mailpit\nSMTP_PORT=1025\nMAILPIT_URL=http://mailpit:8025\n`;
writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
writeFileSync(credentials, `本机私有凭据，请勿发布\n配置文件: ${target}\n实例: ${values.project}\n店主: owner@pawline.demo\n设计师: designer@pawline.demo\n员工密码: ${staff}\n邮箱用户: operator\n邮箱密码: ${mail}\n`, { mode: 0o600, flag: 'wx' });
console.log(`Created ${target} and ${credentials}. PostgreSQL and its interface are part of the full-stack startup.`);
