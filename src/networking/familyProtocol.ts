/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import nacl from 'tweetnacl';
import {
  AuthenticatedOnboardingProof,
  ChatMessage,
  FamilyGroupConfig,
  FamilyMember,
  InviteAuthorizationCert,
  PeerSessionBinding,
  RosterSnapshot,
  UserIdentity,
} from '../types.ts';
import {
  INVITE_ALNUM_CHARS,
  INVITE_SYMBOL_CHARS,
  base64ToUint8Array,
  canonicalAuthenticatedOnboardingPayload,
  decryptE2EE,
  deriveInviteCommitment,
  encryptE2EE,
  EncryptedPayload,
  isAuthorizedActiveDevice,
  isAuthorizedModeratorDevice,
  isCredentialRevokedInSnapshots,
  sha256Hex,
  signDetachedString,
  stringToUint8Array,
  uint8ArrayToBase64,
  uint8ArrayToString,
  validateSharedInviteCode,
  verifyDetachedString,
  verifyModeratorDeviceAuthority,
} from '../crypto/cryptoUtils.ts';

export const SESSION_BINDING_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

export interface VerifiedPeerSession {
  memberId: string;
  deviceKeyId: string;
  boxPublicKey: string;
  deviceSignPublicKey: string;
  rsaUserId: string;
  ephemeralPeerId: string;
  familyId: string;
  epoch: number;
  verifiedAt: number;
}

export type JoinInviteRequestWire = {
  type: 'join_invite_request';
  requestId: string;
  inviteCommitment: string;
  challengeNonce: string;
  candidateMember: {
    memberId: string;
    firstName: string;
    lastName: string;
    boxPublicKey: string;
    deviceSignPublicKey: string;
    deviceKeyId: string;
    rsaPublicKeySpki: string;
    rsaUserId: string;
  };
  ephemeralPeerId: string;
  timestamp: number;
  signature: string;
};

export type OnboardingOfferWire = {
  type: 'onboarding_offer';
  requestId: string;
  challengeNonce: string;
  inviteCert: InviteAuthorizationCert;
  familyId: string;
  familyRoomId: string;
  epoch: number;
  founderId: string;
  senderBoxPublicKey: string;
  senderMemberId: string;
  senderDeviceKeyId: string;
  sealedNonce: string;
  sealedCiphertext: string;
  signature: string;
};

export type OnboardingPermanentAuthReqWire = {
  type: 'permanent_auth_req';
  requestId: string;
  familyId: string;
  challengeNonce: string;
  memberId: string;
  deviceKeyId: string;
  ephemeralPeerId: string;
  timestamp: number;
  signature: string;
};

export type OnboardingPermanentAuthResWire = {
  type: 'permanent_auth_res';
  requestId: string;
  familyId: string;
  permanentAuthProof: AuthenticatedOnboardingProof;
  latestSnapshot: RosterSnapshot;
};

export type OnboardingRejectionWire = {
  type: 'onboarding_rejected';
  requestId: string;
  reason: string;
};

export type SealedOnboardingBundle = {
  familyConfig: FamilyGroupConfig;
  initialSnapshot: RosterSnapshot;
  initialContacts: FamilyMember[];
  onboardingMessages: ChatMessage[];
};

export type SignedGroupEnvelope = {
  v: 1;
  familyId: string;
  epoch: number;
  msgId: string;
  senderMemberId: string;
  senderDeviceKeyId: string;
  nonce: string;
  ciphertext: string;
  timestamp: number;
  lamportClock: number;
  signature: string;
};

export type AuthenticatedDirectEnvelopeWire = {
  v: 1;
  familyId: string;
  msgId: string;
  senderMemberId: string;
  senderDeviceKeyId: string;
  recipientMemberId: string;
  nonce: string;
  ciphertext: string;
  timestamp: number;
  lamportClock: number;
  signature: string;
};

export type DirectDeliveryAckWire = {
  v: 1;
  familyId: string;
  messageId: string;
  senderMemberId: string;
  recipientMemberId: string;
  recipientDeviceKeyId: string;
  committedAt: number;
  signature: string;
};

// --- PeerSessionBinding Signing & Verification ---

export function canonicalPeerSessionBindingPayload(
  binding: Omit<PeerSessionBinding, 'signature'>
): string {
  return JSON.stringify({
    familyId: binding.familyId,
    epoch: binding.epoch,
    memberId: binding.memberId,
    deviceKeyId: binding.deviceKeyId,
    boxPublicKey: binding.boxPublicKey,
    deviceSignPublicKey: binding.deviceSignPublicKey,
    rsaUserId: binding.rsaUserId,
    ephemeralPeerId: binding.ephemeralPeerId,
    issuedAt: binding.issuedAt,
    expiresAt: binding.expiresAt,
  });
}

export function signPeerSessionBinding(params: {
  identity: UserIdentity;
  rsaUserId: string;
  ephemeralPeerId: string;
  familyId: string;
  epoch: number;
  now?: number;
}): PeerSessionBinding {
  const { identity, rsaUserId, ephemeralPeerId, familyId, epoch } = params;
  const now = params.now ?? Date.now();
  const memberId = identity.memberId || identity.identityHash;
  if (
    !identity.deviceKeyId ||
    !identity.deviceSignPublicKey ||
    !identity.deviceSignSecretKey
  ) {
    throw new Error('Identity missing per-device Ed25519 credentials');
  }
  const unsigned: Omit<PeerSessionBinding, 'signature'> = {
    familyId,
    epoch,
    memberId,
    deviceKeyId: identity.deviceKeyId,
    boxPublicKey: identity.publicKey,
    deviceSignPublicKey: identity.deviceSignPublicKey,
    rsaUserId,
    ephemeralPeerId,
    issuedAt: now,
    expiresAt: now + SESSION_BINDING_TTL_MS,
  };
  return {
    ...unsigned,
    signature: signDetachedString(
      canonicalPeerSessionBindingPayload(unsigned),
      identity.deviceSignSecretKey
    ),
  };
}

export function verifyPeerSessionBinding(params: {
  binding: PeerSessionBinding;
  expectedFamilyId: string;
  expectedLivePeerId: string;
  expectedRsaUserId: string;
  authoritativeSnapshot: RosterSnapshot;
  now?: number;
}): { valid: boolean; reason?: string } {
  const {
    binding,
    expectedFamilyId,
    expectedLivePeerId,
    expectedRsaUserId,
    authoritativeSnapshot,
  } = params;
  const now = params.now ?? Date.now();

  if (!binding || typeof binding !== 'object') {
    return { valid: false, reason: 'Malformed session binding' };
  }
  if (binding.familyId !== expectedFamilyId) {
    return { valid: false, reason: 'Session binding familyId mismatch' };
  }
  if (binding.ephemeralPeerId !== expectedLivePeerId) {
    return { valid: false, reason: 'Session binding peerId mismatch' };
  }
  if (binding.rsaUserId !== expectedRsaUserId) {
    return { valid: false, reason: 'Session binding RSA userId mismatch' };
  }
  if (now > binding.expiresAt || binding.issuedAt > now + 60_000) {
    return { valid: false, reason: 'Expired or future-dated session binding' };
  }
  if (
    isCredentialRevokedInSnapshots(
      [authoritativeSnapshot],
      binding.memberId,
      binding.deviceKeyId
    )
  ) {
    return { valid: false, reason: 'Member or device credential is revoked' };
  }
  if (
    !isAuthorizedActiveDevice(
      authoritativeSnapshot,
      binding.memberId,
      binding.deviceKeyId
    )
  ) {
    return {
      valid: false,
      reason: 'Device credential is not authorized/active in current snapshot',
    };
  }
  const activeDev = authoritativeSnapshot.devices.find(
    (d) =>
      d.deviceKeyId === binding.deviceKeyId &&
      d.memberId === binding.memberId &&
      d.status === 'active'
  );
  if (
    !activeDev ||
    activeDev.boxPublicKey !== binding.boxPublicKey ||
    activeDev.deviceSignPublicKey !== binding.deviceSignPublicKey
  ) {
    return {
      valid: false,
      reason: 'Binding keys do not match authoritative device record',
    };
  }
  const sigOk = verifyDetachedString(
    canonicalPeerSessionBindingPayload(binding),
    binding.signature,
    binding.deviceSignPublicKey
  );
  if (!sigOk) {
    return { valid: false, reason: 'Invalid session binding signature' };
  }
  return { valid: true };
}

// --- Invite Rendezvous Request & InviteAuthorizationCert ---

export function signJoinInviteRequest(params: {
  identity: UserIdentity;
  rsaUserId: string;
  ephemeralPeerId: string;
  inviteCommitment: string;
  challengeNonce: string;
  requestId: string;
}): JoinInviteRequestWire {
  const {
    identity,
    rsaUserId,
    ephemeralPeerId,
    inviteCommitment,
    challengeNonce,
    requestId,
  } = params;
  const memberId = identity.memberId || identity.identityHash;
  if (
    !identity.deviceKeyId ||
    !identity.deviceSignPublicKey ||
    !identity.deviceSignSecretKey ||
    !identity.rsaPublicKeySpki
  ) {
    throw new Error('Joiner identity incomplete');
  }
  const timestamp = Date.now();
  const candidateMember = {
    memberId,
    firstName: identity.firstName,
    lastName: identity.lastName,
    boxPublicKey: identity.publicKey,
    deviceSignPublicKey: identity.deviceSignPublicKey,
    deviceKeyId: identity.deviceKeyId,
    rsaPublicKeySpki: identity.rsaPublicKeySpki,
    rsaUserId,
  };
  const canonical = JSON.stringify({
    requestId,
    inviteCommitment,
    challengeNonce,
    candidateMember,
    ephemeralPeerId,
    timestamp,
  });
  return {
    type: 'join_invite_request',
    requestId,
    inviteCommitment,
    challengeNonce,
    candidateMember,
    ephemeralPeerId,
    timestamp,
    signature: signDetachedString(canonical, identity.deviceSignSecretKey),
  };
}

export function verifyJoinInviteRequest(
  req: JoinInviteRequestWire,
  expectedLivePeerId: string,
  expectedCommitment: string
): boolean {
  if (!req || req.type !== 'join_invite_request') return false;
  if (req.ephemeralPeerId !== expectedLivePeerId) return false;
  if (req.inviteCommitment !== expectedCommitment) return false;
  const c = req.candidateMember;
  if (
    !c?.memberId ||
    !c?.deviceKeyId ||
    !c?.boxPublicKey ||
    !c?.deviceSignPublicKey ||
    !c?.rsaPublicKeySpki ||
    !c?.rsaUserId
  ) {
    return false;
  }
  const canonical = JSON.stringify({
    requestId: req.requestId,
    inviteCommitment: req.inviteCommitment,
    challengeNonce: req.challengeNonce,
    candidateMember: req.candidateMember,
    ephemeralPeerId: req.ephemeralPeerId,
    timestamp: req.timestamp,
  });
  return verifyDetachedString(canonical, req.signature, c.deviceSignPublicKey);
}

export function canonicalInviteCertPayload(
  cert: Omit<InviteAuthorizationCert, 'signature'>
): string {
  return JSON.stringify({
    familyId: cert.familyId,
    inviteCommitment: cert.inviteCommitment,
    issuedAtEpoch: cert.issuedAtEpoch,
    signerModId: cert.signerModId,
    signerDeviceKeyId: cert.signerDeviceKeyId,
    issuedAt: cert.issuedAt,
  });
}

export function signInviteAuthorizationCert(params: {
  familyId: string;
  inviteCommitment: string;
  issuedAtEpoch: number;
  moderatorIdentity: UserIdentity;
}): InviteAuthorizationCert {
  const { familyId, inviteCommitment, issuedAtEpoch, moderatorIdentity } =
    params;
  const signerModId =
    moderatorIdentity.memberId || moderatorIdentity.identityHash;
  if (!moderatorIdentity.deviceKeyId || !moderatorIdentity.deviceSignSecretKey) {
    throw new Error('Moderator device credential required for InviteAuthorizationCert');
  }
  const unsigned: Omit<InviteAuthorizationCert, 'signature'> = {
    familyId,
    inviteCommitment,
    issuedAtEpoch,
    signerModId,
    signerDeviceKeyId: moderatorIdentity.deviceKeyId,
    issuedAt: Date.now(),
  };
  return {
    ...unsigned,
    signature: signDetachedString(
      canonicalInviteCertPayload(unsigned),
      moderatorIdentity.deviceSignSecretKey
    ),
  };
}

export async function sealOnboardingOffer(params: {
  requestId: string;
  challengeNonce: string;
  inviteCode: string;
  bundle: SealedOnboardingBundle;
  recipientBoxPublicKey: string;
  moderatorIdentity: UserIdentity;
}): Promise<OnboardingOfferWire> {
  const {
    requestId,
    challengeNonce,
    inviteCode,
    bundle,
    recipientBoxPublicKey,
    moderatorIdentity,
  } = params;
  if (!validateSharedInviteCode(inviteCode)) {
    throw new Error('Invalid shared invite code');
  }
  const modId = moderatorIdentity.memberId || moderatorIdentity.identityHash;
  if (!moderatorIdentity.deviceKeyId || !moderatorIdentity.deviceSignSecretKey) {
    throw new Error('Moderator device key required');
  }
  const inviteCommitment = await deriveInviteCommitment(inviteCode);
  const inviteCert = signInviteAuthorizationCert({
    familyId: bundle.familyConfig.familyId,
    inviteCommitment,
    issuedAtEpoch: bundle.initialSnapshot.epoch,
    moderatorIdentity,
  });
  const sealed = encryptE2EE(
    JSON.stringify(bundle),
    recipientBoxPublicKey,
    moderatorIdentity.secretKey
  );
  const unsignedOffer = {
    type: 'onboarding_offer' as const,
    requestId,
    challengeNonce,
    inviteCert,
    familyId: bundle.familyConfig.familyId,
    familyRoomId: bundle.familyConfig.familyRoomId,
    epoch: bundle.initialSnapshot.epoch,
    founderId: bundle.familyConfig.founderId,
    senderBoxPublicKey: moderatorIdentity.publicKey,
    senderMemberId: modId,
    senderDeviceKeyId: moderatorIdentity.deviceKeyId,
    sealedNonce: sealed.nonce,
    sealedCiphertext: sealed.ciphertext,
  };
  const signature = signDetachedString(
    JSON.stringify(unsignedOffer),
    moderatorIdentity.deviceSignSecretKey
  );
  return { ...unsignedOffer, signature };
}

export async function openOnboardingOffer(params: {
  offer: OnboardingOfferWire;
  enteredInviteCode: string;
  recipientIdentity: UserIdentity;
}): Promise<SealedOnboardingBundle> {
  const { offer, enteredInviteCode, recipientIdentity } = params;
  if (!validateSharedInviteCode(enteredInviteCode)) {
    throw new Error('Invalid shared invitation code format');
  }
  const expectedCommitment = await deriveInviteCommitment(enteredInviteCode);
  if (offer.inviteCert.inviteCommitment !== expectedCommitment) {
    throw new Error('Invite commitment mismatch on onboarding offer');
  }
  const decryptedJson = decryptE2EE(
    { nonce: offer.sealedNonce, ciphertext: offer.sealedCiphertext },
    offer.senderBoxPublicKey,
    recipientIdentity.secretKey
  );
  if (!decryptedJson) {
    throw new Error('Failed to decrypt onboarding bundle');
  }
  const bundle = JSON.parse(decryptedJson) as SealedOnboardingBundle;
  const viewSnap: RosterSnapshot = {
    ...bundle.initialSnapshot,
    trustState: 'verified_current',
  };
  if (
    !isAuthorizedModeratorDevice(
      viewSnap,
      offer.senderMemberId,
      offer.senderDeviceKeyId
    )
  ) {
    throw new Error('Onboarding offer sender is not an authorized moderator device');
  }
  const unsignedOffer = {
    type: offer.type,
    requestId: offer.requestId,
    challengeNonce: offer.challengeNonce,
    inviteCert: offer.inviteCert,
    familyId: offer.familyId,
    familyRoomId: offer.familyRoomId,
    epoch: offer.epoch,
    founderId: offer.founderId,
    senderBoxPublicKey: offer.senderBoxPublicKey,
    senderMemberId: offer.senderMemberId,
    senderDeviceKeyId: offer.senderDeviceKeyId,
    sealedNonce: offer.sealedNonce,
    sealedCiphertext: offer.sealedCiphertext,
  };
  if (
    !verifyModeratorDeviceAuthority(
      JSON.stringify(unsignedOffer),
      offer.signature,
      offer.senderMemberId,
      offer.senderDeviceKeyId,
      viewSnap
    )
  ) {
    throw new Error('Invalid onboarding offer moderator-device signature');
  }
  if (
    !verifyModeratorDeviceAuthority(
      canonicalInviteCertPayload(offer.inviteCert),
      offer.inviteCert.signature,
      offer.inviteCert.signerModId,
      offer.inviteCert.signerDeviceKeyId,
      viewSnap
    )
  ) {
    throw new Error('Invalid InviteAuthorizationCert signature');
  }
  return bundle;
}

// --- Group Message Symmetric Envelope (groupSecretKey + deviceSignSecretKey) ---

async function deriveGroupSecretBoxKey(
  groupSecretKeyBase64: string,
  familyId: string
): Promise<Uint8Array> {
  const hex = await sha256Hex(`fc:groupbox:v1:${familyId}:${groupSecretKeyBase64}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function encryptGroupEnvelope(params: {
  familyConfig: FamilyGroupConfig;
  identity: UserIdentity;
  message: ChatMessage;
}): Promise<SignedGroupEnvelope> {
  const { familyConfig, identity, message } = params;
  const senderMemberId = identity.memberId || identity.identityHash;
  if (!identity.deviceKeyId || !identity.deviceSignSecretKey) {
    throw new Error('Per-device signing credential required for group messaging');
  }
  const key = await deriveGroupSecretBoxKey(
    familyConfig.groupSecretKey,
    familyConfig.familyId
  );
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plaintext = stringToUint8Array(
    JSON.stringify({
      senderName: message.senderName,
      content: message.content,
      mediaType: message.mediaType,
      mediaUrl: message.mediaUrl,
      mediaMimeType: message.mediaMimeType,
      fileName: message.fileName,
      fileSize: message.fileSize,
    })
  );
  const boxed = nacl.secretbox(plaintext, nonce, key);
  const nonceB64 = uint8ArrayToBase64(nonce);
  const ciphertextB64 = uint8ArrayToBase64(boxed);
  const lamportClock = message.lamportClock ?? 1;
  const canonical = JSON.stringify({
    v: 1,
    familyId: familyConfig.familyId,
    epoch: familyConfig.epoch,
    msgId: message.id,
    senderMemberId,
    senderDeviceKeyId: identity.deviceKeyId,
    nonce: nonceB64,
    ciphertext: ciphertextB64,
    timestamp: message.timestamp,
    lamportClock,
  });
  return {
    v: 1,
    familyId: familyConfig.familyId,
    epoch: familyConfig.epoch,
    msgId: message.id,
    senderMemberId,
    senderDeviceKeyId: identity.deviceKeyId,
    nonce: nonceB64,
    ciphertext: ciphertextB64,
    timestamp: message.timestamp,
    lamportClock,
    signature: signDetachedString(canonical, identity.deviceSignSecretKey),
  };
}

export async function decryptGroupEnvelope(params: {
  envelope: SignedGroupEnvelope;
  familyConfig: FamilyGroupConfig;
  senderSession: VerifiedPeerSession;
}): Promise<ChatMessage | null> {
  const { envelope, familyConfig, senderSession } = params;
  if (
    !envelope ||
    envelope.v !== 1 ||
    envelope.familyId !== familyConfig.familyId ||
    envelope.senderMemberId !== senderSession.memberId ||
    envelope.senderDeviceKeyId !== senderSession.deviceKeyId
  ) {
    return null;
  }
  const canonical = JSON.stringify({
    v: 1,
    familyId: envelope.familyId,
    epoch: envelope.epoch,
    msgId: envelope.msgId,
    senderMemberId: envelope.senderMemberId,
    senderDeviceKeyId: envelope.senderDeviceKeyId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    timestamp: envelope.timestamp,
    lamportClock: envelope.lamportClock,
  });
  if (
    !verifyDetachedString(
      canonical,
      envelope.signature,
      senderSession.deviceSignPublicKey
    )
  ) {
    return null;
  }
  const key = await deriveGroupSecretBoxKey(
    familyConfig.groupSecretKey,
    familyConfig.familyId
  );
  const opened = nacl.secretbox.open(
    base64ToUint8Array(envelope.ciphertext),
    base64ToUint8Array(envelope.nonce),
    key
  );
  if (!opened) return null;
  const body = JSON.parse(uint8ArrayToString(opened)) as Partial<ChatMessage>;
  return {
    id: envelope.msgId,
    chatId: 'global',
    senderId: envelope.senderMemberId,
    senderName: body.senderName || 'Family Member',
    content: body.content || '',
    timestamp: envelope.timestamp,
    lamportClock: envelope.lamportClock,
    epoch: envelope.epoch,
    status: 'delivered',
    encrypted: true,
    mediaType: body.mediaType,
    mediaUrl: body.mediaUrl,
    mediaMimeType: body.mediaMimeType,
    fileName: body.fileName,
    fileSize: body.fileSize,
  };
}

// --- Authenticated Direct Message E2EE + Persistent Delivery ACKs ---

export function signDirectEnvelope(params: {
  familyId: string;
  message: ChatMessage;
  senderIdentity: UserIdentity;
  recipientSession: VerifiedPeerSession;
}): AuthenticatedDirectEnvelopeWire {
  const { familyId, message, senderIdentity, recipientSession } = params;
  const senderMemberId =
    senderIdentity.memberId || senderIdentity.identityHash;
  if (!senderIdentity.deviceKeyId || !senderIdentity.deviceSignSecretKey) {
    throw new Error('Sender per-device signing credential missing');
  }
  const inner = JSON.stringify({
    senderName: message.senderName,
    content: message.content,
    mediaType: message.mediaType,
    mediaUrl: message.mediaUrl,
    mediaMimeType: message.mediaMimeType,
    fileName: message.fileName,
    fileSize: message.fileSize,
  });
  const encrypted: EncryptedPayload = encryptE2EE(
    inner,
    recipientSession.boxPublicKey,
    senderIdentity.secretKey
  );
  const lamportClock = message.lamportClock ?? 1;
  const canonical = JSON.stringify({
    v: 1,
    familyId,
    msgId: message.id,
    senderMemberId,
    senderDeviceKeyId: senderIdentity.deviceKeyId,
    recipientMemberId: recipientSession.memberId,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    timestamp: message.timestamp,
    lamportClock,
  });
  return {
    v: 1,
    familyId,
    msgId: message.id,
    senderMemberId,
    senderDeviceKeyId: senderIdentity.deviceKeyId,
    recipientMemberId: recipientSession.memberId,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    timestamp: message.timestamp,
    lamportClock,
    signature: signDetachedString(canonical, senderIdentity.deviceSignSecretKey),
  };
}

export function verifyAndDecryptDirectEnvelope(params: {
  envelope: AuthenticatedDirectEnvelopeWire;
  expectedFamilyId: string;
  recipientIdentity: UserIdentity;
  senderSession: VerifiedPeerSession;
}): ChatMessage | null {
  const { envelope, expectedFamilyId, recipientIdentity, senderSession } =
    params;
  const selfMemberId =
    recipientIdentity.memberId || recipientIdentity.identityHash;
  if (
    !envelope ||
    envelope.v !== 1 ||
    envelope.familyId !== expectedFamilyId ||
    envelope.recipientMemberId !== selfMemberId ||
    envelope.senderMemberId !== senderSession.memberId ||
    envelope.senderDeviceKeyId !== senderSession.deviceKeyId
  ) {
    return null;
  }
  const canonical = JSON.stringify({
    v: 1,
    familyId: envelope.familyId,
    msgId: envelope.msgId,
    senderMemberId: envelope.senderMemberId,
    senderDeviceKeyId: envelope.senderDeviceKeyId,
    recipientMemberId: envelope.recipientMemberId,
    nonce: envelope.nonce,
    ciphertext: envelope.ciphertext,
    timestamp: envelope.timestamp,
    lamportClock: envelope.lamportClock,
  });
  if (
    !verifyDetachedString(
      canonical,
      envelope.signature,
      senderSession.deviceSignPublicKey
    )
  ) {
    return null;
  }
  const decrypted = decryptE2EE(
    { nonce: envelope.nonce, ciphertext: envelope.ciphertext },
    senderSession.boxPublicKey,
    recipientIdentity.secretKey
  );
  if (!decrypted) return null;
  const body = JSON.parse(decrypted) as Partial<ChatMessage>;
  return {
    id: envelope.msgId,
    chatId: envelope.senderMemberId,
    senderId: envelope.senderMemberId,
    senderName: body.senderName || 'Family Member',
    content: body.content || '',
    timestamp: envelope.timestamp,
    lamportClock: envelope.lamportClock,
    status: 'delivered',
    encrypted: true,
    mediaType: body.mediaType,
    mediaUrl: body.mediaUrl,
    mediaMimeType: body.mediaMimeType,
    fileName: body.fileName,
    fileSize: body.fileSize,
  };
}

export function signDeliveryAck(params: {
  familyId: string;
  messageId: string;
  senderMemberId: string;
  recipientIdentity: UserIdentity;
}): DirectDeliveryAckWire {
  const { familyId, messageId, senderMemberId, recipientIdentity } = params;
  const recipientMemberId =
    recipientIdentity.memberId || recipientIdentity.identityHash;
  if (!recipientIdentity.deviceKeyId || !recipientIdentity.deviceSignSecretKey) {
    throw new Error('Recipient per-device signing credential missing');
  }
  const committedAt = Date.now();
  const canonical = JSON.stringify({
    v: 1,
    familyId,
    messageId,
    senderMemberId,
    recipientMemberId,
    recipientDeviceKeyId: recipientIdentity.deviceKeyId,
    committedAt,
  });
  return {
    v: 1,
    familyId,
    messageId,
    senderMemberId,
    recipientMemberId,
    recipientDeviceKeyId: recipientIdentity.deviceKeyId,
    committedAt,
    signature: signDetachedString(canonical, recipientIdentity.deviceSignSecretKey),
  };
}

export function verifyDeliveryAck(params: {
  ack: DirectDeliveryAckWire;
  expectedFamilyId: string;
  expectedSelfMemberId: string;
  senderSession: VerifiedPeerSession;
}): boolean {
  const { ack, expectedFamilyId, expectedSelfMemberId, senderSession } = params;
  if (
    !ack ||
    ack.v !== 1 ||
    ack.familyId !== expectedFamilyId ||
    ack.senderMemberId !== expectedSelfMemberId ||
    ack.recipientMemberId !== senderSession.memberId ||
    ack.recipientDeviceKeyId !== senderSession.deviceKeyId
  ) {
    return false;
  }
  const canonical = JSON.stringify({
    v: 1,
    familyId: ack.familyId,
    messageId: ack.messageId,
    senderMemberId: ack.senderMemberId,
    recipientMemberId: ack.recipientMemberId,
    recipientDeviceKeyId: ack.recipientDeviceKeyId,
    committedAt: ack.committedAt,
  });
  return verifyDetachedString(
    canonical,
    ack.signature,
    senderSession.deviceSignPublicKey
  );
}

export function checkOnboardingProofSignatureHelper(
  proof: AuthenticatedOnboardingProof,
  snapshot: RosterSnapshot
): boolean {
  return verifyModeratorDeviceAuthority(
    canonicalAuthenticatedOnboardingPayload(proof),
    proof.moderatorSignature,
    proof.authorizingModId,
    proof.authorizingDeviceKeyId,
    { ...snapshot, trustState: 'verified_current' }
  );
}

// --- Stage 2 Invite Input Formatting (Preserves Case & Invalid Characters) ---

function isInvitePayloadChar(ch: string): boolean {
  return INVITE_ALNUM_CHARS.includes(ch) || INVITE_SYMBOL_CHARS.includes(ch);
}

/**
 * Formats typed or pasted XXXX-XXXX-XXXX-XXXX family invite input while:
 * - Preserving exact case sensitivity (never uppercasing or lowercasing)
 * - Never stripping or mutating invalid characters into a different valid-looking code
 * - Auto-inserting hyphens only when characters form valid un-hyphenated 4-char blocks
 *   or progressive typing on an already valid XXXX-... prefix.
 */
export function formatInviteInputWithStage2Rules(val: string): string {
  if (typeof val !== 'string') return '';

  // Un-hyphenated input <= 16 chars where every character is valid: auto-group by 4
  if (!val.includes('-')) {
    if (val.length > 0 && val.length <= 16) {
      let allValid = true;
      for (const ch of val) {
        if (!isInvitePayloadChar(ch)) {
          allValid = false;
          break;
        }
      }
      if (allValid) {
        return val.match(/.{1,4}/g)?.join('-') ?? val;
      }
    }
    return val;
  }

  // Progressive typing after an already auto-dashed valid 4-char block prefix (e.g. "K7#m-Q2v!R" -> "K7#m-Q2v!-R")
  const parts = val.split('-');
  if (parts.length >= 2 && parts.length <= 4) {
    const prefixValid = parts
      .slice(0, -1)
      .every(
        (g) =>
          g.length === 4 && Array.from(g).every((ch) => isInvitePayloadChar(ch))
      );
    const tail = parts[parts.length - 1];
    const tailValid =
      tail.length >= 5 &&
      Array.from(tail).every((ch) => isInvitePayloadChar(ch));
    const totalPayloadLen = parts.reduce((acc, g) => acc + g.length, 0);
    if (prefixValid && tailValid && totalPayloadLen <= 16) {
      const rebuilt = `${parts.slice(0, -1).join('-')}-${tail.slice(0, 4)}-${tail.slice(4)}`;
      return rebuilt.slice(0, 19);
    }
  }

  // Preserve verbatim (including any invalid chars, wrong casing, wrong dash positions) so validator rejects explicitly
  return val;
}

// --- Signed 1:1 WebRTC Call Signaling Protocol ---

export type CallMediaType = 'audio' | 'video';
export type CallSignalKind =
  | 'call_invite'
  | 'call_accept'
  | 'call_reject'
  | 'call_hangup';

export interface CallSignalingFrameWire {
  v: 1;
  type: CallSignalKind;
  familyId: string;
  callId: string;
  mediaType: CallMediaType;
  senderMemberId: string;
  senderDeviceKeyId: string;
  recipientMemberId: string;
  timestamp: number;
  reason?: string;
  signature: string;
}

function canonicalCallSignalPayload(
  frame: Omit<CallSignalingFrameWire, 'signature'>
): string {
  return JSON.stringify({
    v: 1,
    type: frame.type,
    familyId: frame.familyId,
    callId: frame.callId,
    mediaType: frame.mediaType,
    senderMemberId: frame.senderMemberId,
    senderDeviceKeyId: frame.senderDeviceKeyId,
    recipientMemberId: frame.recipientMemberId,
    timestamp: frame.timestamp,
    reason: frame.reason ?? '',
  });
}

export function signCallSignalingFrame(params: {
  familyId: string;
  type: CallSignalKind;
  callId: string;
  mediaType: CallMediaType;
  senderIdentity: UserIdentity;
  recipientMemberId: string;
  reason?: string;
  timestamp?: number;
}): CallSignalingFrameWire {
  const {
    familyId,
    type,
    callId,
    mediaType,
    senderIdentity,
    recipientMemberId,
    reason,
  } = params;
  const senderMemberId =
    senderIdentity.memberId || senderIdentity.identityHash;
  if (!senderIdentity.deviceKeyId || !senderIdentity.deviceSignSecretKey) {
    throw new Error('Sender per-device signing credential missing for call');
  }
  const unsigned: Omit<CallSignalingFrameWire, 'signature'> = {
    v: 1,
    type,
    familyId,
    callId,
    mediaType,
    senderMemberId,
    senderDeviceKeyId: senderIdentity.deviceKeyId,
    recipientMemberId,
    timestamp: params.timestamp ?? Date.now(),
    ...(reason !== undefined ? { reason } : {}),
  };
  return {
    ...unsigned,
    signature: signDetachedString(
      canonicalCallSignalPayload(unsigned),
      senderIdentity.deviceSignSecretKey
    ),
  };
}

export function verifyCallSignalingFrame(params: {
  frame: CallSignalingFrameWire;
  expectedFamilyId: string;
  expectedSelfMemberId: string;
  senderSession: VerifiedPeerSession;
}): boolean {
  const { frame, expectedFamilyId, expectedSelfMemberId, senderSession } =
    params;
  if (
    !frame ||
    frame.v !== 1 ||
    !frame.callId ||
    (frame.mediaType !== 'audio' && frame.mediaType !== 'video') ||
    (frame.type !== 'call_invite' &&
      frame.type !== 'call_accept' &&
      frame.type !== 'call_reject' &&
      frame.type !== 'call_hangup') ||
    frame.familyId !== expectedFamilyId ||
    frame.recipientMemberId !== expectedSelfMemberId ||
    frame.senderMemberId !== senderSession.memberId ||
    frame.senderDeviceKeyId !== senderSession.deviceKeyId
  ) {
    return false;
  }
  return verifyDetachedString(
    canonicalCallSignalPayload(frame),
    frame.signature,
    senderSession.deviceSignPublicKey
  );
}

