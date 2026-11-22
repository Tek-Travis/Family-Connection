/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ChatRoom } from 'core/chat/ChatRoom';
import { ChatRoomRegistry } from 'core/chat/ChatRoomRegistry';
import { ChatRoomEvent } from 'core/chat/events';
import { deriveUserId } from 'core/chat/identity';
import { EncryptionService, AllowedKeyType, encryption } from 'core/crypto/Encryption';
import { PeerAction } from 'core/models/network';
import { PeerVerificationState } from 'core/models/chat';
import { RoomConfig, TrysteroTransport } from 'core/transport/TrysteroTransport';
import {
  ActionNamespace,
  DataPayload,
  PeerStreamType,
  PeerTransport,
} from 'core/transport/types';
import { PlatformAdapters, LoggerAdapter } from 'core/adapters/types';
import { rtcConfig as defaultRtcConfig } from 'config/rtcConfig';
import { trackerUrls as defaultTrackerUrls } from 'config/trackerUrls';
import { messageCharacterSizeLimit } from 'core/config/messaging';
import { createWebPlatformAdapters } from '../adapters/web/webAdapters.ts';
import { StorageManager, storageManager } from '../storage/indexedDB.ts';
import {
  AppPresenceState,
  AuthenticatedOnboardingProof,
  ChatMessage,
  DeviceCredentialRecord,
  FamilyGroupConfig,
  FamilyMember,
  GroupMeetingState,
  MessageStatus,
  PeerPresence,
  PeerSessionBinding,
  PrivateChannelState,
  RosterSnapshot,
  UserIdentity,
} from '../types.ts';
import {
  createDefaultFamilyConfig,
  deriveInviteCommitment,
  deriveInviteRendezvousId,
  isAuthorizedActiveDevice,
  isAuthorizedModeratorDevice,
  isCredentialRevokedInSnapshots,
  saveIdentity,
  sha256Hex,
  signAuthenticatedOnboardingProof,
  signDetachedString,
  signRosterSnapshotWithModeratorDevice,
  upgradeLegacyIdentity,
  validateSharedInviteCode,
  verifyDetachedString,
  verifyRosterSnapshotAuthority,
} from '../crypto/cryptoUtils.ts';
import {
  AuthenticatedDirectEnvelopeWire,
  CallMediaType,
  CallSignalingFrameWire,
  DirectDeliveryAckWire,
  JoinInviteRequestWire,
  OnboardingOfferWire,
  OnboardingPermanentAuthReqWire,
  OnboardingPermanentAuthResWire,
  OnboardingRejectionWire,
  SealedOnboardingBundle,
  SignedGroupEnvelope,
  VerifiedPeerSession,
  checkOnboardingProofSignatureHelper,
  decryptGroupEnvelope,
  encryptGroupEnvelope,
  openOnboardingOffer,
  sealOnboardingOffer,
  signCallSignalingFrame,
  signDeliveryAck,
  signDirectEnvelope,
  signJoinInviteRequest,
  signPeerSessionBinding,
  verifyAndDecryptDirectEnvelope,
  verifyCallSignalingFrame,
  verifyDeliveryAck,
  verifyJoinInviteRequest,
  verifyPeerSessionBinding,
} from './familyProtocol.ts';

// Trystero action names MUST stay <= 12 characters (`${namespace}.${action}`)
const ACTION_SESSION_BIND = 'fc_bind' as unknown as PeerAction; // g.fc_bind (9)
const ACTION_ROSTER_SNAP = 'fc_snap' as unknown as PeerAction; // g.fc_snap (9)
const ACTION_PRESENCE = 'fc_pres' as unknown as PeerAction; // g.fc_pres (9)
const ACTION_GROUP_LARGE = 'fc_msg' as unknown as PeerAction; // g.fc_msg (8)
const ACTION_ONBOARD_REQ = 'fc_onb' as unknown as PeerAction; // g.fc_onb (8)
const ACTION_PERM_AUTH = 'fc_auth' as unknown as PeerAction; // g.fc_auth (9)
const ACTION_DM_E2EE = 'fc_e2ee' as unknown as PeerAction; // dm.fc_e2ee (10)
const ACTION_DM_ACK = 'fc_ack' as unknown as PeerAction; // dm.fc_ack (9)
const ACTION_CALL_SIG = 'fc_call' as unknown as PeerAction; // dm.fc_call (10)

function makeTypedAction<T>(
  transport: PeerTransport,
  action: PeerAction,
  namespace: ActionNamespace
): [
  (data: T, opts?: { target?: string }) => Promise<void>,
  (cb: (data: T, ctx: { peerId: string }) => void) => void,
  unknown,
  () => void,
] {
  const [send, connect, progress, disconnect] = transport.makeAction<DataPayload>(
    action,
    namespace
  );
  return [
    (data, opts) => send(data as unknown as DataPayload, opts),
    (cb) =>
      connect((payload, ctx) =>
        cb(payload as unknown as T, { peerId: ctx.peerId })
      ),
    progress,
    disconnect,
  ];
}

const DEFAULT_APP_ID = 'family-connection-chitchatter-v1';
const DEFAULT_ONBOARDING_TIMEOUT_MS = 12_000;
const PRESENCE_TIMEOUT_MS = 75_000;

export type StatusUpdateCallback = (update: {
  messageId: string;
  status: MessageStatus;
}) => void;
export type DirectMessageCallback = (message: ChatMessage) => void;
export type TrackCallback = (peerId: string, stream: MediaStream) => void;
export type ConnectionStateCallback = (
  peerId: string,
  state: 'connecting' | 'connected' | 'disconnected'
) => void;

export type CallState =
  | 'idle'
  | 'ringing_outgoing'
  | 'ringing_incoming'
  | 'connecting'
  | 'connected'
  | 'rejected'
  | 'failed'
  | 'ended';

export interface ActiveCallSession {
  callId: string;
  peerId: string;
  peerName: string;
  mediaType: CallMediaType;
  direction: 'outgoing' | 'incoming';
  state: CallState;
  muted: boolean;
  videoEnabled: boolean;
  errorReason?: string;
  startedAt: number;
  connectedAt?: number;
}

export type IncomingCallCallback = (call: ActiveCallSession) => void;
export type CallStateCallback = (call: ActiveCallSession) => void;

export interface ChitchatterFamilyBridgeOptions {
  storageManager?: StorageManager;
  transportFactory?: (config: RoomConfig, roomId: string) => PeerTransport;
  encryptionService?: EncryptionService;
  relayUrls?: string[];
  rtcConfig?: RTCConfiguration;
  appId?: string;
  autoListenInvite?: boolean;
  onboardingTimeoutMs?: number;
  disableFileTransfer?: boolean;
  logger?: Partial<LoggerAdapter>;
  saveIdentityFn?: (identity: UserIdentity) => void;
}

interface PendingJoinWaiter {
  resolve: (offer: OnboardingOfferWire) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPermAuthWaiter {
  resolve: (res: OnboardingPermanentAuthResWire) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActiveRoomSession {
  roomId: string;
  transport: PeerTransport;
  room: ChatRoom;
  cleanups: Array<() => void>;
  sendBind: (data: PeerSessionBinding, opts?: { target?: string }) => Promise<void>;
  sendSnap: (data: RosterSnapshot, opts?: { target?: string }) => Promise<void>;
  sendPresence: (
    data: { status: AppPresenceState; memberId: string; deviceKeyId: string; timestamp: number },
    opts?: { target?: string }
  ) => Promise<void>;
  sendLargeGroup: (data: SignedGroupEnvelope, opts?: { target?: string }) => Promise<void>;
  sendPermAuth: (
    data: OnboardingPermanentAuthReqWire | OnboardingPermanentAuthResWire,
    opts?: { target?: string }
  ) => Promise<void>;
  sendDirectE2EE: (
    data: AuthenticatedDirectEnvelopeWire,
    opts?: { target?: string }
  ) => Promise<void>;
  sendDirectAck: (
    data: DirectDeliveryAckWire,
    opts?: { target?: string }
  ) => Promise<void>;
  sendCallSig: (
    data: CallSignalingFrameWire,
    opts?: { target?: string }
  ) => Promise<void>;
}

/**
 * Policy-independent Chitchatter adaptation bridge for Family Connection.
 * Uses Chitchatter ChatRoom, ChatRoomRegistry, TrysteroTransport, and PlatformAdapters
 * wired into Stage 2 persistent member/device authority and IndexedDB storage.
 */
export class ChitchatterFamilyBridge extends EventTarget {
  private readonly storage: StorageManager;
  private readonly encryptionService: EncryptionService;
  private readonly adapters: PlatformAdapters;
  private readonly transportFactory: (config: RoomConfig, roomId: string) => PeerTransport;
  private readonly appId: string;
  private readonly relayUrls?: string[];
  private readonly rtcConfig: RTCConfiguration;
  private readonly autoListenInvite: boolean;
  private readonly onboardingTimeoutMs: number;
  private readonly saveIdentityFn: (identity: UserIdentity) => void;

  private readonly registry = new ChatRoomRegistry();

  private identity: UserIdentity | null = null;
  private rsaPublicKey: CryptoKey | null = null;
  private rsaPrivateKey: CryptoKey | null = null;
  private rsaUserId: string = '';

  private activeFamily: FamilyGroupConfig | null = null;
  private latestSnapshot: RosterSnapshot | null = null;
  private members = new Map<string, FamilyMember>();
  private lamportClock = 0;

  private activeSession: ActiveRoomSession | null = null;
  private rendezvousSession: {
    roomId: string;
    inviteCode: string;
    transport: PeerTransport;
    room: ChatRoom;
    cleanups: Array<() => void>;
    sendOnb: (
      data: JoinInviteRequestWire | OnboardingOfferWire | OnboardingRejectionWire,
      opts?: { target?: string }
    ) => Promise<void>;
  } | null = null;

  private verifiedByPeerId = new Map<string, VerifiedPeerSession>();
  private verifiedByMemberId = new Map<string, VerifiedPeerSession>();
  private pendingBindings = new Map<string, PeerSessionBinding>();
  private pendingInviteRequests = new Map<string, JoinInviteRequestWire>();
  private pendingJoinWaiters = new Map<string, PendingJoinWaiter>();
  private pendingPermAuthWaiters = new Map<string, PendingPermAuthWaiter>();
  private seenMessageIds = new Set<string>();
  private flushingMembers = new Set<string>();

  // Presence & UI compatibility state
  private appPowerState: AppPresenceState = 'ONLINE';
  private peerPresenceMap = new Map<string, { state: PeerPresence; lastSeen: number }>();
  private groupMeetingState: GroupMeetingState = 'DISCONNECTED';
  private privateChannelStates = new Map<string, PrivateChannelState>();
  private activeChatPeerId: string | null = null;
  private unreadCounts = new Map<string, number>();

  private statusCallbacks = new Set<StatusUpdateCallback>();
  private directMessageCallbacks = new Set<DirectMessageCallback>();
  private connectionStateCallbacks = new Set<ConnectionStateCallback>();
  private trackCallbacks = new Set<TrackCallback>();
  private incomingCallCallbacks = new Set<IncomingCallCallback>();
  private callStateCallbacks = new Set<CallStateCallback>();
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private activeCall: (ActiveCallSession & { targetEphemeralPeerId?: string }) | null = null;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleAttached = false;
  private destroyed = false;

  constructor(options: ChitchatterFamilyBridgeOptions = {}) {
    super();
    this.storage = options.storageManager ?? storageManager;
    this.encryptionService = options.encryptionService ?? encryption;
    this.appId = options.appId ?? DEFAULT_APP_ID;
    this.relayUrls = options.relayUrls ?? defaultTrackerUrls;
    this.rtcConfig = options.rtcConfig ?? defaultRtcConfig;
    this.autoListenInvite = options.autoListenInvite ?? true;
    this.onboardingTimeoutMs =
      options.onboardingTimeoutMs ?? DEFAULT_ONBOARDING_TIMEOUT_MS;
    this.saveIdentityFn = options.saveIdentityFn ?? saveIdentity;

    this.adapters = createWebPlatformAdapters({
      storageManager: this.storage,
      rtcConfig: this.rtcConfig,
      disableFileTransfer: options.disableFileTransfer,
      logger: options.logger,
    });

    this.transportFactory =
      options.transportFactory ??
      ((config, roomId) => new TrysteroTransport(config, roomId));
  }

  public getChatRoomRegistry(): ChatRoomRegistry {
    return this.registry;
  }

  public getActiveFamily(): FamilyGroupConfig | null {
    return this.activeFamily;
  }

  public getLatestSnapshot(): RosterSnapshot | null {
    return this.latestSnapshot;
  }

  public getVerifiedPeerSession(memberOrLegacyId: string): VerifiedPeerSession | null {
    const canonical = this.resolveCanonicalMemberId(memberOrLegacyId);
    return this.verifiedByMemberId.get(canonical) ?? null;
  }

  public getSelfPeerId(): string | null {
    return this.activeSession?.transport.selfId ?? null;
  }

  public getSelfRsaUserId(): string {
    return this.rsaUserId;
  }

  public getSelfMemberId(): string {
    if (!this.identity) return '';
    return this.identity.memberId || this.identity.identityHash;
  }

  public isSelfId(id: string | null | undefined): boolean {
    if (!id || !this.identity) return false;
    return (
      id === this.identity.identityHash ||
      (Boolean(this.identity.memberId) && id === this.identity.memberId)
    );
  }

  private memberAliases = new Map<string, Set<string>>();

  private registerMemberAlias(a?: string, b?: string): void {
    const ids = [a, b].filter((x): x is string => Boolean(x));
    if (ids.length === 0) return;
    const merged = new Set<string>(ids);
    for (const id of ids) {
      const existing = this.memberAliases.get(id);
      if (existing) {
        for (const alias of existing) merged.add(alias);
      }
    }
    for (const alias of merged) {
      this.memberAliases.set(alias, merged);
    }
  }

  private resolveMemberRecord(id: string): FamilyMember | undefined {
    const direct = this.members.get(id);
    if (direct) return direct;
    for (const member of this.members.values()) {
      if (member.identityHash === id || member.memberId === id) {
        return member;
      }
    }
    const aliases = this.memberAliases.get(id);
    if (aliases) {
      for (const alias of aliases) {
        const hit = this.members.get(alias);
        if (hit) return hit;
      }
    }
    return undefined;
  }

  public resolveCanonicalMemberId(id: string): string {
    if (!id) return id;
    if (this.isSelfId(id)) {
      return this.getSelfMemberId() || id;
    }
    const member = this.resolveMemberRecord(id);
    if (member) {
      return member.memberId || member.identityHash;
    }
    return id;
  }

  private getMemberIdAliases(id: string): string[] {
    if (!id) return [];
    if (this.isSelfId(id) && this.identity) {
      return Array.from(
        new Set(
          [id, this.identity.memberId, this.identity.identityHash].filter(
            (x): x is string => Boolean(x)
          )
        )
      );
    }
    const member = this.resolveMemberRecord(id);
    const canonical = member ? member.memberId || member.identityHash : id;
    const tracked = this.memberAliases.get(canonical) || this.memberAliases.get(id);
    return Array.from(
      new Set(
        [
          id,
          canonical,
          member?.memberId,
          member?.identityHash,
          ...(tracked ? Array.from(tracked) : []),
        ].filter((x): x is string => Boolean(x))
      )
    );
  }

  public isSameMember(
    idA: string | null | undefined,
    idB: string | null | undefined
  ): boolean {
    if (!idA || !idB) return false;
    if (idA === idB) return true;
    if (this.isSelfId(idA) && this.isSelfId(idB)) return true;

    const aliasesA = new Set(this.getMemberIdAliases(idA));
    if (aliasesA.has(idB)) return true;

    const mA = this.resolveMemberRecord(idA);
    const mB = this.resolveMemberRecord(idB);
    if (mA && mB) {
      return (mA.memberId || mA.identityHash) === (mB.memberId || mB.identityHash);
    }
    if (mA) {
      return mA.memberId === idB || mA.identityHash === idB;
    }
    if (mB) {
      return mB.memberId === idA || mB.identityHash === idA;
    }
    return false;
  }

  private upsertMemberInMemory(member: FamilyMember): boolean {
    const canonical = member.memberId || member.identityHash;
    this.registerMemberAlias(member.identityHash, member.memberId);

    const prevByCanonical = this.members.get(canonical);
    const prevByHash = this.members.get(member.identityHash);
    const prev = prevByCanonical || prevByHash;
    const existed = Boolean(prev);

    if (member.identityHash && member.identityHash !== canonical && this.members.has(member.identityHash)) {
      this.members.delete(member.identityHash);
    }
    const preservedIdentityHash =
      prev?.identityHash && prev.identityHash !== canonical
        ? prev.identityHash
        : member.identityHash;

    this.members.set(
      canonical,
      prev
        ? { ...prev, ...member, identityHash: preservedIdentityHash, memberId: canonical }
        : member
    );
    return !existed;
  }

  public hasActiveRendezvous(): boolean {
    return this.rendezvousSession !== null;
  }

  public getActiveRendezvousRoomId(): string | null {
    return this.rendezvousSession?.roomId ?? null;
  }

  private runAsyncSafe(context: string, p: Promise<unknown>): void {
    void p.catch((err) => {
      const normalized = err instanceof Error ? err : new Error(String(err));
      this.adapters.logger.warn(
        `Async bridge handler error (${context})`,
        normalized
      );
      this.dispatchEvent(
        new CustomEvent('bridge_error', {
          detail: {
            context,
            name: normalized.name,
            message: normalized.message,
          },
        })
      );
    });
  }

  public async init(rawIdentity: UserIdentity): Promise<void> {
    this.destroyed = false;
    await this.storage.init();

    const upgraded = await upgradeLegacyIdentity(rawIdentity);
    this.identity = upgraded;

    if (!upgraded.rsaPublicKeySpki || !upgraded.rsaPrivateKeyPkcs8) {
      throw new Error('Identity missing Chitchatter RSA credentials');
    }

    const [pubKey, privKey, rsaUid] = await Promise.all([
      this.encryptionService.parseCryptoKeyString(
        upgraded.rsaPublicKeySpki,
        AllowedKeyType.PUBLIC
      ),
      this.encryptionService.parseCryptoKeyString(
        upgraded.rsaPrivateKeyPkcs8,
        AllowedKeyType.PRIVATE
      ),
      deriveUserId(upgraded.rsaPublicKeySpki),
    ]);
    this.rsaPublicKey = pubKey;
    this.rsaPrivateKey = privKey;
    this.rsaUserId = rsaUid;

    const selfMemberId = upgraded.memberId || upgraded.identityHash;

    // Load or initialize FamilyGroupConfig & RosterSnapshot
    let fam = await this.storage.getActiveFamilyConfig();
    if (!fam) {
      fam = await createDefaultFamilyConfig(upgraded);
      await this.storage.saveFamilyConfig(fam);
    }
    this.activeFamily = fam;

    let snap = await this.storage.getLatestRosterSnapshot(fam.familyId);
    if (!snap) {
      snap = await this.createInitialFounderSnapshot(fam, upgraded);
      await this.storage.saveRosterSnapshot(snap);
      await this.storage.setHighestVerifiedEpoch(fam.familyId, snap.epoch);
    }
    this.latestSnapshot = snap;

    // Preserve offline saved contacts in local member registry (indexed by canonical memberId || identityHash)
    this.members.clear();
    const contacts = await this.storage.getContacts();
    for (const c of contacts) {
      this.upsertMemberInMemory(c);
    }

    // Seed deduplication cache & lamport clock from persistent storage
    const allMsgs = await this.storage.getAllMessages();
    for (const m of allMsgs) {
      this.seenMessageIds.add(m.id);
      if (typeof m.lamportClock === 'number' && m.lamportClock > this.lamportClock) {
        this.lamportClock = m.lamportClock;
      }
    }

    // Start permanent Chitchatter group room
    await this.openPermanentSession(fam, upgraded);

    // Automatically listen on family invite rendezvous when this device is an authorized moderator
    if (
      this.autoListenInvite &&
      validateSharedInviteCode(fam.inviteCode) &&
      isAuthorizedModeratorDevice(
        { ...snap, trustState: 'verified_current' },
        selfMemberId,
        upgraded.deviceKeyId!
      )
    ) {
      await this.ensureRendezvousListening(fam.inviteCode);
    }

    this.setupLifecycleAndPresence();
    this.setGroupMeetingState('CONNECTED');
  }

  private async createInitialFounderSnapshot(
    fam: FamilyGroupConfig,
    identity: UserIdentity
  ): Promise<RosterSnapshot> {
    const selfMemberId = identity.memberId || identity.identityHash;
    const selfMember: FamilyMember = {
      identityHash: identity.identityHash,
      memberId: selfMemberId,
      firstName: identity.firstName,
      lastName: identity.lastName,
      publicKey: identity.publicKey,
      signPublicKey: identity.signPublicKey,
      deviceKeyIds: [identity.deviceKeyId!],
      inviteCode: fam.inviteCode,
      addedAt: fam.createdAt,
      role: 'founder',
      joinedAtEpoch: 1,
      status: 'active',
    };
    const selfDevice: DeviceCredentialRecord = {
      deviceKeyId: identity.deviceKeyId!,
      memberId: selfMemberId,
      boxPublicKey: identity.publicKey,
      deviceSignPublicKey: identity.deviceSignPublicKey!,
      rsaUserId: this.rsaUserId,
      status: 'active',
      authorizedByModId: selfMemberId,
      authorizedAtEpoch: 1,
      addedAt: fam.createdAt,
    };
    const inviteCommitment = await deriveInviteCommitment(fam.inviteCode);
    const stateHash = await sha256Hex(
      `fc:state:${fam.familyId}:1:${selfMemberId}:${identity.deviceKeyId}`
    );
    return signRosterSnapshotWithModeratorDevice(
      {
        snapshotKey: `${fam.familyId}:1:${stateHash}`,
        familyId: fam.familyId,
        founderId: fam.founderId,
        epoch: 1,
        prevSnapshotHash: 'genesis',
        inviteCommitment,
        stateHash,
        members: [selfMember],
        moderators: [selfMemberId],
        devices: [selfDevice],
        broadcastAllowedIds: [selfMemberId],
        broadcastBlockedIds: [],
        revokedKeyIds: [],
        clockVector: { [selfMemberId]: 1 },
        signerModId: selfMemberId,
        signerDeviceKeyId: identity.deviceKeyId!,
        trustState: fam.isUnusedDefault ? 'verified_current' : 'verified_current',
      },
      identity
    );
  }

  private buildRoomConfig(password?: string): RoomConfig {
    const config: RoomConfig = {
      appId: this.appId,
      rtcConfig: this.rtcConfig,
    };
    if (password) {
      config.password = password;
    }
    if (this.relayUrls && this.relayUrls.length > 0) {
      config.relayConfig = {
        urls: this.relayUrls,
        warnOnRelayFailure: false,
      };
    }
    return config;
  }

  private async closeActiveSession(): Promise<void> {
    if (!this.activeSession) return;
    const session = this.activeSession;
    this.activeSession = null;

    for (const unsub of session.cleanups) {
      try {
        unsub();
      } catch {
        // Ignore cleanup hook errors
      }
    }
    this.verifiedByPeerId.clear();
    this.verifiedByMemberId.clear();
    this.pendingBindings.clear();

    await this.registry.clearDirect();
    this.registry.setGroup(null);
    await session.room.leave();
    session.transport.leaveRoom();
  }

  private async openPermanentSession(
    fam: FamilyGroupConfig,
    identity: UserIdentity
  ): Promise<ActiveRoomSession> {
    await this.closeActiveSession();
    if (!this.rsaPublicKey || !this.rsaPrivateKey) {
      throw new Error('RSA keys not parsed');
    }

    const roomConfig = this.buildRoomConfig(fam.groupSecretKey);
    const transport = this.transportFactory(roomConfig, fam.familyRoomId);
    const displayName = `${identity.firstName} ${identity.lastName}`.trim();

    const room = new ChatRoom({
      roomId: fam.familyRoomId,
      userId: this.rsaUserId,
      customUsername: displayName,
      publicKey: this.rsaPublicKey,
      privateKey: this.rsaPrivateKey,
      password: fam.groupSecretKey,
      transport,
      adapters: this.adapters,
    });

    const [sendBind, onBind, , offBind] = makeTypedAction<PeerSessionBinding>(
      transport,
      ACTION_SESSION_BIND,
      ActionNamespace.GROUP
    );
    const [sendSnap, onSnap, , offSnap] = makeTypedAction<RosterSnapshot>(
      transport,
      ACTION_ROSTER_SNAP,
      ActionNamespace.GROUP
    );
    const [sendPresence, onPresence, , offPresence] = makeTypedAction<{
      status: AppPresenceState;
      memberId: string;
      deviceKeyId: string;
      timestamp: number;
    }>(transport, ACTION_PRESENCE, ActionNamespace.GROUP);
    const [sendLargeGroup, onLargeGroup, , offLargeGroup] =
      makeTypedAction<SignedGroupEnvelope>(
        transport,
        ACTION_GROUP_LARGE,
        ActionNamespace.GROUP
      );
    const [sendPermAuth, onPermAuth, , offPermAuth] = makeTypedAction<
      OnboardingPermanentAuthReqWire | OnboardingPermanentAuthResWire
    >(transport, ACTION_PERM_AUTH, ActionNamespace.GROUP);
    const [sendDirectE2EE, onDirectE2EE, , offDirectE2EE] =
      makeTypedAction<AuthenticatedDirectEnvelopeWire>(
        transport,
        ACTION_DM_E2EE,
        ActionNamespace.DIRECT_MESSAGE
      );
    const [sendDirectAck, onDirectAck, , offDirectAck] =
      makeTypedAction<DirectDeliveryAckWire>(
        transport,
        ACTION_DM_ACK,
        ActionNamespace.DIRECT_MESSAGE
      );
    const [sendCallSig, onCallSig, , offCallSig] =
      makeTypedAction<CallSignalingFrameWire>(
        transport,
        ACTION_CALL_SIG,
        ActionNamespace.DIRECT_MESSAGE
      );

    const session: ActiveRoomSession = {
      roomId: fam.familyRoomId,
      transport,
      room,
      cleanups: [
        offBind,
        offSnap,
        offPresence,
        offLargeGroup,
        offPermAuth,
        offDirectE2EE,
        offDirectAck,
        offCallSig,
      ],
      sendBind: (d, opts) => sendBind(d, opts),
      sendSnap: (d, opts) => sendSnap(d, opts),
      sendPresence: (d, opts) => sendPresence(d, opts),
      sendLargeGroup: (d, opts) => sendLargeGroup(d, opts),
      sendPermAuth: (d, opts) => sendPermAuth(d, opts),
      sendDirectE2EE: (d, opts) => sendDirectE2EE(d, opts),
      sendDirectAck: (d, opts) => sendDirectAck(d, opts),
      sendCallSig: (d, opts) => sendCallSig(d, opts),
    };

    this.activeSession = session;
    this.registry.setGroup(room);

    // Wire Chitchatter media stream hook scoped to verified peers & active 1:1 calls
    if ('onPeerStream' in transport && typeof transport.onPeerStream === 'function') {
      (transport as TrysteroTransport).onPeerStream(
        PeerStreamType.AUDIO,
        (stream: MediaStream, peerId: string, metadata?: unknown) => {
          this.handleIncomingPeerStream(stream, peerId, metadata);
        }
      );
    }

    onBind((binding, { peerId }) => {
      this.pendingBindings.set(peerId, binding);
      this.runAsyncSafe('tryFinalizePeerBinding', this.tryFinalizePeerBinding(peerId));
    });

    onSnap((snap, { peerId }) => {
      this.runAsyncSafe(
        'handleIncomingSnapshot',
        this.handleIncomingSnapshot(snap, peerId)
      );
    });

    onPresence((pres, { peerId }) => {
      this.handleIncomingPresence(pres, peerId);
    });

    onLargeGroup((env, { peerId }) => {
      this.runAsyncSafe(
        'handleIncomingGroupEnvelope',
        this.handleIncomingGroupEnvelope(env, peerId)
      );
    });

    onPermAuth((frame, { peerId }) => {
      this.runAsyncSafe(
        'handlePermanentAuthFrame',
        this.handlePermanentAuthFrame(frame, peerId)
      );
    });

    onDirectE2EE((env, { peerId }) => {
      this.runAsyncSafe(
        'handleIncomingDirectEnvelope',
        this.handleIncomingDirectEnvelope(env, peerId)
      );
    });

    onDirectAck((ack, { peerId }) => {
      this.runAsyncSafe(
        'handleIncomingDeliveryAck',
        this.handleIncomingDeliveryAck(ack, peerId)
      );
    });

    onCallSig((frame, { peerId }) => {
      this.runAsyncSafe(
        'handleIncomingCallSignal',
        this.handleIncomingCallSignal(frame, peerId)
      );
    });

    const unsubPeerJoin = room.on(ChatRoomEvent.PEER_JOIN, ({ peerId }) => {
      if (this.activeSession !== session) return;
      this.runAsyncSafe(
        'sendOwnSessionBinding',
        this.sendOwnSessionBinding(session, peerId)
      );
    });

    const unsubPeerVerif = room.on(
      ChatRoomEvent.PEER_VERIFICATION,
      ({ peerId, verificationState }) => {
        if (this.activeSession !== session) return;
        if (verificationState === PeerVerificationState.VERIFIED) {
          this.runAsyncSafe(
            'sendOwnSessionBinding',
            this.sendOwnSessionBinding(session, peerId)
          );
          this.runAsyncSafe(
            'tryFinalizePeerBinding',
            this.tryFinalizePeerBinding(peerId)
          );
        } else if (verificationState === PeerVerificationState.UNVERIFIED) {
          this.dropPeerSession(peerId);
        }
      }
    );

    const unsubPeerLeave = room.on(ChatRoomEvent.PEER_LEAVE, ({ peerId }) => {
      if (this.activeSession !== session) return;
      this.dropPeerSession(peerId);
    });

    const unsubRoomMsg = room.on(
      ChatRoomEvent.MESSAGE_RECEIVED,
      ({ message, peerId }) => {
        if (this.activeSession !== session) return;
        if (!('text' in message)) return;
        try {
          const parsed = JSON.parse(message.text) as SignedGroupEnvelope;
          this.runAsyncSafe(
            'handleIncomingGroupEnvelope',
            this.handleIncomingGroupEnvelope(parsed, peerId)
          );
        } catch {
          // Non-signed/malformed frame ignored cleanly
        }
      }
    );

    const unsubRoomErr = room.on(ChatRoomEvent.ERROR, ({ error, context }) => {
      this.adapters.logger.warn(`ChatRoom error (${context})`, error);
    });

    session.cleanups.push(
      unsubPeerJoin,
      unsubPeerVerif,
      unsubPeerLeave,
      unsubRoomMsg,
      unsubRoomErr
    );

    await room.join();
    return session;
  }

  private async sendOwnSessionBinding(
    session: ActiveRoomSession,
    targetPeerId?: string
  ): Promise<void> {
    if (!this.identity || !this.activeFamily) return;
    const binding = signPeerSessionBinding({
      identity: this.identity,
      rsaUserId: this.rsaUserId,
      ephemeralPeerId: session.transport.selfId,
      familyId: this.activeFamily.familyId,
      epoch: this.latestSnapshot?.epoch ?? this.activeFamily.epoch,
    });
    await session.sendBind(
      binding,
      targetPeerId ? { target: targetPeerId } : undefined
    );
  }

  private async tryFinalizePeerBinding(peerId: string): Promise<void> {
    const session = this.activeSession;
    if (!session || !this.activeFamily || !this.latestSnapshot || !this.identity) {
      return;
    }

    const binding = this.pendingBindings.get(peerId);
    if (!binding) return;

    const chatPeer = session.room.getPeers().find((p) => p.peerId === peerId);
    if (!chatPeer || chatPeer.verificationState !== PeerVerificationState.VERIFIED) {
      return;
    }

    const res = verifyPeerSessionBinding({
      binding,
      expectedFamilyId: this.activeFamily.familyId,
      expectedLivePeerId: peerId,
      expectedRsaUserId: chatPeer.userId,
      authoritativeSnapshot: {
        ...this.latestSnapshot,
        trustState: 'verified_current',
      },
    });

    if (!res.valid) {
      this.adapters.logger.warn(`Rejected peer session binding (${res.reason || 'invalid'})`);
      this.dropPeerSession(peerId);
      this.dispatchEvent(
        new CustomEvent('peer_binding_rejected', {
          detail: { peerId, reason: res.reason },
        })
      );
      return;
    }

    const verifiedSession: VerifiedPeerSession = {
      memberId: binding.memberId,
      deviceKeyId: binding.deviceKeyId,
      boxPublicKey: binding.boxPublicKey,
      deviceSignPublicKey: binding.deviceSignPublicKey,
      rsaUserId: binding.rsaUserId,
      ephemeralPeerId: peerId,
      familyId: binding.familyId,
      epoch: binding.epoch,
      verifiedAt: Date.now(),
    };

    this.verifiedByPeerId.set(peerId, verifiedSession);
    this.verifiedByMemberId.set(binding.memberId, verifiedSession);

    // Open Chitchatter direct-message ChatRoom scoped to this authenticated peer
    if (
      !this.registry.getDirect(peerId) &&
      this.rsaPublicKey &&
      this.rsaPrivateKey
    ) {
      const dmRoom = new ChatRoom({
        roomId: `${this.activeFamily.familyRoomId}:dm:${binding.memberId}`,
        userId: this.rsaUserId,
        customUsername: `${this.identity.firstName} ${this.identity.lastName}`.trim(),
        publicKey: this.rsaPublicKey,
        privateKey: this.rsaPrivateKey,
        password: this.activeFamily.groupSecretKey,
        targetPeerId: peerId,
        transport: session.transport,
        adapters: this.adapters,
      });
      this.registry.setDirect(peerId, dmRoom);
      await dmRoom.join();
    }

    // Update presence and private connection state
    this.peerPresenceMap.set(binding.memberId, {
      state: 'ONLINE',
      lastSeen: Date.now(),
    });
    const nextPrivState: PrivateChannelState =
      this.activeChatPeerId === binding.memberId ? 'ACTIVE_CHAT' : 'CONNECTED';
    this.privateChannelStates.set(binding.memberId, nextPrivState);

    this.dispatchEvent(
      new CustomEvent('presence_change', {
        detail: { contactId: binding.memberId, state: 'ONLINE' },
      })
    );
    this.dispatchEvent(
      new CustomEvent('connection_state_change', {
        detail: { contactId: binding.memberId, state: nextPrivState },
      })
    );
    this.connectionStateCallbacks.forEach((cb) => cb(binding.memberId, 'connected'));

    // Flush any sender-queued offline DMs for this authenticated member
    await this.flushOfflineQueue(binding.memberId);

    // Check if any permanent onboarding auth request was waiting on this binding
    const waitingPermReq = this.pendingPermReqByPeer.get(peerId);
    if (waitingPermReq) {
      this.pendingPermReqByPeer.delete(peerId);
      await this.handlePermanentAuthFrame(waitingPermReq, peerId);
    }
  }

  private pendingPermReqByPeer = new Map<string, OnboardingPermanentAuthReqWire>();

  private dropPeerSession(peerId: string): void {
    this.pendingBindings.delete(peerId);
    this.pendingPermReqByPeer.delete(peerId);
    const existing = this.verifiedByPeerId.get(peerId);
    if (!existing) return;

    this.verifiedByPeerId.delete(peerId);
    const current = this.verifiedByMemberId.get(existing.memberId);
    if (current?.ephemeralPeerId === peerId) {
      this.verifiedByMemberId.delete(existing.memberId);
      this.peerPresenceMap.set(existing.memberId, {
        state: 'OFFLINE',
        lastSeen: Date.now(),
      });
      this.privateChannelStates.set(existing.memberId, 'DISCONNECTED');
      this.dispatchEvent(
        new CustomEvent('presence_change', {
          detail: { contactId: existing.memberId, state: 'OFFLINE' },
        })
      );
      this.dispatchEvent(
        new CustomEvent('connection_state_change', {
          detail: { contactId: existing.memberId, state: 'DISCONNECTED' },
        })
      );
      this.connectionStateCallbacks.forEach((cb) =>
        cb(existing.memberId, 'disconnected')
      );

      // Tear down any active 1:1 call tied to this peer session cleanly
      if (this.activeCall && this.isSameMember(this.activeCall.peerId, existing.memberId)) {
        this.cleanupActiveCall('failed', 'Peer disconnected or session revoked');
      }
    }
  }

  private async handleIncomingSnapshot(
    candidate: RosterSnapshot,
    peerId: string
  ): Promise<void> {
    if (!this.activeFamily || !this.latestSnapshot || !this.identity) return;
    const senderSession = this.verifiedByPeerId.get(peerId);
    if (!senderSession) return;
    if (candidate.familyId !== this.activeFamily.familyId) return;
    if (
      !verifyRosterSnapshotAuthority(candidate, {
        ...this.latestSnapshot,
        trustState: 'verified_current',
      })
    ) {
      this.adapters.logger.warn('Rejected unauthorized RosterSnapshot update');
      return;
    }

    const storedSnap: RosterSnapshot = {
      ...candidate,
      trustState: 'verified_current',
      snapshotKey:
        candidate.snapshotKey ||
        `${candidate.familyId}:${candidate.epoch}:${candidate.stateHash}`,
    };
    await this.storage.saveRosterSnapshot(storedSnap);
    await this.storage.setHighestVerifiedEpoch(
      this.activeFamily.familyId,
      storedSnap.epoch
    );
    this.latestSnapshot = storedSnap;

    const updatedFamily: FamilyGroupConfig = {
      ...this.activeFamily,
      epoch: storedSnap.epoch,
      isUnusedDefault: false,
      authorityState: 'verified_current',
      updatedAt: Date.now(),
    };
    await this.storage.saveFamilyConfig(updatedFamily);
    this.activeFamily = updatedFamily;

    for (const m of storedSnap.members) {
      if (this.isSelfId(m.identityHash) || (m.memberId && this.isSelfId(m.memberId))) {
        continue;
      }
      const canonical = m.memberId || m.identityHash;
      const existingRec =
        this.resolveMemberRecord(canonical) ||
        this.resolveMemberRecord(m.identityHash);
      if (m.status === 'removed' || m.status === 'left') {
        this.members.delete(canonical);
        this.members.delete(m.identityHash);
        await this.storage.removeContact(existingRec?.identityHash || m.identityHash);
      } else {
        const normalizedMember: FamilyMember =
          existingRec?.identityHash && existingRec.identityHash !== canonical
            ? { ...m, identityHash: existingRec.identityHash, memberId: canonical }
            : m;
        const isNew = this.upsertMemberInMemory(normalizedMember);
        await this.storage.saveContact(normalizedMember);
        if (isNew) {
          this.dispatchEvent(
            new CustomEvent('member_added', { detail: normalizedMember })
          );
        }
      }
    }

    // Re-evaluate connected sessions against updated revocations
    for (const [connectedPeerId, sess] of [...this.verifiedByPeerId.entries()]) {
      if (
        !isAuthorizedActiveDevice(
          storedSnap,
          sess.memberId,
          sess.deviceKeyId
        )
      ) {
        this.dropPeerSession(connectedPeerId);
      }
    }
  }

  public async publishModeratorSnapshot(
    snapshot: RosterSnapshot
  ): Promise<void> {
    if (!this.activeFamily || !this.latestSnapshot) {
      throw new Error('Bridge session not initialized');
    }
    if (snapshot.familyId !== this.activeFamily.familyId) {
      throw new Error('Snapshot familyId mismatch');
    }
    if (
      !verifyRosterSnapshotAuthority(snapshot, {
        ...this.latestSnapshot,
        trustState: 'verified_current',
      })
    ) {
      throw new Error('Snapshot failed moderator authority verification');
    }

    const storedSnap: RosterSnapshot = {
      ...snapshot,
      trustState: 'verified_current',
      snapshotKey:
        snapshot.snapshotKey ||
        `${snapshot.familyId}:${snapshot.epoch}:${snapshot.stateHash}`,
    };
    await this.storage.saveRosterSnapshot(storedSnap);
    await this.storage.setHighestVerifiedEpoch(
      this.activeFamily.familyId,
      storedSnap.epoch
    );
    this.latestSnapshot = storedSnap;

    const updatedFamily: FamilyGroupConfig = {
      ...this.activeFamily,
      epoch: storedSnap.epoch,
      isUnusedDefault: false,
      authorityState: 'verified_current',
      updatedAt: Date.now(),
    };
    await this.storage.saveFamilyConfig(updatedFamily);
    this.activeFamily = updatedFamily;

    for (const [connectedPeerId, sess] of [...this.verifiedByPeerId.entries()]) {
      if (
        !isAuthorizedActiveDevice(
          storedSnap,
          sess.memberId,
          sess.deviceKeyId
        )
      ) {
        this.dropPeerSession(connectedPeerId);
      }
    }

    await this.activeSession?.sendSnap(storedSnap);
  }

  private handleIncomingPresence(
    pres: {
      status: AppPresenceState;
      memberId: string;
      deviceKeyId: string;
      timestamp: number;
    },
    peerId: string
  ): void {
    const senderSession = this.verifiedByPeerId.get(peerId);
    if (!senderSession || senderSession.memberId !== pres.memberId) return;

    const peerStatus: PeerPresence =
      pres.status === 'BACKGROUND' || pres.status === 'IDLE' ? 'IDLE' : 'ONLINE';
    const prev = this.peerPresenceMap.get(senderSession.memberId);
    this.peerPresenceMap.set(senderSession.memberId, {
      state: peerStatus,
      lastSeen: Date.now(),
    });
    if (prev?.state !== peerStatus) {
      this.dispatchEvent(
        new CustomEvent('presence_change', {
          detail: { contactId: senderSession.memberId, state: peerStatus },
        })
      );
      void this.flushOfflineQueue(senderSession.memberId);
    }
  }

  // =========================================================================
  // INVITE RENDEZVOUS, AUTOMATIC ADMISSION & TWO-PHASE ONBOARDING
  // =========================================================================

  private async cleanupRendezvous(): Promise<void> {
    if (!this.rendezvousSession) return;
    const r = this.rendezvousSession;
    this.rendezvousSession = null;

    for (const unsub of r.cleanups) {
      try {
        unsub();
      } catch {
        // Ignore cleanup failure
      }
    }
    this.pendingInviteRequests.clear();
    await r.room.leave();
    r.transport.leaveRoom();
  }

  private async ensureRendezvousListening(inviteCode: string): Promise<void> {
    if (!this.identity || !this.rsaPublicKey || !this.rsaPrivateKey) return;
    const cleanCode = inviteCode.trim();
    if (!validateSharedInviteCode(cleanCode)) return;

    const rendezvousRoomId = await deriveInviteRendezvousId(cleanCode);
    if (this.rendezvousSession?.roomId === rendezvousRoomId) return;

    await this.cleanupRendezvous();

    const transport = this.transportFactory(
      this.buildRoomConfig(rendezvousRoomId),
      rendezvousRoomId
    );
    const room = new ChatRoom({
      roomId: rendezvousRoomId,
      userId: this.rsaUserId,
      customUsername: `${this.identity.firstName} ${this.identity.lastName}`.trim(),
      publicKey: this.rsaPublicKey,
      privateKey: this.rsaPrivateKey,
      password: rendezvousRoomId,
      transport,
      adapters: this.adapters,
    });

    const [sendOnb, onOnb, , offOnb] = makeTypedAction<
      JoinInviteRequestWire | OnboardingOfferWire | OnboardingRejectionWire
    >(transport, ACTION_ONBOARD_REQ, ActionNamespace.GROUP);

    const sessionRef = {
      roomId: rendezvousRoomId,
      inviteCode: cleanCode,
      transport,
      room,
      cleanups: [offOnb] as Array<() => void>,
      sendOnb: (
        d: JoinInviteRequestWire | OnboardingOfferWire | OnboardingRejectionWire,
        opts?: { target?: string }
      ) => sendOnb(d, opts),
    };
    this.rendezvousSession = sessionRef;

    onOnb((frame, { peerId }) => {
      if (this.rendezvousSession !== sessionRef) return;
      if (frame.type === 'join_invite_request') {
        this.pendingInviteRequests.set(peerId, frame);
        void this.tryProcessJoinInviteRequest(peerId);
      } else if (frame.type === 'onboarding_offer') {
        const waiter = this.pendingJoinWaiters.get(frame.requestId);
        if (waiter) {
          this.pendingJoinWaiters.delete(frame.requestId);
          clearTimeout(waiter.timer);
          waiter.resolve(frame);
        }
      } else if (frame.type === 'onboarding_rejected') {
        const waiter = this.pendingJoinWaiters.get(frame.requestId);
        if (waiter) {
          this.pendingJoinWaiters.delete(frame.requestId);
          clearTimeout(waiter.timer);
          waiter.reject(new Error(frame.reason || 'Onboarding rejected'));
        }
      }
    });

    const unsubVerif = room.on(
      ChatRoomEvent.PEER_VERIFICATION,
      ({ peerId, verificationState }) => {
        if (this.rendezvousSession !== sessionRef) return;
        if (verificationState === PeerVerificationState.VERIFIED) {
          void this.tryProcessJoinInviteRequest(peerId);
        }
      }
    );

    const unsubJoin = room.on(ChatRoomEvent.PEER_JOIN, ({ peerId }) => {
      if (this.rendezvousSession !== sessionRef) return;
      this.dispatchEvent(
        new CustomEvent('rendezvous_peer_joined', { detail: { peerId } })
      );
    });

    sessionRef.cleanups.push(unsubVerif, unsubJoin);
    await room.join();
  }

  private async tryProcessJoinInviteRequest(peerId: string): Promise<void> {
    const r = this.rendezvousSession;
    if (
      !r ||
      !this.identity ||
      !this.activeFamily ||
      !this.latestSnapshot
    ) {
      return;
    }
    const req = this.pendingInviteRequests.get(peerId);
    if (!req) return;

    const chatPeer = r.room.getPeers().find((p) => p.peerId === peerId);
    if (!chatPeer || chatPeer.verificationState !== PeerVerificationState.VERIFIED) {
      return;
    }

    this.pendingInviteRequests.delete(peerId);

    try {
      const expectedCommitment = await deriveInviteCommitment(r.inviteCode);
      if (
        chatPeer.userId !== req.candidateMember.rsaUserId ||
        !verifyJoinInviteRequest(req, peerId, expectedCommitment)
      ) {
        await r.sendOnb(
          {
            type: 'onboarding_rejected',
            requestId: req.requestId,
            reason: 'Invalid invite request or RSA session mismatch',
          },
          { target: peerId }
        );
        return;
      }

      const selfMemberId = this.identity.memberId || this.identity.identityHash;
      const snapView: RosterSnapshot = {
        ...this.latestSnapshot,
        trustState: 'verified_current',
      };
      if (
        !isAuthorizedModeratorDevice(
          snapView,
          selfMemberId,
          this.identity.deviceKeyId!
        )
      ) {
        return; // Not an authorized moderator device; stay passive
      }

      if (
        isCredentialRevokedInSnapshots(
          [snapView],
          req.candidateMember.memberId,
          req.candidateMember.deviceKeyId
        )
      ) {
        await r.sendOnb(
          {
            type: 'onboarding_rejected',
            requestId: req.requestId,
            reason: 'Member or device credential is revoked',
          },
          { target: peerId }
        );
        return;
      }

      // Automatic valid-code admission (no manual approval prompt)
      const now = Date.now();
      const nextEpoch = snapView.epoch + 1;
      const existingMemberIdx = snapView.members.findIndex(
        (m) =>
          m.memberId === req.candidateMember.memberId ||
          m.identityHash === req.candidateMember.memberId
      );
      const existingLocalMember = this.resolveMemberRecord(
        req.candidateMember.memberId
      );
      const existingSnapMember =
        existingMemberIdx >= 0 ? snapView.members[existingMemberIdx] : undefined;
      const preservedIdentityHash =
        existingLocalMember?.identityHash ||
        existingSnapMember?.identityHash ||
        req.candidateMember.memberId;

      const newMember: FamilyMember = {
        identityHash: preservedIdentityHash,
        memberId: req.candidateMember.memberId,
        firstName: req.candidateMember.firstName,
        lastName: req.candidateMember.lastName,
        publicKey: req.candidateMember.boxPublicKey,
        deviceKeyIds: [req.candidateMember.deviceKeyId],
        inviteCode: r.inviteCode,
        addedAt: now,
        role: 'member',
        joinedAtEpoch: nextEpoch,
        status: 'active',
      };

      const updatedMembers = [...snapView.members];
      if (existingMemberIdx >= 0) {
        updatedMembers[existingMemberIdx] = {
          ...updatedMembers[existingMemberIdx],
          ...newMember,
          deviceKeyIds: Array.from(
            new Set([
              ...(updatedMembers[existingMemberIdx].deviceKeyIds || []),
              req.candidateMember.deviceKeyId,
            ])
          ),
        };
      } else {
        updatedMembers.push(newMember);
      }

      const updatedDevices = [
        ...snapView.devices.filter(
          (d) => d.deviceKeyId !== req.candidateMember.deviceKeyId
        ),
        {
          deviceKeyId: req.candidateMember.deviceKeyId,
          memberId: req.candidateMember.memberId,
          boxPublicKey: req.candidateMember.boxPublicKey,
          deviceSignPublicKey: req.candidateMember.deviceSignPublicKey,
          rsaUserId: req.candidateMember.rsaUserId,
          status: 'active' as const,
          authorizedByModId: selfMemberId,
          authorizedAtEpoch: nextEpoch,
          addedAt: now,
        },
      ];

      const stateHash = await sha256Hex(
        `fc:state:${this.activeFamily.familyId}:${nextEpoch}:${req.candidateMember.deviceKeyId}`
      );
      const nextSnap = signRosterSnapshotWithModeratorDevice(
        {
          snapshotKey: `${this.activeFamily.familyId}:${nextEpoch}:${stateHash}`,
          familyId: this.activeFamily.familyId,
          founderId: snapView.founderId,
          epoch: nextEpoch,
          prevSnapshotHash: snapView.stateHash,
          inviteCommitment: expectedCommitment,
          stateHash,
          members: updatedMembers,
          moderators: snapView.moderators,
          devices: updatedDevices,
          broadcastAllowedIds: snapView.broadcastAllowedIds,
          broadcastBlockedIds: snapView.broadcastBlockedIds,
          revokedKeyIds: snapView.revokedKeyIds,
          clockVector: { ...snapView.clockVector, [selfMemberId]: nextEpoch },
          signerModId: selfMemberId,
          signerDeviceKeyId: this.identity.deviceKeyId!,
          trustState: 'verified_current',
        },
        this.identity
      );

      const nextFamilyConfig: FamilyGroupConfig = {
        ...this.activeFamily,
        isUnusedDefault: false,
        authorityState: 'verified_current',
        epoch: nextEpoch,
        updatedAt: now,
      };

      await this.storage.saveFamilyConfig(nextFamilyConfig);
      await this.storage.saveRosterSnapshot(nextSnap);
      await this.storage.setHighestVerifiedEpoch(
        nextFamilyConfig.familyId,
        nextEpoch
      );
      await this.storage.saveContact(newMember);

      this.activeFamily = nextFamilyConfig;
      this.latestSnapshot = nextSnap;
      const isNew = this.upsertMemberInMemory(newMember);
      if (isNew) {
        this.dispatchEvent(new CustomEvent('member_added', { detail: newMember }));
      }

      // Broadcast updated snapshot to existing permanent-room peers
      await this.activeSession?.sendSnap(nextSnap);

      // Slice last 5 group messages for new member onboarding context
      const groupMsgs = (await this.storage.getMessages('global')).slice(-5);

      const bundle: SealedOnboardingBundle = {
        familyConfig: {
          ...nextFamilyConfig,
          joinedAtEpoch: nextEpoch,
        },
        initialSnapshot: nextSnap,
        initialContacts: updatedMembers.filter(
          (m) =>
            m.memberId !== newMember.memberId &&
            m.identityHash !== newMember.identityHash
        ),
        onboardingMessages: groupMsgs.map((m) => ({
          ...m,
          isOnboardingContext: true,
        })),
      };

      const offer = await sealOnboardingOffer({
        requestId: req.requestId,
        challengeNonce: req.challengeNonce,
        inviteCode: r.inviteCode,
        bundle,
        recipientBoxPublicKey: req.candidateMember.boxPublicKey,
        moderatorIdentity: this.identity,
      });

      await r.sendOnb(offer, { target: peerId });
    } catch (err) {
      this.adapters.logger.error(
        'Automatic invite processing failed',
        err instanceof Error ? err : new Error(String(err))
      );
    }
  }

  private async handlePermanentAuthFrame(
    frame: OnboardingPermanentAuthReqWire | OnboardingPermanentAuthResWire,
    peerId: string
  ): Promise<void> {
    if (frame.type === 'permanent_auth_res') {
      const waiter = this.pendingPermAuthWaiters.get(frame.requestId);
      if (waiter) {
        this.pendingPermAuthWaiters.delete(frame.requestId);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
      return;
    }

    // Responder moderator side answering permanent_auth_req after live peer session verifies
    if (!this.identity || !this.activeFamily || !this.latestSnapshot || !this.activeSession) {
      return;
    }
    const senderSession = this.verifiedByPeerId.get(peerId);
    if (!senderSession) {
      // Wait until PeerSessionBinding & RSA VERIFIED settle on permanent room
      this.pendingPermReqByPeer.set(peerId, frame);
      return;
    }
    if (
      frame.familyId !== this.activeFamily.familyId ||
      frame.memberId !== senderSession.memberId ||
      frame.deviceKeyId !== senderSession.deviceKeyId ||
      frame.ephemeralPeerId !== peerId
    ) {
      return;
    }
    const canonicalReq = JSON.stringify({
      type: 'permanent_auth_req',
      requestId: frame.requestId,
      familyId: frame.familyId,
      challengeNonce: frame.challengeNonce,
      memberId: frame.memberId,
      deviceKeyId: frame.deviceKeyId,
      ephemeralPeerId: frame.ephemeralPeerId,
      timestamp: frame.timestamp,
    });
    if (
      !verifyDetachedString(
        canonicalReq,
        frame.signature,
        senderSession.deviceSignPublicKey
      )
    ) {
      return;
    }
    const selfMemberId = this.identity.memberId || this.identity.identityHash;
    const snapView: RosterSnapshot = {
      ...this.latestSnapshot,
      trustState: 'verified_current',
    };
    if (
      !isAuthorizedModeratorDevice(
        snapView,
        selfMemberId,
        this.identity.deviceKeyId!
      )
    ) {
      return;
    }

    const proof = signAuthenticatedOnboardingProof(
      {
        familyId: this.activeFamily.familyId,
        epoch: snapView.epoch,
        admittedMemberId: senderSession.memberId,
        admittedDeviceKeyId: senderSession.deviceKeyId,
        authorizingModId: selfMemberId,
        authorizingDeviceKeyId: this.identity.deviceKeyId!,
        permanentRoomId: this.activeFamily.familyRoomId,
        challengeNonce: frame.challengeNonce,
        authenticatedAt: Date.now(),
      },
      this.identity
    );

    await this.activeSession.sendPermAuth(
      {
        type: 'permanent_auth_res',
        requestId: frame.requestId,
        familyId: this.activeFamily.familyId,
        permanentAuthProof: proof,
        latestSnapshot: snapView,
      },
      { target: peerId }
    );
  }

  /**
   * Preserves existing UI trigger while executing full verified onboarding:
   * invite rendezvous -> InviteAuthorizationCert -> pendingAdoptions -> permanent room auth ->
   * AuthenticatedOnboardingProof -> finalizePendingAdoption -> rendezvous cleanup.
   */
  public searchAndJoinByCode(inviteCode: string): void {
    void this.joinFamilyByInviteCode(inviteCode).catch((err) => {
      const reason =
        err instanceof Error ? err.message : 'Family onboarding failed';
      this.dispatchEvent(
        new CustomEvent('onboarding_failed', { detail: { reason } })
      );
    });
  }

  public async joinFamilyByInviteCode(rawInviteCode: string): Promise<FamilyGroupConfig> {
    if (!this.identity || !this.rsaPublicKey || !this.rsaPrivateKey) {
      throw new Error('Identity not initialized');
    }

    const inviteCode = rawInviteCode.trim();
    if (!validateSharedInviteCode(inviteCode)) {
      throw new Error('Invalid family invitation code format');
    }
    if (this.activeFamily && inviteCode === this.activeFamily.inviteCode) {
      throw new Error('Cannot join using your own active invitation code');
    }
    if (
      this.activeFamily &&
      !this.activeFamily.isUnusedDefault &&
      this.activeFamily.authorityState === 'verified_current'
    ) {
      throw new Error(
        'Active verified family already exists; cannot silently overwrite active family'
      );
    }

    const previousFamily = this.activeFamily;
    const oldFamilyId = previousFamily?.familyId || 'unused-default';
    const inviteCommitment = await deriveInviteCommitment(inviteCode);
    const rendezvousRoomId = await deriveInviteRendezvousId(inviteCode);
    const requestId = `join-${crypto.randomUUID()}`;
    const challengeNonce = await sha256Hex(
      `fc:onb:${requestId}:${Date.now()}:${Math.random()}`
    );

    // Tear down any prior rendezvous listener temporarily while connecting as joiner
    await this.cleanupRendezvous();

    const rTransport = this.transportFactory(
      this.buildRoomConfig(rendezvousRoomId),
      rendezvousRoomId
    );
    const rRoom = new ChatRoom({
      roomId: rendezvousRoomId,
      userId: this.rsaUserId,
      customUsername: `${this.identity.firstName} ${this.identity.lastName}`.trim(),
      publicKey: this.rsaPublicKey,
      privateKey: this.rsaPrivateKey,
      password: rendezvousRoomId,
      transport: rTransport,
      adapters: this.adapters,
    });

    const [sendOnb, onOnb, , offOnb] = makeTypedAction<
      JoinInviteRequestWire | OnboardingOfferWire | OnboardingRejectionWire
    >(rTransport, ACTION_ONBOARD_REQ, ActionNamespace.GROUP);

    const rCleanups: Array<() => void> = [offOnb];
    this.rendezvousSession = {
      roomId: rendezvousRoomId,
      inviteCode,
      transport: rTransport,
      room: rRoom,
      cleanups: rCleanups,
      sendOnb: (d, opts) => sendOnb(d, opts),
    };

    let stagedAdoptionId: string | null = null;
    let candidatePermSession: ActiveRoomSession | null = null;
    const savedActiveSnapshot = this.latestSnapshot;

    try {
      const offer = await new Promise<OnboardingOfferWire>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingJoinWaiters.delete(requestId);
          reject(new Error('Timed out waiting for family moderator onboarding'));
        }, this.onboardingTimeoutMs);

        this.pendingJoinWaiters.set(requestId, { resolve, reject, timer });

        onOnb((frame) => {
          if (frame.type === 'onboarding_offer' && frame.requestId === requestId) {
            const waiter = this.pendingJoinWaiters.get(requestId);
            if (waiter) {
              this.pendingJoinWaiters.delete(requestId);
              clearTimeout(waiter.timer);
              waiter.resolve(frame);
            }
          } else if (
            frame.type === 'onboarding_rejected' &&
            frame.requestId === requestId
          ) {
            const waiter = this.pendingJoinWaiters.get(requestId);
            if (waiter) {
              this.pendingJoinWaiters.delete(requestId);
              clearTimeout(waiter.timer);
              waiter.reject(new Error(frame.reason || 'Onboarding rejected'));
            }
          }
        });

        const sendReqToPeer = async (peerId: string) => {
          if (!this.identity) return;
          const req = signJoinInviteRequest({
            identity: this.identity,
            rsaUserId: this.rsaUserId,
            ephemeralPeerId: rTransport.selfId,
            inviteCommitment,
            challengeNonce,
            requestId,
          });
          await sendOnb(req, { target: peerId });
        };

        rCleanups.push(
          rRoom.on(ChatRoomEvent.PEER_VERIFICATION, ({ peerId, verificationState }) => {
            if (verificationState === PeerVerificationState.VERIFIED) {
              void sendReqToPeer(peerId);
            }
          })
        );

        void rRoom.join().then(() => {
          for (const p of rRoom.getPeers()) {
            if (p.verificationState === PeerVerificationState.VERIFIED) {
              void sendReqToPeer(p.peerId);
            }
          }
        });
      });

      // Decrypt & verify InviteAuthorizationCert + offer signature
      const bundle = await openOnboardingOffer({
        offer,
        enteredInviteCode: inviteCode,
        recipientIdentity: this.identity,
      });

      const localSnaps = await this.storage.getRosterSnapshots(
        bundle.familyConfig.familyId
      );
      const selfMemberId = this.identity.memberId || this.identity.identityHash;
      if (
        isCredentialRevokedInSnapshots(
          localSnaps,
          selfMemberId,
          this.identity.deviceKeyId
        ) ||
        isCredentialRevokedInSnapshots(
          localSnaps,
          offer.senderMemberId,
          offer.senderDeviceKeyId
        )
      ) {
        throw new Error('Adoption references a locally revoked credential');
      }

      // Phase 1: Stage into pendingAdoptions WITHOUT touching active familyState or contacts
      stagedAdoptionId = `adopt:${oldFamilyId}->${bundle.familyConfig.familyId}`;
      await this.storage.savePendingAdoption({
        adoptionId: stagedAdoptionId,
        oldFamilyId,
        inviteCode,
        newFamilyConfig: bundle.familyConfig,
        initialSnapshot: bundle.initialSnapshot,
        initialContacts: bundle.initialContacts,
        onboardingMessages: bundle.onboardingMessages.slice(-5),
        status: 'pending_permanent_auth',
        createdAt: Date.now(),
      });

      // Phase 2: Connect & authenticate on the PERMANENT familyRoomId ChatRoom before promoting!
      this.latestSnapshot = {
        ...bundle.initialSnapshot,
        trustState: 'verified_current',
      };
      this.activeFamily = bundle.familyConfig;
      candidatePermSession = await this.openPermanentSession(
        bundle.familyConfig,
        this.identity
      );

      const authRes = await new Promise<OnboardingPermanentAuthResWire>(
        (resolve, reject) => {
          const timer = setTimeout(() => {
            this.pendingPermAuthWaiters.delete(requestId);
            reject(
              new Error(
                'Timed out authenticating permanent family room connection'
              )
            );
          }, this.onboardingTimeoutMs);

          this.pendingPermAuthWaiters.set(requestId, { resolve, reject, timer });

          const trySendPermReq = async () => {
            const modSess = this.verifiedByMemberId.get(offer.senderMemberId);
            if (!modSess || !candidatePermSession || !this.identity) return;
            const timestamp = Date.now();
            const canonical = JSON.stringify({
              type: 'permanent_auth_req',
              requestId,
              familyId: bundle.familyConfig.familyId,
              challengeNonce,
              memberId: selfMemberId,
              deviceKeyId: this.identity.deviceKeyId!,
              ephemeralPeerId: candidatePermSession.transport.selfId,
              timestamp,
            });
            await candidatePermSession.sendPermAuth(
              {
                type: 'permanent_auth_req',
                requestId,
                familyId: bundle.familyConfig.familyId,
                challengeNonce,
                memberId: selfMemberId,
                deviceKeyId: this.identity.deviceKeyId!,
                ephemeralPeerId: candidatePermSession.transport.selfId,
                timestamp,
                signature: signDetachedString(
                  canonical,
                  this.identity.deviceSignSecretKey!
                ),
              },
              { target: modSess.ephemeralPeerId }
            );
          };

          const onPresenceAuth = () => void trySendPermReq();
          this.addEventListener('presence_change', onPresenceAuth);
          candidatePermSession?.cleanups.push(() =>
            this.removeEventListener('presence_change', onPresenceAuth)
          );
          void trySendPermReq();
        }
      );

      if (
        !checkOnboardingProofSignatureHelper(
          authRes.permanentAuthProof,
          authRes.latestSnapshot
        )
      ) {
        throw new Error(
          'Permanent room moderator proof failed signature verification'
        );
      }

      // Stage authenticated record & run Stage 2 atomic finalizePendingAdoption gate
      await this.storage.savePendingAdoption({
        adoptionId: stagedAdoptionId,
        oldFamilyId,
        inviteCode,
        newFamilyConfig: bundle.familyConfig,
        initialSnapshot: authRes.latestSnapshot,
        initialContacts: bundle.initialContacts,
        onboardingMessages: bundle.onboardingMessages.slice(-5),
        status: 'authenticated',
        permanentAuthProof: authRes.permanentAuthProof,
        createdAt: Date.now(),
      });

      await this.storage.finalizePendingAdoption(stagedAdoptionId, {
        expectedMemberId: selfMemberId,
        expectedDeviceKeyId: this.identity.deviceKeyId,
      });

      // Only AFTER finalizePendingAdoption commits: update live identity inviteCode & memory contacts
      const finalizedIdentity: UserIdentity = {
        ...this.identity,
        inviteCode,
      };
      this.identity = finalizedIdentity;
      try {
        this.saveIdentityFn(finalizedIdentity);
      } catch {
        // Storage quota error reported on critical paths; DB adoption already committed cleanly
      }

      this.activeFamily = await this.storage.getActiveFamilyConfig();
      this.latestSnapshot = await this.storage.getLatestRosterSnapshot(
        bundle.familyConfig.familyId
      );

      this.members.clear();
      const finalizedContacts = await this.storage.getContacts();
      for (const c of finalizedContacts) {
        this.upsertMemberInMemory(c);
      }
      for (const m of bundle.onboardingMessages.slice(-5)) {
        this.seenMessageIds.add(m.id);
      }

      await this.cleanupRendezvous();

      const inviterContact =
        finalizedContacts.find(
          (c) =>
            c.memberId === offer.senderMemberId ||
            c.identityHash === offer.senderMemberId
        ) || finalizedContacts[0];
      if (inviterContact) {
        this.dispatchEvent(
          new CustomEvent('joined_family_success', { detail: inviterContact })
        );
      }

      return this.activeFamily!;
    } catch (err) {
      // Failure path: abort pending adoption, restore previous activeFamily/session, cleanup rendezvous
      if (stagedAdoptionId) {
        await this.storage.abortPendingAdoption(stagedAdoptionId).catch(() => {});
      }
      await this.cleanupRendezvous().catch(() => {});
      this.activeFamily = previousFamily;
      this.latestSnapshot = savedActiveSnapshot;
      if (previousFamily && this.identity && !this.destroyed) {
        await this.openPermanentSession(previousFamily, this.identity).catch(
          () => {}
        );
        const selfMemberId =
          this.identity.memberId || this.identity.identityHash;
        if (
          this.autoListenInvite &&
          savedActiveSnapshot &&
          this.identity.deviceKeyId &&
          isAuthorizedModeratorDevice(
            { ...savedActiveSnapshot, trustState: 'verified_current' },
            selfMemberId,
            this.identity.deviceKeyId
          )
        ) {
          await this.ensureRendezvousListening(previousFamily.inviteCode).catch(
            () => {}
          );
        }
      }
      throw err;
    }
  }

  // =========================================================================
  // AUTHENTICATED GROUP & DIRECT MESSAGING + SENDER-ONLY OUTBOX & ACKs
  // =========================================================================

  public async sendGroupMessage(
    groupId: string,
    content: string
  ): Promise<ChatMessage> {
    if (!this.identity || !this.activeFamily || !this.activeSession) {
      throw new Error('Bridge session not initialized');
    }
    const selfMemberId = this.identity.memberId || this.identity.identityHash;
    this.lamportClock += 1;

    const msg: ChatMessage = {
      id: `grp-${crypto.randomUUID()}`,
      chatId: groupId,
      senderId: selfMemberId,
      senderName: `${this.identity.firstName} ${this.identity.lastName}`.trim(),
      content,
      timestamp: Date.now(),
      lamportClock: this.lamportClock,
      epoch: this.activeFamily.epoch,
      status: 'sent',
      encrypted: true,
    };

    // Persist locally first (quota failures reject before mutating caches/wire)
    await this.storage.addMessage(groupId, msg);
    this.seenMessageIds.add(msg.id);

    const envelope = await encryptGroupEnvelope({
      familyConfig: this.activeFamily,
      identity: this.identity,
      message: msg,
    });
    const serialized = JSON.stringify(envelope);

    // Prefer Chitchatter ChatRoom.sendMessage when within messageCharacterSizeLimit
    if (serialized.length <= messageCharacterSizeLimit) {
      await this.activeSession.room.sendMessage(serialized);
    } else {
      await this.activeSession.sendLargeGroup(envelope);
    }

    return msg;
  }

  private async handleIncomingGroupEnvelope(
    envelope: SignedGroupEnvelope,
    peerId: string
  ): Promise<void> {
    if (!this.activeFamily || !this.identity) return;
    const senderSession = this.verifiedByPeerId.get(peerId);
    if (!senderSession) {
      this.adapters.logger.warn('Dropped group frame from unauthenticated peer');
      return;
    }

    if (
      this.seenMessageIds.has(envelope.msgId) ||
      (await this.storage.hasSeenNonce(
        this.activeFamily.familyId,
        `grp:${envelope.msgId}`
      ))
    ) {
      return; // Deduplicate retry cleanly
    }

    const msg = await decryptGroupEnvelope({
      envelope,
      familyConfig: this.activeFamily,
      senderSession,
    });
    if (!msg) return;

    await this.storage.addMessage(msg.chatId, msg);
    await this.storage.markNonceSeen(
      this.activeFamily.familyId,
      `grp:${msg.id}`
    );
    this.seenMessageIds.add(msg.id);
    if (
      typeof msg.lamportClock === 'number' &&
      msg.lamportClock > this.lamportClock
    ) {
      this.lamportClock = msg.lamportClock;
    }

    this.dispatchEvent(new CustomEvent('group_message_received', { detail: msg }));
  }

  public async sendDirectMessage(
    recipientHash: string,
    content: string
  ): Promise<ChatMessage> {
    if (!this.identity || !this.activeFamily) {
      throw new Error('Bridge session not initialized');
    }

    let recipient = this.resolveMemberRecord(recipientHash);
    if (!recipient) {
      const contacts = await this.storage.getContacts();
      recipient = contacts.find(
        (c) => c.identityHash === recipientHash || c.memberId === recipientHash
      );
      if (recipient) this.upsertMemberInMemory(recipient);
    }
    if (!recipient) {
      throw new Error('Recipient not in family registry');
    }

    const selfMemberId = this.identity.memberId || this.identity.identityHash;
    this.lamportClock += 1;

    const recipientMemberId = recipient.memberId || recipient.identityHash;
    const msg: ChatMessage = {
      id: `priv-${crypto.randomUUID()}`,
      chatId: recipientMemberId,
      senderId: selfMemberId,
      senderName: `${this.identity.firstName} ${this.identity.lastName}`.trim(),
      content,
      timestamp: Date.now(),
      lamportClock: this.lamportClock,
      epoch: this.activeFamily.epoch,
      status: 'queued',
      encrypted: true,
    };

    // Persist locally FIRST (quota/write failure throws before sending or queuing)
    await this.storage.addMessage(recipientMemberId, msg);
    this.seenMessageIds.add(msg.id);

    // Always stage in sender-only offlineQueue until recipient confirms persistent storage commit ACK
    await this.storage.enqueueOfflineMessage(msg);

    const verifiedPeer = this.verifiedByMemberId.get(recipientMemberId);
    if (verifiedPeer && this.activeSession) {
      const envelope = signDirectEnvelope({
        familyId: this.activeFamily.familyId,
        message: msg,
        senderIdentity: this.identity,
        recipientSession: verifiedPeer,
      });
      await this.activeSession.sendDirectE2EE(envelope, {
        target: verifiedPeer.ephemeralPeerId,
      });
      msg.status = 'sent';
      await this.storage.updateMessageStatus(recipientMemberId, msg.id, 'sent');
      this.notifyStatus(msg.id, 'sent');
    }

    return msg;
  }

  private async handleIncomingDirectEnvelope(
    envelope: AuthenticatedDirectEnvelopeWire,
    peerId: string
  ): Promise<void> {
    if (!this.identity || !this.activeFamily || !this.activeSession) return;
    const senderSession = this.verifiedByPeerId.get(peerId);
    if (!senderSession) {
      this.adapters.logger.warn('Dropped DM from unauthenticated peer');
      return;
    }
    if (this.isBlocked(senderSession.memberId)) return;

    const msg = verifyAndDecryptDirectEnvelope({
      envelope,
      expectedFamilyId: this.activeFamily.familyId,
      recipientIdentity: this.identity,
      senderSession,
    });
    if (!msg) return;

    const alreadyCommitted =
      this.seenMessageIds.has(msg.id) ||
      (await this.storage.hasSeenNonce(
        this.activeFamily.familyId,
        `dm:${msg.id}`
      ));

    if (!alreadyCommitted) {
      // Commit to local storage FIRST before acknowledging delivery!
      await this.storage.addMessage(senderSession.memberId, msg);
      await this.storage.markNonceSeen(
        this.activeFamily.familyId,
        `dm:${msg.id}`
      );
      this.seenMessageIds.add(msg.id);
      if (
        typeof msg.lamportClock === 'number' &&
        msg.lamportClock > this.lamportClock
      ) {
        this.lamportClock = msg.lamportClock;
      }

      if (this.activeChatPeerId !== senderSession.memberId) {
        this.incrementUnread(senderSession.memberId);
        this.adapters.sound.playNewMessageSound();
      }

      this.directMessageCallbacks.forEach((cb) => cb(msg));
      this.dispatchEvent(
        new CustomEvent('direct_message_received', { detail: msg })
      );
    }

    // Send signed delivery ACK only AFTER storage commit succeeded
    const ack = signDeliveryAck({
      familyId: this.activeFamily.familyId,
      messageId: msg.id,
      senderMemberId: senderSession.memberId,
      recipientIdentity: this.identity,
    });
    await this.activeSession.sendDirectAck(ack, { target: peerId });
  }

  private async handleIncomingDeliveryAck(
    ack: DirectDeliveryAckWire,
    peerId: string
  ): Promise<void> {
    if (!this.identity || !this.activeFamily) return;
    const senderSession = this.verifiedByPeerId.get(peerId);
    if (!senderSession) return;
    const selfMemberId = this.identity.memberId || this.identity.identityHash;

    if (
      !verifyDeliveryAck({
        ack,
        expectedFamilyId: this.activeFamily.familyId,
        expectedSelfMemberId: selfMemberId,
        senderSession,
      })
    ) {
      return;
    }

    const canonicalSenderId = this.resolveCanonicalMemberId(
      senderSession.memberId
    );
    const aliases = this.getMemberIdAliases(canonicalSenderId);

    await this.storage.removeOfflineMessage(ack.messageId);
    for (const alias of aliases) {
      await this.storage.updateMessageStatus(alias, ack.messageId, 'delivered');
    }
    this.notifyStatus(ack.messageId, 'delivered');
    this.directMessageCallbacks.forEach((cb) =>
      cb({
        id: ack.messageId,
        chatId: canonicalSenderId,
        senderId: selfMemberId,
        senderName: `${this.identity!.firstName} ${this.identity!.lastName}`,
        content: '',
        timestamp: ack.committedAt,
        status: 'delivered',
      })
    );
  }

  private async flushOfflineQueue(memberId: string): Promise<void> {
    const canonical = this.resolveCanonicalMemberId(memberId);
    if (this.flushingMembers.has(canonical)) return;
    const verifiedPeer = this.verifiedByMemberId.get(canonical);
    if (!verifiedPeer || !this.identity || !this.activeFamily || !this.activeSession) {
      return;
    }

    this.flushingMembers.add(canonical);
    try {
      const aliases = this.getMemberIdAliases(canonical);
      const seenQueueIds = new Set<string>();
      const queued: ChatMessage[] = [];
      for (const alias of aliases) {
        const rows = await this.storage.getOfflineMessages(alias);
        for (const r of rows) {
          if (!seenQueueIds.has(r.id)) {
            seenQueueIds.add(r.id);
            queued.push(r);
          }
        }
      }
      queued.sort(
        (a, b) =>
          (a.lamportClock ?? 0) - (b.lamportClock ?? 0) ||
          a.timestamp - b.timestamp
      );

      for (const msg of queued) {
        const envelope = signDirectEnvelope({
          familyId: this.activeFamily.familyId,
          message: msg,
          senderIdentity: this.identity,
          recipientSession: verifiedPeer,
        });
        await this.activeSession.sendDirectE2EE(envelope, {
          target: verifiedPeer.ephemeralPeerId,
        });
        await this.storage.updateMessageStatus(msg.chatId, msg.id, 'sent');
        if (msg.chatId !== canonical) {
          await this.storage.updateMessageStatus(canonical, msg.id, 'sent');
        }
        this.notifyStatus(msg.id, 'sent');
      }
    } finally {
      this.flushingMembers.delete(canonical);
    }
  }

  public async getConversationMessages(peerId: string): Promise<ChatMessage[]> {
    const aliases = this.getMemberIdAliases(peerId);
    const byId = new Map<string, ChatMessage>();
    for (const alias of aliases) {
      const msgs = await this.storage.getMessages(alias);
      for (const m of msgs) {
        if (!byId.has(m.id)) {
          byId.set(m.id, m);
        }
      }
    }
    const merged = Array.from(byId.values());
    merged.sort((a, b) => {
      const la = a.lamportClock ?? 0;
      const lb = b.lamportClock ?? 0;
      if (la !== lb) return la - lb;
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return merged;
  }

  // =========================================================================
  // COMPATIBILITY SURFACE (CONNECTION MANAGER + WEBRTC CHANNEL + CALLS)
  // =========================================================================

  public getMembers(): FamilyMember[] {
    return Array.from(this.members.values());
  }

  public async addMember(member: FamilyMember): Promise<boolean> {
    const isNew = this.upsertMemberInMemory(member);
    await this.storage.saveContact(member);
    this.dispatchEvent(new CustomEvent('member_added', { detail: member }));
    return isNew;
  }

  public async removeMember(identityOrMemberId: string): Promise<void> {
    const existing = this.resolveMemberRecord(identityOrMemberId);
    const canonical = existing
      ? existing.memberId || existing.identityHash
      : identityOrMemberId;
    const storageKey = existing?.identityHash || identityOrMemberId;
    this.members.delete(canonical);
    if (existing?.identityHash) this.members.delete(existing.identityHash);
    await this.storage.removeContact(storageKey);

    const sess = this.verifiedByMemberId.get(canonical);
    if (sess) {
      this.dropPeerSession(sess.ephemeralPeerId);
    }
    this.dispatchEvent(new CustomEvent('member_removed', { detail: canonical }));
  }

  public async muteMember(identityOrMemberId: string): Promise<void> {
    const member = this.resolveMemberRecord(identityOrMemberId);
    if (!member) return;
    member.isMuted = !member.isMuted;
    await this.storage.updateContact(member.identityHash, { isMuted: member.isMuted });
    this.dispatchEvent(new CustomEvent('member_updated', { detail: member }));
  }

  public async blockMember(identityOrMemberId: string): Promise<void> {
    const member = this.resolveMemberRecord(identityOrMemberId);
    if (!member) return;
    member.isBlocked = !member.isBlocked;
    await this.storage.updateContact(member.identityHash, {
      isBlocked: member.isBlocked,
    });
    const canonical = member.memberId || member.identityHash;
    const sess = this.verifiedByMemberId.get(canonical);
    if (member.isBlocked && sess) {
      this.dropPeerSession(sess.ephemeralPeerId);
    }
    this.dispatchEvent(new CustomEvent('member_updated', { detail: member }));
  }

  public isMuted(identityOrMemberId: string): boolean {
    return this.resolveMemberRecord(identityOrMemberId)?.isMuted || false;
  }

  public isBlocked(identityOrMemberId: string): boolean {
    return this.resolveMemberRecord(identityOrMemberId)?.isBlocked || false;
  }

  public getPresence(identityOrMemberId: string): 'online' | 'offline' | 'away' {
    const canonical = this.resolveCanonicalMemberId(identityOrMemberId);
    const info = this.peerPresenceMap.get(canonical);
    if (!info) return 'offline';
    if (info.state === 'ONLINE') return 'online';
    if (info.state === 'IDLE') return 'away';
    return 'offline';
  }

  public getPeerPresence(identityOrMemberId: string): PeerPresence {
    const canonical = this.resolveCanonicalMemberId(identityOrMemberId);
    return this.peerPresenceMap.get(canonical)?.state || 'OFFLINE';
  }

  public getAppPowerState(): AppPresenceState {
    return this.appPowerState;
  }

  private setGroupMeetingState(state: GroupMeetingState): void {
    this.groupMeetingState = state;
    this.dispatchEvent(
      new CustomEvent('group_state_change', {
        detail: { state, peerCount: this.getGroupOnlinePeerCount() },
      })
    );
  }

  public getGroupMeetingState(): GroupMeetingState {
    return this.groupMeetingState;
  }

  public getGroupOnlinePeerCount(): number {
    let count = 0;
    this.peerPresenceMap.forEach((info) => {
      if (info.state === 'ONLINE' || info.state === 'IDLE') count++;
    });
    return count;
  }

  public getPrivateChannelState(contactId: string): PrivateChannelState {
    const canonical = this.resolveCanonicalMemberId(contactId);
    if (this.activeChatPeerId === canonical) return 'ACTIVE_CHAT';
    return this.privateChannelStates.get(canonical) || 'DISCONNECTED';
  }

  public promoteToActiveChat(contactId: string): void {
    const canonical = this.resolveCanonicalMemberId(contactId);
    this.activeChatPeerId = canonical;
    this.privateChannelStates.set(canonical, 'ACTIVE_CHAT');
    this.markAsRead(canonical);
    this.dispatchEvent(
      new CustomEvent('connection_state_change', {
        detail: { contactId: canonical, state: 'ACTIVE_CHAT' },
      })
    );
  }

  public demoteFromActiveChat(contactId: string): void {
    const canonical = this.resolveCanonicalMemberId(contactId);
    if (this.activeChatPeerId === canonical) {
      this.activeChatPeerId = null;
      const connected = this.isConnected(canonical);
      const nextState: PrivateChannelState = connected
        ? 'CONNECTED'
        : 'DISCONNECTED';
      this.privateChannelStates.set(canonical, nextState);
      this.dispatchEvent(
        new CustomEvent('connection_state_change', {
          detail: { contactId: canonical, state: nextState },
        })
      );
    }
  }

  public getUnreadCount(contactId: string): number {
    const canonical = this.resolveCanonicalMemberId(contactId);
    return this.unreadCounts.get(canonical) || 0;
  }

  public getTotalUnreadCount(): number {
    let total = 0;
    this.unreadCounts.forEach((n) => {
      total += n;
    });
    return total;
  }

  public markAsRead(contactId: string): void {
    const canonical = this.resolveCanonicalMemberId(contactId);
    if ((this.unreadCounts.get(canonical) || 0) > 0) {
      this.unreadCounts.set(canonical, 0);
      this.dispatchEvent(
        new CustomEvent('unread_change', {
          detail: {
            contactId: canonical,
            count: 0,
            total: this.getTotalUnreadCount(),
          },
        })
      );
    }
  }

  private incrementUnread(contactId: string): number {
    const canonical = this.resolveCanonicalMemberId(contactId);
    const next = (this.unreadCounts.get(canonical) || 0) + 1;
    this.unreadCounts.set(canonical, next);
    this.dispatchEvent(
      new CustomEvent('unread_change', {
        detail: {
          contactId: canonical,
          count: next,
          total: this.getTotalUnreadCount(),
        },
      })
    );
    return next;
  }

  public onMessageStatusChange(cb: StatusUpdateCallback): () => void {
    this.statusCallbacks.add(cb);
    return () => this.statusCallbacks.delete(cb);
  }

  private notifyStatus(messageId: string, status: MessageStatus): void {
    this.statusCallbacks.forEach((cb) => cb({ messageId, status }));
  }

  // WebRTCChannelManager compatibility methods
  public isConnected(memberId: string): boolean {
    const canonical = this.resolveCanonicalMemberId(memberId);
    return this.verifiedByMemberId.has(canonical);
  }

  public onMessage(cb: DirectMessageCallback): () => void {
    this.directMessageCallbacks.add(cb);
    return () => this.directMessageCallbacks.delete(cb);
  }

  public onConnectionState(cb: ConnectionStateCallback): () => void {
    this.connectionStateCallbacks.add(cb);
    return () => this.connectionStateCallbacks.delete(cb);
  }

  public onTrack(cb: TrackCallback): () => void {
    this.trackCallbacks.add(cb);
    return () => this.trackCallbacks.delete(cb);
  }

  public onIncomingCall(cb: IncomingCallCallback): () => void {
    this.incomingCallCallbacks.add(cb);
    return () => this.incomingCallCallbacks.delete(cb);
  }

  public onCallStateChange(cb: CallStateCallback): () => void {
    this.callStateCallbacks.add(cb);
    return () => this.callStateCallbacks.delete(cb);
  }

  public getActiveCall(): ActiveCallSession | null {
    if (!this.activeCall) return null;
    const { targetEphemeralPeerId: _t, ...pub } = this.activeCall;
    return pub;
  }

  public getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  private emitCallState(session: ActiveCallSession): void {
    const snapshot: ActiveCallSession = { ...session };
    this.callStateCallbacks.forEach((cb) => cb(snapshot));
    this.dispatchEvent(
      new CustomEvent('call_state_change', { detail: snapshot })
    );
  }

  private attachScopedMediaStream(
    stream: MediaStream,
    targetEphemeralPeerId: string,
    metadata?: { callId: string; mediaType: CallMediaType }
  ): void {
    const transport = this.activeSession?.transport;
    if (
      transport &&
      'addStream' in transport &&
      typeof (transport as TrysteroTransport).addStream === 'function'
    ) {
      (transport as TrysteroTransport).addStream(stream, {
        target: targetEphemeralPeerId,
        ...(metadata ? { metadata } : {}),
      });
    }
  }

  private detachScopedMediaStream(
    stream: MediaStream | null,
    targetEphemeralPeerId?: string
  ): void {
    const transport = this.activeSession?.transport;
    if (
      stream &&
      targetEphemeralPeerId &&
      transport &&
      'removeStream' in transport &&
      typeof (transport as TrysteroTransport).removeStream === 'function'
    ) {
      try {
        (transport as TrysteroTransport).removeStream(stream, {
          target: targetEphemeralPeerId,
        });
      } catch {
        // Ignore teardown error if peer already disconnected
      }
    }
    if (stream && typeof stream.getTracks === 'function') {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track stop errors
        }
      }
    }
  }

  private cleanupActiveCall(
    terminalState: 'rejected' | 'failed' | 'ended',
    errorReason?: string
  ): void {
    const current = this.activeCall;
    const targetPeerId = current?.targetEphemeralPeerId;
    this.detachScopedMediaStream(this.localStream, targetPeerId);
    this.localStream = null;
    this.remoteStream = null;
    this.activeCall = null;
    if (current) {
      const { targetEphemeralPeerId: _t, ...pub } = current;
      this.emitCallState({
        ...pub,
        state: terminalState,
        ...(errorReason ? { errorReason } : {}),
      });
    }
  }

  public async startCall(
    peerId: string,
    mediaType: CallMediaType,
    localStream: MediaStream
  ): Promise<ActiveCallSession> {
    if (!this.identity || !this.activeFamily || !this.activeSession) {
      throw new Error('Bridge session not initialized');
    }
    if (this.activeCall) {
      throw new Error('Another call is already active');
    }

    const canonicalPeerId = this.resolveCanonicalMemberId(peerId);
    const member = this.resolveMemberRecord(canonicalPeerId);
    const peerName = member
      ? `${member.firstName} ${member.lastName}`.trim()
      : 'Family Member';
    const callId = `call-${crypto.randomUUID()}`;

    const verifiedPeer = this.verifiedByMemberId.get(canonicalPeerId);
    if (!verifiedPeer || this.isBlocked(canonicalPeerId)) {
      this.detachScopedMediaStream(localStream);
      const failedSession: ActiveCallSession = {
        callId,
        peerId: canonicalPeerId,
        peerName,
        mediaType,
        direction: 'outgoing',
        state: 'failed',
        muted: false,
        videoEnabled: mediaType === 'video',
        errorReason: this.isBlocked(canonicalPeerId)
          ? 'Peer is blocked'
          : 'Peer is offline or not authenticated',
        startedAt: Date.now(),
      };
      this.emitCallState(failedSession);
      throw new Error(failedSession.errorReason);
    }

    const hasTrack =
      typeof localStream?.getTracks === 'function' &&
      localStream.getTracks().length > 0;
    if (!localStream || !hasTrack) {
      throw new Error('No local audio/video track provided for call');
    }

    this.localStream = localStream;
    this.remoteStream = null;
    const session: ActiveCallSession & { targetEphemeralPeerId?: string } = {
      callId,
      peerId: verifiedPeer.memberId,
      peerName,
      mediaType,
      direction: 'outgoing',
      state: 'ringing_outgoing',
      muted: false,
      videoEnabled: mediaType === 'video',
      startedAt: Date.now(),
      targetEphemeralPeerId: verifiedPeer.ephemeralPeerId,
    };
    this.activeCall = session;

    const frame = signCallSignalingFrame({
      familyId: this.activeFamily.familyId,
      type: 'call_invite',
      callId,
      mediaType,
      senderIdentity: this.identity,
      recipientMemberId: verifiedPeer.memberId,
    });
    await this.activeSession.sendCallSig(frame, {
      target: verifiedPeer.ephemeralPeerId,
    });

    const pub = this.getActiveCall()!;
    this.emitCallState(pub);
    return pub;
  }

  public async acceptCall(
    callId: string,
    localStream: MediaStream
  ): Promise<ActiveCallSession> {
    if (!this.identity || !this.activeFamily || !this.activeSession) {
      throw new Error('Bridge session not initialized');
    }
    const call = this.activeCall;
    if (!call || call.callId !== callId || call.state !== 'ringing_incoming') {
      throw new Error('No matching incoming call to accept');
    }
    const verifiedPeer = this.verifiedByMemberId.get(call.peerId);
    if (!verifiedPeer) {
      this.cleanupActiveCall('failed', 'Caller disconnected before answer');
      throw new Error('Caller is no longer connected');
    }

    this.localStream = localStream;
    call.state = 'connecting';
    call.targetEphemeralPeerId = verifiedPeer.ephemeralPeerId;

    const frame = signCallSignalingFrame({
      familyId: this.activeFamily.familyId,
      type: 'call_accept',
      callId: call.callId,
      mediaType: call.mediaType,
      senderIdentity: this.identity,
      recipientMemberId: verifiedPeer.memberId,
    });
    await this.activeSession.sendCallSig(frame, {
      target: verifiedPeer.ephemeralPeerId,
    });

    this.attachScopedMediaStream(localStream, verifiedPeer.ephemeralPeerId, {
      callId: call.callId,
      mediaType: call.mediaType,
    });

    const pub = this.getActiveCall()!;
    this.emitCallState(pub);
    return pub;
  }

  public async rejectCall(callId: string, reason = 'Declined'): Promise<void> {
    const call = this.activeCall;
    if (!call || call.callId !== callId) return;
    if (this.identity && this.activeFamily && this.activeSession) {
      const verifiedPeer = this.verifiedByMemberId.get(call.peerId);
      if (verifiedPeer) {
        const frame = signCallSignalingFrame({
          familyId: this.activeFamily.familyId,
          type: 'call_reject',
          callId: call.callId,
          mediaType: call.mediaType,
          senderIdentity: this.identity,
          recipientMemberId: verifiedPeer.memberId,
          reason,
        });
        await this.activeSession
          .sendCallSig(frame, { target: verifiedPeer.ephemeralPeerId })
          .catch(() => {});
      }
    }
    this.cleanupActiveCall('rejected', reason);
  }

  public async endCall(callId?: string): Promise<void> {
    const call = this.activeCall;
    if (!call) {
      this.detachScopedMediaStream(this.localStream);
      this.localStream = null;
      this.remoteStream = null;
      return;
    }
    if (callId && call.callId !== callId) return;

    if (this.identity && this.activeFamily && this.activeSession) {
      const verifiedPeer = this.verifiedByMemberId.get(call.peerId);
      if (verifiedPeer) {
        const frame = signCallSignalingFrame({
          familyId: this.activeFamily.familyId,
          type: 'call_hangup',
          callId: call.callId,
          mediaType: call.mediaType,
          senderIdentity: this.identity,
          recipientMemberId: verifiedPeer.memberId,
        });
        await this.activeSession
          .sendCallSig(frame, { target: verifiedPeer.ephemeralPeerId })
          .catch(() => {});
      }
    }
    this.cleanupActiveCall('ended');
  }

  public toggleMute(): boolean {
    let muted = this.activeCall?.muted ?? false;
    if (this.localStream && typeof this.localStream.getAudioTracks === 'function') {
      const audioTrack = this.localStream.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        muted = !audioTrack.enabled;
      }
    } else if (this.activeCall) {
      muted = !this.activeCall.muted;
    }
    if (this.activeCall) {
      this.activeCall.muted = muted;
      this.emitCallState(this.getActiveCall()!);
    }
    return muted;
  }

  public toggleVideo(): boolean {
    let videoEnabled = this.activeCall?.videoEnabled ?? false;
    if (this.localStream && typeof this.localStream.getVideoTracks === 'function') {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        videoEnabled = videoTrack.enabled;
      }
    } else if (this.activeCall) {
      videoEnabled = !this.activeCall.videoEnabled;
    }
    if (this.activeCall) {
      this.activeCall.videoEnabled = videoEnabled;
      this.emitCallState(this.getActiveCall()!);
    }
    return videoEnabled;
  }

  private async handleIncomingCallSignal(
    frame: CallSignalingFrameWire,
    peerId: string
  ): Promise<void> {
    if (!this.identity || !this.activeFamily || !this.activeSession) return;
    const senderSession = this.verifiedByPeerId.get(peerId);
    if (!senderSession) {
      this.adapters.logger.warn('Dropped call signal from unauthenticated peer');
      return;
    }
    if (this.isBlocked(senderSession.memberId)) return;

    const selfMemberId = this.getSelfMemberId();
    if (
      !verifyCallSignalingFrame({
        frame,
        expectedFamilyId: this.activeFamily.familyId,
        expectedSelfMemberId: selfMemberId,
        senderSession,
      })
    ) {
      this.adapters.logger.warn('Dropped invalid/forged call signaling frame');
      return;
    }

    if (frame.type === 'call_invite') {
      if (this.activeCall) {
        // Already busy in another call
        const busyFrame = signCallSignalingFrame({
          familyId: this.activeFamily.familyId,
          type: 'call_reject',
          callId: frame.callId,
          mediaType: frame.mediaType,
          senderIdentity: this.identity,
          recipientMemberId: senderSession.memberId,
          reason: 'Busy',
        });
        await this.activeSession
          .sendCallSig(busyFrame, { target: peerId })
          .catch(() => {});
        return;
      }

      const member = this.resolveMemberRecord(senderSession.memberId);
      const peerName = member
        ? `${member.firstName} ${member.lastName}`.trim()
        : 'Family Member';
      this.activeCall = {
        callId: frame.callId,
        peerId: senderSession.memberId,
        peerName,
        mediaType: frame.mediaType,
        direction: 'incoming',
        state: 'ringing_incoming',
        muted: false,
        videoEnabled: frame.mediaType === 'video',
        startedAt: Date.now(),
        targetEphemeralPeerId: peerId,
      };
      const pub = this.getActiveCall()!;
      this.incomingCallCallbacks.forEach((cb) => cb(pub));
      this.dispatchEvent(new CustomEvent('incoming_call', { detail: pub }));
      this.emitCallState(pub);
      return;
    }

    const current = this.activeCall;
    if (
      !current ||
      current.callId !== frame.callId ||
      current.peerId !== senderSession.memberId
    ) {
      return;
    }

    if (frame.type === 'call_accept') {
      if (current.state !== 'ringing_outgoing') return;
      current.state = 'connecting';
      current.targetEphemeralPeerId = peerId;
      if (this.localStream) {
        this.attachScopedMediaStream(this.localStream, peerId, {
          callId: current.callId,
          mediaType: current.mediaType,
        });
      }
      this.emitCallState(this.getActiveCall()!);
      return;
    }

    if (frame.type === 'call_reject') {
      this.cleanupActiveCall('rejected', frame.reason || 'Call declined');
      return;
    }

    if (frame.type === 'call_hangup') {
      this.cleanupActiveCall('ended');
    }
  }

  private handleIncomingPeerStream(
    stream: MediaStream,
    peerId: string,
    metadata?: unknown
  ): void {
    const verified = this.verifiedByPeerId.get(peerId);
    if (!verified) return;
    if (this.isBlocked(verified.memberId)) return;

    const current = this.activeCall;
    if (
      !current ||
      current.peerId !== verified.memberId ||
      (current.state !== 'connecting' && current.state !== 'connected')
    ) {
      return;
    }

    if (
      metadata &&
      typeof metadata === 'object' &&
      'callId' in metadata &&
      typeof (metadata as { callId?: unknown }).callId === 'string' &&
      (metadata as { callId: string }).callId !== current.callId
    ) {
      return;
    }

    this.remoteStream = stream;
    if (current.state !== 'connected') {
      current.state = 'connected';
      current.connectedAt = Date.now();
      this.emitCallState(this.getActiveCall()!);
    }
    this.trackCallbacks.forEach((cb) => cb(verified.memberId, stream));
    this.dispatchEvent(
      new CustomEvent('remote_track_received', {
        detail: { peerId: verified.memberId, stream },
      })
    );
  }

  public setLocalStream(stream: MediaStream | null, targetMemberId?: string): void {
    const prev = this.localStream;
    const prevTarget = this.activeCall?.targetEphemeralPeerId;
    if (prev && prev !== stream) {
      this.detachScopedMediaStream(prev, prevTarget);
    }
    this.localStream = stream;
    const targetCanonical = targetMemberId
      ? this.resolveCanonicalMemberId(targetMemberId)
      : this.activeCall?.peerId;
    const sess = targetCanonical
      ? this.verifiedByMemberId.get(targetCanonical)
      : undefined;
    if (stream && sess) {
      this.attachScopedMediaStream(
        stream,
        sess.ephemeralPeerId,
        this.activeCall
          ? { callId: this.activeCall.callId, mediaType: this.activeCall.mediaType }
          : undefined
      );
    }
  }

  public getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  public async connectToPeer(memberId: string): Promise<void> {
    const canonical = this.resolveCanonicalMemberId(memberId);
    const sess = this.verifiedByMemberId.get(canonical);
    if (sess && this.activeSession) {
      await this.sendOwnSessionBinding(this.activeSession, sess.ephemeralPeerId);
    }
  }

  public closeSession(memberId: string): void {
    const canonical = this.resolveCanonicalMemberId(memberId);
    const sess = this.verifiedByMemberId.get(canonical);
    if (sess) {
      this.dropPeerSession(sess.ephemeralPeerId);
    }
  }

  private setupLifecycleAndPresence(): void {
    if (
      !this.lifecycleAttached &&
      typeof window !== 'undefined' &&
      typeof document !== 'undefined'
    ) {
      this.lifecycleAttached = true;
      const onActivity = () => {
        if (this.destroyed) return;
        if (this.appPowerState !== 'ONLINE' && document.visibilityState === 'visible') {
          this.setAppPowerState('ONLINE');
        }
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
          if (!this.destroyed && document.visibilityState === 'visible') {
            this.setAppPowerState('IDLE');
          }
        }, 60_000);
      };
      window.addEventListener('pointermove', onActivity, { passive: true });
      window.addEventListener('keydown', onActivity, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (this.destroyed) return;
        if (document.visibilityState === 'hidden') {
          this.setAppPowerState('BACKGROUND');
        } else {
          this.setAppPowerState('ONLINE');
          onActivity();
        }
      });
    }

    this.startHeartbeat();
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = setInterval(() => {
      const now = Date.now();
      this.peerPresenceMap.forEach((info, memberId) => {
        if (
          info.state !== 'OFFLINE' &&
          now - info.lastSeen > PRESENCE_TIMEOUT_MS
        ) {
          info.state = 'OFFLINE';
          this.dispatchEvent(
            new CustomEvent('presence_change', {
              detail: { contactId: memberId, state: 'OFFLINE' },
            })
          );
        }
      });
    }, 5_000);
  }

  private setAppPowerState(next: AppPresenceState): void {
    if (this.appPowerState === next) return;
    this.appPowerState = next;
    this.dispatchEvent(
      new CustomEvent('app_power_state_change', { detail: { state: next } })
    );
    this.startHeartbeat();
    void this.sendPresenceHeartbeat();
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    const interval =
      this.appPowerState === 'BACKGROUND'
        ? 120_000
        : this.appPowerState === 'IDLE'
          ? 60_000
          : 25_000;
    this.heartbeatTimer = setInterval(() => {
      void this.sendPresenceHeartbeat();
    }, interval);
  }

  private async sendPresenceHeartbeat(): Promise<void> {
    if (!this.identity || !this.activeSession) return;
    await this.activeSession.sendPresence({
      status: this.appPowerState,
      memberId: this.identity.memberId || this.identity.identityHash,
      deviceKeyId: this.identity.deviceKeyId!,
      timestamp: Date.now(),
    });
  }

  public async destroy(): Promise<void> {
    this.destroyed = true;
    await this.endCall().catch(() => {});
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    for (const w of this.pendingJoinWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Bridge destroyed'));
    }
    this.pendingJoinWaiters.clear();
    for (const w of this.pendingPermAuthWaiters.values()) {
      clearTimeout(w.timer);
      w.reject(new Error('Bridge destroyed'));
    }
    this.pendingPermAuthWaiters.clear();

    await this.cleanupRendezvous();
    await this.closeActiveSession();
    this.setGroupMeetingState('DISCONNECTED');
  }
}

export const chitchatterFamilyBridge = new ChitchatterFamilyBridge();
