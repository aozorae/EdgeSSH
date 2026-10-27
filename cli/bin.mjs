#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { accessToken, cloudflared, loadConfig, saveConfig, siteOrigin } from './lib/config.mjs';
import { Client } from './lib/client.mjs';
import { connect, download, execute, hostByName, sftp, terminal, upload } from './lib/operations.mjs';

const help = `EdgeSSH CLI — Node.js >=22.12 and cloudflared required

  edgessh login --url https://ssh.example.com  Open Access login and save site
  edgessh status                             Show authenticated workspace
  edgessh logout                             Forget local CLI configuration
  edgessh hosts                              List hosts (JSON, no credentials)
  edgessh exec <host> -- '<command>'          Run once, preserve SSH exit code
  edgessh connect <host>                     Interactive terminal (Ctrl+] exits)
  edgessh ls <host> [path]                    List remote directory
  edgessh get <host> <remote> <local>         Download file (64 MiB maximum)
  edgessh put <host> <local> <remote>         Upload file (64 MiB maximum)
  edgessh mkdir <host> <path>                 Create directory
  edgessh rm <host> <path>                    Remove file
  edgessh rmdir <host> <path>                 Remove empty directory
  edgessh mv <host> <old> <new>               Rename remote path

Host: exact ID or unique name. Options:
  --json                   Exec: one JSON object with stdout/stderr/exitCode
  --timeout <seconds>      Lifetime including connection, 1..600 (exec:60, others:600)
  --max-output <bytes>     Exec output limit, default 1048576, max 16777216
  --fingerprint <SHA256:…> Verify a known fingerprint
  --accept-new             Explicitly trust and pin a first-seen host key
  --force                  Allow get/put to replace an existing file
  --url <origin>           Override saved site (credentials remain origin-bound)

No daemon, polling or automatic retries. Run login explicitly when Access expires.
logout forgets CLI settings; cloudflared's shared token cache is separate.
`;
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { process.exitCode = signal === 'SIGINT' ? 130 : 143; controller.abort(new Error('Interrupted')); });
let client, timer;
let json = false;
try {
  const parsed = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    timeout: { type: 'string' }, 'max-output': { type: 'string' }, fingerprint: { type: 'string' },
    'accept-new': { type: 'boolean' }, force: { type: 'boolean' },
  } });
  const options = parsed.values;
  json = options.json || false;
  const [command, ...args] = parsed.positionals;
  if (!command || options.help || command === 'help') { process.stdout.write(help); }
  else {
    const arity = { login: [0, 0], logout: [0, 0], status: [0, 0], hosts: [0, 0], exec: [2, 2], connect: [1, 1], ls: [1, 2], get: [3, 3], put: [3, 3], mkdir: [2, 2], rm: [2, 2], rmdir: [2, 2], mv: [3, 3] }[command];
    if (!arity || args.length < arity[0] || args.length > arity[1]) throw new Error('Invalid command or arguments. Run edgessh --help');
    options.timeout = Number(options.timeout ?? (command === 'exec' ? 60 : 600));
    options['max-output'] = Number(options['max-output'] ?? 1024 * 1024);
    if (!Number.isInteger(options.timeout) || options.timeout < 1 || options.timeout > 600) throw new Error('--timeout must be 1..600 seconds');
    if (!Number.isInteger(options['max-output']) || options['max-output'] < 1 || options['max-output'] > 16 * 1024 * 1024) throw new Error('--max-output must be 1..16777216 bytes');
    if (options.fingerprint && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(options.fingerprint)) throw new Error('Invalid SHA256 fingerprint');
    const config = await loadConfig();
    if (command === 'logout') {
      await saveConfig({ knownHosts: {} });
      process.stdout.write(`${JSON.stringify({ ok: true, message: 'CLI settings removed. cloudflared shared token cache is unchanged.' })}\n`);
    } else {
      const origin = siteOrigin(options.url || config.origin || (() => { throw new Error('Run edgessh login --url https://ssh.example.com first'); })());
      timer = setTimeout(() => controller.abort(new Error('CLI operation timed out')), options.timeout * 1000);
      const token = command === 'login' ? await cloudflared(['login', origin], options.timeout * 1000, controller.signal) : await accessToken(origin, controller.signal);
      client = new Client(origin, token, controller.signal);
      if (command === 'login' || command === 'status') {
        const identity = await client.request('/api/auth/me');
        if (identity.provider !== 'cloudflare') throw new Error('This CLI version requires AUTH_PROVIDER=cloudflare');
        if (command === 'login') await saveConfig({ ...config, origin });
        process.stdout.write(`${JSON.stringify({ origin, ...identity })}\n`);
      } else if (command === 'hosts') {
        const { hosts } = await client.request('/api/hosts');
        process.stdout.write(`${JSON.stringify({ hosts: hosts.map(({ id, name, group, host, port, username, authMethod, hasCredential, fingerprint }) => ({ id, name, group, host, port, username, authMethod, hasCredential, fingerprint })) })}\n`);
      } else {
        const host = await hostByName(client, args[0]);
        if (command === 'connect' && (!process.stdin.isTTY || !process.stdout.isTTY || options.json)) throw new Error('connect requires an interactive terminal; agents should use exec');
        const main = await connect(client, host, options, command === 'exec' ? 'exec' : command === 'connect' ? undefined : 'sftp', command === 'exec' ? args[1] : undefined);
        if (command === 'exec') { const code = await execute(main, options); process.exitCode ||= code; }
        else if (command === 'connect') { const code = await terminal(main); process.exitCode ||= code; }
        else {
          const channel = await sftp(client, main);
          let result;
          if (command === 'get') result = await download(channel, args[1], args[2], options.force || false);
          else if (command === 'put') result = await upload(channel, args[1], args[2], options.force || false);
          else {
            const action = { ls: 'list', mkdir: 'mkdir', rm: 'delete', rmdir: 'rmdir', mv: 'rename' }[command];
            channel.send({ type: `sftp_${action}`, requestId: 'cli', ...(command === 'mv' ? { oldPath: args[1], newPath: args[2] } : { path: args[1] || '.' }) });
            result = await channel.until(`sftp_${action}_result`);
          }
          process.stdout.write(`${JSON.stringify(result)}\n`);
        }
      }
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (json) process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  else process.stderr.write(`edgessh: ${message}\n`);
  process.exitCode ||= 1;
} finally { clearTimeout(timer); client?.close(); }
