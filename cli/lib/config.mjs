import { mkdir, readFile, writeFile, rename, rm, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

export function siteOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use the site origin, e.g. https://ssh.example.com');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('HTTPS is required except for localhost development');
  return url.origin;
}
export function configPath() {
  return process.env.EDGESSH_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'edgessh', 'config.json');
}
export async function loadConfig() {
  try { return JSON.parse(await readFile(configPath(), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { knownHosts: {} }; throw error; }
}
export async function saveConfig(config) {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    if (process.platform !== 'win32') await chmod(path, 0o600);
  } finally { await rm(temporary, { force: true }); }
}
export function cloudflared(args, timeout = 15_000, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('cloudflared', ['access', ...args], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, signal });
    let output = '';
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.length > 128 * 1024) child.kill();
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(new Error(error.code === 'ENOENT' ? 'Install cloudflared first: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/' : 'cloudflared was interrupted'));
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('Access authentication failed or expired. Run edgessh login --url <site>'));
      const token = output.match(/(?:^|\s)([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)(?:\s|$)/)?.[1];
      if (!token) return reject(new Error('cloudflared did not return an Access token. Run edgessh login again'));
      resolve(token);
    });
  });
}
export async function accessToken(origin, signal) {
  const token = process.env.EDGESSH_ACCESS_TOKEN || await cloudflared(['token', `-app=${origin}`], 15_000, signal);
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Access token');
  return token;
}
