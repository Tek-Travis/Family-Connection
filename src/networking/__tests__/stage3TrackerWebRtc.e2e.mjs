/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { Server: TrackerServer } = require('bittorrent-tracker');

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:3000';
const HARNESS_URL = `${APP_URL}/__stage3_harness__`;
const CACHED_CHROME =
  '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell';

async function startLocalTracker() {
  const server = new TrackerServer({
    udp: false,
    http: false,
    ws: true,
    stats: false,
  });

  server.on('warning', (err) => {
    console.error('[local-tracker warning]', err?.message || err);
  });
  server.on('error', (err) => {
    console.error('[local-tracker error]', err?.message || err);
  });
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = server.ws.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  if (!port) {
    throw new Error('Failed to bind local bittorrent-tracker WebSocket port');
  }
  return { server, wsUrl: `ws://127.0.0.1:${port}` };
}

async function startLocalStun() {
  const { default: dgram } = await import('node:dgram');
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0001) return;
    const cookie = msg.readUInt32BE(4);
    const resp = Buffer.alloc(32);
    resp.writeUInt16BE(0x0101, 0);
    resp.writeUInt16BE(12, 2);
    resp.writeUInt32BE(cookie, 4);
    msg.subarray(8, 20).copy(resp, 8);
    resp.writeUInt16BE(0x0020, 20);
    resp.writeUInt16BE(8, 22);
    resp.writeUInt8(0, 24);
    resp.writeUInt8(1, 25);
    resp.writeUInt16BE(rinfo.port ^ (cookie >>> 16), 26);
    const p = rinfo.address.split('.').map(Number);
    resp.writeUInt32BE(
      (((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) ^ cookie) >>> 0,
      28
    );
    sock.send(resp, rinfo.port, rinfo.address);
  });
  await new Promise((resolve) => sock.bind(0, '127.0.0.1', () => resolve()));
  const port = sock.address().port;
  return { sock, stunUrl: `stun:127.0.0.1:${port}` };
}

async function attachHarnessRoute(context) {
  await context.route(HARNESS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Stage 3 Controlled Tracker WebRTC Harness</title></head><body></body></html>',
    });
  });
}

async function runControlledTrackerWebRtcTests() {
  const { server: tracker, wsUrl } = await startLocalTracker();
  const { sock: stunSock, stunUrl } = await startLocalStun();
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
      (fs.existsSync(CACHED_CHROME) ? CACHED_CHROME : undefined),
    args: [
      '--allow-loopback-in-peer-connection',
      '--disable-features=LocalNetworkAccessChecks,LocalNetworkAccessChecksWebSocket,WebRtcHideLocalIpsWithMdns',
      '--disable-web-security',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  });

  const consoleLogs = [];
  const pageErrors = [];
  const secretValues = [];
  let pageAlice;
  let pageBob;

  try {
    const ctxAlice = await browser.newContext();
    const ctxBob = await browser.newContext();
    const ctxCarol = await browser.newContext();
    const ctxDave = await browser.newContext();

    for (const ctx of [ctxAlice, ctxBob, ctxCarol, ctxDave]) {
      await attachHarnessRoute(ctx);
    }

    pageAlice = await ctxAlice.newPage();
    pageBob = await ctxBob.newPage();
    const pageCarol = await ctxCarol.newPage();
    const pageDave = await ctxDave.newPage();

    for (const p of [pageAlice, pageBob, pageCarol, pageDave]) {
      p.on('console', (m) => consoleLogs.push(`[${m.type()}] ${m.text()}`));
      p.on('pageerror', (e) => pageErrors.push(e.message));
    }

    await Promise.all([
      pageAlice.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' }),
      pageBob.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' }),
      pageCarol.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' }),
      pageDave.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' }),
    ]);

    // 1. Alice boots ChitchatterFamilyBridge over real TrysteroTransport + local bittorrent-tracker
    const aliceInfo = await pageAlice.evaluate(async ({ wsUrl, stunUrl }) => {
      const { createNewIdentity, saveIdentity } = await import('/src/crypto/cryptoUtils.ts');
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const { ChitchatterFamilyBridge } = await import('/src/networking/chitchatterFamilyBridge.ts');

      const storage = new StorageManager();
      const identity = await createNewIdentity('Alice', 'Miller');
      saveIdentity(identity);

      const bridge = new ChitchatterFamilyBridge({
        storageManager: storage,
        relayUrls: [wsUrl],
        rtcConfig: { iceServers: [{ urls: stunUrl }] },
        onboardingTimeoutMs: 15_000,
      });
      window.__fcStorage = storage;
      window.__fcBridge = bridge;
      window.__fcGroupMsgs = [];
      window.__fcRejectedBindings = [];
      window.__fcAliceStatusUpdates = [];
      bridge.onMessageStatusChange((u) => {
        window.__fcAliceStatusUpdates.push(u);
      });
      bridge.addEventListener('group_message_received', (e) => {
        window.__fcGroupMsgs.push(e.detail);
      });
      bridge.addEventListener('peer_binding_rejected', (e) => {
        window.__fcRejectedBindings.push(e.detail);
      });

      await bridge.init(identity);

      for (let i = 1; i <= 6; i++) {
        await bridge.sendGroupMessage('global', `TrackerGroupHistory-${i}`);
      }

      return {
        inviteCode: identity.inviteCode,
        memberId: identity.memberId,
        familyId: bridge.getActiveFamily().familyId,
        secrets: [
          identity.inviteCode,
          identity.secretKey,
          identity.signSecretKey,
          identity.deviceSignSecretKey,
          identity.rsaPrivateKeyPkcs8,
        ],
      };
    }, { wsUrl, stunUrl });

    secretValues.push(...aliceInfo.secrets, 'TrackerGroupHistory-', 'RealTrackerOfflineDM-ForBobOnly');

    // 2. Bob onboards automatically with valid invite code over real local tracker + WebRTC
    const bobInfo = await pageBob.evaluate(
      async ({ wsUrl, stunUrl, aliceInviteCode }) => {
        const { createNewIdentity, saveIdentity } = await import('/src/crypto/cryptoUtils.ts');
        const { StorageManager } = await import('/src/storage/indexedDB.ts');
        const { ChitchatterFamilyBridge } = await import('/src/networking/chitchatterFamilyBridge.ts');

        const storage = new StorageManager();
        const identity = await createNewIdentity('Bob', 'Miller');
        saveIdentity(identity);

        const bridge = new ChitchatterFamilyBridge({
          storageManager: storage,
          relayUrls: [wsUrl],
          rtcConfig: { iceServers: [{ urls: stunUrl }] },
          autoListenInvite: false,
          onboardingTimeoutMs: 15_000,
        });
        window.__fcStorage = storage;
        window.__fcBridge = bridge;

        await bridge.init(identity);
        const defaultFamilyId = bridge.getActiveFamily().familyId;

        const adopted = await bridge.joinFamilyByInviteCode(aliceInviteCode);
        const oldFamAfter = await storage.getFamilyConfigById(defaultFamilyId);
        const pendingAfter = await storage.getPendingAdoptions();
        const groupMsgs = await storage.getMessages('global');

        await bridge.sendGroupMessage('global', 'BobWebRtcLiveMessage-1');

        return {
          defaultFamilyId,
          adoptedFamilyId: adopted.familyId,
          authorityState: adopted.authorityState,
          oldFamRemoved: oldFamAfter === null,
          pendingCount: pendingAfter.length,
          hasActiveRendezvous: bridge.hasActiveRendezvous(),
          seededContents: groupMsgs.map((m) => m.content),
          onboardingFlags: groupMsgs.map((m) => m.isOnboardingContext),
          memberId: identity.memberId,
          secrets: [
            identity.secretKey,
            identity.signSecretKey,
            identity.deviceSignSecretKey,
            identity.rsaPrivateKeyPkcs8,
          ],
        };
      },
      { wsUrl, stunUrl, aliceInviteCode: aliceInfo.inviteCode }
    );

    secretValues.push(...bobInfo.secrets);
    assert.equal(bobInfo.adoptedFamilyId, aliceInfo.familyId);
    assert.notEqual(bobInfo.adoptedFamilyId, bobInfo.defaultFamilyId);
    assert.equal(bobInfo.authorityState, 'verified_current');
    assert.equal(bobInfo.oldFamRemoved, true);
    assert.equal(bobInfo.pendingCount, 0);
    assert.equal(bobInfo.hasActiveRendezvous, false);
    assert.deepEqual(bobInfo.seededContents.slice(0, 5), [
      'TrackerGroupHistory-2',
      'TrackerGroupHistory-3',
      'TrackerGroupHistory-4',
      'TrackerGroupHistory-5',
      'TrackerGroupHistory-6',
    ]);
    assert.ok(bobInfo.onboardingFlags.slice(0, 5).every((v) => v === true));

    // Verify Alice receives Bob's live group message over real WebRTC DataChannel
    await pageAlice.waitForFunction(
      () =>
        window.__fcGroupMsgs.some(
          (m) => m.content === 'BobWebRtcLiveMessage-1'
        ),
      null,
      { timeout: 15_000 }
    );
    console.log(
      'PASS [Controlled Tracker/WebRTC 1]: Automatic onboarding, pendingAdoptions -> permanent room auth -> finalizePendingAdoption, <=5 seeded history, rendezvous cleanup & live WebRTC group delivery'
    );

    // 3. Carol joins as 3rd peer; then Bob closes page (offline); Alice sends 1:1 DM to Bob
    const carolInfo = await pageCarol.evaluate(
      async ({ wsUrl, stunUrl, aliceInviteCode }) => {
        const { createNewIdentity, saveIdentity } = await import('/src/crypto/cryptoUtils.ts');
        const { StorageManager } = await import('/src/storage/indexedDB.ts');
        const { ChitchatterFamilyBridge } = await import('/src/networking/chitchatterFamilyBridge.ts');

        const storage = new StorageManager();
        const identity = await createNewIdentity('Carol', 'Miller');
        saveIdentity(identity);

        const bridge = new ChitchatterFamilyBridge({
          storageManager: storage,
          relayUrls: [wsUrl],
          rtcConfig: { iceServers: [{ urls: stunUrl }] },
          autoListenInvite: false,
          onboardingTimeoutMs: 15_000,
        });
        window.__fcStorage = storage;
        window.__fcBridge = bridge;
        window.__fcDirectMsgs = [];
        bridge.addEventListener('direct_message_received', (e) => {
          window.__fcDirectMsgs.push(e.detail);
        });

        await bridge.init(identity);
        await bridge.joinFamilyByInviteCode(aliceInviteCode);
        return {
          memberId: identity.memberId,
          deviceKeyId: identity.deviceKeyId,
          secrets: [
            identity.secretKey,
            identity.signSecretKey,
            identity.deviceSignSecretKey,
            identity.rsaPrivateKeyPkcs8,
          ],
        };
      },
      { wsUrl, stunUrl, aliceInviteCode: aliceInfo.inviteCode }
    );
    secretValues.push(...carolInfo.secrets);

    // Close Bob's page cleanly & wait for Alice to register Bob offline
    await pageBob.close();
    await pageAlice.waitForFunction(
      (bobId) => !window.__fcBridge.isConnected(bobId),
      bobInfo.memberId,
      { timeout: 15_000 }
    );

    const dmQueuedId = await pageAlice.evaluate(async (bobId) => {
      const sent = await window.__fcBridge.sendDirectMessage(
        bobId,
        'RealTrackerOfflineDM-ForBobOnly'
      );
      if (sent.status !== 'queued') {
        throw new Error(`Expected queued status while Bob offline, got ${sent.status}`);
      }
      const offline = await window.__fcStorage.getOfflineMessages(bobId);
      if (!offline.some((m) => m.id === sent.id)) {
        throw new Error('Offline DM not persisted in sender offlineQueue');
      }
      return sent.id;
    }, bobInfo.memberId);

    // Confirm Carol (online 3rd peer) NEVER receives Bob's private offline DM
    await new Promise((r) => setTimeout(r, 400));
    const carolDmCount = await pageCarol.evaluate(
      () => window.__fcDirectMsgs.length
    );
    assert.equal(carolDmCount, 0);

    // Reopen Bob's page (same Chromium IDB/localStorage context) & verify offline DM flush + ACK
    const pageBob2 = await ctxBob.newPage();
    pageBob2.on('console', (m) => consoleLogs.push(m.text()));
    pageBob2.on('pageerror', (e) => pageErrors.push(e.message));
    await pageBob2.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

    await pageBob2.evaluate(async ({ wsUrl, stunUrl }) => {
      const { getSavedIdentity } = await import('/src/crypto/cryptoUtils.ts');
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const { ChitchatterFamilyBridge } = await import('/src/networking/chitchatterFamilyBridge.ts');

      const storage = new StorageManager();
      const identity = getSavedIdentity();
      const bridge = new ChitchatterFamilyBridge({
        storageManager: storage,
        relayUrls: [wsUrl],
        rtcConfig: { iceServers: [{ urls: stunUrl }] },
        autoListenInvite: false,
        onboardingTimeoutMs: 15_000,
      });
      window.__fcStorage = storage;
      window.__fcBridge = bridge;
      window.__fcBobDmEvents = [];
      window.__fcBobBridgeErrors = [];
      bridge.addEventListener('direct_message_received', (e) => {
        window.__fcBobDmEvents.push(e.detail?.id);
      });
      bridge.addEventListener('bridge_error', (e) => {
        window.__fcBobBridgeErrors.push(e.detail);
      });
      await bridge.init(identity);
    }, { wsUrl, stunUrl });

    // Wait for real WebRTC delivery + Bob IDB commit + signed dm.fc_ack on Alice
    await pageAlice.waitForFunction(
      (dmQueuedId) =>
        window.__fcAliceStatusUpdates.some(
          (u) => u.messageId === dmQueuedId && u.status === 'delivered'
        ),
      dmQueuedId,
      { timeout: 20_000 }
    );

    const aliceAfterAck = await pageAlice.evaluate(
      async ({ bobId, dmQueuedId }) => {
        const msgs = await window.__fcStorage.getMessages(bobId);
        const queue = await window.__fcStorage.getOfflineMessages(bobId);
        return {
          status: msgs.find((m) => m.id === dmQueuedId)?.status,
          queueLen: queue.length,
        };
      },
      { bobId: bobInfo.memberId, dmQueuedId }
    );
    assert.equal(aliceAfterAck.status, 'delivered');
    assert.equal(aliceAfterAck.queueLen, 0);

    // Reload Bob and assert exactly 1 persisted copy survived reload
    await pageBob2.reload({ waitUntil: 'domcontentloaded' });
    const bobDmCountAfterReload = await pageBob2.evaluate(
      async ({ aliceId, dmQueuedId }) => {
        const { StorageManager } = await import('/src/storage/indexedDB.ts');
        const sm = new StorageManager();
        await sm.init();
        const msgs = await sm.getMessages(aliceId);
        return msgs.filter((m) => m.id === dmQueuedId).length;
      },
      { aliceId: aliceInfo.memberId, dmQueuedId }
    );
    assert.equal(bobDmCountAfterReload, 1);
    console.log(
      'PASS [Controlled Tracker/WebRTC 2]: Offline sender-only DM queue (0 3rd-peer relay), real WebRTC reconnect flush, recipient IDB commit ACK -> delivered, & reload persistence'
    );

    // 3b. Synthetic-Media WebRTC 1:1 Video & Audio Calling (Alice <-> Bob, Carol stays isolated)
    // Reload pageBob2 without closing ctxBob so bridge runs live on pageBob2 again for call tests
    await pageBob2.evaluate(async ({ wsUrl, stunUrl }) => {
      const { getSavedIdentity } = await import('/src/crypto/cryptoUtils.ts');
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const { ChitchatterFamilyBridge } = await import('/src/networking/chitchatterFamilyBridge.ts');

      const storage = new StorageManager();
      const identity = getSavedIdentity();
      const bridge = new ChitchatterFamilyBridge({
        storageManager: storage,
        relayUrls: [wsUrl],
        rtcConfig: { iceServers: [{ urls: stunUrl }] },
        autoListenInvite: false,
        onboardingTimeoutMs: 15_000,
      });
      window.__fcStorage = storage;
      window.__fcBridge = bridge;
      window.__fcBobCallStates = [];
      window.__fcBobIncomingCalls = [];
      window.__fcBobRemoteTracks = [];
      bridge.onCallStateChange((c) => window.__fcBobCallStates.push(c));
      bridge.onIncomingCall((c) => window.__fcBobIncomingCalls.push(c));
      bridge.onTrack((peerId, stream) => {
        window.__fcBobRemoteTracks.push({
          peerId,
          audioCount: stream.getAudioTracks().length,
          videoCount: stream.getVideoTracks().length,
        });
      });
      await bridge.init(identity);
    }, { wsUrl, stunUrl });

    await pageCarol.evaluate(() => {
      window.__fcCarolIncomingCalls = [];
      window.__fcCarolRemoteTracks = [];
      window.__fcBridge.onIncomingCall((c) => window.__fcCarolIncomingCalls.push(c));
      window.__fcBridge.onTrack((peerId, stream) => {
        window.__fcCarolRemoteTracks.push({ peerId, id: stream.id });
      });
    });

    await pageAlice.evaluate(() => {
      window.__fcAliceCallStates = [];
      window.__fcAliceRemoteTracks = [];
      window.__fcBridge.onCallStateChange((c) => window.__fcAliceCallStates.push(c));
      window.__fcBridge.onTrack((peerId, stream) => {
        window.__fcAliceRemoteTracks.push({
          peerId,
          audioCount: stream.getAudioTracks().length,
          videoCount: stream.getVideoTracks().length,
        });
      });
    });

    await pageAlice.waitForFunction(
      (bobId) => window.__fcBridge.isConnected(bobId),
      bobInfo.memberId,
      { timeout: 15_000 }
    );
    await pageBob2.waitForFunction(
      (aliceId) => window.__fcBridge.isConnected(aliceId),
      aliceInfo.memberId,
      { timeout: 15_000 }
    );

    // Offline peer call failure (never timer-faked to connected)
    const offlineCallRes = await pageAlice.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      try {
        await window.__fcBridge.startCall('offline-nonexistent-peer', 'audio', stream);
        return { failed: false };
      } catch (err) {
        return { failed: true, message: String(err?.message || err) };
      }
    });
    assert.equal(offlineCallRes.failed, true);

    // Alice initiates real WebRTC Video Call -> Bob using synthetic Chromium fake camera/mic
    await pageAlice.evaluate(async (bobId) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      window.__fcAliceCallLocalStream = stream;
      await window.__fcBridge.startCall(bobId, 'video', stream);
    }, bobInfo.memberId);

    await pageBob2.waitForFunction(
      () => window.__fcBobIncomingCalls.length === 1,
      null,
      { timeout: 15_000 }
    );
    await new Promise((r) => setTimeout(r, 300));
    const carolCallLeakCount = await pageCarol.evaluate(() => ({
      calls: window.__fcCarolIncomingCalls.length,
      tracks: window.__fcCarolRemoteTracks.length,
    }));
    assert.equal(carolCallLeakCount.calls, 0);
    assert.equal(carolCallLeakCount.tracks, 0);

    // Bob answers video call with real synthetic media stream
    await pageBob2.evaluate(async () => {
      const callId = window.__fcBobIncomingCalls[0].callId;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      window.__fcBobCallLocalStream = stream;
      await window.__fcBridge.acceptCall(callId, stream);
    });

    await Promise.all([
      pageAlice.waitForFunction(
        () =>
          window.__fcBridge.getActiveCall()?.state === 'connected' &&
          window.__fcAliceRemoteTracks.some((t) => t.audioCount >= 1 && t.videoCount >= 1),
        null,
        { timeout: 20_000 }
      ),
      pageBob2.waitForFunction(
        () =>
          window.__fcBridge.getActiveCall()?.state === 'connected' &&
          window.__fcBobRemoteTracks.some((t) => t.audioCount >= 1 && t.videoCount >= 1),
        null,
        { timeout: 20_000 }
      ),
    ]);

    // Verify Carol still got ZERO remote media streams (strict { target } scoping)
    const carolPostVideoLeak = await pageCarol.evaluate(() => ({
      calls: window.__fcCarolIncomingCalls.length,
      tracks: window.__fcCarolRemoteTracks.length,
    }));
    assert.equal(carolPostVideoLeak.calls, 0);
    assert.equal(carolPostVideoLeak.tracks, 0);

    // Mute + video toggle + hangup verification
    const toggleAndHangupRes = await pageAlice.evaluate(async () => {
      const muted = window.__fcBridge.toggleMute();
      const videoEnabled = window.__fcBridge.toggleVideo();
      const audioEnabledAfter = window.__fcAliceCallLocalStream.getAudioTracks()[0].enabled;
      const videoEnabledAfter = window.__fcAliceCallLocalStream.getVideoTracks()[0].enabled;
      await window.__fcBridge.endCall();
      return {
        muted,
        videoEnabled,
        audioEnabledAfter,
        videoEnabledAfter,
        activeAfterHangup: window.__fcBridge.getActiveCall(),
      };
    });
    assert.equal(toggleAndHangupRes.muted, true);
    assert.equal(toggleAndHangupRes.audioEnabledAfter, false);
    assert.equal(toggleAndHangupRes.videoEnabled, false);
    assert.equal(toggleAndHangupRes.videoEnabledAfter, false);
    assert.equal(toggleAndHangupRes.activeAfterHangup, null);

    await pageBob2.waitForFunction(
      () => window.__fcBridge.getActiveCall() === null,
      null,
      { timeout: 10_000 }
    );

    // Audio-only call reject + accept/hangup roundtrip
    await pageAlice.evaluate(async (bobId) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      await window.__fcBridge.startCall(bobId, 'audio', stream);
    }, bobInfo.memberId);

    await pageBob2.waitForFunction(
      () => window.__fcBobIncomingCalls.length === 2,
      null,
      { timeout: 10_000 }
    );
    await pageBob2.evaluate(async () => {
      await window.__fcBridge.rejectCall(window.__fcBobIncomingCalls[1].callId, 'Busy test');
    });
    await pageAlice.waitForFunction(
      () =>
        window.__fcBridge.getActiveCall() === null &&
        window.__fcAliceCallStates.some((s) => s.state === 'rejected'),
      null,
      { timeout: 10_000 }
    );

    console.log(
      'PASS [Controlled Tracker/WebRTC 2b]: Synthetic-media 1:1 WebRTC video/audio call (target-scoped, Carol 0 leaks, live remote tracks, mute/video toggle, reject & mutual hangup)'
    );

    // 4a. Failure Path: Invalid/unreachable invite code aborts cleanly preserving active family
    const invalidAbortRes = await pageDave.evaluate(async ({ wsUrl, stunUrl }) => {
      const {
        createNewIdentity,
        saveIdentity,
        generateSharedInviteCode,
      } = await import('/src/crypto/cryptoUtils.ts');
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const { ChitchatterFamilyBridge } = await import('/src/networking/chitchatterFamilyBridge.ts');

      const storage = new StorageManager();
      const identity = await createNewIdentity('Dave', 'Miller');
      saveIdentity(identity);

      const bridge = new ChitchatterFamilyBridge({
        storageManager: storage,
        relayUrls: [wsUrl],
        rtcConfig: { iceServers: [{ urls: stunUrl }] },
        autoListenInvite: false,
        onboardingTimeoutMs: 1200,
      });
      window.__fcStorage = storage;
      window.__fcBridge = bridge;
      await bridge.init(identity);

      const originalFamId = bridge.getActiveFamily().familyId;
      let rejected = false;
      try {
        await bridge.joinFamilyByInviteCode(generateSharedInviteCode());
      } catch {
        rejected = true;
      }

      return {
        rejected,
        hasActiveRendezvous: bridge.hasActiveRendezvous(),
        pendingCount: (await storage.getPendingAdoptions()).length,
        activeFamId: (await storage.getActiveFamilyConfig()).familyId,
        originalFamId,
      };
    }, { wsUrl, stunUrl });

    assert.equal(invalidAbortRes.rejected, true);
    assert.equal(invalidAbortRes.hasActiveRendezvous, false);
    assert.equal(invalidAbortRes.pendingCount, 0);
    assert.equal(invalidAbortRes.activeFamId, invalidAbortRes.originalFamId);

    // 4b. Failure Path: Revoked credential dropped live & rejected on WebRTC reconnect
    await pageAlice.evaluate(async (carolDevKeyId) => {
      const {
        getSavedIdentity,
        signRosterSnapshotWithModeratorDevice,
      } = await import('/src/crypto/cryptoUtils.ts');
      const aliceId = getSavedIdentity();
      const latestSnap = window.__fcBridge.getLatestSnapshot();
      const revokedSnap = signRosterSnapshotWithModeratorDevice(
        {
          ...latestSnap,
          epoch: latestSnap.epoch + 1,
          revokedKeyIds: [...(latestSnap.revokedKeyIds || []), carolDevKeyId],
          devices: latestSnap.devices.map((d) =>
            d.deviceKeyId === carolDevKeyId
              ? { ...d, status: 'revoked', revokedAtEpoch: latestSnap.epoch + 1 }
              : d
          ),
        },
        aliceId
      );
      window.__fcRejectedBindings = [];
      await window.__fcBridge.publishModeratorSnapshot(revokedSnap);
    }, carolInfo.deviceKeyId);

    const aliceSeesCarolDisconnected = await pageAlice.evaluate(
      (carolId) => !window.__fcBridge.isConnected(carolId),
      carolInfo.memberId
    );
    assert.equal(aliceSeesCarolDisconnected, true);

    // Carol reloads & attempts to reconnect over real tracker/WebRTC with revoked credential
    await pageCarol.reload({ waitUntil: 'domcontentloaded' });
    await pageCarol.evaluate(async ({ wsUrl, stunUrl }) => {
      const { getSavedIdentity } = await import('/src/crypto/cryptoUtils.ts');
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const { ChitchatterFamilyBridge } = await import('/src/networking/chitchatterFamilyBridge.ts');

      const storage = new StorageManager();
      const identity = getSavedIdentity();
      const bridge = new ChitchatterFamilyBridge({
        storageManager: storage,
        relayUrls: [wsUrl],
        rtcConfig: { iceServers: [{ urls: stunUrl }] },
        autoListenInvite: false,
      });
      await bridge.init(identity);
    }, { wsUrl, stunUrl });

    await pageAlice.waitForFunction(
      () =>
        window.__fcRejectedBindings.some((ev) =>
          String(ev.reason || '').toLowerCase().includes('revoked')
        ),
      null,
      { timeout: 15_000 }
    );
    const aliceStillRejectsCarol = await pageAlice.evaluate(
      (carolId) => !window.__fcBridge.isConnected(carolId),
      carolInfo.memberId
    );
    assert.equal(aliceStillRejectsCarol, true);

    // 4c. Failure Path: Aborted permanent-room auth cleans pendingAdoptions & preserves original family
    await pageAlice.evaluate(async () => {
      // Alice simulates abrupt permanent-session loss right when Dave receives offer
      const origHandlePerm = window.__fcBridge.handlePermanentAuthFrame?.bind(
        window.__fcBridge
      );
      void origHandlePerm;
      // Temporarily reject permanent_auth_req by removing local moderator capability in memory via destroy & restarting only rendezvous? Simpler: closeAlice activeSession right after offer sent!
      const origTry = window.__fcBridge.tryProcessJoinInviteRequest.bind(
        window.__fcBridge
      );
      window.__fcBridge.tryProcessJoinInviteRequest = async (peerId) => {
        await origTry(peerId);
        await window.__fcBridge.closeActiveSession();
      };
    });

    const daveAbortRes = await pageDave.evaluate(
      async ({ aliceInviteCode }) => {
        const storage = window.__fcStorage;
        const bridge = window.__fcBridge;
        const originalFamId = bridge.getActiveFamily().familyId;

        let failed = false;
        try {
          await bridge.joinFamilyByInviteCode(aliceInviteCode);
        } catch {
          failed = true;
        }
        return {
          failed,
          hasActiveRendezvous: bridge.hasActiveRendezvous(),
          pendingCount: (await storage.getPendingAdoptions()).length,
          activeFamId: (await storage.getActiveFamilyConfig()).familyId,
          originalFamId,
        };
      },
      { aliceInviteCode: aliceInfo.inviteCode }
    );

    assert.equal(daveAbortRes.failed, true);
    assert.equal(daveAbortRes.hasActiveRendezvous, false);
    assert.equal(daveAbortRes.pendingCount, 0);
    assert.equal(daveAbortRes.activeFamId, daveAbortRes.originalFamId);
    console.log(
      'PASS [Controlled Tracker/WebRTC 3]: Unknown invite abort, revoked-device live drop + WebRTC reconnect rejection, & permanent-auth-abort cleanup'
    );

    // 5. Cutover React UI Screen Verification (Zero legacy signaling.ts auto-connect + UI diagnostics/invite formatting)
    const ctxUi = await browser.newContext();
    const pageUi = await ctxUi.newPage();
    pageUi.on('console', (m) => consoleLogs.push(`[UI:${m.type()}] ${m.text()}`));
    pageUi.on('pageerror', (e) => pageErrors.push(`UI:${e.message}`));

    // Instrument BroadcastChannel before load to catch any legacy family_connection_mesh_v1 singleton leak
    await pageUi.addInitScript(() => {
      const OrigBC = window.BroadcastChannel;
      window.__fcOpenedChannels = [];
      if (OrigBC) {
        window.BroadcastChannel = class extends OrigBC {
          constructor(name) {
            super(name);
            window.__fcOpenedChannels.push(name);
          }
        };
      }
    });

    await pageUi.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await pageUi.getByPlaceholder('e.g. Alice').fill('Elena');
    await pageUi.getByPlaceholder('e.g. Johnson').fill('Miller');
    await pageUi.getByRole('button', { name: 'Start Family Connection' }).click();

    // Advance past splash screen and wait for SettingsScreen
    await pageUi.getByText('P2P Network & Privacy').waitFor({ timeout: 10_000 });
    await pageUi.getByText('P2P Network & Privacy').click();
    await pageUi.getByText('PBKDF2-SHA256 (310,000 iterations) + AES-256-GCM').waitFor({ timeout: 5_000 });
    await pageUi.getByText('is not encrypted by the app').waitFor({ timeout: 5_000 });

    // Check AddMemberModal preserves case & invalid chars cleanly
    await pageUi.getByRole('button', { name: 'ADD FAMILY MEMBER', exact: true }).click();
    const inviteField = pageUi.getByPlaceholder('XXXX-XXXX-XXXX-XXXX');
    await inviteField.fill('K7#mQ2v!R@9tL4$x');
    assert.equal(await inviteField.inputValue(), 'K7#m-Q2v!-R@9t-L4$x');
    await inviteField.fill('K7#m Q2v! R@9t L4$=');
    await pageUi.getByRole('button', { name: 'Add Family Member', exact: true }).click();
    await pageUi.getByText('Invalid invite code format').waitFor({ timeout: 5_000 });

    const openedChannels = await pageUi.evaluate(() => window.__fcOpenedChannels || []);
    assert.ok(
      !openedChannels.includes('family_connection_mesh_v1'),
      'Cutover UI bundle must never instantiate legacy signaling.ts BroadcastChannel'
    );
    console.log(
      'PASS [Cutover UI Verification]: Real React UI screens, accurate PBKDF2-SHA256 + AES-256-GCM / unencrypted-DB disclosure, case/symbol invite validation, and 0 legacy signaling BroadcastChannel'
    );

    // Verify ZERO private key, invite code, or plaintext message leakage in console/errors
    const combinedOutput = [...consoleLogs, ...pageErrors].join('\n');
    for (const secret of secretValues) {
      if (secret && secret.length > 6) {
        assert.ok(
          !combinedOutput.includes(secret),
          'Diagnostic/console output leaked sensitive material'
        );
      }
    }
    console.log('PASS [Controlled Tracker/WebRTC 4]: Zero secret/plaintext leaks in diagnostics');
  } catch (err) {
    try {
      const trackerTopics = Object.keys(tracker.torrents || {});
      const aliceDiag = await pageAlice.evaluate(() => ({
        hasRendezvous: window.__fcBridge?.hasActiveRendezvous?.(),
        rendezvousRoomId: window.__fcBridge?.getActiveRendezvousRoomId?.(),
        rendezvousPeers: window.__fcBridge?.rendezvousSession?.room?.getPeers?.()?.map((p) => ({
          peerId: p.peerId,
          verificationState: p.verificationState,
        })),
        transportPeers: window.__fcBridge?.rendezvousSession?.transport?.getPeers?.(),
        permPeers: window.__fcBridge?.activeSession?.transport?.getPeers?.(),
        pendingInviteSize: window.__fcBridge?.pendingInviteRequests?.size,
      }));
      const bobDiag =
        pageBob && !pageBob.isClosed()
          ? await pageBob.evaluate(() => ({
              hasRendezvous: window.__fcBridge?.hasActiveRendezvous?.(),
              rendezvousPeers: window.__fcBridge?.rendezvousSession?.room?.getPeers?.()?.map((p) => ({
                peerId: p.peerId,
                verificationState: p.verificationState,
              })),
              transportPeers: window.__fcBridge?.rendezvousSession?.transport?.getPeers?.(),
            }))
          : { closed: true };
      console.error('Diag trackerTopics:', trackerTopics.length, trackerTopics);
      console.error('Diag alice:', JSON.stringify(aliceDiag));
      console.error('Diag bob:', JSON.stringify(bobDiag));
    } catch (diagErr) {
      console.error('Diag failed:', diagErr);
    }
    console.error('Captured browser console logs:', consoleLogs.slice(-30));
    console.error('Captured browser pageErrors:', pageErrors);
    throw err;
  } finally {
    await browser.close();
    await new Promise((resolve) => tracker.close(() => resolve()));
    stunSock.close();
  }
}

runControlledTrackerWebRtcTests().catch((err) => {
  console.error('Controlled tracker/WebRTC test failed:', err);
  process.exit(1);
});
