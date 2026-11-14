'use strict';

/**
 * End-to-end check of a study room across two real Flowcus processes.
 *
 *   npm run room:e2e
 *
 * Launches two separate instances (own profiles, own keys), drives their real
 * UI over the Chrome DevTools Protocol, and walks the whole flow: create a
 * room, join by typing its short code (through a local relay from
 * tools/local-relay.js), timer sync, chat both ways, rotate the code, kick and
 * rejoin, then closes the host's window and waits for the other peer to take
 * over. Everything crosses real WebRTC data channels and the real IPC bridge.
 */

const fs = require('node:fs');
const path = require('node:path');

const { launch } = require('./launch');
const { startLocalRelay } = require('./local-relay');

const outputDir = path.join(__dirname, '..', '.smoke');
const PORTS = { a: 9341, b: 9342 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A tiny CDP client: enough to evaluate expressions in the page. */
async function connect(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && /index\.html/.test(t.url));
    } catch {
      /* not listening yet */
    }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error(`no page on port ${port}`);

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });

  let nextId = 1;
  const waiting = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = waiting.get(message.id);
    if (entry) {
      waiting.delete(message.id);
      entry.resolve(message);
    }
  });
  // A page that exits mid-call (the window-close step) must not hang its caller.
  socket.addEventListener('close', () => {
    for (const entry of waiting.values()) entry.reject(new Error('page closed'));
    waiting.clear();
  });

  return {
    async eval(expression) {
      const id = nextId++;
      const reply = new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
      const message = await reply;
      if (message.result && message.result.exceptionDetails) {
        throw new Error(message.result.exceptionDetails.exception?.description || 'evaluation failed');
      }
      return message.result.result.value;
    },
    close: () => socket.close(),
  };
}

async function waitFor(label, peer, expression, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await peer.eval(expression);
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for: ${label} (last: ${JSON.stringify(last)})`);
}

const click = (text, scope = '#view-room') =>
  `[...document.querySelectorAll('${scope} button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)}).click()`;

let relayUrl = '';

function start(name) {
  const userData = path.join(outputDir, `e2e-${name}`);
  fs.rmSync(userData, { recursive: true, force: true });
  const child = launch([`--remote-debugging-port=${PORTS[name]}`], {
    FLOWCUS_MULTI_INSTANCE: '1',
    FLOWCUS_USER_DATA: userData,
    FLOWCUS_RELAY_URL: relayUrl,
    __stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
  return child;
}

let step = 0;
const log = (message) => console.log(`[e2e] ${++step}. ${message}`);

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });
  const relay = await startLocalRelay({ port: 0 });
  relayUrl = relay.url;
  const children = [start('a'), start('b')];
  const cleanup = () => {
    children.forEach((child) => child.kill());
    relay.close();
  };
  process.on('exit', cleanup);

  try {
    const a = await connect(PORTS.a);
    const b = await connect(PORTS.b);
    await sleep(1500);

    log('host creates a room and gets a short code');
    await a.eval(`document.getElementById('btn-room').click()`);
    await a.eval(`document.getElementById('room-name').value = 'Alice'`);
    await a.eval(`document.getElementById('room-create').click()`);
    const mnemonic = await waitFor('room tag on host', a, `!document.getElementById('room-tag').hidden && document.getElementById('room-tag').textContent`);
    const code = await waitFor('room code', a, `/^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(document.getElementById('room-code').textContent) && document.getElementById('room-code').textContent`);
    console.log(`       code: ${code}`);

    log('joiner types the code and is in the room with no copy-paste');
    await b.eval(`document.getElementById('btn-room').click()`);
    await b.eval(`document.getElementById('room-name').value = 'Bob'`);
    await b.eval(`(() => { const input = document.getElementById('room-code-input'); input.value = ${JSON.stringify(code.toLowerCase())}; input.dispatchEvent(new Event('input')); document.getElementById('room-join').click(); })()`);
    await waitFor('joiner in room', b, `!document.getElementById('room-tag').hidden && document.getElementById('room-tag').textContent`, 40000);
    const joinerTag = await b.eval(`document.getElementById('room-tag').textContent`);
    if (joinerTag !== mnemonic) throw new Error(`room label differs: ${mnemonic} vs ${joinerTag}`);
    for (const peer of [a, b]) {
      await waitFor('two members', peer, `document.querySelectorAll('#view-room .room-member').length === 2`);
    }
    const hostSawModal = await a.eval(`!document.getElementById('room-admit').hidden`);
    if (hostSawModal) throw new Error('open join should not ask the host');
    await waitFor('joiner shows the same code', b, `document.getElementById('room-code').textContent === ${JSON.stringify(code)}`);

    log('the QR code renders in the real page (CSP allows the shared script and SVG)');
    await a.eval(`document.getElementById('room-qr-toggle').click()`);
    await waitFor('qr svg', a, `(() => { const p = document.querySelector('#room-qr svg path'); return p && p.getAttribute('d').length > 100; })()`);

    log('host starts the timer; the joiner follows and cannot control it');
    await a.eval(`window.flowcus.action('start')`);
    await waitFor('joiner focus', b, `document.body.dataset.phase === 'FOCUS' && document.body.dataset.room === 'follower'`);
    const followerButtons = await b.eval(`document.querySelectorAll('#timer-controls button').length`);
    if (followerButtons !== 0) throw new Error('follower still has timer controls');
    const digits = await Promise.all([a.eval(`document.getElementById('digits').textContent`), b.eval(`document.getElementById('digits').textContent`)]);
    console.log(`       digits: host ${digits[0]}, joiner ${digits[1]}`);

    log('chat crosses both ways');
    await a.eval(`window.flowcus.room.chat('hello from Alice')`);
    await waitFor('chat at joiner', b, `document.querySelector('#view-room .chat-log').textContent.includes('hello from Alice')`);
    await b.eval(`window.flowcus.room.chat('hello from Bob')`);
    await waitFor('chat at host', a, `document.querySelector('#view-room .chat-log').textContent.includes('hello from Bob')`);

    log('the host pauses; the joiner sees it');
    await a.eval(`window.flowcus.action('pause')`);
    await waitFor('joiner paused', b, `document.body.dataset.phase === 'FOCUS_PAUSED'`);

    log('the host rotates the code; every member sees the new one');
    await a.eval(`document.getElementById('room-rotate').click()`);
    const fresh = await waitFor('new code at host', a, `document.getElementById('room-code').textContent !== ${JSON.stringify(code)} && document.getElementById('room-code').textContent`);
    await waitFor('new code at joiner', b, `document.getElementById('room-code').textContent === ${JSON.stringify(fresh)}`);

    log('the host kicks the joiner, who sees why and can rejoin with the new code');
    await a.eval(`(() => { const kick = document.querySelector('#view-room [data-action="kick"]'); kick.click(); kick.click(); })()`);
    await waitFor('removal notice', b, `!document.getElementById('room-notice').hidden && /removed/.test(document.getElementById('room-notice').textContent)`);
    await waitFor('host back to one member', a, `document.querySelectorAll('#view-room .room-member').length === 1`);
    await b.eval(`(() => { const input = document.getElementById('room-code-input'); input.value = ${JSON.stringify(fresh)}; input.dispatchEvent(new Event('input')); document.getElementById('room-join').click(); })()`);
    await waitFor('joiner back in room', b, `!document.getElementById('room-tag').hidden && document.querySelectorAll('#view-room .room-member').length === 2`, 40000)
      .catch(async (err) => { throw new Error(`${err.message} | join note: ${await b.eval(`document.getElementById('room-join-note').textContent`)} | idle error: ${await b.eval(`document.querySelector('#view-room .room-note').textContent`)}`); });

    log('host closes its window; the joiner takes over as host');
    await a.eval(`window.flowcus.window('close')`).catch(() => {}); // the page goes away mid-call
    await waitFor('joiner becomes host', b, `document.querySelector('#view-room .room-sub').textContent.includes('You are the host') && document.body.dataset.room === 'host'`, 25000);
    const phase = await b.eval(`document.body.dataset.phase`);
    if (phase !== 'FOCUS_PAUSED') throw new Error(`state lost across handover: ${phase}`);

    log('new host resumes the shared timer');
    await b.eval(`window.flowcus.action('resume')`);
    await waitFor('resumed', b, `document.body.dataset.phase === 'FOCUS'`);

    console.log('\n[e2e] all steps passed');
  } finally {
    cleanup();
  }
}

main().catch((err) => {
  console.error(`\n[e2e] FAILED: ${err.message}`);
  process.exitCode = 1;
  process.exit(1);
});
