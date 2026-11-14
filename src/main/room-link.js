'use strict';

const Code = require('../shared/room-code');
const { compareVersions } = require('./version');

const UNSUPPORTED = 'Your version is not supported. Please relaunch to update.';

/**
 * Glue between RoomService (trust and room state) and RelayClient (how a
 * stranger finds the room). No Electron: the IPC layer calls into this and
 * forwards its `onRenderer` events, so tests can drive it without a window.
 *
 * The renderer still builds the WebRTC offers and answers; this module only
 * moves their signed blobs between it and the relay.
 *
 * onRenderer(channel, payload):
 *   'relay-invite' {joinId, text}  a joiner's invite for this member to answer
 *   'join-phase'   {phase}         joiner progress: checking | waiting | connecting
 */
class RoomLink {
  constructor({ service, relay, appVersion, onRenderer = () => {} }) {
    this.service = service;
    this.appVersion = appVersion;
    this.relay = relay;
    this.onRenderer = onRenderer;
    this.session = null; // the joiner's relay session

    service.on('authority', (raw) => this.relay.syncRoster(raw));
    service.on('left', () => {
      this.relay.leave();
      this.closeSession();
    });
    service.on('joined', () => {
      // The room is peer-to-peer from here: the joiner's socket has done its job.
      if (this.session) {
        this.session.done();
        this.session = null;
      }
      // Everyone but the creator (who registers the room itself) takes up relay presence.
      if (service.roster && service.roster.hostKey !== service.selfKey) this.attachMember();
    });

    relay.on('offer', (offer) => this.onRelayOffer(offer));
    relay.on('code', ({ code }) => service.setRelayInfo({ code }));
    relay.on('link', (state) => {
      if (service.status === 'active') service.setRelayInfo({ state });
    });
    relay.on('closed', ({ reason }) => {
      if (reason === 'ended') return; // the room-end frame carries its own notice
      service.setRelayInfo({ state: 'down', code: null });
    });
  }

  /**
   * Is this app new enough for the relay? Unreachable counts as fine: the relay
   * itself rejects an old client at hello, and Advanced still works offline.
   */
  async checkVersion() {
    if (!this.relay.configured) return { ok: true };
    const info = await this.relay.info();
    if (info && this.appVersion && compareVersions(this.appVersion, info.minApp) < 0) {
      return { ok: false, unsupported: true, error: UNSUPPORTED };
    }
    return { ok: true };
  }

  closeSession() {
    if (this.session) this.session.close();
    this.session = null;
  }

  // ------------------------------------------------------------------- host

  /** Creates the room, then registers it with the relay. A relay failure leaves a working local room. */
  async createRoom(name) {
    const view = this.service.createRoom(name);
    if (!this.relay.configured) {
      this.service.setRelayInfo({ state: 'off', code: null });
      return { ok: true, view: this.service.view() };
    }
    this.service.setRelayInfo({ state: 'connecting', code: null });
    const result = await this.relay.createRoom(this.service.authorityRaw);
    if (!result.ok) {
      this.service.setRelayInfo({ state: 'down', code: null });
      return { ok: true, view: this.service.view(), relayError: result.error };
    }
    this.service.setRelayInfo({ state: 'up', code: result.code });
    return { ok: true, view: this.service.view() };
  }

  /** Joined as a member: take up relay presence so newcomers can be routed to us. */
  attachMember() {
    if (this.service.status !== 'active' || !this.service.roster) return;
    this.service.setRelayInfo({ state: 'connecting' });
    this.relay.memberConnect(this.service.roster.roomId);
  }

  // ----------------------------------------------------------------- member

  /** The relay routed a joiner's invite to us: vet it and hand it to the renderer to answer. */
  onRelayOffer({ joinId, invite }) {
    const opened = this.service.openInvite(invite);
    if (!opened.ok) {
      const banned = /banned/.test(opened.error);
      const full = /full/.test(opened.error);
      this.relay.decline(joinId, banned ? 'banned' : full ? 'full' : 'busy');
      return;
    }
    this.onRenderer('relay-invite', { joinId, text: invite });
  }

  /** The renderer built an answer SDP for `joinId`; sign it for that joiner and send it back. */
  answerOffer({ joinId, sdp, to, offerSdp }) {
    const made = this.service.makeReply(sdp, { to, offerSdp });
    if (!made.ok) {
      this.relay.decline(joinId, 'busy');
      return made;
    }
    this.relay.answer(joinId, made.reply);
    return { ok: true };
  }

  declineOffer(joinId) {
    this.relay.decline(joinId, 'busy');
  }

  // ----------------------------------------------------------------- joiner

  /** Checks a typed code with the relay before any SDP work is done. */
  async startJoin(rawCode) {
    if (!this.relay.configured) return { ok: false, error: 'Joining by code is not available in this build. Use Advanced to join with an invite.' };
    const code = Code.normalize(rawCode);
    if (!code) return { ok: false, error: "That code isn't valid. Check it and try again." };
    this.closeSession();
    this.onRenderer('join-phase', { phase: 'checking' });
    const joined = await this.relay.joinWithCode(code);
    if (!joined.ok) return { ok: false, error: joined.error, code: joined.code };
    this.session = joined.session;
    return { ok: true, admission: joined.admission };
  }

  /** Wraps the renderer's offer SDP as a signed invite and exchanges it for a reply. */
  async submitOffer(name, sdp) {
    if (!this.session) return { ok: false, error: 'Enter a room code first.' };
    const made = this.service.makeInvite(name, sdp);
    if (!made.ok) return made;
    this.onRenderer('join-phase', { phase: 'waiting' });
    const result = await this.session.offer(made.invite);
    if (!result.ok) {
      this.closeSession();
      this.service.leave();
      return result;
    }
    this.onRenderer('join-phase', { phase: 'connecting' });
    return { ok: true, reply: result.reply };
  }
}

module.exports = { RoomLink };
