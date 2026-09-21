'use strict';

/**
 * WebRTC data channels, and nothing else.
 *
 * A mesh of RTCPeerConnections that turns SDP into a channel and moves strings
 * across it. It knows nothing about rooms, people or the timer: the controller
 * feeds it SDP and reads channel events, and the trusted side in the main
 * process decides what any of it means.
 *
 * ICE is not trickled. Every SDP is produced only after candidate gathering
 * finishes, because a copy-paste invite has to be one complete blob.
 */
(function () {
  const Flowcus = (window.Flowcus = window.Flowcus || {});

  /** How long to wait for candidates. STUN answers in well under a second when reachable. */
  const GATHER_TIMEOUT_MS = 5000;

  function waitForGathering(pc) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') finish();
      };
      const timer = setTimeout(finish, GATHER_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  /**
   * @param {object} options
   * @param {RTCIceServer[]} options.iceServers
   * @param {(channelId: string) => void} options.onOpen
   * @param {(channelId: string) => void} options.onClose
   * @param {(channelId: string, data: string) => void} options.onMessage
   */
  function createMesh({ iceServers, onOpen, onClose, onMessage }) {
    let servers = iceServers;
    const peers = new Map(); // channelId -> { pc, dc }

    function newPeer() {
      const channelId = crypto.randomUUID();
      const pc = new RTCPeerConnection({ iceServers: servers });
      const peer = { pc, dc: null, closed: false };
      peers.set(channelId, peer);
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close(channelId);
      });
      return { channelId, peer };
    }

    function attach(channelId, peer, dc) {
      peer.dc = dc;
      dc.addEventListener('open', () => onOpen(channelId));
      dc.addEventListener('message', (event) => {
        if (typeof event.data === 'string') onMessage(channelId, event.data);
      });
      dc.addEventListener('close', () => close(channelId));
    }

    /** Builds an offer and resolves with a complete SDP once gathering is done. */
    async function makeOffer() {
      const { channelId, peer } = newPeer();
      try {
        attach(channelId, peer, peer.pc.createDataChannel('flowcus', { ordered: true }));
        await peer.pc.setLocalDescription(await peer.pc.createOffer());
        await waitForGathering(peer.pc);
        return { channelId, sdp: peer.pc.localDescription.sdp };
      } catch (err) {
        close(channelId);
        throw err;
      }
    }

    async function acceptOffer(sdp) {
      const { channelId, peer } = newPeer();
      try {
        peer.pc.addEventListener('datachannel', (event) => attach(channelId, peer, event.channel));
        await peer.pc.setRemoteDescription({ type: 'offer', sdp });
        await peer.pc.setLocalDescription(await peer.pc.createAnswer());
        await waitForGathering(peer.pc);
        return { channelId, sdp: peer.pc.localDescription.sdp };
      } catch (err) {
        close(channelId);
        throw err;
      }
    }

    async function acceptAnswer(channelId, sdp) {
      const peer = peers.get(channelId);
      if (!peer) return;
      await peer.pc.setRemoteDescription({ type: 'answer', sdp });
    }

    function send(channelId, data) {
      const peer = peers.get(channelId);
      if (peer && peer.dc && peer.dc.readyState === 'open') peer.dc.send(data);
    }

    function close(channelId) {
      const peer = peers.get(channelId);
      if (!peer || peer.closed) return;
      peer.closed = true;
      peers.delete(channelId);
      try {
        peer.pc.close();
      } catch {
        /* already closed */
      }
      onClose(channelId);
    }

    function closeAll() {
      for (const channelId of [...peers.keys()]) close(channelId);
    }

    return {
      makeOffer,
      acceptOffer,
      acceptAnswer,
      send,
      close,
      closeAll,
      has: (channelId) => peers.has(channelId),
      setIceServers: (next) => {
        servers = next;
      },
    };
  }

  Flowcus.createMesh = createMesh;
})();
