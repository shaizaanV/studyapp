'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createUpdateManager } = require('../src/main/update-manager');

function setup({ packaged = true, answer = 0 } = {}) {
  const updater = new EventEmitter();
  updater.checks = 0;
  updater.installs = [];
  updater.checkForUpdates = async () => { updater.checks += 1; };
  updater.quitAndInstall = (...args) => updater.installs.push(args);
  const dialogs = [];
  const dialog = {
    showMessageBox: async (_win, options) => {
      dialogs.push(options);
      return { response: answer };
    },
  };
  const manager = createUpdateManager({ updater, dialog, isPackaged: () => packaged, log: { error() {} } });
  return { manager, updater, dialogs };
}

test('a normal download asks before restarting', async () => {
  const { updater, dialogs } = setup({ answer: 1 });
  updater.emit('update-downloaded', { version: '5.0.1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0].message, /5\.0\.1/);
  assert.equal(updater.installs.length, 0, '"Later" does not install');
});

test('requireUpdate downloads and then installs with no prompt', async () => {
  const { manager, updater, dialogs } = setup();
  assert.equal(await manager.requireUpdate(), 'checking');
  assert.equal(updater.checks, 1);
  updater.emit('update-downloaded', { version: '5.0.1' });
  assert.equal(updater.installs.length, 1);
  assert.equal(dialogs.length, 0);
});

test('requireUpdate installs straight away when the build is already downloaded', async () => {
  const { manager, updater } = setup({ answer: 1 });
  updater.emit('update-downloaded', { version: '5.0.1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await manager.requireUpdate(), 'installing');
  assert.equal(updater.installs.length, 1);
});

test('a development run reports that it cannot self-update', async () => {
  const { manager, updater } = setup({ packaged: false });
  assert.equal(await manager.requireUpdate(), 'unsupported');
  assert.equal(updater.checks, 0);
});

test('promptUnsupported relaunches into the update only when the person agrees', async () => {
  const agree = setup({ answer: 0 });
  await agree.manager.promptUnsupported();
  assert.match(agree.dialogs[0].message, /not supported/);
  assert.equal(agree.updater.checks, 1);

  const decline = setup({ answer: 1 });
  await decline.manager.promptUnsupported();
  assert.equal(decline.updater.checks, 0);
});

test('when no newer build exists, a forced update says so instead of hanging', async () => {
  const { manager, updater, dialogs } = setup();
  await manager.requireUpdate();
  updater.emit('update-not-available');
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(dialogs.at(-1).message, /No newer build/);
});

test('the Store build never loads electron-updater, polls, or self-installs', async () => {
  const opened = [];
  const dialogs = [];
  const manager = createUpdateManager({
    store: true,
    dialog: { showMessageBox: async (_w, options) => { dialogs.push(options); return { response: 0 }; } },
    shell: { openExternal: async (url) => opened.push(url) },
  });
  manager.start();
  manager.stop();
  assert.equal(await manager.requireUpdate(), 'store');
  await manager.promptUnsupported();
  assert.match(dialogs[0].detail, /Microsoft Store/);
  assert.deepEqual(opened, ['ms-windows-store://downloadsandupdates']);
});

test('declining the Store prompt opens nothing', async () => {
  const opened = [];
  const manager = createUpdateManager({
    store: true,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    shell: { openExternal: async (url) => opened.push(url) },
  });
  await manager.promptUnsupported();
  assert.deepEqual(opened, []);
});
