'use strict';

/**
 * Connects the WebRTC mesh to the trusted room service in the main process.
 *
 * It owns no room rules. It turns UI gestures (make an invite, paste a reply)
 * into offers and answers, tells main when channels open and close, hands main
 * every string that arrives, and sends whatever main tells it to send.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});

  /** A relayed offer that gets no answer in this long is retried: the peer may not know us yet. */
  const RELAY_RETRY_MS = 6000;
  const RELAY_ATTEMPTS = 3;

  function createRoomController({ onView }) {
    const api = window.flowcus.room;
    let mesh = null;
    let view = null;

    /** channelId -> {mode, peerKey}: what main should be told when the channel opens. */
    const roles = new Map();
    /** peerKey -> {channelId, attempt, timer}: relayed offers still waiting for an answer. */
    const pendingRelays = new Map();
    let joinChannelId = null;

    function forgetRelay(peerKey) {
      const entry = pendingRelays.get(peerKey);
      if (entry) clearTimeout(entry.timer);
      pendingRelays.delete(peerKey);
    }

    function onChannelOpen(channelId) {
      const role = roles.get(channelId);
      if (!role) return;
      if (role.mode === 'relay') forgetRelay(role.peerKey);
      api.channelOpen(channelId, role.mode, role.peerKey);
    }

    function onChannelClose(channelId) {
      const role = roles.get(channelId);
      roles.delete(channelId);
      if (channelId === joinChannelId) joinChannelId = null;
      if (role && role.mode === 'relay') {
        const entry = pendingRelays.get(role.peerKey);
        if (entry && entry.channelId === channelId) forgetRelay(role.peerKey);
      }
      api.channelClosed(channelId);
    }

    // ---------------------------------------------------- mesh completion

    /** We are the newcomer: offer a connection to a member we have no channel to yet. */
    async function connectTo(peerKey, attempt) {
      let offer;
      try {
        offer = await mesh.makeOffer();
      } catch {
        return;
      }
      roles.set(offer.channelId, { mode: 'relay', peerKey });
      const timer = setTimeout(() => {
        const entry = pendingRelays.get(peerKey);
        if (!entry || entry.channelId !== offer.channelId) return;
        mesh.close(offer.channelId);
        if (attempt < RELAY_ATTEMPTS) connectTo(peerKey, attempt + 1);
      }, RELAY_RETRY_MS);
      pendingRelays.set(peerKey, { channelId: offer.channelId, attempt, timer });
      await api.relayOut(peerKey, 'offer', offer.sdp);
    }

    async function onRelaySignal({ origin, kind, sdp }) {
      if (kind === 'offer') {
        let answer;
        try {
          answer = await mesh.acceptOffer(sdp);
        } catch {
          return;
        }
        roles.set(answer.channelId, { mode: 'relay', peerKey: origin });
        await api.relayOut(origin, 'answer', answer.sdp);
        return;
      }
      const entry = pendingRelays.get(origin);
      if (!entry) return;
      try {
        await mesh.acceptAnswer(entry.channelId, sdp);
      } catch {
        mesh.close(entry.channelId);
      }
    }

    // --------------------------------------------------------- UI gestures

    /** Joiner, step 1. Resolves {ok, invite} with the text to send to a member. */
    async function makeInvite(name) {
      cancelJoin();
      let offer;
      try {
        offer = await mesh.makeOffer();
      } catch {
        return { ok: false, error: 'Could not prepare a connection on this machine.' };
      }
      const result = await api.makeInvite(name, offer.sdp);
      if (!result.ok) {
        mesh.close(offer.channelId);
        return result;
      }
      joinChannelId = offer.channelId;
      return result;
    }

    /** Joiner, step 2: paste the reply that came back. */
    async function useReply(text) {
      if (!joinChannelId || !mesh.has(joinChannelId)) return { ok: false, error: 'Create an invite first.' };
      const result = await api.openReply(text);
      if (!result.ok) return result;
      roles.set(joinChannelId, { mode: 'joiner', peerKey: result.reply.pubKey });
      try {
        await mesh.acceptAnswer(joinChannelId, result.reply.sdp);
      } catch {
        return { ok: false, error: 'That reply does not match your invite.' };
      }
      return { ok: true };
    }

    /** Member: turn a pasted invite into a reply to send back. */
    async function admit(text) {
      const opened = await api.openInvite(text);
      if (!opened.ok) return opened;
      let answer;
      try {
        answer = await mesh.acceptOffer(opened.invite.sdp);
      } catch {
        return { ok: false, error: 'That invite could not be used.' };
      }
      roles.set(answer.channelId, { mode: 'admit', peerKey: opened.invite.pubKey });
      const reply = await api.makeReply(answer.sdp);
      if (!reply.ok) {
        mesh.close(answer.channelId);
        return reply;
      }
      return { ok: true, reply: reply.reply, name: opened.invite.name };
    }

    function cancelJoin() {
      if (joinChannelId) mesh.close(joinChannelId);
      joinChannelId = null;
    }

    async function leave() {
      cancelJoin();
      await api.leave();
      mesh.closeAll();
      for (const peerKey of [...pendingRelays.keys()]) forgetRelay(peerKey);
    }

    // ---------------------------------------------------------------- init

    async function init() {
      const boot = await api.get();
      view = boot.view;
      mesh = Flowcus.createMesh({
        iceServers: boot.iceServers,
        onOpen: onChannelOpen,
        onClose: onChannelClose,
        onMessage: (channelId, data) => api.data(channelId, data),
      });

      api.onSend(({ channelIds, data }) => {
        for (const id of channelIds) mesh.send(id, data);
      });
      api.onClose(({ channelId }) => mesh.close(channelId));
      api.onRelayConnect(({ peerKey }) => connectTo(peerKey, 1));
      api.onRelaySignal(onRelaySignal);
      api.onState((next) => {
        view = next;
        // Main is the source of truth: once it says there is no room, nothing may stay open.
        if (next.status === 'idle') {
          mesh.closeAll();
          for (const peerKey of [...pendingRelays.keys()]) forgetRelay(peerKey);
        }
        onView(next);
      });

      onView(view);
    }

    async function setTurn(turn) {
      const saved = await api.setTurn(turn);
      mesh.setIceServers(saved.iceServers);
      return saved.turn;
    }

    return {
      init,
      makeInvite,
      useReply,
      admit,
      cancelJoin,
      leave,
      setTurn,
      getTurn: () => api.getTurn(),
      create: (name) => api.create(name),
      approve: (key) => api.approve(key),
      deny: (key) => api.deny(key),
      chat: (text) => api.chat(text),
      get view() {
        return view;
      },
    };
  }

  Flowcus.createRoomController = createRoomController;
})();
