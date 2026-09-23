#!/usr/bin/env node
// Source-checkout convenience entry. Runtime behavior stays in start-server.ts.
import { spawn, spawnSync } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const host = '127.0.0.1';
const port = 7228;

export function assertNodeVersion(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (!(major === 24 || (major === 22 && minor >= 18))) {
    throw new Error('Install Node.js 24 (including npm), then run this command again.');
  }
}

export function startCommands(root, platform = process.platform) {
  // Only fixed repository commands enter cmd.exe; no user input is interpolated.
  const npm = (args) => platform === 'win32'
    ? { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `npm ${args.join(' ')}`] }
    : { executable: 'npm', args };
  return [
    { id: 'dependencies', ...npm(['ci']) },
    { id: 'build', ...npm(['run', 'build']) },
    { id: 'console', executable: process.execPath, args: [
      '--conditions=source', path.join(root, 'tools/server-scripts/start-server.ts'),
      '--profile', 'core', '--host', host, '--port', String(port), '--with-ui', '--strict-port',
    ] },
  ];
}

export function assertPortAvailable() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is in use. Open the existing console at http://${host}:${port}, or stop that instance first.`)
      : error));
    probe.listen({ host, port, exclusive: true }, () => probe.close((error) => error ? reject(error) : resolve()));
  });
}

export function runCommand(command, { cwd = repositoryRoot } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd, stdio: 'inherit', shell: false, detached: process.platform !== 'win32',
    });
    let cancelled;
    const handlers = new Map(['SIGINT', 'SIGTERM'].map((signal) => [signal, () => {
      cancelled = signal;
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') {
          // Stop only this launcher's child tree, including npm's build children.
          spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        } else {
          process.kill(-child.pid, signal);
        }
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill(signal);
      }
    }]));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const cleanup = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', (code, signal) => {
      cleanup();
      const stopped = cancelled || signal;
      if (code === 0 && !stopped) return resolve();
      reject(Object.assign(new Error(`${command.id || 'Command'} ${stopped ? `stopped (${stopped})` : `failed (exit ${code})`}.`), {
        exitCode: stopped ? (stopped === 'SIGINT' ? 130 : 143) : (code || 1),
      }));
    });
  });
}

export async function start({ root = repositoryRoot, version = process.versions.node,
  run = runCommand, checkPort = assertPortAvailable, log = console.log } = {}) {
  assertNodeVersion(version);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== 'meshrix.js') throw new Error('Run the script from a complete Meshrix.js source checkout.');
  await access(path.join(root, 'package-lock.json'));
  // Refuse a live port before npm ci can replace dependencies of a running instance.
  await checkPort();
  for (const command of startCommands(root)) {
    log(`[Meshrix.js] ${command.id}`);
    await run(command, { cwd: root });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).length) {
    console.log('Usage: node tools/start.mjs\nRequires a source checkout and Node.js 24 with npm.');
    process.exitCode = process.argv[2] === '--help' && process.argv.length === 3 ? 0 : 1;
  } else {
    start().catch((error) => {
      console.error(`[Meshrix.js] ${error.message}`);
      process.exitCode = error.exitCode || 1;
    });
  }
}
