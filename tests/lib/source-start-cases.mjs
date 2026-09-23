import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNodeVersion, startCommands, runCommand, start } from '../../tools/start.mjs';

export function registerSourceStartTests(test) {
  test('accepts the supported source-running Node versions', () => {
    for (const version of ['22.18.0', '22.20.0', '24.0.0', '24.18.1']) assertNodeVersion(version);
    for (const version of ['20.19.0', '22.16.0', '23.6.0', '25.0.0', 'invalid']) {
      assert.throws(() => assertNodeVersion(version), /Node.js 24/);
    }
  });
  test('uses fixed npm steps and the existing Core UI server', () => {
    const commands = startCommands('/example/with spaces', 'linux');
    assert.deepEqual(commands.map(({ id }) => id), ['dependencies', 'build', 'console']);
    assert.deepEqual(commands[0].args, ['ci']);
    assert.deepEqual(commands[1].args, ['run', 'build']);
    assert.equal(commands[2].executable, process.execPath);
    assert.deepEqual(commands[2].args, ['--conditions=source',
      path.join('/example/with spaces', 'tools/server-scripts/start-server.ts'),
      '--profile', 'core', '--host', '127.0.0.1', '--port', '7228', '--with-ui', '--strict-port']);
  });
  test('uses cmd.exe for fixed npm commands on Windows, not npm.cmd spawn', () => {
    const commands = startCommands('C:/example with spaces', 'win32');
    assert.deepEqual(commands[0].args, ['/d', '/s', '/c', 'npm ci']);
    assert.deepEqual(commands[1].args, ['/d', '/s', '/c', 'npm run build']);
    assert.equal(commands[2].executable, process.execPath);
  });

  async function fixture(callback) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'meshrix-source-start-'));
    try {
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'meshrix.js' }));
      await writeFile(path.join(root, 'package-lock.json'), '{}');
      await callback(root);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  test('checks the port before dependency work and runs each step in checkout root', () => fixture(async (root) => {
    const events = [];
    await start({ root, version: '24.0.0', log: () => {}, checkPort: async () => events.push('port'),
      run: async (command, options) => { assert.equal(options.cwd, root); events.push(command.id); } });
    assert.deepEqual(events, ['port', 'dependencies', 'build', 'console']);
  }));
  test('an occupied port prevents installation and startup', () => fixture(async (root) => {
    const calls = [];
    await assert.rejects(start({ root, version: '24.0.0', log: () => {},
      checkPort: async () => { throw new Error('occupied'); }, run: async (command) => calls.push(command.id) }), /occupied/);
    assert.deepEqual(calls, []);
  }));
  for (const failing of ['dependencies', 'build', 'console']) {
    test(`${failing} failure stops the sequence without a fallback`, () => fixture(async (root) => {
      const calls = [];
      await assert.rejects(start({ root, version: '24.0.0', log: () => {}, checkPort: async () => {},
        run: async (command) => { calls.push(command.id); if (command.id === failing) throw new Error('failed'); } }), /failed/);
      const expected = ['dependencies', 'build', 'console'];
      assert.deepEqual(calls, expected.slice(0, expected.indexOf(failing) + 1));
    }));
  }
  test('a missing lockfile does not run npm', () => fixture(async (root) => {
    await rm(path.join(root, 'package-lock.json'));
    const calls = [];
    await assert.rejects(start({ root, version: '24.0.0', log: () => {},
      checkPort: async () => calls.push('port'), run: async () => calls.push('run') }), /ENOENT/);
    assert.deepEqual(calls, []);
  }));
  test('a wrong checkout is rejected before any command', () => fixture(async (root) => {
    await writeFile(path.join(root, 'package.json'), '{"name":"other-project"}');
    await assert.rejects(start({ root, version: '24.0.0' }), /source checkout/);
  }));
  test('a real subprocess success restores signal handlers', async () => {
    const before = process.listenerCount('SIGTERM');
    await runCommand({ executable: process.execPath, args: ['-e', 'process.exit(0)'] }, { cwd: os.tmpdir() });
    assert.equal(process.listenerCount('SIGTERM'), before);
  });
  test('a real subprocess failure retains its exit code', async () => {
    await assert.rejects(runCommand({ executable: process.execPath, args: ['-e', 'process.exit(7)'] }, { cwd: os.tmpdir() }),
      (error) => error.exitCode === 7);
  });
  test('a missing executable rejects without retaining signal handlers', async () => {
    const before = process.listenerCount('SIGTERM');
    await assert.rejects(runCommand({ executable: path.join(os.tmpdir(), 'meshrix-no-such-executable'), args: [] }, { cwd: os.tmpdir() }), /ENOENT/);
    assert.equal(process.listenerCount('SIGTERM'), before);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { test } = await import('node:test');
  registerSourceStartTests(test);
}
