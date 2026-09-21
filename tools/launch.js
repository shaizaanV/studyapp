'use strict';

/**
 * Spawns the Electron binary with a clean environment.
 *
 * Any terminal hosted inside an Electron app -- VS Code's integrated terminal
 * is the common one -- exports ELECTRON_RUN_AS_NODE=1. Inherited by a child
 * Electron process, that flag turns the binary into a plain Node runtime: the
 * `electron` module then resolves to undefined and the app dies on the first
 * `app.setAppUserModelId` with a confusing "cannot read properties of
 * undefined". Stripping it here makes `npm start` work from any terminal.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const electron = require('electron');

/**
 * @param {string[]} args Extra arguments for Electron.
 * @param {object} extraEnv Environment additions for the child.
 * @returns {import('node:child_process').ChildProcess}
 */
function launch(args = [], extraEnv = {}) {
  const projectRoot = path.join(__dirname, '..');

  const env = { ...process.env, ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;

  return spawn(electron, [projectRoot, ...args], {
    cwd: projectRoot,
    env,
    stdio: extraEnv.__stdio || 'inherit',
  });
}

module.exports = { launch };

if (require.main === module) {
  const child = launch(process.argv.slice(2));
  child.on('close', (code) => {
    process.exitCode = code === null ? 1 : code;
  });
}
