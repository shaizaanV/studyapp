---
title: Focuvibe privacy policy
---

# Focuvibe privacy policy

Last updated: 2026-11-14

Focuvibe is a focus timer for Windows. It does not have accounts, does not ask for your name or email, and does not contain advertising or third-party analytics. This page lists everything that leaves your computer.

## Stays on your computer

Your settings, your focus-session history and the analytics dashboard are stored in files in the app's data folder on your PC. They are never uploaded. Study-room signing keys and any relay credentials you enter are stored encrypted with Windows (DPAPI) and never leave your PC.

## Anonymous study totals (on by default, can be turned off)

When a solo focus block ends, Focuvibe can send exactly two values: a random anonymous ID and the number of minutes studied, for example `{ "anon_id": "…", "minutes_spent": 25 }`. The ID is a hash of a key generated on your PC; it is not linked to you. This adds to the "Global Focus Hours" counter in the title bar. Nothing from study rooms is ever sent. Turn it off in **Settings → Privacy → Share anonymous study stats**; nothing is sent while it is off.

## Study rooms

- **Room code service.** Creating or joining a room by code connects to a small relay service operated by the developer (Cloudflare Workers). It passes the short handshake messages that let two computers find each other: your chosen display name, a public key, and the network details WebRTC needs to connect (which include your public IP address). The service sees your public IP address while you are connecting. It stores your IP only as a one-way hash, and only for people who are banned from a room or who recently joined it (so a room's moderators can block someone); this is deleted when the room ends. It does not log message contents.
- **Everything in a room is peer to peer.** Timer state and chat go directly between the people in the room. Chat is kept only in memory while you are in the room and is never saved. The people in your room can see your display name and your IP address, as is normal for a direct connection.
- **STUN servers.** To connect through routers, Focuvibe asks public STUN servers (run by Google and Cloudflare) for your public address. They learn that your IP address made a request; no room or personal data is sent.
- **Your own relay (optional).** If you enter a TURN relay in the Advanced settings, room traffic passes through the server you chose, under its operator's rules.

## Updates

The version downloaded from GitHub checks GitHub Releases for new versions, which means GitHub sees your IP address. The Microsoft Store version is updated by the Microsoft Store instead and does not do this.

## Children

Focuvibe does not knowingly collect personal information from anyone, including children.

## Changes and contact

If this policy changes, the date above changes. Questions: open an issue at https://github.com/shaizaanV/studyapp/issues.
