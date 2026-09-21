'use strict';

/**
 * Renders every screen of the app to a PNG so the UI can be checked without
 * clicking through it by hand.
 *
 *   npm run smoke              -> all scenarios into .smoke/
 *   npm run smoke -- flow mini -> just those two
 *
 * Each scenario runs in its own Electron process, because the point is to see
 * the app boot from scratch into that state.
 */

const fs = require('node:fs');
const path = require('node:path');

const { launch } = require('./launch');

const projectRoot = path.join(__dirname, '..');
const outputDir = path.join(projectRoot, '.smoke');

const ALL_SCENARIOS = [
  'idle',
  'pomodoro',
  'flow',
  'break',
  'breakRunning',
  'alarm',
  'settings',
  'mini',
  'wallIdle',
  'wall',
  'wallMini',
  'wallHandover',
  'analytics',
  'analyticsTiers',
  'analyticsHover',
  'analyticsTable',
  'analyticsEmpty',
  'roomIdle',
  'roomActive',
  'roomLoopback',
];

function runScenario(name) {
  return new Promise((resolve) => {
    const target = path.join(outputDir, `${name}.png`);
    const userData = path.join(outputDir, 'userdata');

    // Every scenario boots from a clean profile, so no screenshot shows
    // sessions left behind by the one before it.
    fs.rmSync(userData, { recursive: true, force: true });

    const child = launch([], {
      FLOWCUS_CAPTURE: target,
      FLOWCUS_SCENARIO: name,
      // Keep the harness away from real settings and session history.
      FLOWCUS_USER_DATA: userData,
      __stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      const ok = code === 0 && fs.existsSync(target);
      if (!ok) {
        console.error(`[smoke] ${name} FAILED (exit ${code})`);
        if (stderr.trim()) console.error(stderr.trim());
      }
      resolve(ok);
    });
  });
}

async function main() {
  const requested = process.argv.slice(2);
  const scenarios = requested.length > 0 ? requested : ALL_SCENARIOS;

  fs.mkdirSync(outputDir, { recursive: true });

  const failures = [];
  for (const name of scenarios) {
    const ok = await runScenario(name);
    if (!ok) failures.push(name);
  }

  console.log(
    `\n[smoke] ${scenarios.length - failures.length}/${scenarios.length} captured into .smoke/`
  );
  if (failures.length > 0) {
    console.error(`[smoke] failed: ${failures.join(', ')}`);
    process.exitCode = 1;
  }
}

main();
