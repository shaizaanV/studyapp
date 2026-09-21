'use strict';

const { execFile } = require('node:child_process');
const { Notification } = require('electron');

const { APP_ID } = require('./constants');

/** Escapes text for safe inclusion in toast XML. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Shows a toast through the real Windows notification platform.
 *
 * Electron's own Notification class is genuinely native, but it exposes no way
 * to set the toast `scenario` attribute. `scenario="alarm"` is what makes
 * Windows keep a toast on screen until it is dismissed instead of sliding it
 * away after a few seconds -- exactly the behaviour wanted for the end of a
 * break. So the alarm path builds the toast XML itself and hands it to the
 * platform through PowerShell.
 *
 * The script is passed as -EncodedCommand (UTF-16LE base64) so that no amount
 * of quoting in the title or body can break the command line.
 *
 * Requires the AppUserModelID to be registered against a Start Menu shortcut,
 * which the NSIS installer creates. Unpackaged dev runs have no such shortcut,
 * which is why this silently falls back rather than throwing.
 */
function showToastViaPowerShell({ title, body, scenario }) {
  return new Promise((resolve) => {
    const scenarioAttr = scenario ? ` scenario="${escapeXml(scenario)}"` : '';
    const xml = [
      `<toast${scenarioAttr} duration="long">`,
      '<visual><binding template="ToastGeneric">',
      `<text>${escapeXml(title)}</text>`,
      `<text>${escapeXml(body)}</text>`,
      '</binding></visual>',
      // An explicit dismiss action gives the alarm toast a button, and keeps
      // Windows from treating a scenario="alarm" toast as malformed.
      '<actions><action content="Dismiss" arguments="dismiss" activationType="background"/></actions>',
      '</toast>',
    ].join('');

    const script = [
      '$ErrorActionPreference = "Stop"',
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
      `$doc.LoadXml([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String("${Buffer.from(xml, 'utf8').toString('base64')}")))`,
      '$toast = New-Object Windows.UI.Notifications.ToastNotification $doc',
      `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("${APP_ID}").Show($toast)`,
    ].join('\n');

    const encoded = Buffer.from(script, 'utf16le').toString('base64');

    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 8000 },
      (err) => resolve(!err)
    );
  });
}

/** Electron's built-in toast. Reliable, but cannot set a scenario. */
function showToastViaElectron({ title, body, silent }) {
  if (!Notification.isSupported()) return false;
  try {
    new Notification({ title, body, silent: silent === true }).show();
    return true;
  } catch (err) {
    console.error('[flowcus] notification failed:', err.message);
    return false;
  }
}

/**
 * @param {{title:string, body:string, scenario?:string, silent?:boolean}} options
 */
async function notify(options) {
  if (process.platform === 'win32' && options.scenario) {
    const shown = await showToastViaPowerShell(options);
    if (shown) return;
    // The raw-XML path needs a registered AUMID; fall through when it is absent.
  }
  showToastViaElectron(options);
}

/**
 * Drags the window in front of whatever the user is looking at.
 *
 * No ordinary Win32 or Electron process can ring the way the UWP Clock app
 * does -- that app holds privileged alarm rights that bypass Focus Assist and
 * force the volume up. What is available, and what this does, is to restore,
 * raise, focus and flash the window so the alarm is impossible to miss even
 * when the toast is suppressed.
 */
function alertWindow(win) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();

  win.setAlwaysOnTop(true, 'screen-saver');
  win.show();
  win.focus();
  win.flashFrame(true);
}

/** How long forceFocus holds the window topmost before relaxing it. */
const FOCUS_RAISE_MS = 1500;

/**
 * Brings the window to the front for a transition the user has to see, without
 * the alarm's persistent taskbar flash.
 *
 * Windows' foreground lock normally refuses focus requests from a background
 * app and only flashes its taskbar button instead. Holding the window topmost
 * for a moment gets it in front regardless, then it relaxes back.
 *
 * @param {() => boolean} keepOnTop Read after the raise, so a mini-mode toggle
 *   made in the meantime is respected rather than overwritten.
 */
function forceFocus(win, keepOnTop) {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true, 'screen-saver');
  win.moveTop();
  win.focus();
  setTimeout(() => {
    if (win.isDestroyed()) return;
    win.setAlwaysOnTop(Boolean(keepOnTop()), 'screen-saver');
  }, FOCUS_RAISE_MS);
}

/** Undoes alertWindow, restoring whatever always-on-top state mini mode wants. */
function clearAlert(win, keepOnTop) {
  if (!win || win.isDestroyed()) return;
  win.flashFrame(false);
  win.setAlwaysOnTop(Boolean(keepOnTop), 'screen-saver');
}

module.exports = { notify, alertWindow, clearAlert, forceFocus, escapeXml };
