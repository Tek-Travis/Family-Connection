/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import nacl from 'tweetnacl';
import { EncryptionService } from 'core/crypto/Encryption';
import {
  AuthenticatedOnboardingProof,
  DeviceCredentialRecord,
  DeviceMigrationPayload,
  EncryptedMigrationArchive,
  FamilyGroupConfig,
  PendingAdoptionRecord,
  PendingDeviceReplacementRequest,
  RosterSnapshot,
  UserIdentity,
} from '../types.ts';

// Shared invitation code alphabets:
// - 4 groups of 4 separated by 3 dashes ('-')
// - '-' is excluded from meaningful code characters and reserved solely for dashes
// - Each group has 3 case-sensitive alphanumeric chars + 1 approved symbol at a CSPRNG position
export const INVITE_ALNUM_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const INVITE_SYMBOL_CHARS = '!@#$%^&*+?';

const PBKDF2_ITERATIONS = 310_000;
const UINT32_RANGE = 2 ** 32;

// Helper utilities for Uint8Array <-> Base64
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function stringToUint8Array(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function uint8ArrayToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Unbiased CSPRNG integer in [0, exclusiveMax) using rejection sampling.
 */
export function secureRandomInt(exclusiveMax: number): number {
  if (!Number.isInteger(exclusiveMax) || exclusiveMax <= 0) {
    throw new Error('exclusiveMax must be a positive integer');
  }
  const unbiasedLimit = UINT32_RANGE - (UINT32_RANGE % exclusiveMax);
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= unbiasedLimit);
  return value % exclusiveMax;
}

/**
 * Computes SHA-256 hash formatted as lowercase hex string.
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const buffer = typeof input === 'string' ? stringToUint8Array(input) : input;
  const digest = await crypto.subtle.digest(
    'SHA-256',
    buffer as unknown as BufferSource
  );
  const hashArray = Array.from(new Uint8Array(digest));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generates an exact shared family invitation code in the format:
 *   XXXX-XXXX-XXXX-XXXX
 * where each 4-character block has 3 case-sensitive alphanumeric chars
 * and 1 approved symbol ('-' excluded) placed at a CSPRNG position.
 */
export function generateSharedInviteCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < 4; g++) {
    const chars = [
      INVITE_ALNUM_CHARS[secureRandomInt(INVITE_ALNUM_CHARS.length)],
      INVITE_ALNUM_CHARS[secureRandomInt(INVITE_ALNUM_CHARS.length)],
      INVITE_ALNUM_CHARS[secureRandomInt(INVITE_ALNUM_CHARS.length)],
      INVITE_SYMBOL_CHARS[secureRandomInt(INVITE_SYMBOL_CHARS.length)],
    ];
    for (let i = chars.length - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      const tmp = chars[i];
      chars[i] = chars[j];
      chars[j] = tmp;
    }
    groups.push(chars.join(''));
  }
  return groups.join('-');
}

/**
 * Strict case-sensitive validator for XXXX-XXXX-XXXX-XXXX shared family invite codes.
 */
export function validateSharedInviteCode(rawCode: string): boolean {
  if (typeof rawCode !== 'string') return false;
  const trimmed = rawCode.trim();
  const groups = trimmed.split('-');
  if (groups.length !== 4) return false;

  for (const group of groups) {
    if (group.length !== 4) return false;
    let alnumCount = 0;
    let symbolCount = 0;
    for (const ch of group) {
      if (ch === '-') return false;
      if (INVITE_ALNUM_CHARS.includes(ch)) {
        alnumCount++;
      } else if (INVITE_SYMBOL_CHARS.includes(ch)) {
        symbolCount++;
      } else {
        return false;
      }
    }
    if (alnumCount !== 3 || symbolCount !== 1) return false;
  }
  return true;
}

/**
 * Derives a deterministic, one-way rendezvous identifier from an invitation code.
 * Note: SHA-256 is one-way hashing for room discovery only, not encryption.
 */
export async function deriveInviteRendezvousId(
  inviteCode: string
): Promise<string> {
  if (!validateSharedInviteCode(inviteCode)) {
    throw new Error('Invalid shared invitation code format');
  }
  return sha256Hex(`fc:invite:rendezvous:v1:${inviteCode.trim()}`);
}

/**
 * Derives an invitation commitment stored inside signed RosterSnapshots.
 */
export async function deriveInviteCommitment(
  inviteCode: string
): Promise<string> {
  if (!validateSharedInviteCode(inviteCode)) {
    throw new Error('Invalid shared invitation code format');
  }
  return sha256Hex(`fc:invite:commitment:v1:${inviteCode.trim()}`);
}

/**
 * Backward-compatible helper name preserved for existing UI callers.
 */
export async function generateInviteCode(
  _appId?: string,
  _firstName?: string,
  _lastName?: string
): Promise<string> {
  return generateSharedInviteCode();
}

export interface EncryptedPayload {
  nonce: string; // Base64 24 bytes
  ciphertext: string; // Base64
}

/**
 * TweetNaCl box end-to-end encryption using Curve25519 DH + XSalsa20-Poly1305.
 */
export function encryptE2EE(
  plainText: string,
  recipientPublicKeyBase64: string,
  senderSecretKeyBase64: string
): EncryptedPayload {
  const recipientPubKey = base64ToUint8Array(recipientPublicKeyBase64);
  const senderSecKey = base64ToUint8Array(senderSecretKeyBase64);
  const nonce = nacl.randomBytes(24);
  const messageBytes = stringToUint8Array(plainText);

  const ciphertext = nacl.box(
    messageBytes,
    nonce,
    recipientPubKey,
    senderSecKey
  );
  if (!ciphertext) {
    throw new Error('Encryption failed');
  }

  return {
    nonce: uint8ArrayToBase64(nonce),
    ciphertext: uint8ArrayToBase64(ciphertext),
  };
}

/**
 * TweetNaCl box decryption.
 */
export function decryptE2EE(
  encrypted: EncryptedPayload,
  senderPublicKeyBase64: string,
  recipientSecretKeyBase64: string
): string | null {
  try {
    const senderPubKey = base64ToUint8Array(senderPublicKeyBase64);
    const recipientSecKey = base64ToUint8Array(recipientSecretKeyBase64);
    const nonce = base64ToUint8Array(encrypted.nonce);
    const ciphertext = base64ToUint8Array(encrypted.ciphertext);

    const decryptedBytes = nacl.box.open(
      ciphertext,
      nonce,
      senderPubKey,
      recipientSecKey
    );
    if (!decryptedBytes) {
      return null;
    }
    return uint8ArrayToString(decryptedBytes);
  } catch {
    return null;
  }
}

/**
 * Ed25519 detached signatures for persistent member authority and session binding.
 */
export function signDetachedString(
  payload: string,
  signSecretKeyBase64: string
): string {
  const secretKey = base64ToUint8Array(signSecretKeyBase64);
  const sig = nacl.sign.detached(stringToUint8Array(payload), secretKey);
  return uint8ArrayToBase64(sig);
}

export function verifyDetachedString(
  payload: string,
  signatureBase64: string,
  signPublicKeyBase64: string
): boolean {
  try {
    const pubKey = base64ToUint8Array(signPublicKeyBase64);
    const sig = base64ToUint8Array(signatureBase64);
    return nacl.sign.detached.verify(
      stringToUint8Array(payload),
      sig,
      pubKey
    );
  } catch {
    return false;
  }
}

const chitchatterEncryption = new EncryptionService();

async function exportRsaDeviceKeyStrings(): Promise<{
  rsaPublicKeySpki: string;
  rsaPrivateKeyPkcs8: string;
}> {
  const pair = await chitchatterEncryption.generateKeyPair();
  const [rsaPublicKeySpki, rsaPrivateKeyPkcs8] = await Promise.all([
    chitchatterEncryption.stringifyCryptoKey(pair.publicKey),
    chitchatterEncryption.stringifyCryptoKey(pair.privateKey),
  ]);
  return { rsaPublicKeySpki, rsaPrivateKeyPkcs8 };
}

async function computeDeviceKeyId(
  boxPublicKey: string,
  rsaPublicKeySpki: string,
  deviceSignPublicKey: string
): Promise<string> {
  return sha256Hex(
    `fc:device:v1:${boxPublicKey}:${rsaPublicKeySpki}:${deviceSignPublicKey}`
  );
}

/**
 * Creates a persistent human identity + separated per-device credentials
 * (member Ed25519 + per-device Ed25519 + Curve25519 + Chitchatter RSA).
 */
export async function createNewIdentity(
  firstName: string,
  lastName: string,
  _appId: string = 'family_connection',
  avatarDataUrl?: string
): Promise<UserIdentity> {
  const boxKeyPair = nacl.box.keyPair();
  const memberSignKeyPair = nacl.sign.keyPair();
  const deviceSignKeyPair = nacl.sign.keyPair();
  const { rsaPublicKeySpki, rsaPrivateKeyPkcs8 } =
    await exportRsaDeviceKeyStrings();

  const publicKeyBase64 = uint8ArrayToBase64(boxKeyPair.publicKey);
  const secretKeyBase64 = uint8ArrayToBase64(boxKeyPair.secretKey);
  const signPublicKeyBase64 = uint8ArrayToBase64(memberSignKeyPair.publicKey);
  const signSecretKeyBase64 = uint8ArrayToBase64(memberSignKeyPair.secretKey);
  const deviceSignPublicKeyBase64 = uint8ArrayToBase64(
    deviceSignKeyPair.publicKey
  );
  const deviceSignSecretKeyBase64 = uint8ArrayToBase64(
    deviceSignKeyPair.secretKey
  );

  const memberId = await sha256Hex(`fc:member:v1:${signPublicKeyBase64}`);
  const deviceKeyId = await computeDeviceKeyId(
    publicKeyBase64,
    rsaPublicKeySpki,
    deviceSignPublicKeyBase64
  );
  const inviteCode = generateSharedInviteCode();

  return {
    identityHash: memberId,
    memberId,
    deviceKeyId,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    publicKey: publicKeyBase64,
    secretKey: secretKeyBase64,
    signPublicKey: signPublicKeyBase64,
    signSecretKey: signSecretKeyBase64,
    deviceSignPublicKey: deviceSignPublicKeyBase64,
    deviceSignSecretKey: deviceSignSecretKeyBase64,
    rsaPublicKeySpki,
    rsaPrivateKeyPkcs8,
    avatarDataUrl,
    inviteCode,
    created: Date.now(),
  };
}

/**
 * Upgrades any legacy v1/v2 identity loaded from localStorage/archive cleanly
 * without breaking legacy identityHash.
 */
export async function upgradeLegacyIdentity(
  identity: UserIdentity
): Promise<UserIdentity> {
  let signPublicKey = identity.signPublicKey;
  let signSecretKey = identity.signSecretKey;
  if (!signPublicKey || !signSecretKey) {
    const memberSign = nacl.sign.keyPair();
    signPublicKey = uint8ArrayToBase64(memberSign.publicKey);
    signSecretKey = uint8ArrayToBase64(memberSign.secretKey);
  }

  let deviceSignPublicKey = identity.deviceSignPublicKey;
  let deviceSignSecretKey = identity.deviceSignSecretKey;
  if (!deviceSignPublicKey || !deviceSignSecretKey) {
    const devSign = nacl.sign.keyPair();
    deviceSignPublicKey = uint8ArrayToBase64(devSign.publicKey);
    deviceSignSecretKey = uint8ArrayToBase64(devSign.secretKey);
  }

  let rsaPublicKeySpki = identity.rsaPublicKeySpki;
  let rsaPrivateKeyPkcs8 = identity.rsaPrivateKeyPkcs8;
  if (!rsaPublicKeySpki || !rsaPrivateKeyPkcs8) {
    const rsa = await exportRsaDeviceKeyStrings();
    rsaPublicKeySpki = rsa.rsaPublicKeySpki;
    rsaPrivateKeyPkcs8 = rsa.rsaPrivateKeyPkcs8;
  }

  const memberId = identity.memberId || identity.identityHash;
  const deviceKeyId =
    identity.deviceKeyId ||
    (await computeDeviceKeyId(
      identity.publicKey,
      rsaPublicKeySpki,
      deviceSignPublicKey
    ));

  return {
    ...identity,
    memberId,
    deviceKeyId,
    signPublicKey,
    signSecretKey,
    deviceSignPublicKey,
    deviceSignSecretKey,
    rsaPublicKeySpki,
    rsaPrivateKeyPkcs8,
  };
}

/**
 * Verifies whether a memberId or deviceKeyId is already revoked against canonical snapshots.
 * Note: A revoked device may still cryptographically generate signatures with its local keypair,
 * so verifying devices MUST always check revocation and device authorization before accepting authority.
 */
export function isCredentialRevokedInSnapshots(
  snapshots: readonly RosterSnapshot[],
  memberId: string,
  deviceKeyId?: string
): boolean {
  for (const snap of snapshots) {
    if (snap.revokedKeyIds.includes(memberId)) return true;
    if (deviceKeyId && snap.revokedKeyIds.includes(deviceKeyId)) return true;
    const member = snap.members.find(
      (m) => m.identityHash === memberId || m.memberId === memberId
    );
    if (member && (member.status === 'removed' || member.status === 'left')) {
      return true;
    }
    if (deviceKeyId) {
      const dev = snap.devices.find((d) => d.deviceKeyId === deviceKeyId);
      if (dev && dev.status === 'revoked') return true;
    }
  }
  return false;
}

/**
 * Checks whether (memberId, deviceKeyId) holds active, non-revoked moderator-device authority
 * in the supplied authoritative snapshot. Possession of a member identity key alone is NOT sufficient.
 */
export function isAuthorizedModeratorDevice(
  authoritativeSnapshot: RosterSnapshot,
  memberId: string,
  deviceKeyId: string
): boolean {
  if (!memberId || !deviceKeyId) return false;
  if (authoritativeSnapshot.trustState === 'historical_unvalidated') {
    return false;
  }
  if (
    authoritativeSnapshot.revokedKeyIds.includes(memberId) ||
    authoritativeSnapshot.revokedKeyIds.includes(deviceKeyId)
  ) {
    return false;
  }

  const isModerator =
    authoritativeSnapshot.founderId === memberId ||
    authoritativeSnapshot.moderators.includes(memberId);
  if (!isModerator) return false;

  const member = authoritativeSnapshot.members.find(
    (m) => m.memberId === memberId || m.identityHash === memberId
  );
  if (!member || (member.status && member.status !== 'active')) {
    return false;
  }

  const device = authoritativeSnapshot.devices.find(
    (d) => d.deviceKeyId === deviceKeyId && d.memberId === memberId
  );
  if (!device || device.status !== 'active') {
    return false;
  }
  return true;
}

/**
 * Signs an arbitrary moderator action payload using the moderator's per-device Ed25519 key.
 * Rejects invocation if identity lacks deviceSignSecretKey.
 */
export function signModeratorActionWithDevice(
  payload: string,
  identity: UserIdentity
): { signerModId: string; signerDeviceKeyId: string; signature: string } {
  const signerModId = identity.memberId || identity.identityHash;
  if (!identity.deviceKeyId || !identity.deviceSignSecretKey) {
    throw new Error('Moderator action requires per-device Ed25519 signing credential');
  }
  return {
    signerModId,
    signerDeviceKeyId: identity.deviceKeyId,
    signature: signDetachedString(payload, identity.deviceSignSecretKey),
  };
}

/**
 * Verifies a moderator action against the authoritative snapshot's active, non-revoked
 * moderator-device credentials. A revoked device or a member-identity-only signature fails.
 */
export function verifyModeratorDeviceAuthority(
  payload: string,
  signatureBase64: string,
  signerModId: string,
  signerDeviceKeyId: string,
  authoritativeSnapshot: RosterSnapshot
): boolean {
  if (
    !isAuthorizedModeratorDevice(
      authoritativeSnapshot,
      signerModId,
      signerDeviceKeyId
    )
  ) {
    return false;
  }
  const authDevice = authoritativeSnapshot.devices.find(
    (d) =>
      d.deviceKeyId === signerDeviceKeyId &&
      d.memberId === signerModId &&
      d.status === 'active'
  );
  if (!authDevice) return false;
  return verifyDetachedString(
    payload,
    signatureBase64,
    authDevice.deviceSignPublicKey
  );
}

export function canonicalRosterSnapshotPayload(
  snapshot: Omit<RosterSnapshot, 'signature' | 'snapshotKey' | 'trustState'>
): string {
  return JSON.stringify({
    familyId: snapshot.familyId,
    founderId: snapshot.founderId,
    epoch: snapshot.epoch,
    prevSnapshotHash: snapshot.prevSnapshotHash,
    inviteCommitment: snapshot.inviteCommitment,
    stateHash: snapshot.stateHash,
    members: snapshot.members,
    moderators: snapshot.moderators,
    devices: snapshot.devices,
    broadcastAllowedIds: snapshot.broadcastAllowedIds,
    broadcastBlockedIds: snapshot.broadcastBlockedIds,
    revokedKeyIds: snapshot.revokedKeyIds,
    clockVector: snapshot.clockVector,
    signerModId: snapshot.signerModId,
    signerDeviceKeyId: snapshot.signerDeviceKeyId,
  });
}

export function signRosterSnapshotWithModeratorDevice(
  unsignedSnapshot: Omit<RosterSnapshot, 'signature'>,
  moderatorIdentity: UserIdentity
): RosterSnapshot {
  const signerModId =
    moderatorIdentity.memberId || moderatorIdentity.identityHash;
  if (!moderatorIdentity.deviceKeyId || !moderatorIdentity.deviceSignSecretKey) {
    throw new Error(
      'Signing RosterSnapshot requires an authorized moderator device key'
    );
  }
  const withSigner = {
    ...unsignedSnapshot,
    signerModId,
    signerDeviceKeyId: moderatorIdentity.deviceKeyId,
  };
  const signature = signDetachedString(
    canonicalRosterSnapshotPayload(withSigner),
    moderatorIdentity.deviceSignSecretKey
  );
  return { ...withSigner, signature };
}

export function verifyRosterSnapshotAuthority(
  candidateSnapshot: RosterSnapshot,
  authoritativeSnapshot: RosterSnapshot
): boolean {
  if (candidateSnapshot.familyId !== authoritativeSnapshot.familyId) {
    return false;
  }
  if (candidateSnapshot.epoch <= authoritativeSnapshot.epoch) {
    return false;
  }
  return verifyModeratorDeviceAuthority(
    canonicalRosterSnapshotPayload(candidateSnapshot),
    candidateSnapshot.signature,
    candidateSnapshot.signerModId,
    candidateSnapshot.signerDeviceKeyId,
    authoritativeSnapshot
  );
}

/**
 * Checks whether any member device (moderator or ordinary member) is active and non-revoked
 * against a verified current snapshot. Unauthorized candidate devices return false.
 */
export function isAuthorizedActiveDevice(
  authoritativeSnapshot: RosterSnapshot,
  memberId: string,
  deviceKeyId: string
): boolean {
  if (!memberId || !deviceKeyId) return false;
  if (authoritativeSnapshot.trustState === 'historical_unvalidated') {
    return false;
  }
  if (
    authoritativeSnapshot.revokedKeyIds.includes(memberId) ||
    authoritativeSnapshot.revokedKeyIds.includes(deviceKeyId)
  ) {
    return false;
  }
  const member = authoritativeSnapshot.members.find(
    (m) => m.memberId === memberId || m.identityHash === memberId
  );
  if (!member || (member.status && member.status !== 'active')) {
    return false;
  }
  const dev = authoritativeSnapshot.devices.find(
    (d) => d.deviceKeyId === deviceKeyId && d.memberId === memberId
  );
  return Boolean(dev && dev.status === 'active');
}

/**
 * Verifies that a sequence of candidate snapshots forms a valid, unbroken moderator-device
 * signed chain anchored directly from an existing trusted local verified_current snapshot.
 */
export function verifySnapshotAuthorityChainFromAnchor(
  localVerifiedAnchor: RosterSnapshot,
  candidateSnapshots: readonly RosterSnapshot[]
): boolean {
  if (localVerifiedAnchor.trustState === 'historical_unvalidated') {
    return false;
  }
  const ordered = candidateSnapshots
    .filter(
      (s) =>
        s.familyId === localVerifiedAnchor.familyId &&
        s.epoch > localVerifiedAnchor.epoch
    )
    .sort((a, b) => a.epoch - b.epoch);
  if (ordered.length === 0) return false;

  let currentAnchor: RosterSnapshot = {
    ...localVerifiedAnchor,
    trustState: 'verified_current',
  };
  for (const nextSnap of ordered) {
    if (!verifyRosterSnapshotAuthority(nextSnap, currentAnchor)) {
      return false;
    }
    currentAnchor = { ...nextSnap, trustState: 'verified_current' };
  }
  return true;
}

/**
 * Authorizes a PendingDeviceReplacementRequest inside a newly signed RosterSnapshot,
 * optionally retiring (`'retire'`) or revoking (`'revoke'`) the member's original device
 * without revoking the replacement credential or member identity.
 */
export function authorizeReplacementDeviceInSnapshot(params: {
  currentSnapshot: RosterSnapshot;
  moderatorIdentity: UserIdentity;
  request: PendingDeviceReplacementRequest;
  oldDeviceResolution: 'retire' | 'revoke' | 'keep';
  nextStateHash: string;
}): RosterSnapshot {
  const {
    currentSnapshot,
    moderatorIdentity,
    request,
    oldDeviceResolution,
    nextStateHash,
  } = params;
  const modId = moderatorIdentity.memberId || moderatorIdentity.identityHash;
  if (
    !isAuthorizedModeratorDevice(
      currentSnapshot,
      modId,
      moderatorIdentity.deviceKeyId || ''
    )
  ) {
    throw new Error(
      'Authorizing replacement device requires an active, non-revoked moderator-device credential'
    );
  }
  if (!verifyReplacementCandidateRequest(request, currentSnapshot)) {
    throw new Error(
      'Invalid or revoked replacement-device candidate request'
    );
  }

  const nextEpoch = currentSnapshot.epoch + 1;
  const now = Date.now();
  const updatedDevices: DeviceCredentialRecord[] = currentSnapshot.devices.map(
    (d) => {
      if (
        d.deviceKeyId === request.oldDeviceKeyId &&
        d.memberId === request.memberId
      ) {
        if (oldDeviceResolution === 'retire') {
          return { ...d, status: 'retired' as const, retiredAt: now };
        }
        if (oldDeviceResolution === 'revoke') {
          return { ...d, status: 'revoked' as const, revokedAtEpoch: nextEpoch };
        }
      }
      return d;
    }
  );

  updatedDevices.push({
    deviceKeyId: request.candidateDeviceKeyId,
    memberId: request.memberId,
    boxPublicKey: request.candidateBoxPublicKey,
    deviceSignPublicKey: request.candidateDeviceSignPublicKey,
    rsaUserId: request.candidateDeviceKeyId,
    status: 'active',
    authorizedByModId: modId,
    authorizedAtEpoch: nextEpoch,
    addedAt: now,
  });

  const nextRevoked = [...currentSnapshot.revokedKeyIds];
  if (
    oldDeviceResolution === 'revoke' &&
    !nextRevoked.includes(request.oldDeviceKeyId)
  ) {
    nextRevoked.push(request.oldDeviceKeyId);
  }

  return signRosterSnapshotWithModeratorDevice(
    {
      ...currentSnapshot,
      snapshotKey: `${currentSnapshot.familyId}:${nextEpoch}:${nextStateHash}`,
      epoch: nextEpoch,
      prevSnapshotHash: currentSnapshot.stateHash,
      stateHash: nextStateHash,
      devices: updatedDevices,
      revokedKeyIds: nextRevoked,
      signerModId: modId,
      signerDeviceKeyId: moderatorIdentity.deviceKeyId!,
      trustState: 'verified_current',
    },
    moderatorIdentity
  );
}

export function canonicalAuthenticatedOnboardingPayload(
  proof: Omit<AuthenticatedOnboardingProof, 'moderatorSignature'>
): string {
  return JSON.stringify({
    familyId: proof.familyId,
    epoch: proof.epoch,
    admittedMemberId: proof.admittedMemberId,
    admittedDeviceKeyId: proof.admittedDeviceKeyId,
    authorizingModId: proof.authorizingModId,
    authorizingDeviceKeyId: proof.authorizingDeviceKeyId,
    permanentRoomId: proof.permanentRoomId,
    challengeNonce: proof.challengeNonce,
    authenticatedAt: proof.authenticatedAt,
  });
}

export function signAuthenticatedOnboardingProof(
  unsignedProof: Omit<AuthenticatedOnboardingProof, 'moderatorSignature'>,
  moderatorIdentity: UserIdentity
): AuthenticatedOnboardingProof {
  if (!moderatorIdentity.deviceKeyId || !moderatorIdentity.deviceSignSecretKey) {
    throw new Error(
      'Authenticated onboarding proof requires a moderator device signing key'
    );
  }
  const sig = signDetachedString(
    canonicalAuthenticatedOnboardingPayload(unsignedProof),
    moderatorIdentity.deviceSignSecretKey
  );
  return { ...unsignedProof, moderatorSignature: sig };
}

/**
 * Strictly validates a PendingAdoptionRecord before local promotion to verified_current.
 * Rejects unauthenticated, wrong-family, malformed, invalid-invite, mismatched-identity,
 * revoked, or invalid-signature adoption records.
 */
export async function verifyAdoptionRecordForPromotion(
  record: PendingAdoptionRecord,
  options?: {
    expectedMemberId?: string;
    expectedDeviceKeyId?: string;
    existingRevokedKeyIds?: readonly string[];
  }
): Promise<{ valid: boolean; reason?: string }> {
  if (!record || typeof record !== 'object') {
    return { valid: false, reason: 'Missing adoption record' };
  }
  if (record.status !== 'authenticated') {
    return {
      valid: false,
      reason: 'Pending adoption has not completed permanent-session authentication',
    };
  }
  if (!record.permanentAuthProof) {
    return { valid: false, reason: 'Missing permanentAuthProof' };
  }
  if (
    !record.oldFamilyId ||
    !record.newFamilyConfig?.familyId ||
    record.oldFamilyId === record.newFamilyConfig.familyId
  ) {
    return { valid: false, reason: 'Invalid old/new family binding' };
  }
  if (!validateSharedInviteCode(record.inviteCode)) {
    return { valid: false, reason: 'Malformed family invite code' };
  }
  if (record.newFamilyConfig.inviteCode !== record.inviteCode) {
    return { valid: false, reason: 'Mismatched invite code on familyConfig' };
  }

  const snap = record.initialSnapshot;
  const proof = record.permanentAuthProof;
  if (
    !snap ||
    snap.familyId !== record.newFamilyConfig.familyId ||
    proof.familyId !== record.newFamilyConfig.familyId ||
    proof.permanentRoomId !== record.newFamilyConfig.familyRoomId ||
    snap.epoch < 1 ||
    snap.epoch !== record.newFamilyConfig.epoch ||
    proof.epoch !== snap.epoch
  ) {
    return {
      valid: false,
      reason: 'Wrong-family or epoch-mismatched adoption binding',
    };
  }

  const expectedCommitment = await deriveInviteCommitment(record.inviteCode);
  if (snap.inviteCommitment !== expectedCommitment) {
    return {
      valid: false,
      reason: 'Snapshot inviteCommitment does not match inviteCode',
    };
  }

  // Enforce identity & credential binding
  if (
    options?.expectedMemberId &&
    proof.admittedMemberId !== options.expectedMemberId
  ) {
    return { valid: false, reason: 'Mismatched admittedMemberId' };
  }
  if (
    options?.expectedDeviceKeyId &&
    proof.admittedDeviceKeyId !== options.expectedDeviceKeyId
  ) {
    return { valid: false, reason: 'Mismatched admittedDeviceKeyId' };
  }

  const priorRevoked = options?.existingRevokedKeyIds || [];
  if (
    priorRevoked.includes(proof.admittedMemberId) ||
    priorRevoked.includes(proof.admittedDeviceKeyId) ||
    priorRevoked.includes(proof.authorizingModId) ||
    priorRevoked.includes(proof.authorizingDeviceKeyId) ||
    priorRevoked.includes(snap.signerModId) ||
    priorRevoked.includes(snap.signerDeviceKeyId)
  ) {
    return {
      valid: false,
      reason: 'Adoption references a previously revoked member or device',
    };
  }

  // Validate against a verified-view copy of initialSnapshot for cryptographic self-check
  const verifiedViewSnap: RosterSnapshot = {
    ...snap,
    trustState: 'verified_current',
  };

  if (
    !isAuthorizedActiveDevice(
      verifiedViewSnap,
      proof.admittedMemberId,
      proof.admittedDeviceKeyId
    )
  ) {
    return {
      valid: false,
      reason: 'Admitted member/device is not active and non-revoked in initialSnapshot',
    };
  }

  if (
    !verifyModeratorDeviceAuthority(
      canonicalRosterSnapshotPayload(verifiedViewSnap),
      snap.signature,
      snap.signerModId,
      snap.signerDeviceKeyId,
      verifiedViewSnap
    )
  ) {
    return {
      valid: false,
      reason: 'Initial snapshot lacks valid authorized moderator-device signature',
    };
  }

  if (
    !verifyModeratorDeviceAuthority(
      canonicalAuthenticatedOnboardingPayload(proof),
      proof.moderatorSignature,
      proof.authorizingModId,
      proof.authorizingDeviceKeyId,
      verifiedViewSnap
    )
  ) {
    return {
      valid: false,
      reason: 'Permanent session auth proof lacks valid authorized moderator-device signature',
    };
  }

  return { valid: true };
}

/**
 * Generates fresh local per-device keys for a replacement phone and produces an
 * UNTRUSTED PendingDeviceReplacementRequest (`selfAuthorized: false`).
 * Peers MUST reject this device until an active non-revoked moderator authorizes it
 * in a signed RosterSnapshot.
 */
export async function prepareReplacementDeviceCandidate(
  sourceIdentity: UserIdentity,
  authoritativeSnapshots: readonly RosterSnapshot[] = []
): Promise<{
  updatedIdentity: UserIdentity;
  oldDeviceKeyId: string;
  newDeviceKeyId: string;
  pendingReplacementRequest: PendingDeviceReplacementRequest;
}> {
  const upgraded = await upgradeLegacyIdentity(sourceIdentity);
  const memberId = upgraded.memberId || upgraded.identityHash;
  const oldDeviceKeyId = upgraded.deviceKeyId!;

  if (
    isCredentialRevokedInSnapshots(
      authoritativeSnapshots,
      memberId,
      oldDeviceKeyId
    )
  ) {
    throw new Error(
      'Revoked device or removed member cannot mint a replacement device credential'
    );
  }

  const newBox = nacl.box.keyPair();
  const newDeviceSign = nacl.sign.keyPair();
  const { rsaPublicKeySpki, rsaPrivateKeyPkcs8 } =
    await exportRsaDeviceKeyStrings();

  const newBoxPublicKey = uint8ArrayToBase64(newBox.publicKey);
  const newBoxSecretKey = uint8ArrayToBase64(newBox.secretKey);
  const newDeviceSignPublicKey = uint8ArrayToBase64(newDeviceSign.publicKey);
  const newDeviceSignSecretKey = uint8ArrayToBase64(newDeviceSign.secretKey);
  const newDeviceKeyId = await computeDeviceKeyId(
    newBoxPublicKey,
    rsaPublicKeySpki,
    newDeviceSignPublicKey
  );

  const createdAt = Date.now();
  const requestId = uint8ArrayToBase64(nacl.randomBytes(16));
  const canonical = JSON.stringify({
    requestId,
    memberId,
    oldDeviceKeyId,
    candidateDeviceKeyId: newDeviceKeyId,
    candidateBoxPublicKey: newBoxPublicKey,
    candidateDeviceSignPublicKey: newDeviceSignPublicKey,
    candidateRsaPublicKeySpki: rsaPublicKeySpki,
    createdAt,
  });

  const candidateProofSignature = signDetachedString(
    canonical,
    newDeviceSignSecretKey
  );
  const memberProofSignature = upgraded.signSecretKey
    ? signDetachedString(canonical, upgraded.signSecretKey)
    : undefined;

  const updatedIdentity: UserIdentity = {
    ...upgraded,
    publicKey: newBoxPublicKey,
    secretKey: newBoxSecretKey,
    deviceSignPublicKey: newDeviceSignPublicKey,
    deviceSignSecretKey: newDeviceSignSecretKey,
    rsaPublicKeySpki,
    rsaPrivateKeyPkcs8,
    deviceKeyId: newDeviceKeyId,
  };

  const pendingReplacementRequest: PendingDeviceReplacementRequest = {
    requestId,
    memberId,
    oldDeviceKeyId,
    candidateDeviceKeyId: newDeviceKeyId,
    candidateBoxPublicKey: newBoxPublicKey,
    candidateDeviceSignPublicKey: newDeviceSignPublicKey,
    candidateRsaPublicKeySpki: rsaPublicKeySpki,
    selfAuthorized: false,
    authorizationStatus: 'pending_moderator_authorization',
    createdAt,
    candidateProofSignature,
    memberProofSignature,
  };

  return {
    updatedIdentity,
    oldDeviceKeyId,
    newDeviceKeyId,
    pendingReplacementRequest,
  };
}

/**
 * Verifies a replacement-device candidate packet's cryptographic proofs and confirms it
 * does NOT claim self-authorization or originate from a revoked key.
 * Note: Returning true only validates request authenticity—acceptance still requires
 * an active, non-revoked moderator to admit candidateDeviceKeyId in a signed RosterSnapshot.
 */
export function verifyReplacementCandidateRequest(
  req: PendingDeviceReplacementRequest,
  latestSnapshot: RosterSnapshot
): boolean {
  if (req.selfAuthorized !== false) return false;
  if (req.authorizationStatus !== 'pending_moderator_authorization') {
    return false;
  }
  if (
    isCredentialRevokedInSnapshots(
      [latestSnapshot],
      req.memberId,
      req.oldDeviceKeyId
    )
  ) {
    return false;
  }
  const canonical = JSON.stringify({
    requestId: req.requestId,
    memberId: req.memberId,
    oldDeviceKeyId: req.oldDeviceKeyId,
    candidateDeviceKeyId: req.candidateDeviceKeyId,
    candidateBoxPublicKey: req.candidateBoxPublicKey,
    candidateDeviceSignPublicKey: req.candidateDeviceSignPublicKey,
    candidateRsaPublicKeySpki: req.candidateRsaPublicKeySpki,
    createdAt: req.createdAt,
  });
  return verifyDetachedString(
    canonical,
    req.candidateProofSignature,
    req.candidateDeviceSignPublicKey
  );
}

/**
 * Builds an empty unused default family configuration at first setup.
 */
export async function createDefaultFamilyConfig(
  identity: UserIdentity
): Promise<FamilyGroupConfig> {
  const upgraded = await upgradeLegacyIdentity(identity);
  const secretBytes = nacl.randomBytes(32);
  const groupSecretKey = uint8ArrayToBase64(secretBytes);
  const founderId = upgraded.memberId || upgraded.identityHash;
  const now = Date.now();
  const familyId = await sha256Hex(
    `fc:family:v1:${founderId}:${uint8ArrayToBase64(nacl.randomBytes(16))}`
  );
  const familyRoomId = await sha256Hex(`fc:room:v1:${familyId}:1`);
  const inviteCode = validateSharedInviteCode(upgraded.inviteCode)
    ? upgraded.inviteCode
    : generateSharedInviteCode();

  return {
    familyId,
    familyRoomId,
    groupSecretKey,
    inviteCode,
    epoch: 1,
    founderId,
    joinedAtEpoch: 1,
    isUnusedDefault: true,
    authorityState: 'unused_default',
    createdAt: now,
    updatedAt: now,
  };
}

// --- Authenticated Passphrase Encryption for Replacement-Phone Backup Archives ---
// Note: This encrypts exported migration backups with PBKDF2-SHA256 + AES-256-GCM.
// Local browser IndexedDB/localStorage records remain unencrypted at rest inside browser origin storage.

async function deriveMigrationAesKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  usage: KeyUsage[]
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    stringToUint8Array(passphrase) as unknown as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usage
  );
}

export async function exportMigrationArchive(
  passphrase: string,
  payload: DeviceMigrationPayload
): Promise<string> {
  if (typeof passphrase !== 'string' || passphrase.length < 8) {
    throw new Error('Migration passphrase must be at least 8 characters');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveMigrationAesKey(passphrase, salt, PBKDF2_ITERATIONS, [
    'encrypt',
  ]);
  const plaintext = stringToUint8Array(JSON.stringify(payload));
  const encryptedBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    plaintext as unknown as BufferSource
  );
  const archive: EncryptedMigrationArchive = {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    saltB64: uint8ArrayToBase64(salt),
    ivB64: uint8ArrayToBase64(iv),
    ciphertextB64: uint8ArrayToBase64(new Uint8Array(encryptedBuffer)),
  };
  return JSON.stringify(archive);
}

function isValidMigrationPayload(obj: unknown): obj is DeviceMigrationPayload {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Partial<DeviceMigrationPayload>;
  if (p.version !== 1 || typeof p.exportedAt !== 'number') return false;
  if (!p.identity || typeof p.identity !== 'object') return false;
  if (
    typeof p.identity.identityHash !== 'string' ||
    typeof p.identity.firstName !== 'string' ||
    typeof p.identity.publicKey !== 'string' ||
    typeof p.identity.secretKey !== 'string'
  ) {
    return false;
  }
  if (
    !Array.isArray(p.contacts) ||
    !Array.isArray(p.messages) ||
    !Array.isArray(p.offlineQueue) ||
    !Array.isArray(p.rosterSnapshots) ||
    !Array.isArray(p.migrationCheckpoints)
  ) {
    return false;
  }
  return true;
}

export async function decryptMigrationArchive(
  passphrase: string,
  rawArchiveJson: string
): Promise<DeviceMigrationPayload> {
  if (typeof passphrase !== 'string' || !passphrase) {
    throw new Error('Passphrase is required');
  }
  let parsedArchive: unknown;
  try {
    parsedArchive = JSON.parse(rawArchiveJson);
  } catch {
    throw new Error('Invalid migration archive JSON');
  }

  const archive = parsedArchive as Partial<EncryptedMigrationArchive>;
  if (
    !archive ||
    archive.version !== 1 ||
    archive.kdf !== 'PBKDF2-SHA256' ||
    typeof archive.iterations !== 'number' ||
    archive.iterations < 100_000 ||
    typeof archive.saltB64 !== 'string' ||
    typeof archive.ivB64 !== 'string' ||
    typeof archive.ciphertextB64 !== 'string'
  ) {
    throw new Error('Unsupported or malformed migration archive envelope');
  }

  try {
    const salt = base64ToUint8Array(archive.saltB64);
    const iv = base64ToUint8Array(archive.ivB64);
    const ciphertext = base64ToUint8Array(archive.ciphertextB64);
    const key = await deriveMigrationAesKey(
      passphrase,
      salt,
      archive.iterations,
      ['decrypt']
    );
    const decryptedBuffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    const decoded = JSON.parse(
      uint8ArrayToString(new Uint8Array(decryptedBuffer))
    );
    if (!isValidMigrationPayload(decoded)) {
      throw new Error('Invalid migration payload contents');
    }
    return decoded;
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === 'Invalid migration payload contents'
    ) {
      throw err;
    }
    throw new Error('Invalid passphrase or tampered migration backup');
  }
}

// --- Local Identity Storage Helpers ---

const STORAGE_KEY_IDENTITY = 'fm_user_identity';
const STORAGE_KEY_DEV_MODE = 'fm_dev_mode_enabled';

export function isDevMode(): boolean {
  return typeof sessionStorage !== 'undefined'
    ? sessionStorage.getItem(STORAGE_KEY_DEV_MODE) === 'true'
    : false;
}

export function setDevMode(enabled: boolean): void {
  if (typeof sessionStorage === 'undefined') return;
  if (enabled) {
    sessionStorage.setItem(STORAGE_KEY_DEV_MODE, 'true');
  } else {
    sessionStorage.removeItem(STORAGE_KEY_DEV_MODE);
  }
}

export function getSavedIdentity(): UserIdentity | null {
  const storage = isDevMode() ? sessionStorage : localStorage;
  const raw = storage.getItem(STORAGE_KEY_IDENTITY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserIdentity;
  } catch {
    return null;
  }
}

export function saveIdentity(identity: UserIdentity): void {
  const storage = isDevMode() ? sessionStorage : localStorage;
  storage.setItem(STORAGE_KEY_IDENTITY, JSON.stringify(identity));
}

export function clearIdentity(): void {
  const storage = isDevMode() ? sessionStorage : localStorage;
  storage.removeItem(STORAGE_KEY_IDENTITY);
}

/**
 * 100% offline Web Audio API message chime.
 */
export function playNotificationChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(698.46, ctx.currentTime);
    osc.frequency.setValueAtTime(880, ctx.currentTime + 0.12);

    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.45);
  } catch {
    // Graceful fallback if audio is autoplay-restricted
  }
}
