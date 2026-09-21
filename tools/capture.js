'use strict';

/**
 * Development screenshot harness.
 *
 * Drives the app into a named state, captures the rendered window and exits.
 * Only reachable when FLOWCUS_CAPTURE is set, and deliberately kept outside
 * src/ so electron-builder never packages it.
 *
 * Driven by tools/smoke.js -- see `npm run smoke`.
 */

const fs = require('node:fs');

const MINUTE_MS = 60000;

/** Long enough for the analytics entrance transitions to finish. */
const CHART_SETTLE_MS = 1300;

/** Lets the renderer settle after a state change before the frame is grabbed. */
const SETTLE_MS = 700;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fakes elapsed focus time by rewriting the engine's accumulator directly.
 * Only sound because the engine derives everything from these two fields.
 */
function fakeFocus(engine, minutes) {
  engine.focusAccumMs = minutes * MINUTE_MS;
  engine.focusSegmentStart = Date.now();
}

/**
 * Seeds a believable month of sessions through the real store, so the charts
 * are drawn from the same rollup path the app uses. A fixed-seed generator
 * keeps every run identical.
 */
function seedHistory() {
  const store = require('../src/main/store');
  let seed = 11;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  const now = new Date();
  for (let daysAgo = 29; daysAgo >= 0; daysAgo--) {
    if (random() < 0.2) continue; // rest days
    const count = 1 + Math.floor(random() * 3);
    for (let s = 0; s < count; s++) {
      const isFlow = random() < 0.65;
      const minutes = isFlow ? 30 + Math.floor(random() * 120) : 52;
      let endedAt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 10 + s * 3).getTime();
      if (endedAt > now.getTime()) endedAt = now.getTime() - (count - s) * MINUTE_MS;
      const completed = !isFlow && random() < 0.8;
      store.appendSession({
        mode: isFlow ? 'FLOW' : 'POMODORO',
        focusMs: minutes * MINUTE_MS,
        earnedMs: completed || isFlow ? 17 * MINUTE_MS : 0,
        endedAt,
        endReason: completed ? 'complete' : 'stop',
      });
    }
  }
}

async function openAnalytics(windows) {
  await windows.win.webContents.executeJavaScript(
    "document.getElementById('btn-analytics').click()"
  );
  await delay(CHART_SETTLE_MS);
}

/** Starts a wall and winds its clock forward, as if it had been running. */
function fakeWall(engine, minutesIn) {
  engine.settings = { ...engine.settings, wallMethodEnabled: true };
  engine.setMode('FLOW');
  engine.start();
  engine.wallStartedAt = Date.now() - minutesIn * MINUTE_MS;
}

const SCENARIOS = {
  /** Idle pomodoro, the first thing a user sees. */
  async idle() {},

  /** Pomodoro mid-session. */
  async pomodoro({ engine }) {
    engine.start();
    fakeFocus(engine, 8.5);
  },

  /** Flow counting up past the tier 2 boundary, with the live preview showing. */
  async flow({ engine }) {
    engine.setMode('FLOW');
    engine.start();
    fakeFocus(engine, 73);
  },

  /** The earned-break summary: breakdown box plus reward links. */
  async break({ engine }) {
    engine.setMode('FLOW');
    engine.start();
    fakeFocus(engine, 127);
    engine.stop();
  },

  /** A break counting down. */
  async breakRunning({ engine }) {
    engine.setMode('FLOW');
    engine.start();
    fakeFocus(engine, 127);
    engine.stop();
    engine.startBreak();
  },

  /** The alarm state. */
  async alarm({ engine }) {
    engine.setMode('FLOW');
    engine.start();
    fakeFocus(engine, 127);
    engine.stop();
    engine.startBreak();
    engine.triggerAlarm();
  },

  async settings({ windows }) {
    await windows.win.webContents.executeJavaScript(
      "document.getElementById('btn-settings').click()"
    );
  },

  /** The Wall Method baseline, three and a half minutes in. */
  async wall({ engine }) {
    fakeWall(engine, 3.5);
  },

  /** The same baseline as seen in the mini widget. */
  async wallMini({ engine, windows }) {
    fakeWall(engine, 3.5);
    windows.setMini(true);
  },

  /**
   * Idle with the Wall Method switched on through the real Settings toggle,
   * so the whole save path -- renderer, IPC, store, engine, back -- runs.
   */
  async wallIdle({ windows }) {
    await windows.win.webContents.executeJavaScript(`
      (async () => {
        document.getElementById('btn-settings').click();
        document.getElementById('set-wall').click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        document.getElementById('btn-close-settings').click();
      })()
    `);
  },

  /**
   * The wall reaching 0:00 on the real 250ms tick loop and handing over to a
   * running flow session, with the main-process tone and force-focus firing.
   */
  async wallHandover({ engine }) {
    fakeWall(engine, 10 - 1 / 60);
    await delay(2000);
  },

  /** Analytics over a seeded month: the index and the 30-day trend. */
  async analytics({ windows }) {
    seedHistory();
    await openAnalytics(windows);
  },

  /** The same panel scrolled down to the tier distribution. */
  async analyticsTiers({ windows }) {
    seedHistory();
    await openAnalytics(windows);
    await windows.win.webContents.executeJavaScript(
      "document.querySelector('.analytics-scroll').scrollTop = 100000"
    );
  },

  /** Hover readouts: the crosshair on the trend, a row on the tier bars. */
  async analyticsHover({ windows }) {
    seedHistory();
    await openAnalytics(windows);
    await windows.win.webContents.executeJavaScript(`
      (() => {
        const scroll = document.querySelector('.analytics-scroll');
        scroll.scrollTop = 150;
        const hit = document.querySelector('#chart-daily .viz-hit-x');
        const box = hit.getBoundingClientRect();
        hit.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, clientX: box.left + box.width * 0.7, clientY: box.top + box.height / 2,
        }));
        const rows = document.querySelectorAll('#chart-tiers .viz-row .viz-hit');
        rows[rows.length - 2].dispatchEvent(new PointerEvent('pointerenter'));
      })()
    `);
  },

  /** The accessible table twin of the trend chart. */
  async analyticsTable({ windows }) {
    seedHistory();
    await openAnalytics(windows);
    await windows.win.webContents.executeJavaScript(
      "document.getElementById('toggle-daily').click()"
    );
  },

  /** A brand-new install: no history at all. */
  async analyticsEmpty({ windows }) {
    await openAnalytics(windows);
  },

  /** The study room start screen: name, create/join, and the relay option. */
  async roomIdle({ windows }) {
    await windows.win.webContents.executeJavaScript(
      "document.getElementById('btn-room').click()"
    );
  },

  /** A room just created through the real panel: the host view with chat. */
  async roomActive({ windows }) {
    await windows.win.webContents.executeJavaScript(`
      (async () => {
        document.getElementById('btn-room').click();
        document.getElementById('room-name').value = 'Hana';
        [...document.querySelectorAll('#view-room .btn')].find((b) => b.textContent === 'Create a room').click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        const input = document.querySelector('#view-room .chat-input');
        input.value = 'Ready when you are';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      })()
    `);
  },

  /**
   * Two real WebRTC meshes in the app's own renderer, under its real CSP:
   * offer, answer, channel open, a message each way. Throws if any step fails,
   * which is what proves connect-src 'none' does not block peer connections.
   */
  async roomLoopback({ windows }) {
    const result = await windows.win.webContents.executeJavaScript(`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const opened = new Set();
        const got = [];
        const make = (name) => Flowcus.createMesh({
          iceServers: [],
          onOpen: (id) => opened.add(name + id),
          onClose: () => {},
          onMessage: (id, data) => got.push(name + ':' + data),
        });
        const a = make('a');
        const b = make('b');
        const offer = await a.makeOffer();
        const answer = await b.acceptOffer(offer.sdp);
        await a.acceptAnswer(offer.channelId, answer.sdp);
        const deadline = Date.now() + 8000;
        while (opened.size < 2 && Date.now() < deadline) await wait(50);
        if (opened.size < 2) return { ok: false, why: 'channels did not open', opened: [...opened] };
        a.send(offer.channelId, 'ping');
        b.send(answer.channelId, 'pong');
        while (got.length < 2 && Date.now() < deadline) await wait(50);
        a.closeAll();
        b.closeAll();
        return { ok: got.length === 2, got };
      })()
    `);
    if (!result.ok) throw new Error('WebRTC loopback under the app CSP failed: ' + JSON.stringify(result));
    console.log('[capture] roomLoopback ok', JSON.stringify(result.got));
  },

  /** The mini widget, mid flow session. */
  async mini({ engine, windows }) {
    engine.setMode('FLOW');
    engine.start();
    fakeFocus(engine, 73);
    windows.setMini(true);
  },
};

function run({ app, engine, windows }) {
  const target = process.env.FLOWCUS_CAPTURE;
  const name = process.env.FLOWCUS_SCENARIO || 'idle';
  const scenario = SCENARIOS[name];

  if (!scenario) {
    console.error(`[capture] unknown scenario "${name}"`);
    app.exit(2);
    return;
  }

  windows.win.once('ready-to-show', async () => {
    try {
      await delay(SETTLE_MS);
      await scenario({ engine, windows });
      engine.emitState();
      await delay(SETTLE_MS);

      const image = await windows.win.webContents.capturePage();
      fs.writeFileSync(target, image.toPNG());
      console.log(`[capture] ${name} -> ${target}`);
      app.exit(0);
    } catch (err) {
      console.error(`[capture] ${name} failed:`, err);
      app.exit(1);
    }
  });
}

module.exports = { run, SCENARIOS };
