import { describe, it, expect, beforeAll, vi } from 'vitest';
import { ChatRoom } from 'core/chat/ChatRoom';
import { ChatRoomRegistry } from 'core/chat/ChatRoomRegistry';
import { ChatRoomEvent } from 'core/chat/events';
import { deriveUserIdFromKey } from 'core/chat/identity';
import { createPlatformAdapters } from 'core/adapters/noop';
import { EncryptionService } from 'core/crypto/Encryption';
import { PeerVerificationState } from 'core/models/chat';
import {
  InMemoryTransport,
  createInMemoryNetwork,
} from 'core/transport/InMemoryTransport';
import { PeerAction } from 'core/models/network';
import * as TrysteroTransportModule from 'core/transport/TrysteroTransport';

describe('Stage 1 — Chitchatter Core Import & Smoke Test', () => {
  const enc = new EncryptionService();
  let keysA: CryptoKeyPair;
  let keysB: CryptoKeyPair;
  let idA: string;
  let idB: string;

  beforeAll(async () => {
    [keysA, keysB] = await Promise.all([
      enc.generateKeyPair(),
      enc.generateKeyPair(),
    ]);
    [idA, idB] = await Promise.all([
      deriveUserIdFromKey(enc, keysA.publicKey),
      deriveUserIdFromKey(enc, keysB.publicKey),
    ]);
  }, 30_000);

  it('exports TrysteroTransport cleanly in headless environment', () => {
    expect(typeof TrysteroTransportModule.TrysteroTransport).toBe('function');
  });

  it('derives deterministic Chitchatter userId from RSA public key', async () => {
    const derived = await deriveUserIdFromKey(enc, keysA.publicKey);
    expect(derived).toBe(idA);
    expect(derived.length).toBeGreaterThan(16);
  });

  it('connects two headless ChatRoom instances over InMemoryTransport, verifies RSA identity, and delivers messages', async () => {
    const network = createInMemoryNetwork();

    const tA = new InMemoryTransport(network, 'peer-a');
    const tB = new InMemoryTransport(network, 'peer-b');

    const regA = new ChatRoomRegistry();
    const regB = new ChatRoomRegistry();

    const roomA = new ChatRoom({
      roomId: 'stage1-smoke-room',
      userId: idA,
      customUsername: 'Alice Family',
      publicKey: keysA.publicKey,
      privateKey: keysA.privateKey,
      transport: tA,
      adapters: createPlatformAdapters({ uuid: () => crypto.randomUUID() }),
    });
    const roomB = new ChatRoom({
      roomId: 'stage1-smoke-room',
      userId: idB,
      customUsername: 'Bob Family',
      publicKey: keysB.publicKey,
      privateKey: keysB.privateKey,
      transport: tB,
      adapters: createPlatformAdapters({ uuid: () => crypto.randomUUID() }),
    });

    regA.setGroup(roomA);
    regB.setGroup(roomB);

    const receivedByB: string[] = [];
    roomB.on(ChatRoomEvent.MESSAGE_RECEIVED, ({ message }) => {
      if ('text' in message) {
        receivedByB.push(message.text);
      }
    });

    await roomA.join();
    await roomB.join();

    await vi.waitFor(
      () => {
        const peersOnB = roomB.getPeers();
        expect(peersOnB.length).toBe(1);
        expect(peersOnB[0].verificationState).toBe(
          PeerVerificationState.VERIFIED
        );
      },
      { timeout: 8_000 }
    );

    await roomA.sendMessage('Stage 1 Chitchatter core check');

    await vi.waitFor(
      () => {
        expect(receivedByB).toContain('Stage 1 Chitchatter core check');
      },
      { timeout: 5_000 }
    );

    expect(PeerAction.MESSAGE).toBe(0);

    await roomA.leave();
    await roomB.leave();
  }, 15_000);
});
