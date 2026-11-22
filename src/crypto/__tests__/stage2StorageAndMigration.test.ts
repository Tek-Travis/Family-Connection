/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INVITE_ALNUM_CHARS,
  INVITE_SYMBOL_CHARS,
  authorizeReplacementDeviceInSnapshot,
  clearIdentity,
  createDefaultFamilyConfig,
  createNewIdentity,
  decryptE2EE,
  decryptMigrationArchive,
  deriveInviteCommitment,
  deriveInviteRendezvousId,
  encryptE2EE,
  exportMigrationArchive,
  generateSharedInviteCode,
  getSavedIdentity,
  isAuthorizedActiveDevice,
  isAuthorizedModeratorDevice,
  isCredentialRevokedInSnapshots,
  prepareReplacementDeviceCandidate,
  saveIdentity,
  setDevMode,
  signAuthenticatedOnboardingProof,
  signDetachedString,
  signModeratorActionWithDevice,
  signRosterSnapshotWithModeratorDevice,
  upgradeLegacyIdentity,
  validateSharedInviteCode,
  verifyModeratorDeviceAuthority,
  verifyReplacementCandidateRequest,
  verifyRosterSnapshotAuthority,
} from '../cryptoUtils';
import { DB_VERSION, StorageManager } from '../../storage/indexedDB';
import { InMemoryIdbFactory } from '../../storage/__tests__/inMemoryIdb';
import {
  ChatMessage,
  DeviceCredentialRecord,
  FamilyGroupConfig,
  FamilyMember,
  PendingAdoptionRecord,
  PendingDeviceReplacementRequest,
  RosterSnapshot,
  UserIdentity,
} from '../../types';

function createMemoryWebStorage(): Storage {
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
      map.set(k, String(v));
    },
  };
}

function toDeviceCredential(
  identity: UserIdentity,
  authorizedByModId: string,
  authorizedAtEpoch: number,
  status: DeviceCredentialRecord['status'] = 'active'
): DeviceCredentialRecord {
  return {
    deviceKeyId: identity.deviceKeyId!,
    memberId: identity.memberId!,
    boxPublicKey: identity.publicKey,
    deviceSignPublicKey: identity.deviceSignPublicKey!,
    rsaUserId: identity.deviceKeyId!,
    status,
    authorizedByModId,
    authorizedAtEpoch,
    addedAt: 1000,
  };
}

async function makeSignedSnapshot(params: {
  familyId: string;
  founderId: string;
  epoch: number;
  inviteCode: string;
  members: FamilyMember[];
  moderators: string[];
  signerIdentity: UserIdentity;
  revokedKeyIds?: string[];
  devices?: DeviceCredentialRecord[];
  trustState?: RosterSnapshot['trustState'];
  stateHash?: string;
}): Promise<RosterSnapshot> {
  const unsigned: Omit<RosterSnapshot, 'signature'> = {
    familyId: params.familyId,
    founderId: params.founderId,
    epoch: params.epoch,
    prevSnapshotHash: params.epoch === 1 ? 'genesis' : `prev-${params.epoch - 1}`,
    inviteCommitment: await deriveInviteCommitment(params.inviteCode),
    stateHash: params.stateHash || `state-hash-${params.epoch}`,
    members: params.members,
    moderators: params.moderators,
    devices: params.devices || [
      toDeviceCredential(params.signerIdentity, params.founderId, params.epoch),
    ],
    broadcastAllowedIds: [...params.moderators],
    broadcastBlockedIds: [],
    revokedKeyIds: params.revokedKeyIds || [],
    clockVector: { [params.founderId]: params.epoch },
    signerModId: params.signerIdentity.memberId!,
    signerDeviceKeyId: params.signerIdentity.deviceKeyId!,
    trustState: params.trustState ?? 'verified_current',
  };
  return signRosterSnapshotWithModeratorDevice(unsigned, params.signerIdentity);
}

describe('Stage 2 — Invite Format, Moderator-Device Authority, Adoption Validation, Import Protection & IDB v2->v3', () => {
  const originalLocalStorage = globalThis.localStorage;
  const originalSessionStorage = globalThis.sessionStorage;
  let idbHarness: InMemoryIdbFactory;
  let idbFactory: IDBFactory;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createMemoryWebStorage(),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: createMemoryWebStorage(),
      configurable: true,
      writable: true,
    });
    idbHarness = new InMemoryIdbFactory();
    idbFactory = idbHarness.createFactory();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      value: originalSessionStorage,
      configurable: true,
      writable: true,
    });
  });

  it('generates K7#m-Q2v!-R@9t-L4$x invites with CSPRNG unbiased distribution & strict validation', async () => {
    const symbolPositions = new Set<number>();
    let hasUpper = false;
    let hasLower = false;
    let hasDigit = false;

    for (let i = 0; i < 120; i++) {
      const code = generateSharedInviteCode();
      expect(code).toHaveLength(19);
      expect(validateSharedInviteCode(code)).toBe(true);

      const groups = code.split('-');
      expect(groups).toHaveLength(4);
      for (const g of groups) {
        expect(g).toHaveLength(4);
        let symCount = 0;
        let alnumCount = 0;
        for (let idx = 0; idx < 4; idx++) {
          const ch = g[idx];
          expect(ch).not.toBe('-');
          if (INVITE_SYMBOL_CHARS.includes(ch)) {
            symCount++;
            symbolPositions.add(idx);
          } else if (INVITE_ALNUM_CHARS.includes(ch)) {
            alnumCount++;
            if (ch >= 'A' && ch <= 'Z') hasUpper = true;
            if (ch >= 'a' && ch <= 'z') hasLower = true;
            if (ch >= '0' && ch <= '9') hasDigit = true;
          }
        }
        expect(symCount).toBe(1);
        expect(alnumCount).toBe(3);
      }
    }

    expect(symbolPositions.size).toBe(4);
    expect(hasUpper && hasLower && hasDigit).toBe(true);

    expect(validateSharedInviteCode('K7#m-Q2v!-R@9t-L4$x')).toBe(true);
    expect(validateSharedInviteCode('abcd-efgh-ijkl-mnop')).toBe(false);
    expect(validateSharedInviteCode('Ab!!-Cd2@-Ef3#-Gh4$')).toBe(false);
    expect(validateSharedInviteCode('Ab3--Cd4@-Ef5#-Gh6$')).toBe(false);
    expect(validateSharedInviteCode('Ab3~-Cd4@-Ef5#-Gh6$')).toBe(false);

    const rUpper = await deriveInviteRendezvousId('Ab3!-Cd4@-Ef5#-Gh6$');
    const rLower = await deriveInviteRendezvousId('ab3!-cd4@-ef5#-gh6$');
    expect(rUpper).not.toBe(rLower);
    expect(await deriveInviteCommitment('Ab3!-Cd4@-Ef5#-Gh6$')).not.toBe(rUpper);
  });

  it('requires authorized non-revoked moderator-device credentials and rejects revoked devices even when signatures are cryptographically valid', async () => {
    const alice = await createNewIdentity('Alice', 'Miller');
    const modBob = await createNewIdentity('Bob', 'Miller');
    const revokedModDevice = {
      ...(await createNewIdentity('Bob', 'OldPhone')),
      memberId: modBob.memberId,
      identityHash: modBob.identityHash,
      signPublicKey: modBob.signPublicKey,
      signSecretKey: modBob.signSecretKey,
    };
    const memberDave = await createNewIdentity('Dave', 'Miller');

    expect(alice.deviceSignPublicKey).not.toBe(alice.signPublicKey);

    const sealed = encryptE2EE('Family check-in', modBob.publicKey, alice.secretKey);
    expect(decryptE2EE(sealed, alice.publicKey, modBob.secretKey)).toBe('Family check-in');

    const fam = await createDefaultFamilyConfig(alice);
    const aliceMember: FamilyMember = {
      identityHash: alice.identityHash,
      memberId: alice.memberId,
      firstName: 'Alice',
      lastName: 'Miller',
      publicKey: alice.publicKey,
      signPublicKey: alice.signPublicKey,
      inviteCode: fam.inviteCode,
      addedAt: 1000,
      role: 'founder',
      status: 'active',
    };
    const bobMember: FamilyMember = {
      identityHash: modBob.identityHash,
      memberId: modBob.memberId,
      firstName: 'Bob',
      lastName: 'Miller',
      publicKey: modBob.publicKey,
      signPublicKey: modBob.signPublicKey,
      inviteCode: fam.inviteCode,
      addedAt: 1000,
      role: 'moderator',
      status: 'active',
    };
    const daveMember: FamilyMember = {
      identityHash: memberDave.identityHash,
      memberId: memberDave.memberId,
      firstName: 'Dave',
      lastName: 'Miller',
      publicKey: memberDave.publicKey,
      signPublicKey: memberDave.signPublicKey,
      inviteCode: fam.inviteCode,
      addedAt: 1000,
      role: 'member',
      status: 'active',
    };

    const authoritativeSnapshot = await makeSignedSnapshot({
      familyId: fam.familyId,
      founderId: alice.memberId!,
      epoch: 3,
      inviteCode: fam.inviteCode,
      members: [aliceMember, bobMember, daveMember],
      moderators: [alice.memberId!, modBob.memberId!],
      signerIdentity: alice,
      revokedKeyIds: [revokedModDevice.deviceKeyId!],
      devices: [
        toDeviceCredential(alice, alice.memberId!, 1, 'active'),
        toDeviceCredential(modBob, alice.memberId!, 2, 'active'),
        toDeviceCredential(revokedModDevice, alice.memberId!, 1, 'revoked'),
        toDeviceCredential(memberDave, alice.memberId!, 2, 'active'),
      ],
    });

    expect(
      isAuthorizedModeratorDevice(
        authoritativeSnapshot,
        modBob.memberId!,
        modBob.deviceKeyId!
      )
    ).toBe(true);
    const actionPayload = JSON.stringify({ action: 'rotate_invite', epoch: 4 });
    const modSigned = signModeratorActionWithDevice(actionPayload, modBob);
    expect(
      verifyModeratorDeviceAuthority(
        actionPayload,
        modSigned.signature,
        modSigned.signerModId,
        modSigned.signerDeviceKeyId,
        authoritativeSnapshot
      )
    ).toBe(true);

    // Possession of member identity key alone MUST FAIL
    const memberIdentityOnlySig = signDetachedString(
      actionPayload,
      modBob.signSecretKey!
    );
    expect(
      verifyModeratorDeviceAuthority(
        actionPayload,
        memberIdentityOnlySig,
        modBob.memberId!,
        modBob.deviceKeyId!,
        authoritativeSnapshot
      )
    ).toBe(false);

    // Non-moderator active device (Dave) MUST FAIL
    const daveSigned = signModeratorActionWithDevice(actionPayload, memberDave);
    expect(
      verifyModeratorDeviceAuthority(
        actionPayload,
        daveSigned.signature,
        daveSigned.signerModId,
        daveSigned.signerDeviceKeyId,
        authoritativeSnapshot
      )
    ).toBe(false);

    // Revoked device CAN still produce valid signature bytes locally, yet peers reject authority
    const revokedSigned = signModeratorActionWithDevice(
      actionPayload,
      revokedModDevice
    );
    expect(revokedSigned.signature).toBeTruthy();
    expect(
      verifyModeratorDeviceAuthority(
        actionPayload,
        revokedSigned.signature,
        revokedModDevice.memberId!,
        revokedModDevice.deviceKeyId!,
        authoritativeSnapshot
      )
    ).toBe(false);

    const revokedSnapEpoch4 = await makeSignedSnapshot({
      familyId: fam.familyId,
      founderId: alice.memberId!,
      epoch: 4,
      inviteCode: fam.inviteCode,
      members: [aliceMember, bobMember],
      moderators: [alice.memberId!, modBob.memberId!],
      signerIdentity: revokedModDevice,
      devices: authoritativeSnapshot.devices,
    });
    expect(
      verifyRosterSnapshotAuthority(revokedSnapEpoch4, authoritativeSnapshot)
    ).toBe(false);

    // Full replace_device lifecycle + retiring original device without revoking replacement
    const replacementCandidate = await prepareReplacementDeviceCandidate(memberDave, [
      authoritativeSnapshot,
    ]);
    expect(replacementCandidate.pendingReplacementRequest.selfAuthorized).toBe(false);
    // Before moderator authorization, replacement device CANNOT participate normally
    expect(
      isAuthorizedActiveDevice(
        authoritativeSnapshot,
        memberDave.memberId!,
        replacementCandidate.newDeviceKeyId
      )
    ).toBe(false);

    // Active moderator authorizes replacement & retires Dave's original device cleanly
    const postReplaceSnap = authorizeReplacementDeviceInSnapshot({
      currentSnapshot: authoritativeSnapshot,
      moderatorIdentity: modBob,
      request: replacementCandidate.pendingReplacementRequest,
      oldDeviceResolution: 'retire',
      nextStateHash: 'state-hash-4-retired-old',
    });
    expect(
      verifyRosterSnapshotAuthority(postReplaceSnap, authoritativeSnapshot)
    ).toBe(true);
    // Original device is retired (not active, not revoked); replacement device is active & not revoked!
    expect(
      isAuthorizedActiveDevice(
        postReplaceSnap,
        memberDave.memberId!,
        memberDave.deviceKeyId!
      )
    ).toBe(false);
    expect(
      isAuthorizedActiveDevice(
        postReplaceSnap,
        memberDave.memberId!,
        replacementCandidate.newDeviceKeyId
      )
    ).toBe(true);
    expect(
      isCredentialRevokedInSnapshots(
        [postReplaceSnap],
        memberDave.memberId!,
        replacementCandidate.newDeviceKeyId
      )
    ).toBe(false);

    expect(
      isCredentialRevokedInSnapshots(
        [authoritativeSnapshot],
        revokedModDevice.memberId!,
        revokedModDevice.deviceKeyId!
      )
    ).toBe(true);
    await expect(
      prepareReplacementDeviceCandidate(revokedModDevice, [
        authoritativeSnapshot,
      ])
    ).rejects.toThrow('Revoked device or removed member cannot mint');
  });

  it('performs non-destructive v2 -> v3 upgrade on populated IDB preserving legacy records across reload & isolates production localStorage vs dev sessionStorage', async () => {
    expect(DB_VERSION).toBe(3);

    // Production identity persists in localStorage across sessionStorage loss; DevMode stays isolated
    const prodUser = await createNewIdentity('Prod', 'User');
    saveIdentity(prodUser);
    expect(globalThis.localStorage.getItem('fm_user_identity')).toBeTruthy();
    expect(globalThis.sessionStorage.getItem('fm_user_identity')).toBeNull();
    globalThis.sessionStorage.clear();
    expect(getSavedIdentity()?.deviceKeyId).toBe(prodUser.deviceKeyId);

    setDevMode(true);
    const devUser = await createNewIdentity('Dev', 'Isolation');
    saveIdentity(devUser);
    expect(getSavedIdentity()?.deviceKeyId).toBe(devUser.deviceKeyId);
    setDevMode(false);
    expect(getSavedIdentity()?.deviceKeyId).toBe(prodUser.deviceKeyId);
    clearIdentity();

    const legacyContact = {
      identityHash: 'legacy-bob-hash',
      firstName: 'Bob',
      lastName: 'Legacy',
      publicKey: 'legacy-bob-pub',
      inviteCode: 'Ab3!-Cd4@-Ef5#-Gh6$',
      addedAt: 1700000000000,
    };
    const legacyGlobalMsg = {
      id: 'v2-msg-1',
      chatId: 'global',
      senderId: 'legacy-bob-hash',
      senderName: 'Bob Legacy',
      content: 'Pre-existing v2 family message',
      timestamp: 1700000005000,
      status: 'delivered',
    };
    const legacyQueuedMsg = {
      id: 'v2-q-1',
      chatId: 'legacy-bob-hash',
      senderId: 'local-user',
      senderName: 'Local User',
      content: 'Queued v2 outbound DM',
      timestamp: 1700000006000,
      status: 'queued',
    };

    idbHarness.seedDatabase('FamilyMeeting', {
      initialVersion: 2,
      initialStores: {
        messages: {
          keyPath: 'id',
          indexes: { chatId: 'chatId', timestamp: 'timestamp' },
          records: [[legacyGlobalMsg.id, legacyGlobalMsg]],
        },
        contacts: {
          keyPath: 'identityHash',
          indexes: {},
          records: [[legacyContact.identityHash, legacyContact]],
        },
        offlineQueue: {
          keyPath: 'id',
          indexes: { recipientId: 'chatId' },
          records: [[legacyQueuedMsg.id, legacyQueuedMsg]],
        },
        settings: {
          keyPath: null,
          indexes: {},
          records: [['ui_theme', 'theme-earthy-2']],
        },
      },
    });

    const sm1 = new StorageManager({ idbFactory });
    await sm1.init();

    expect(idbHarness.deletedStores).toEqual([]);
    expect(idbHarness.clearedStoresDuringUpgrade).toEqual([]);
    expect((await sm1.getMessages('global'))[0].content).toBe(
      'Pre-existing v2 family message'
    );
    expect((await sm1.getContacts())[0]).toMatchObject({
      identityHash: 'legacy-bob-hash',
      role: 'member',
      status: 'active',
    });
    expect((await sm1.getOfflineMessages('legacy-bob-hash'))[0].id).toBe('v2-q-1');
    expect(await sm1.getSetting<string>('ui_theme')).toBe('theme-earthy-2');

    const legacyIdentity: UserIdentity = {
      identityHash: 'legacy-local-hash',
      firstName: 'Clara',
      lastName: 'Miller',
      publicKey: 'old-pub-b64',
      secretKey: 'old-sec-b64',
      inviteCode: 'K7#m-Q2v!-R@9t-L4$x',
      created: 1700000000000,
    };
    const upgradedId = await upgradeLegacyIdentity(legacyIdentity);
    expect(upgradedId.identityHash).toBe('legacy-local-hash');
    expect(upgradedId.memberId).toBe('legacy-local-hash');
    expect(upgradedId.deviceKeyId).toBeTruthy();

    const fam = await createDefaultFamilyConfig(upgradedId);
    await sm1.saveFamilyConfig(fam);
    await sm1.markNonceSeen(fam.familyId, 'nonce-abc');

    const smReloaded = new StorageManager({ idbFactory });
    await smReloaded.init();
    expect((await smReloaded.getMessages('global'))[0].id).toBe('v2-msg-1');
    expect((await smReloaded.getContacts())[0].identityHash).toBe('legacy-bob-hash');
    expect((await smReloaded.getActiveFamilyConfig())?.familyId).toBe(fam.familyId);
    expect(await smReloaded.hasSeenNonce(fam.familyId, 'nonce-abc')).toBe(true);
    expect(await smReloaded.getSetting<string>('ui_theme')).toBe('theme-earthy-2');
  });

  it('enforces the trust-promotion boundary on pendingAdoptions, rejecting unauthenticated, stale, wrong-family, revoked, and malformed records while preserving active family', async () => {
    const beth = await createNewIdentity('Beth', 'Miller');
    const defaultFam = await createDefaultFamilyConfig(beth);
    const alice = await createNewIdentity('Alice', 'Miller');
    const joinedFam: FamilyGroupConfig = {
      ...(await createDefaultFamilyConfig(alice)),
      isUnusedDefault: false,
      authorityState: 'verified_current',
      epoch: 3,
      joinedAtEpoch: 3,
    };

    const contactA: FamilyMember = {
      identityHash: alice.identityHash,
      memberId: alice.memberId,
      firstName: alice.firstName,
      lastName: alice.lastName,
      publicKey: alice.publicKey,
      signPublicKey: alice.signPublicKey,
      inviteCode: joinedFam.inviteCode,
      addedAt: Date.now(),
      role: 'founder',
      status: 'active',
      joinedAtEpoch: 1,
    };
    const contactB: FamilyMember = {
      identityHash: beth.identityHash,
      memberId: beth.memberId,
      firstName: beth.firstName,
      lastName: beth.lastName,
      publicKey: beth.publicKey,
      signPublicKey: beth.signPublicKey,
      inviteCode: joinedFam.inviteCode,
      addedAt: Date.now(),
      role: 'member',
      status: 'active',
      joinedAtEpoch: 3,
    };
    const snapshot = await makeSignedSnapshot({
      familyId: joinedFam.familyId,
      founderId: alice.memberId!,
      epoch: 3,
      inviteCode: joinedFam.inviteCode,
      members: [contactA, contactB],
      moderators: [alice.memberId!],
      signerIdentity: alice,
      devices: [
        toDeviceCredential(alice, alice.memberId!, 1, 'active'),
        toDeviceCredential(beth, alice.memberId!, 3, 'active'),
      ],
    });
    const validAuthProof = signAuthenticatedOnboardingProof(
      {
        familyId: joinedFam.familyId,
        epoch: 3,
        admittedMemberId: beth.memberId!,
        admittedDeviceKeyId: beth.deviceKeyId!,
        authorizingModId: alice.memberId!,
        authorizingDeviceKeyId: alice.deviceKeyId!,
        permanentRoomId: joinedFam.familyRoomId,
        challengeNonce: 'nonce-chal-3',
        authenticatedAt: Date.now(),
      },
      alice
    );
    const sevenMessages: ChatMessage[] = Array.from({ length: 7 }, (_, i) => ({
      id: `msg-${i + 1}`,
      chatId: 'global',
      senderId: alice.identityHash,
      senderName: 'Alice Miller',
      content: `Line ${i + 1}`,
      timestamp: 2000 + i,
      lamportClock: i + 1,
      status: 'delivered',
    }));

    const sm1 = new StorageManager({ idbFactory });
    await sm1.saveFamilyConfig(defaultFam);
    await sm1.setHighestVerifiedEpoch(defaultFam.familyId, 1);

    const baseValidRecord: PendingAdoptionRecord = {
      adoptionId: `adopt:${defaultFam.familyId}->${joinedFam.familyId}`,
      oldFamilyId: defaultFam.familyId,
      inviteCode: joinedFam.inviteCode,
      newFamilyConfig: joinedFam,
      initialSnapshot: snapshot,
      initialContacts: [contactA, contactB],
      onboardingMessages: sevenMessages,
      status: 'authenticated',
      permanentAuthProof: validAuthProof,
      createdAt: Date.now(),
    };

    // 1. Unauthenticated pending_permanent_auth MUST be rejected
    await sm1.savePendingAdoption({
      ...baseValidRecord,
      adoptionId: 'adopt:unauth',
      status: 'pending_permanent_auth',
      permanentAuthProof: undefined,
    });
    await expect(sm1.finalizePendingAdoption('adopt:unauth')).rejects.toThrow(
      /has not completed permanent-session authentication/
    );
    expect((await sm1.getActiveFamilyConfig())?.familyId).toBe(defaultFam.familyId);

    // 2. Wrong-family snapshot mismatch MUST be rejected
    await sm1.savePendingAdoption({
      ...baseValidRecord,
      adoptionId: 'adopt:wrong-family',
      initialSnapshot: { ...snapshot, familyId: 'wrong-family-id' },
    });
    await expect(sm1.finalizePendingAdoption('adopt:wrong-family')).rejects.toThrow(
      /Wrong-family or epoch-mismatched/
    );

    // 3. Malformed / tampered signature MUST be rejected
    await sm1.savePendingAdoption({
      ...baseValidRecord,
      adoptionId: 'adopt:tampered-sig',
      permanentAuthProof: { ...validAuthProof, challengeNonce: 'tampered-nonce' },
    });
    await expect(sm1.finalizePendingAdoption('adopt:tampered-sig')).rejects.toThrow(
      /lacks valid authorized moderator-device signature/
    );

    // 4. Revoked member/device MUST be rejected
    await sm1.savePendingAdoption({
      ...baseValidRecord,
      adoptionId: 'adopt:revoked-admitted',
      initialSnapshot: { ...snapshot, revokedKeyIds: [beth.deviceKeyId!] },
    });
    await expect(sm1.finalizePendingAdoption('adopt:revoked-admitted')).rejects.toThrow(
      /not active and non-revoked/
    );

    // 5. Stale epoch MUST be rejected (simulate local already having epoch 5 for joinedFam)
    await sm1.setHighestVerifiedEpoch(joinedFam.familyId, 5);
    await sm1.savePendingAdoption({
      ...baseValidRecord,
      adoptionId: 'adopt:stale-epoch',
    });
    await expect(sm1.finalizePendingAdoption('adopt:stale-epoch')).rejects.toThrow(
      /Rejected stale adoption promotion/
    );
    // Reset test epoch back to 0 to test valid authenticated storage-promotion path
    await sm1.setSetting(`highest_epoch:${joinedFam.familyId}`, 0);

    // Active default family MUST STILL be preserved untouched after all rejections!
    expect((await sm1.getActiveFamilyConfig())?.familyId).toBe(defaultFam.familyId);

    // 6. Valid authenticated adoption record stages, persists across reload, aborts cleanly, and promotes atomically
    await sm1.savePendingAdoption(baseValidRecord);
    const smReload1 = new StorageManager({ idbFactory });
    expect((await smReload1.getActiveFamilyConfig())?.familyId).toBe(defaultFam.familyId);

    await smReload1.savePendingAdoption({ ...baseValidRecord, adoptionId: 'adopt:temp-abort' });
    await smReload1.abortPendingAdoption('adopt:temp-abort');
    expect(await smReload1.getPendingAdoption('adopt:temp-abort')).toBeNull();

    const txBefore = idbHarness.completedTransactions;
    await smReload1.finalizePendingAdoption(baseValidRecord.adoptionId, {
      expectedMemberId: beth.memberId,
      expectedDeviceKeyId: beth.deviceKeyId,
    });
    expect(idbHarness.completedTransactions).toBeGreaterThan(txBefore);

    const smReload2 = new StorageManager({ idbFactory });
    expect((await smReload2.getActiveFamilyConfig())?.familyId).toBe(joinedFam.familyId);
    expect((await smReload2.getActiveFamilyConfig())?.authorityState).toBe('verified_current');
    expect(await smReload2.hasValidatedFamilyAuthority(joinedFam.familyId)).toBe(true);
    expect(await smReload2.getHighestVerifiedEpoch(joinedFam.familyId)).toBe(3);

    const persistedMsgs = await smReload2.getMessages('global');
    expect(persistedMsgs.map((m) => m.id)).toEqual([
      'msg-3',
      'msg-4',
      'msg-5',
      'msg-6',
      'msg-7',
    ]);
    expect(persistedMsgs.every((m) => m.isOnboardingContext === true)).toBe(true);
  });

  it('rejects malformed, weak, tampered, wrong-passphrase, and tx.abort()-interrupted imports with zero partial corruption across reload', async () => {
    const oldIdentity = await createNewIdentity('Clara', 'Miller');
    const oldFam: FamilyGroupConfig = {
      ...(await createDefaultFamilyConfig(oldIdentity)),
      isUnusedDefault: false,
      authorityState: 'verified_current',
      epoch: 4,
    };
    const peerBob = await createNewIdentity('Bob', 'Miller');

    const sourceSm = new StorageManager({ idbFactory: new InMemoryIdbFactory().createFactory() });
    await sourceSm.saveFamilyConfig(oldFam);
    await sourceSm.setHighestVerifiedEpoch(oldFam.familyId, 4);
    await sourceSm.saveContact({
      identityHash: peerBob.identityHash,
      memberId: peerBob.memberId,
      firstName: 'Bob',
      lastName: 'Miller',
      publicKey: peerBob.publicKey,
      inviteCode: oldFam.inviteCode,
      addedAt: 1000,
      role: 'moderator',
    });
    await sourceSm.addMessage('global', {
      id: 'm-export-1',
      chatId: 'global',
      senderId: peerBob.identityHash,
      senderName: 'Bob Miller',
      content: 'Protected chat line',
      timestamp: 2000,
      lamportClock: 5,
      status: 'delivered',
    });
    await sourceSm.enqueueOfflineMessage({
      id: 'q-export-1',
      chatId: peerBob.identityHash,
      senderId: oldIdentity.identityHash,
      senderName: 'Clara Miller',
      content: 'Pending offline note',
      timestamp: 2500,
      status: 'queued',
    });

    const archiveJson = await sourceSm.exportMigrationBundle('StrongPass!99', oldIdentity);
    expect(archiveJson).not.toContain('Protected chat line');
    expect(archiveJson).not.toContain(oldIdentity.secretKey);
    expect(archiveJson).not.toContain(oldFam.groupSecretKey);

    const targetSm = new StorageManager({ idbFactory });
    const existingLocalIdentity = await createNewIdentity('Target', 'Phone');
    const existingFam = await createDefaultFamilyConfig(existingLocalIdentity);
    await targetSm.saveFamilyConfig(existingFam);
    await targetSm.addMessage('global', {
      id: 'target-existing-msg',
      chatId: 'global',
      senderId: 'local',
      senderName: 'Target',
      content: 'Must remain untouched',
      timestamp: 100,
      status: 'delivered',
    });

    await expect(
      targetSm.importMigrationBundle('StrongPass!99', '{corrupt-json')
    ).rejects.toThrow('Invalid migration archive JSON');

    const truncated = archiveJson.slice(0, Math.floor(archiveJson.length / 2));
    await expect(
      targetSm.importMigrationBundle('StrongPass!99', truncated)
    ).rejects.toThrow('Invalid migration archive JSON');

    const weakArchive = JSON.parse(archiveJson);
    weakArchive.iterations = 1000;
    await expect(
      targetSm.importMigrationBundle('StrongPass!99', JSON.stringify(weakArchive))
    ).rejects.toThrow('Unsupported or malformed migration archive envelope');

    await expect(
      targetSm.importMigrationBundle('WrongPass123', archiveJson)
    ).rejects.toThrow('Invalid passphrase or tampered migration backup');

    const tampered = JSON.parse(archiveJson);
    tampered.ciphertextB64 = 'AAAA' + tampered.ciphertextB64.slice(4);
    await expect(
      decryptMigrationArchive('StrongPass!99', JSON.stringify(tampered))
    ).rejects.toThrow('Invalid passphrase or tampered migration backup');

    idbHarness.forceAbortOnStore = 'offlineQueue';
    await expect(
      targetSm.importMigrationBundle('StrongPass!99', archiveJson, 'replace_device')
    ).rejects.toThrow(/Forced tx\.abort\(\)|aborted/i);
    expect(idbHarness.abortedTransactions).toBe(1);
    idbHarness.forceAbortOnStore = null;

    const targetAfterFailure = new StorageManager({ idbFactory });
    expect((await targetAfterFailure.getActiveFamilyConfig())?.familyId).toBe(
      existingFam.familyId
    );
    expect((await targetAfterFailure.getMessages('global')).map((m) => m.id)).toEqual([
      'target-existing-msg',
    ]);
    expect(await targetAfterFailure.getContacts()).toEqual([]);
    expect(await targetAfterFailure.getSetting('pending_device_replacement_request')).toBeNull();
  });

  it('protects existing verified authority across lower, equal-identical, equal-conflicting, and unvalidated-higher imports while blocking cross-family merges', async () => {
    const clara = await createNewIdentity('Clara', 'Miller');
    const modBob = await createNewIdentity('Bob', 'Miller');
    const charlie = await createNewIdentity('Charlie', 'Miller');

    const fam = {
      ...(await createDefaultFamilyConfig(clara)),
      isUnusedDefault: false,
      authorityState: 'verified_current' as const,
      epoch: 7,
    };

    const claraMember: FamilyMember = {
      identityHash: clara.identityHash,
      memberId: clara.memberId,
      firstName: 'Clara',
      lastName: 'Miller',
      publicKey: clara.publicKey,
      signPublicKey: clara.signPublicKey,
      inviteCode: fam.inviteCode,
      addedAt: 1000,
      role: 'founder',
      status: 'active',
    };
    const bobMember: FamilyMember = {
      identityHash: modBob.identityHash,
      memberId: modBob.memberId,
      firstName: 'Bob',
      lastName: 'Miller',
      publicKey: modBob.publicKey,
      signPublicKey: modBob.signPublicKey,
      inviteCode: fam.inviteCode,
      addedAt: 1000,
      role: 'moderator',
      status: 'active',
    };
    const charlieMember: FamilyMember = {
      identityHash: charlie.identityHash,
      memberId: charlie.memberId,
      firstName: 'Charlie',
      lastName: 'Miller',
      publicKey: charlie.publicKey,
      signPublicKey: charlie.signPublicKey,
      inviteCode: fam.inviteCode,
      addedAt: 1000,
      role: 'member',
      status: 'active',
    };

    const snapEpoch4 = await makeSignedSnapshot({
      familyId: fam.familyId,
      founderId: clara.memberId!,
      epoch: 4,
      inviteCode: fam.inviteCode,
      members: [claraMember, bobMember, charlieMember],
      moderators: [clara.memberId!],
      signerIdentity: clara,
      devices: [
        toDeviceCredential(clara, clara.memberId!, 1, 'active'),
        toDeviceCredential(modBob, clara.memberId!, 2, 'active'),
        toDeviceCredential(charlie, clara.memberId!, 3, 'active'),
      ],
    });
    const snapEpoch7Canonical = await makeSignedSnapshot({
      familyId: fam.familyId,
      founderId: clara.memberId!,
      epoch: 7,
      inviteCode: fam.inviteCode,
      members: [claraMember, bobMember, { ...charlieMember, status: 'removed' }],
      moderators: [clara.memberId!, modBob.memberId!],
      signerIdentity: clara,
      revokedKeyIds: [charlie.memberId!, charlie.deviceKeyId!],
      devices: [
        toDeviceCredential(clara, clara.memberId!, 1, 'active'),
        toDeviceCredential(modBob, clara.memberId!, 2, 'active'),
        toDeviceCredential(charlie, clara.memberId!, 3, 'revoked'),
      ],
      stateHash: 'state-hash-7-canonical',
    });

    const olderBackupEpoch4 = await exportMigrationArchive('BackupSecret!42', {
      version: 1,
      exportedAt: Date.now(),
      identity: clara,
      familyConfig: { ...fam, epoch: 4 },
      highestVerifiedEpoch: 4,
      rosterSnapshots: [snapEpoch4],
      contacts: [bobMember, charlieMember],
      messages: [
        {
          id: 'old-backup-msg',
          chatId: 'global',
          senderId: modBob.identityHash,
          senderName: 'Bob Miller',
          content: 'Archived family message',
          timestamp: 5000,
          lamportClock: 9,
          status: 'delivered',
        },
        {
          id: 'unrelated-dm-msg',
          chatId: 'external-unrelated-peer-id',
          senderId: 'external-unrelated-peer-id',
          senderName: 'External',
          content: 'Should not leak across conversations',
          timestamp: 5100,
          status: 'delivered',
        },
      ],
      offlineQueue: [],
      migrationCheckpoints: [],
    });

    // Case 1: Fresh phone (no local same-family state, even with an unused_default config present)
    // quarantines imported authority as historical_unvalidated & filters out unknown external DMs
    const freshHarness = new InMemoryIdbFactory();
    const freshSm = new StorageManager({ idbFactory: freshHarness.createFactory() });
    await freshSm.saveFamilyConfig(await createDefaultFamilyConfig(modBob));

    const freshRes = await freshSm.importMigrationBundle(
      'BackupSecret!42',
      olderBackupEpoch4,
      'replace_device'
    );
    expect(freshRes.comparedEpochScope).toBe('no_local_same_family');
    expect(freshRes.authorityStatus).toBe('historical_unvalidated');
    expect(freshRes.importedContacts).toBe(0);
    expect(freshRes.importedMessages).toBe(1); // Only 'global', external unrelated DM filtered out!
    expect(freshRes.pendingReplacementRequest?.selfAuthorized).toBe(false);

    const reloadedFresh = new StorageManager({ idbFactory: freshHarness.createFactory() });
    expect((await reloadedFresh.getActiveFamilyConfig())?.authorityState).toBe(
      'historical_unverified'
    );
    expect(await reloadedFresh.hasValidatedFamilyAuthority(fam.familyId)).toBe(false);
    expect(await reloadedFresh.getHighestVerifiedEpoch(fam.familyId)).toBe(0);
    expect(await reloadedFresh.getContacts()).toEqual([]);

    // Case 2: Unrelated active non-default family MUST refuse cross-family backup merge
    const otherActiveHarness = new InMemoryIdbFactory();
    const otherSm = new StorageManager({ idbFactory: otherActiveHarness.createFactory() });
    const otherActiveFam: FamilyGroupConfig = {
      ...(await createDefaultFamilyConfig(modBob)),
      isUnusedDefault: false,
      authorityState: 'verified_current',
      epoch: 20,
    };
    await otherSm.saveFamilyConfig(otherActiveFam);
    await expect(
      otherSm.importMigrationBundle('BackupSecret!42', olderBackupEpoch4, 'replace_device')
    ).rejects.toThrow('Cannot merge backup across unrelated active family');

    // Case 3: Local holds verified_current epoch 7 -> protect against lower, equal-identical,
    // equal-conflicting, and higher unvalidated backups
    const smVerified = new StorageManager({ idbFactory });
    await smVerified.saveFamilyConfig(fam);
    await smVerified.setHighestVerifiedEpoch(fam.familyId, 7);
    await smVerified.saveRosterSnapshot(snapEpoch7Canonical);
    await smVerified.saveContact(bobMember);

    // 3a. Lower epoch (4 < 7)
    const lowerRes = await smVerified.importMigrationBundle(
      'BackupSecret!42',
      olderBackupEpoch4,
      'replace_device'
    );
    expect(lowerRes.authorityStatus).toBe('preserved_higher_local');
    expect(lowerRes.preservedHigherLocalEpoch).toBe(7);
    expect(await smVerified.hasValidatedFamilyAuthority(fam.familyId)).toBe(true);

    // 3b. Equal epoch with IDENTICAL snapshot (7 === 7, matching stateHash/signature)
    const equalIdenticalArchive = await exportMigrationArchive('BackupSecret!42', {
      version: 1,
      exportedAt: Date.now(),
      identity: clara,
      familyConfig: fam,
      highestVerifiedEpoch: 7,
      rosterSnapshots: [snapEpoch7Canonical],
      contacts: [bobMember],
      messages: [],
      offlineQueue: [],
      migrationCheckpoints: [],
    });
    const equalIdenticalRes = await smVerified.importMigrationBundle(
      'BackupSecret!42',
      equalIdenticalArchive,
      'replace_device'
    );
    expect(equalIdenticalRes.authorityStatus).toBe('preserved_equal_local');
    expect(await smVerified.hasValidatedFamilyAuthority(fam.familyId)).toBe(true);
    expect((await smVerified.getActiveFamilyConfig())?.authorityState).toBe('verified_current');

    // 3c. Equal epoch with CONFLICTING snapshot (7 === 7, tampered moderators/stateHash)
    const conflictingSnap7 = await makeSignedSnapshot({
      familyId: fam.familyId,
      founderId: clara.memberId!,
      epoch: 7,
      inviteCode: fam.inviteCode,
      members: [claraMember],
      moderators: [clara.memberId!], // Dropped modBob!
      signerIdentity: clara,
      stateHash: 'conflicting-hash-7',
    });
    const equalConflictingArchive = await exportMigrationArchive('BackupSecret!42', {
      version: 1,
      exportedAt: Date.now(),
      identity: clara,
      familyConfig: fam,
      highestVerifiedEpoch: 7,
      rosterSnapshots: [conflictingSnap7],
      contacts: [claraMember],
      messages: [],
      offlineQueue: [],
      migrationCheckpoints: [],
    });
    const conflictRes = await smVerified.importMigrationBundle(
      'BackupSecret!42',
      equalConflictingArchive,
      'replace_device'
    );
    expect(conflictRes.authorityStatus).toBe('quarantined_conflict_or_unvalidated_higher');
    expect(conflictRes.quarantinedSnapshotCount).toBe(1);
    expect((await smVerified.getLatestRosterSnapshot(fam.familyId))?.stateHash).toBe(
      'state-hash-7-canonical'
    );
    expect((await smVerified.getQuarantinedImportConflicts(fam.familyId))[0].stateHash).toBe(
      'conflicting-hash-7'
    );

    // 3d. Higher claimed epoch (12 > 7) WITHOUT validated authority chain anchored from local trusted state
    const unvalidatedHigherSnap = await makeSignedSnapshot({
      familyId: fam.familyId,
      founderId: clara.memberId!,
      epoch: 12,
      inviteCode: fam.inviteCode,
      members: [claraMember],
      moderators: [clara.memberId!],
      signerIdentity: await createNewIdentity('Forged', 'Mod'), // Not an active mod in local epoch 7!
      stateHash: 'forged-hash-12',
    });
    const unvalidatedHigherArchive = await exportMigrationArchive('BackupSecret!42', {
      version: 1,
      exportedAt: Date.now(),
      identity: clara,
      familyConfig: { ...fam, epoch: 12 },
      highestVerifiedEpoch: 12,
      rosterSnapshots: [unvalidatedHigherSnap],
      contacts: [],
      messages: [],
      offlineQueue: [],
      migrationCheckpoints: [],
    });
    const higherUnvalidatedRes = await smVerified.importMigrationBundle(
      'BackupSecret!42',
      unvalidatedHigherArchive,
      'replace_device'
    );
    expect(higherUnvalidatedRes.authorityStatus).toBe(
      'quarantined_conflict_or_unvalidated_higher'
    );
    expect(await smVerified.getHighestVerifiedEpoch(fam.familyId)).toBe(7);
    expect((await smVerified.getActiveFamilyConfig())?.epoch).toBe(7);
    expect((await smVerified.getContacts()).map((c) => c.memberId)).toEqual([modBob.memberId]);

    // Case 4: Revoked archived credential is rejected cleanly
    const charlieBackup = await exportMigrationArchive('CharliePass!99', {
      version: 1,
      exportedAt: Date.now(),
      identity: charlie,
      familyConfig: { ...fam, epoch: 4 },
      highestVerifiedEpoch: 4,
      rosterSnapshots: [snapEpoch4],
      contacts: [claraMember],
      messages: [],
      offlineQueue: [],
      migrationCheckpoints: [],
    });
    await expect(
      smVerified.importMigrationBundle('CharliePass!99', charlieBackup, 'replace_device')
    ).rejects.toThrow('archived member or device is revoked');
  });
});
