/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type DeviceCredentialStatus = 'active' | 'revoked' | 'retired';

export interface DeviceCredentialRecord {
  deviceKeyId: string;
  memberId: string;
  boxPublicKey: string;
  deviceSignPublicKey: string; // Per-device Ed25519 key (cannot self-authorize new devices)
  rsaUserId: string;
  status: DeviceCredentialStatus;
  authorizedByModId: string;
  authorizedAtEpoch: number;
  revokedAtEpoch?: number;
  addedAt: number;
  retiredAt?: number;
}

export type MemberRole = 'founder' | 'moderator' | 'member';

export interface UserIdentity {
  identityHash: string;
  firstName: string;
  lastName: string;
  publicKey: string; // Base64 Curve25519 public key (per-device)
  secretKey: string; // Base64 Curve25519 secret key (per-device)
  signPublicKey?: string; // Base64 Ed25519 persistent member signing public key
  signSecretKey?: string; // Base64 Ed25519 persistent member signing secret key
  deviceSignPublicKey?: string; // Base64 Ed25519 per-device signing public key
  deviceSignSecretKey?: string; // Base64 Ed25519 per-device signing secret key
  memberId?: string; // Persistent human identity derived from persistent Ed25519 public key
  deviceKeyId?: string; // Per-device credential identifier (rotates on replacement phone)
  rsaPublicKeySpki?: string; // Base64 SPKI RSA key for Chitchatter ChatRoom
  rsaPrivateKeyPkcs8?: string; // Base64 PKCS8 RSA key for Chitchatter ChatRoom
  avatarDataUrl?: string; // Optional profile photo Data URL stored locally
  inviteCode: string; // Exact 16-meaningful-char shared family code (K7#m-Q2v!-R@9t-L4$x)
  created: number;
}

export interface FamilyMember {
  identityHash: string;
  firstName: string;
  lastName: string;
  publicKey: string;
  inviteCode: string;
  addedAt: number;
  isMuted?: boolean;
  isBlocked?: boolean;
  notes?: string;
  memberId?: string;
  signPublicKey?: string;
  deviceKeyIds?: string[];
  avatarDataUrl?: string;
  role?: MemberRole;
  joinedAtEpoch?: number;
  status?: 'active' | 'removed' | 'left';
  lastSeenAt?: number;
  broadcastAllowed?: boolean;
  broadcastBlocked?: boolean;
}

export type MessageStatus =
  | 'sending'
  | 'queued'
  | 'pending'
  | 'sent'
  | 'delivered'
  | 'failed';

export interface ChatMessage {
  id: string;
  chatId: string; // 'global' or peer's identityHash
  senderId: string;
  senderName: string;
  content: string;
  timestamp: number;
  status: MessageStatus;
  encrypted?: boolean;
  mediaType?: 'text' | 'image' | 'voice_note';
  mediaUrl?: string;
  lamportClock?: number;
  epoch?: number;
  mediaMimeType?: string;
  fileName?: string;
  fileSize?: number;
  isOnboardingContext?: boolean;
  failureReason?: string;
}

export type AuthorityState =
  | 'verified_current'
  | 'historical_unverified'
  | 'unused_default';

export type SnapshotTrustState = 'verified_current' | 'historical_unvalidated';

export interface FamilyGroupConfig {
  familyId: string;
  familyRoomId: string;
  groupSecretKey: string;
  inviteCode: string;
  epoch: number;
  founderId: string;
  joinedAtEpoch: number;
  isUnusedDefault: boolean;
  authorityState?: AuthorityState;
  historicalImportedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface RosterSnapshot {
  snapshotKey?: string; // `${familyId}:${epoch}:${stateHash}`
  familyId: string;
  founderId: string;
  epoch: number;
  prevSnapshotHash: string;
  inviteCommitment: string;
  stateHash: string;
  members: FamilyMember[];
  moderators: string[];
  devices: DeviceCredentialRecord[];
  broadcastAllowedIds: string[];
  broadcastBlockedIds: string[];
  revokedKeyIds: string[];
  clockVector: Record<string, number>;
  signerModId: string;
  signerDeviceKeyId: string;
  trustState?: SnapshotTrustState;
  signature: string;
}

export interface InviteAuthorizationCert {
  familyId: string;
  inviteCommitment: string;
  issuedAtEpoch: number;
  signerModId: string;
  signerDeviceKeyId: string;
  issuedAt: number;
  signature: string;
}

export interface PeerSessionBinding {
  familyId: string;
  epoch: number;
  memberId: string;
  deviceKeyId: string;
  boxPublicKey: string;
  deviceSignPublicKey: string;
  rsaUserId: string;
  ephemeralPeerId: string;
  issuedAt: number;
  expiresAt: number;
  signature: string;
}

export interface RotationEnvelope {
  familyId: string;
  fromEpoch: number;
  toEpoch: number;
  targetMemberId: string;
  targetDeviceKeyId: string;
  senderBoxPublicKey: string;
  nonce: string;
  ciphertext: string;
  signerModId: string;
  signerDeviceKeyId: string;
  signature: string;
}

export interface MigrationCheckpointEntry {
  checkpointKey: string; // `${familyId}:${fromEpoch}->${toEpoch}`
  familyId: string;
  fromEpoch: number;
  toEpoch: number;
  prevSnapshotHash: string;
  stateHash: string;
  snapshot: RosterSnapshot;
  sealedEnvelopesByDeviceKey: Record<string, RotationEnvelope>;
  ackedDeviceKeys: string[];
  createdAt: number;
}

export interface AuthenticatedOnboardingProof {
  familyId: string;
  epoch: number;
  admittedMemberId: string;
  admittedDeviceKeyId: string;
  authorizingModId: string;
  authorizingDeviceKeyId: string;
  permanentRoomId: string;
  challengeNonce: string;
  authenticatedAt: number;
  moderatorSignature: string;
}

export interface PendingAdoptionRecord {
  adoptionId: string;
  oldFamilyId: string;
  inviteCode: string;
  newFamilyConfig: FamilyGroupConfig;
  initialSnapshot: RosterSnapshot;
  initialContacts: FamilyMember[];
  onboardingMessages: ChatMessage[];
  status: 'pending_permanent_auth' | 'authenticated' | 'aborted';
  permanentAuthProof?: AuthenticatedOnboardingProof;
  createdAt: number;
}

export interface EncryptedMigrationArchive {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
}

export interface DeviceMigrationPayload {
  version: 1;
  exportedAt: number;
  identity: UserIdentity;
  familyConfig: FamilyGroupConfig | null;
  highestVerifiedEpoch: number;
  rosterSnapshots: RosterSnapshot[];
  contacts: FamilyMember[];
  messages: ChatMessage[];
  offlineQueue: ChatMessage[];
  migrationCheckpoints: MigrationCheckpointEntry[];
}

export type ImportMigrationMode = 'replace_device' | 'restore_same_device';

/**
 * Candidate device replacement request created on the replacement phone.
 * Explicitly NOT self-authorizing: peers reject this device until an active,
 * non-revoked moderator admits candidateDeviceKeyId in a signed RosterSnapshot.
 */
export interface PendingDeviceReplacementRequest {
  requestId: string;
  memberId: string;
  oldDeviceKeyId: string;
  candidateDeviceKeyId: string;
  candidateBoxPublicKey: string;
  candidateDeviceSignPublicKey: string;
  candidateRsaPublicKeySpki: string;
  selfAuthorized: false;
  authorizationStatus: 'pending_moderator_authorization';
  createdAt: number;
  candidateProofSignature: string;
  memberProofSignature?: string;
}

export interface ImportMigrationResult {
  mode: ImportMigrationMode;
  identity: UserIdentity;
  memberId: string;
  oldDeviceKeyId?: string;
  newDeviceKeyId: string;
  pendingReplacementRequest?: PendingDeviceReplacementRequest;
  authorityStatus:
    | 'historical_unvalidated'
    | 'preserved_higher_local'
    | 'preserved_equal_local'
    | 'quarantined_conflict_or_unvalidated_higher';
  comparedEpochScope: 'same_family' | 'no_local_same_family';
  preservedHigherLocalEpoch?: number;
  quarantinedSnapshotCount: number;
  importedContacts: number;
  importedHistoricalContacts: number;
  importedMessages: number;
  importedSnapshots: number;
}

export type PresenceState = 'online' | 'offline' | 'away';

// 3 Levels of Connection State
export type AppPresenceState = 'ONLINE' | 'IDLE' | 'BACKGROUND';
export type PeerPresence = 'ONLINE' | 'IDLE' | 'OFFLINE';
export type GroupMeetingState = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED';
export type PrivateChannelState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'ACTIVE_CHAT';

export interface ActiveCall {
  peer: FamilyMember;
  type: 'voice' | 'video';
  status: 'ringing' | 'connected' | 'ended';
  startedAt?: number;
  localStream?: MediaStream | null;
  remoteStream?: MediaStream | null;
  isMuted: boolean;
  isVideoEnabled: boolean;
}

export interface AppNotification {
  id: string;
  type: 'info' | 'success' | 'error';
  message: string;
  timestamp: number;
  onClick?: () => void;
  actionText?: string;
}

export type EarthyTheme =
  | 'theme-earthy-1'
  | 'theme-earthy-2'
  | 'theme-earthy-3'
  | 'theme-earthy-4'
  | 'theme-earthy-5';
