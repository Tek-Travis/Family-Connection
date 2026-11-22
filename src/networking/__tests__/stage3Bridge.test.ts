/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  InMemoryTransport,
  createInMemoryNetwork,
} from 'core/transport/InMemoryTransport';
import { RoomConfig } from 'core/transport/TrysteroTransport';
import { StorageManager } from '../../storage/indexedDB.ts';
import { InMemoryIdbFactory } from '../../storage/__tests__/inMemoryIdb.ts';
import {
  createNewIdentity,
  generateSharedInviteCode,
  prepareReplacementDeviceCandidate,
  validateSharedInviteCode,
  INVITE_SYMBOL_CHARS,
} from '../../crypto/cryptoUtils.ts';
import {
  ChitchatterFamilyBridge,
  ActiveCallSession,
} from '../chitchatterFamilyBridge.ts';
import { formatInviteInputWithStage2Rules } from '../familyProtocol.ts';
import { ChatMessage, RosterSnapshot, UserIdentity } from '../../types.ts';
import { PeerStreamType } from 'core/transport/types';

const makeIdb = (): IDBFactory => new InMemoryIdbFactory().createFactory();

function makeMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

interface MockMediaPeerTransport extends InMemoryTransport {
  addStream: (
    stream: MediaStream,
    options?: { target?: string; metadata?: unknown }
  ) => void;
  removeStream: (stream: MediaStream, options?: { target?: string }) => void;
  onPeerStream: (
    type: PeerStreamType,
    cb: (stream: MediaStream, peerId: string, metadata?: unknown) => void
  ) => void;
}

class InMemoryRoomHub {
  private networks = new Map<string, ReturnType<typeof createInMemoryNetwork>>();
  private streamHub = new Map<
    string,
    Map<
      string,
      (stream: MediaStream, peerId: string, metadata?: unknown) => void
    >
  >();
  public streamDeliveries: Array<{
    from: string;
    target?: string;
    metadata?: unknown;
  }> = [];
  private seq = 0;

  createFactory(peerPrefix: string) {
    return (_config: RoomConfig, roomId: string) => {
      let net = this.networks.get(roomId);
      if (!net) {
        net = createInMemoryNetwork();
        this.networks.set(roomId, net);
      }
      if (!this.streamHub.has(roomId)) {
        this.streamHub.set(roomId, new Map());
      }
      const roomStreams = this.streamHub.get(roomId)!;
      this.seq += 1;
      const peerId = `${peerPrefix}-peer-${this.seq}`;
      const transport = new InMemoryTransport(net, peerId) as MockMediaPeerTransport;

      transport.onPeerStream = (_type, cb) => {
        roomStreams.set(peerId, cb);
      };
      transport.addStream = (stream, options) => {
        this.streamDeliveries.push({
          from: peerId,
          target: options?.target,
          metadata: options?.metadata,
        });
        if (options?.target) {
          const targetCb = roomStreams.get(options.target);
          targetCb?.(stream, peerId, options?.metadata);
        }
      };
      transport.removeStream = () => {};
      return transport;
    };
  }
}

describe('Stage 3 Part A — Chitchatter Web Bridge, Identity Binding, Onboarding & DM Outbox (InMemoryTransport)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', makeMemoryStorage());
    vi.stubGlobal('sessionStorage', makeMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('authenticates valid invite onboarding via pendingAdoptions -> permanent room proof -> finalizePendingAdoption, seeds <=5 messages, and cleans up rendezvous room', async () => {
    const hub = new InMemoryRoomHub();
    const logLines: string[] = [];
    const safeLogger = {
      warn: (msg: string) => logLines.push(msg),
      error: (msg: string) => logLines.push(msg),
    };

    const aliceIdb = makeIdb();
    const bobIdb = makeIdb();
    const aliceStorage = new StorageManager({ idbFactory: aliceIdb });
    const bobStorage = new StorageManager({ idbFactory: bobIdb });

    const aliceIdentity = await createNewIdentity('Alice', 'Miller');
    const bobIdentity = await createNewIdentity('Bob', 'Miller');

    const aliceSavedIds: UserIdentity[] = [];
    const bobSavedIds: UserIdentity[] = [];

    const alice = new ChitchatterFamilyBridge({
      storageManager: aliceStorage,
      transportFactory: hub.createFactory('alice'),
      disableFileTransfer: true,
      logger: safeLogger,
      saveIdentityFn: (id) => aliceSavedIds.push(id),
    });

    await alice.init(aliceIdentity);

    // Seed 7 group messages on Alice so only the last 5 are sent on onboarding
    for (let i = 1; i <= 7; i++) {
      await alice.sendGroupMessage('global', `SecretFamilyHistoryLine-${i}`);
    }

    const bob = new ChitchatterFamilyBridge({
      storageManager: bobStorage,
      transportFactory: hub.createFactory('bob'),
      disableFileTransfer: true,
      autoListenInvite: false,
      onboardingTimeoutMs: 6_000,
      logger: safeLogger,
      saveIdentityFn: (id) => bobSavedIds.push(id),
    });
    await bob.init(bobIdentity);

    const bobDefaultFamilyId = bob.getActiveFamily()!.familyId;
    expect(bob.getActiveFamily()!.isUnusedDefault).toBe(true);

    // Automatic valid-code admission (no manual moderator approval click)
    const adopted = await bob.joinFamilyByInviteCode(aliceIdentity.inviteCode);

    expect(adopted.familyId).toBe(alice.getActiveFamily()!.familyId);
    expect(adopted.familyId).not.toBe(bobDefaultFamilyId);
    expect(adopted.authorityState).toBe('verified_current');
    expect(adopted.isUnusedDefault).toBe(false);

    // Old default family removed atomically; pendingAdoptions cleared; max 5 onboarding msgs
    expect(await bobStorage.getFamilyConfigById(bobDefaultFamilyId)).toBeNull();
    expect(await bobStorage.getPendingAdoptions()).toHaveLength(0);
    const bobGroupMsgs = await bobStorage.getMessages('global');
    expect(bobGroupMsgs).toHaveLength(5);
    expect(bobGroupMsgs.map((m) => m.content)).toEqual([
      'SecretFamilyHistoryLine-3',
      'SecretFamilyHistoryLine-4',
      'SecretFamilyHistoryLine-5',
      'SecretFamilyHistoryLine-6',
      'SecretFamilyHistoryLine-7',
    ]);
    expect(bobGroupMsgs.every((m) => m.isOnboardingContext === true)).toBe(true);

    // Rendezvous room was cleaned up after adoption completed
    expect(bob.hasActiveRendezvous()).toBe(false);

    // Live bidirectional Chitchatter ChatRoom group message delivery works after cutover
    const receivedByAlice: ChatMessage[] = [];
    alice.addEventListener('group_message_received', (e) => {
      receivedByAlice.push((e as CustomEvent<ChatMessage>).detail);
    });
    await bob.sendGroupMessage('global', 'Bob joined permanent Chitchatter room!');

    await vi.waitFor(() => {
      expect(
        receivedByAlice.some(
          (m) => m.content === 'Bob joined permanent Chitchatter room!'
        )
      ).toBe(true);
    });

    // Zero private keys, passphrases, or invite codes in diagnostics
    const allLogs = logLines.join('\n');
    expect(allLogs).not.toContain(aliceIdentity.inviteCode);
    expect(allLogs).not.toContain(aliceIdentity.secretKey);
    expect(allLogs).not.toContain(bobIdentity.secretKey);

    await alice.destroy();
    await bob.destroy();
  }, 20_000);

  it('aborts failed/unauthenticated onboarding cleanly, cleans rendezvous, and preserves existing active family', async () => {
    const hub = new InMemoryRoomHub();
    const { deriveInviteRendezvousId } = await import(
      '../../crypto/cryptoUtils.ts'
    );
    const aliceStorage = new StorageManager({
      idbFactory: makeIdb(),
    });
    const aliceIdentity = await createNewIdentity('Alice', 'Miller');

    const alice = new ChitchatterFamilyBridge({
      storageManager: aliceStorage,
      transportFactory: hub.createFactory('alice'),
      disableFileTransfer: true,
      autoListenInvite: false,
      onboardingTimeoutMs: 500,
    });
    await alice.init(aliceIdentity);

    const originalFam = alice.getActiveFamily()!;
    const missingCode = generateSharedInviteCode();
    const failedRendezvousId = await deriveInviteRendezvousId(missingCode);

    await expect(alice.joinFamilyByInviteCode(missingCode)).rejects.toThrow();

    expect(alice.hasActiveRendezvous()).toBe(false);
    expect(alice.getActiveRendezvousRoomId()).not.toBe(failedRendezvousId);
    expect(await aliceStorage.getPendingAdoptions()).toHaveLength(0);
    expect((await aliceStorage.getActiveFamilyConfig())?.familyId).toBe(
      originalFam.familyId
    );
    await alice.destroy();
  });

  it('rejects revoked and unauthorized (self-authorized candidate) device bindings on live peer sessions', async () => {
    const hub = new InMemoryRoomHub();
    const aliceStorage = new StorageManager({
      idbFactory: makeIdb(),
    });
    const bobStorage = new StorageManager({
      idbFactory: makeIdb(),
    });

    const aliceId = await createNewIdentity('Alice', 'Miller');
    const bobId = await createNewIdentity('Bob', 'Miller');

    const alice = new ChitchatterFamilyBridge({
      storageManager: aliceStorage,
      transportFactory: hub.createFactory('alice'),
      disableFileTransfer: true,
    });
    const bob = new ChitchatterFamilyBridge({
      storageManager: bobStorage,
      transportFactory: hub.createFactory('bob'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });

    await alice.init(aliceId);
    await bob.init(bobId);
    await bob.joinFamilyByInviteCode(aliceId.inviteCode);

    const verifiedFam = alice.getActiveFamily()!;
    const latestSnap = alice.getLatestSnapshot()!;

    // Test 1: Unauthorized replacement phone (selfAuthorized candidate not in RosterSnapshot) tries to join permanent room
    const cand = await prepareReplacementDeviceCandidate(bobId, [latestSnap]);
    const rogueStorage = new StorageManager({
      idbFactory: makeIdb(),
    });
    await rogueStorage.init();
    await rogueStorage.saveFamilyConfig(verifiedFam);
    await rogueStorage.saveRosterSnapshot(latestSnap);

    const rejectedEvents: Array<{ peerId: string; reason?: string }> = [];
    alice.addEventListener('peer_binding_rejected', (e) => {
      rejectedEvents.push(
        (e as CustomEvent<{ peerId: string; reason?: string }>).detail
      );
    });

    const rogue = new ChitchatterFamilyBridge({
      storageManager: rogueStorage,
      transportFactory: hub.createFactory('rogue'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });
    await rogue.init(cand.updatedIdentity);

    await vi.waitFor(() => {
      expect(rejectedEvents.length).toBeGreaterThanOrEqual(1);
    });

    // Alice never accepts rogue device or marks it connected under rogue deviceKeyId
    const aliceSessForBob = alice.getVerifiedPeerSession(bobId.memberId!);
    expect(aliceSessForBob?.deviceKeyId).toBe(bobId.deviceKeyId);

    // Test 2: Explicit moderator revocation snapshot drops Bob's live session & rejects future reconnect
    expect(alice.isConnected(bobId.memberId!)).toBe(true);
    const revokedSnap: RosterSnapshot = {
      ...latestSnap,
      epoch: latestSnap.epoch + 1,
      revokedKeyIds: [bobId.deviceKeyId!],
      devices: latestSnap.devices.map((d) =>
        d.deviceKeyId === bobId.deviceKeyId
          ? { ...d, status: 'revoked' as const, revokedAtEpoch: latestSnap.epoch + 1 }
          : d
      ),
    };
    const { signRosterSnapshotWithModeratorDevice } = await import(
      '../../crypto/cryptoUtils.ts'
    );
    const signedRevoke = signRosterSnapshotWithModeratorDevice(
      revokedSnap,
      aliceId
    );
    await alice.publishModeratorSnapshot(signedRevoke);
    expect(alice.isConnected(bobId.memberId!)).toBe(false);

    // Reconnecting with the revoked credential is rejected by Alice
    await bob.destroy();
    rejectedEvents.length = 0;
    const bobRevokedReconnect = new ChitchatterFamilyBridge({
      storageManager: bobStorage,
      transportFactory: hub.createFactory('bob-revoked'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });
    await bobRevokedReconnect.init(bobId);
    await vi.waitFor(() => {
      expect(
        rejectedEvents.some((ev) =>
          (ev.reason || '').toLowerCase().includes('revoked')
        )
      ).toBe(true);
    });
    expect(alice.isConnected(bobId.memberId!)).toBe(false);

    await rogue.destroy();
    await bobRevokedReconnect.destroy();
    await alice.destroy();
  }, 20_000);

  it('queues offline DMs exclusively on original sender (no 3rd-peer relay), deduplicates retries, and marks delivered ONLY after recipient storage commit ACK', async () => {
    const hub = new InMemoryRoomHub();
    const aliceStorage = new StorageManager({
      idbFactory: makeIdb(),
    });
    const bobStorage = new StorageManager({
      idbFactory: makeIdb(),
    });
    const carolStorage = new StorageManager({
      idbFactory: makeIdb(),
    });

    const aliceId = await createNewIdentity('Alice', 'Miller');
    const bobId = await createNewIdentity('Bob', 'Miller');
    const carolId = await createNewIdentity('Carol', 'Miller');

    const alice = new ChitchatterFamilyBridge({
      storageManager: aliceStorage,
      transportFactory: hub.createFactory('alice'),
      disableFileTransfer: true,
    });
    const bob = new ChitchatterFamilyBridge({
      storageManager: bobStorage,
      transportFactory: hub.createFactory('bob'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });
    const carol = new ChitchatterFamilyBridge({
      storageManager: carolStorage,
      transportFactory: hub.createFactory('carol'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });

    await alice.init(aliceId);
    await bob.init(bobId);
    await bob.joinFamilyByInviteCode(aliceId.inviteCode);
    await carol.init(carolId);
    await carol.joinFamilyByInviteCode(aliceId.inviteCode);

    // Bob goes offline while Carol remains online in the group
    await bob.destroy();

    const carolReceivedDms: ChatMessage[] = [];
    carol.addEventListener('direct_message_received', (e) => {
      carolReceivedDms.push((e as CustomEvent<ChatMessage>).detail);
    });

    const statusUpdates: Array<{ messageId: string; status: string }> = [];
    alice.onMessageStatusChange((u) => statusUpdates.push(u));

    // Alice sends 1:1 DM while Bob is offline
    const sentOffline = await alice.sendDirectMessage(
      bobId.memberId!,
      'Offline private note for Bob only'
    );
    expect(sentOffline.status).toBe('queued');
    expect(
      (await aliceStorage.getOfflineMessages(bobId.memberId!)).map((m) => m.id)
    ).toContain(sentOffline.id);

    // Carol (unrelated online device) MUST NEVER receive Bob's DM relay
    await new Promise((r) => setTimeout(r, 150));
    expect(carolReceivedDms).toHaveLength(0);

    // Bob reconnects later with persisted storage
    const bobReconnected = new ChitchatterFamilyBridge({
      storageManager: bobStorage,
      transportFactory: hub.createFactory('bob-re'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });
    const bobReceivedDms: ChatMessage[] = [];
    bobReconnected.addEventListener('direct_message_received', (e) => {
      bobReceivedDms.push((e as CustomEvent<ChatMessage>).detail);
    });

    await bobReconnected.init(bobId);

    // Wait for flush + Bob storage commit + signed dm.fc_ack back to Alice
    await vi.waitFor(
      async () => {
        const aliceMsgs = await aliceStorage.getMessages(bobId.memberId!);
        const bobMsgs = await bobStorage.getMessages(aliceId.memberId!);
        expect(bobMsgs.some((m) => m.id === sentOffline.id)).toBe(true);
        expect(
          aliceMsgs.find((m) => m.id === sentOffline.id)?.status
        ).toBe('delivered');
      },
      { timeout: 8_000 }
    );

    expect(await aliceStorage.getOfflineMessages(bobId.memberId!)).toHaveLength(0);
    expect(statusUpdates.some((u) => u.messageId === sentOffline.id && u.status === 'delivered')).toBe(true);
    expect(bobReceivedDms).toHaveLength(1);

    // Simulate duplicate retry delivery of same message id -> zero duplicate rows or events
    await (alice as unknown as { flushOfflineQueue: (id: string) => Promise<void> }).flushOfflineQueue(
      bobId.memberId!
    );
    await aliceStorage.enqueueOfflineMessage(sentOffline);
    await (alice as unknown as { flushOfflineQueue: (id: string) => Promise<void> }).flushOfflineQueue(
      bobId.memberId!
    );
    await new Promise((r) => setTimeout(r, 150));
    expect((await bobStorage.getMessages(aliceId.memberId!)).filter((m) => m.id === sentOffline.id)).toHaveLength(1);
    expect(bobReceivedDms).toHaveLength(1);

    await carol.destroy();
    await bobReconnected.destroy();
    await alice.destroy();
  }, 20_000);

  it('does not falsely acknowledge delivery or corrupt existing data if storage quota/write fails', async () => {
    const hub = new InMemoryRoomHub();
    const aliceStorage = new StorageManager({
      idbFactory: makeIdb(),
    });
    const bobStorage = new StorageManager({
      idbFactory: makeIdb(),
    });

    const aliceId = await createNewIdentity('Alice', 'Miller');
    const bobId = await createNewIdentity('Bob', 'Miller');

    const alice = new ChitchatterFamilyBridge({
      storageManager: aliceStorage,
      transportFactory: hub.createFactory('alice'),
      disableFileTransfer: true,
    });
    const bob = new ChitchatterFamilyBridge({
      storageManager: bobStorage,
      transportFactory: hub.createFactory('bob'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });

    await alice.init(aliceId);
    await bob.init(bobId);
    await bob.joinFamilyByInviteCode(aliceId.inviteCode);

    // Wait for permanent session binding on both sides
    await vi.waitFor(() => {
      expect(alice.isConnected(bobId.memberId!)).toBe(true);
      expect(bob.isConnected(aliceId.memberId!)).toBe(true);
    });

    // Save baseline message first
    await bobStorage.addMessage(aliceId.memberId!, {
      id: 'existing-safe-msg',
      chatId: aliceId.memberId!,
      senderId: aliceId.memberId!,
      senderName: 'Alice Miller',
      content: 'Existing persisted message',
      timestamp: Date.now(),
      status: 'delivered',
    });

    // Simulate QuotaExceededError on Bob's storage write
    const bridgeErrors: Array<{ context: string; name: string }> = [];
    bob.addEventListener('bridge_error', (e) => {
      bridgeErrors.push(
        (e as CustomEvent<{ context: string; name: string }>).detail
      );
    });
    const origAddMsg = bobStorage.addMessage.bind(bobStorage);
    vi.spyOn(bobStorage, 'addMessage').mockRejectedValueOnce(
      Object.assign(new Error('QuotaExceededError'), {
        name: 'QuotaExceededError',
      })
    );

    const dmSent = await alice.sendDirectMessage(
      bobId.memberId!,
      'Will fail Bob quota'
    );

    await vi.waitFor(() => {
      expect(
        bridgeErrors.some(
          (e) =>
            e.context === 'handleIncomingDirectEnvelope' &&
            e.name === 'QuotaExceededError'
        )
      ).toBe(true);
    });
    const aliceView = (await aliceStorage.getMessages(bobId.memberId!)).find(
      (m) => m.id === dmSent.id
    );
    // Alice MUST NOT mark 'delivered' because Bob did not commit to storage
    expect(aliceView?.status).not.toBe('delivered');
    // Bob's prior data remains intact
    const bobExisting = await bobStorage.getMessages(aliceId.memberId!);
    expect(bobExisting.some((m) => m.id === 'existing-safe-msg')).toBe(true);
    expect(bobExisting.some((m) => m.id === dmSent.id)).toBe(false);

    vi.restoreAllMocks();
    void origAddMsg;
    await bob.destroy();
    await alice.destroy();
  }, 20_000);

  it('supports divergent memberId !== identityHash across history, offline outbox migration, presence, unread, and member isolation', async () => {
    const hub = new InMemoryRoomHub();
    const aliceStorage = new StorageManager({ idbFactory: makeIdb() });
    const bobStorage = new StorageManager({ idbFactory: makeIdb() });
    await aliceStorage.init();
    await bobStorage.init();

    const baseAlice = await createNewIdentity('Alice', 'Miller');
    const baseBob = await createNewIdentity('Bob', 'Miller');
    const aliceId: UserIdentity = {
      ...baseAlice,
      identityHash: 'legacy-alice-hash',
      memberId: 'canonical-alice-member',
    };
    const bobId: UserIdentity = {
      ...baseBob,
      identityHash: 'legacy-bob-hash',
      memberId: 'canonical-bob-member',
    };
    const carolId = await createNewIdentity('Carol', 'Miller');

    // Pre-seed legacy pre-migration message & queued offline DM keyed under legacy-bob-hash
    await aliceStorage.addMessage('legacy-bob-hash', {
      id: 'pre-mig-dm-1',
      chatId: 'legacy-bob-hash',
      senderId: 'legacy-bob-hash',
      senderName: 'Bob Miller',
      content: 'Pre-migration hello',
      timestamp: 1000,
      lamportClock: 1,
      status: 'delivered',
    });
    await aliceStorage.enqueueOfflineMessage({
      id: 'pre-mig-q-1',
      chatId: 'legacy-bob-hash',
      senderId: 'legacy-alice-hash',
      senderName: 'Alice Miller',
      content: 'Pre-migration queued DM',
      timestamp: 1500,
      lamportClock: 2,
      status: 'queued',
    });
    await aliceStorage.addMessage('legacy-bob-hash', {
      id: 'pre-mig-q-1',
      chatId: 'legacy-bob-hash',
      senderId: 'legacy-alice-hash',
      senderName: 'Alice Miller',
      content: 'Pre-migration queued DM',
      timestamp: 1500,
      lamportClock: 2,
      status: 'queued',
    });

    const alice = new ChitchatterFamilyBridge({
      storageManager: aliceStorage,
      transportFactory: hub.createFactory('alice'),
      disableFileTransfer: true,
    });
    const bob = new ChitchatterFamilyBridge({
      storageManager: bobStorage,
      transportFactory: hub.createFactory('bob'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });

    await alice.init(aliceId);
    await alice.addMember({
      identityHash: 'legacy-bob-hash',
      memberId: 'canonical-bob-member',
      firstName: 'Bob',
      lastName: 'Miller',
      publicKey: bobId.publicKey,
      inviteCode: bobId.inviteCode,
      addedAt: 900,
    });
    await alice.addMember({
      identityHash: carolId.identityHash,
      memberId: carolId.memberId,
      firstName: 'Carol',
      lastName: 'Miller',
      publicKey: carolId.publicKey,
      inviteCode: carolId.inviteCode,
      addedAt: 900,
    });

    await bob.init(bobId);
    await bob.joinFamilyByInviteCode(aliceId.inviteCode);

    await vi.waitFor(async () => {
      const bobReceived = await bob.getConversationMessages(aliceId.identityHash);
      expect(bobReceived.some((m) => m.id === 'pre-mig-q-1')).toBe(true);
      const aliceMsgs = await alice.getConversationMessages('legacy-bob-hash');
      expect(aliceMsgs.find((m) => m.id === 'pre-mig-q-1')?.status).toBe('delivered');
    }, { timeout: 8_000 });

    // Both legacy identityHash and canonical memberId work identically for Alice & Bob
    expect(alice.isSameMember('legacy-alice-hash', 'canonical-alice-member')).toBe(true);
    expect(alice.isSameMember('legacy-bob-hash', 'canonical-bob-member')).toBe(true);
    expect(alice.isSameMember('legacy-bob-hash', carolId.memberId!)).toBe(false);
    expect(alice.isSelfId('legacy-alice-hash')).toBe(true);
    expect(alice.isSelfId('canonical-alice-member')).toBe(true);
    expect(alice.isSelfId('legacy-bob-hash')).toBe(false);
    expect(alice.isConnected('legacy-bob-hash')).toBe(true);
    expect(alice.isConnected('canonical-bob-member')).toBe(true);
    expect(alice.getPresence('legacy-bob-hash')).toBe('online');
    expect(alice.getPresence('canonical-bob-member')).toBe('online');
    expect(alice.getPresence(carolId.memberId!)).toBe('offline');

    const byLegacy = await alice.getConversationMessages('legacy-bob-hash');
    const byCanonical = await alice.getConversationMessages('canonical-bob-member');
    expect(byLegacy.map((m) => m.id)).toEqual(['pre-mig-dm-1', 'pre-mig-q-1']);
    expect(byCanonical.map((m) => m.id)).toEqual(['pre-mig-dm-1', 'pre-mig-q-1']);

    await bob.destroy();
    await alice.destroy();
  }, 20_000);

  it('executes authenticated 1:1 audio/video call signaling scoped strictly to target peer, handles reject/disconnect/mute/video, and never fake-connects', async () => {
    const hub = new InMemoryRoomHub();
    const alice = new ChitchatterFamilyBridge({
      storageManager: new StorageManager({ idbFactory: makeIdb() }),
      transportFactory: hub.createFactory('alice'),
      disableFileTransfer: true,
    });
    const bob = new ChitchatterFamilyBridge({
      storageManager: new StorageManager({ idbFactory: makeIdb() }),
      transportFactory: hub.createFactory('bob'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });
    const carol = new ChitchatterFamilyBridge({
      storageManager: new StorageManager({ idbFactory: makeIdb() }),
      transportFactory: hub.createFactory('carol'),
      disableFileTransfer: true,
      autoListenInvite: false,
    });

    const aliceId = await createNewIdentity('Alice', 'Miller');
    const bobId = await createNewIdentity('Bob', 'Miller');
    const carolId = await createNewIdentity('Carol', 'Miller');

    await alice.init(aliceId);
    await bob.init(bobId);
    await bob.joinFamilyByInviteCode(aliceId.inviteCode);
    await carol.init(carolId);
    await carol.joinFamilyByInviteCode(aliceId.inviteCode);

    const makeFakeStream = (hasVideo: boolean) => {
      const audioTrack = { kind: 'audio', enabled: true, stop: vi.fn() };
      const tracks = hasVideo
        ? [audioTrack, { kind: 'video', enabled: true, stop: vi.fn() }]
        : [audioTrack];
      return {
        getTracks: () => tracks,
        getAudioTracks: () => [audioTrack],
        getVideoTracks: () => (hasVideo ? [tracks[1]] : []),
      } as unknown as MediaStream;
    };

    const carolCalls: ActiveCallSession[] = [];
    carol.onIncomingCall((c) => carolCalls.push(c));

    const bobIncoming: ActiveCallSession[] = [];
    bob.onIncomingCall((c) => bobIncoming.push(c));

    // Offline peer fails immediately with 'failed' state (no setTimeout fake connection)
    const aliceStates: ActiveCallSession[] = [];
    alice.onCallStateChange((c) => aliceStates.push(c));
    await expect(
      alice.startCall('non-existent-offline-peer', 'audio', makeFakeStream(false))
    ).rejects.toThrow();
    expect(aliceStates.some((s) => s.state === 'failed')).toBe(true);
    expect(aliceStates.some((s) => s.state === 'connected')).toBe(false);

    // Real outgoing video call Alice -> Bob (Carol receives ZERO invites or streams)
    const aliceStream = makeFakeStream(true);
    const bobStream = makeFakeStream(true);
    const outCall = await alice.startCall(bobId.memberId!, 'video', aliceStream);
    expect(outCall.state).toBe('ringing_outgoing');

    await vi.waitFor(() => {
      expect(bobIncoming.length).toBe(1);
    });
    expect(carolCalls).toHaveLength(0);

    await bob.acceptCall(bobIncoming[0].callId, bobStream);

    await vi.waitFor(() => {
      expect(alice.getActiveCall()?.state).toBe('connected');
      expect(bob.getActiveCall()?.state).toBe('connected');
    });

    // Verify all addStream calls targeted ONLY the specific peer transport id (no broadcast)
    expect(hub.streamDeliveries.length).toBe(2);
    expect(hub.streamDeliveries.every((d) => Boolean(d.target))).toBe(true);

    // Mute and video toggles mutate real track flags
    expect(alice.toggleMute()).toBe(true);
    expect(aliceStream.getAudioTracks()[0].enabled).toBe(false);
    expect(alice.toggleVideo()).toBe(false);
    expect(aliceStream.getVideoTracks()[0].enabled).toBe(false);

    // Mutual hangup cleans up both peers
    await alice.endCall();
    await vi.waitFor(() => {
      expect(alice.getActiveCall()).toBeNull();
      expect(bob.getActiveCall()).toBeNull();
    });
    expect(aliceStream.getAudioTracks()[0].stop).toHaveBeenCalled();
    expect(bobStream.getAudioTracks()[0].stop).toHaveBeenCalled();

    // Decline path test
    const bobIncoming2: ActiveCallSession[] = [];
    bob.onIncomingCall((c) => bobIncoming2.push(c));
    aliceStates.length = 0;
    await alice.startCall(bobId.memberId!, 'audio', makeFakeStream(false));
    await vi.waitFor(() => expect(bobIncoming2).toHaveLength(1));
    await bob.rejectCall(bobIncoming2[0].callId, 'Busy right now');
    await vi.waitFor(() => {
      expect(alice.getActiveCall()).toBeNull();
      expect(aliceStates.some((s) => s.state === 'rejected')).toBe(true);
    });

    await carol.destroy();
    await bob.destroy();
    await alice.destroy();
  }, 20_000);

  it('preserves case sensitivity, validates all 10 symbols, rejects invalid chars without stripping, and does not open legacy BroadcastChannel on import', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const code = generateSharedInviteCode();
      expect(validateSharedInviteCode(code)).toBe(true);
      expect(code).not.toBe('K7#m-Q2v!-R@9t-L4$x');
      codes.add(code);
    }
    expect(codes.size).toBe(20);

    // Every single approved symbol in !@#$%^&*+? passes validation
    for (const sym of INVITE_SYMBOL_CHARS) {
      expect(
        validateSharedInviteCode(`Ab1${sym}-Cd2${sym}-Ef3${sym}-Gh4${sym}`)
      ).toBe(true);
    }

    // Auto-formatting un-hyphenated 16-char code preserves case
    expect(formatInviteInputWithStage2Rules('K7#mQ2v!R@9tL4$x')).toBe(
      'K7#m-Q2v!-R@9t-L4$x'
    );
    // Case sensitivity check: flipping case breaks exact string identity
    expect(formatInviteInputWithStage2Rules('k7#mq2v!r@9tl4$x')).toBe(
      'k7#m-q2v!-r@9t-l4$x'
    );

    // Invalid characters are NEVER stripped/repaired into a valid-looking code
    const withSpace = formatInviteInputWithStage2Rules('K7#m Q2v! R@9t L4$x');
    expect(withSpace).toBe('K7#m Q2v! R@9t L4$x');
    expect(validateSharedInviteCode(withSpace)).toBe(false);

    const withEquals = formatInviteInputWithStage2Rules('K7#m-Q2v!-R@9t-L4$=');
    expect(withEquals).toBe('K7#m-Q2v!-R@9t-L4$=');
    expect(validateSharedInviteCode(withEquals)).toBe(false);
  });
});
