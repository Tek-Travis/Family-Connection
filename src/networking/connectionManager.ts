/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { signaling, SignalingPayload } from './signaling.ts';
import { webrtcChannel } from './webrtcChannel.ts';
import { storageManager } from '../storage/indexedDB.ts';
import {
  UserIdentity,
  FamilyMember,
  ChatMessage,
  MessageStatus,
  AppPresenceState,
  PeerPresence,
  GroupMeetingState,
  PrivateChannelState,
} from '../types.ts';
import { playNotificationChime } from '../crypto/cryptoUtils.ts';
import { notificationManager } from '../components/NotificationContainer.tsx';

export type StatusUpdateCallback = (update: { messageId: string; status: MessageStatus }) => void;

interface PeerPresenceInfo {
  state: PeerPresence;
  lastSeen: number;
}

export class ConnectionManager extends EventTarget {
  private identity: UserIdentity | null = null;
  private members: Map<string, FamilyMember> = new Map();
  // Ephemeral public keys observed on the network (for E2EE decrypt without polluting family member list)
  private peerPublicKeys: Map<string, { publicKey: string; firstName?: string; lastName?: string }> = new Map();

  // --- Level 1: App Presence & Background Heartbeat State ---
  private appPowerState: AppPresenceState = 'ONLINE';
  private peerPresenceMap: Map<string, PeerPresenceInfo> = new Map();
  private heartbeatIntervalTimer: any = null;
  private peerPresenceCheckTimer: any = null;
  private idleTimeoutTimer: any = null;

  // --- Level 2: Family Group Meeting Connection State ---
  private groupMeetingState: GroupMeetingState = 'DISCONNECTED';

  // --- Level 3: Private Message 1:1 Connection State ---
  private privateChannelStates: Map<string, PrivateChannelState> = new Map();
  private activeChatPeerId: string | null = null;

  // --- Unread Message Alert System ---
  private unreadCounts: Map<string, number> = new Map();
  private statusCallbacks: Set<StatusUpdateCallback> = new Set();
  private isInitialized = false;

  public async init(identity: UserIdentity): Promise<void> {
    this.identity = identity;

    // Connect webrtcChannel lookup to our member registry and ephemeral peer public keys
    webrtcChannel.setGetPeerPublicKey((peerId) => {
      const member = this.members.get(peerId);
      if (member) return member.publicKey;
      return this.peerPublicKeys.get(peerId)?.publicKey;
    });
    webrtcChannel.setIdentity(identity);
    signaling.setIdentity(identity);

    await storageManager.init();

    // Load registered contacts
    const contacts = await storageManager.getContacts();
    contacts.forEach((c) => this.members.set(c.identityHash, c));

    if (!this.isInitialized) {
      // Subscribe to Signaling Events
      signaling.subscribe(this.handleSignaling.bind(this));

      // Subscribe to Direct WebRTC Messages & State Changes
      webrtcChannel.onMessage(this.handleDirectMessage.bind(this));
      webrtcChannel.onConnectionState(this.handleWebRTCState.bind(this));

      // Setup Level 1 Lifecycle (Activity & Visibility detection)
      this.setupLifecycleTracking();

      this.isInitialized = true;
    }

    // Set Level 2 Group Meeting State to CONNECTED
    this.setGroupMeetingState('CONNECTED');

    // Start Level 1 Heartbeats
    this.startHeartbeat();

    // Start Level 1 Peer Timeout Check
    this.startPresenceMonitoring();

    // Reconnect any known active peers for 1:1 channels
    this.reconnectActivePeers();
  }

  // =========================================================================
  // LEVEL 1: APP PRESENCE & BACKGROUND HEARTBEAT STATE
  // =========================================================================

  private setupLifecycleTracking(): void {
    const onUserActivity = () => {
      if (this.appPowerState !== 'ONLINE' && document.visibilityState === 'visible') {
        this.setAppPowerState('ONLINE');
      }

      clearTimeout(this.idleTimeoutTimer);
      // After 60 seconds of no interaction, transition to IDLE state
      this.idleTimeoutTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') {
          this.setAppPowerState('IDLE');
        }
      }, 60000);
    };

    window.addEventListener('pointermove', onUserActivity, { passive: true });
    window.addEventListener('keydown', onUserActivity, { passive: true });
    window.addEventListener('touchstart', onUserActivity, { passive: true });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.setAppPowerState('BACKGROUND');
      } else {
        this.setAppPowerState('ONLINE');
        onUserActivity();
      }
    });

    onUserActivity();
  }

  private setAppPowerState(newState: AppPresenceState): void {
    if (this.appPowerState === newState) return;
    this.appPowerState = newState;

    this.dispatchEvent(
      new CustomEvent('app_power_state_change', {
        detail: { state: newState },
      })
    );

    // Restart heartbeat with new adaptive interval
    this.startHeartbeat();
    // Announce state change immediately
    this.broadcastHeartbeat();
  }

  public getAppPowerState(): AppPresenceState {
    return this.appPowerState;
  }

  private startHeartbeat(): void {
    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer);
    }

    // Adaptive intervals based on power state (Level 1)
    let intervalMs = 25000; // ACTIVE: 25s
    if (this.appPowerState === 'IDLE') {
      intervalMs = 60000; // IDLE: 60s
    } else if (this.appPowerState === 'BACKGROUND') {
      intervalMs = 120000; // BACKGROUND: 120s
    }

    this.heartbeatIntervalTimer = setInterval(() => {
      this.broadcastHeartbeat();
    }, intervalMs);
  }

  private broadcastHeartbeat(): void {
    if (!this.identity) return;

    signaling.broadcast({
      type: 'PRESENCE_HEARTBEAT',
      senderId: this.identity.identityHash,
      senderProfile: {
        identityHash: this.identity.identityHash,
        firstName: this.identity.firstName,
        lastName: this.identity.lastName,
        publicKey: this.identity.publicKey,
        inviteCode: this.identity.inviteCode,
      },
      payload: {
        status: this.appPowerState,
      },
      timestamp: Date.now(),
    });
  }

  private startPresenceMonitoring(): void {
    if (this.peerPresenceCheckTimer) {
      clearInterval(this.peerPresenceCheckTimer);
    }

    // Check every 5s if any peer timed out (> 70s without heartbeat)
    this.peerPresenceCheckTimer = setInterval(() => {
      const now = Date.now();
      const timeoutThreshold = 75000;

      this.peerPresenceMap.forEach((info, peerId) => {
        if (info.state !== 'OFFLINE' && now - info.lastSeen > timeoutThreshold) {
          info.state = 'OFFLINE';
          this.dispatchEvent(
            new CustomEvent('presence_change', {
              detail: { contactId: peerId, state: 'OFFLINE' },
            })
          );
        }
      });
    }, 5000);
  }

  public getPresence(identityHash: string): 'online' | 'offline' | 'away' {
    const info = this.peerPresenceMap.get(identityHash);
    if (!info) return 'offline';
    if (info.state === 'ONLINE') return 'online';
    if (info.state === 'IDLE') return 'away';
    return 'offline';
  }

  public getPeerPresence(identityHash: string): PeerPresence {
    return this.peerPresenceMap.get(identityHash)?.state || 'OFFLINE';
  }

  // =========================================================================
  // LEVEL 2: FAMILY GROUP MEETING CONNECTION STATE
  // =========================================================================

  private setGroupMeetingState(state: GroupMeetingState): void {
    this.groupMeetingState = state;
    this.dispatchEvent(
      new CustomEvent('group_state_change', {
        detail: {
          state,
          peerCount: this.getGroupOnlinePeerCount(),
        },
      })
    );
  }

  public getGroupMeetingState(): GroupMeetingState {
    return this.groupMeetingState;
  }

  public getGroupOnlinePeerCount(): number {
    let count = 0;
    this.peerPresenceMap.forEach((info) => {
      if (info.state === 'ONLINE' || info.state === 'IDLE') {
        count++;
      }
    });
    return count;
  }

  // =========================================================================
  // LEVEL 3: PRIVATE MESSAGE 1:1 CONNECTION STATE
  // =========================================================================

  public getPrivateChannelState(contactId: string): PrivateChannelState {
    if (this.activeChatPeerId === contactId) return 'ACTIVE_CHAT';
    return this.privateChannelStates.get(contactId) || 'DISCONNECTED';
  }

  public promoteToActiveChat(contactId: string): void {
    this.activeChatPeerId = contactId;
    this.privateChannelStates.set(contactId, 'ACTIVE_CHAT');
    this.markAsRead(contactId);

    const member = this.members.get(contactId);
    if (member && !webrtcChannel.isConnected(contactId)) {
      this.privateChannelStates.set(contactId, 'CONNECTING');
      webrtcChannel.connectToPeer(contactId, member.publicKey).catch(() => {});
    }

    this.dispatchEvent(
      new CustomEvent('connection_state_change', {
        detail: { contactId, state: 'ACTIVE_CHAT' },
      })
    );
  }

  public demoteFromActiveChat(contactId: string): void {
    if (this.activeChatPeerId === contactId) {
      this.activeChatPeerId = null;
      const isConnected = webrtcChannel.isConnected(contactId);
      const nextState: PrivateChannelState = isConnected ? 'CONNECTED' : 'DISCONNECTED';
      this.privateChannelStates.set(contactId, nextState);

      this.dispatchEvent(
        new CustomEvent('connection_state_change', {
          detail: { contactId, state: nextState },
        })
      );
    }
  }

  // =========================================================================
  // UNREAD MESSAGES & ALERT SYSTEM
  // =========================================================================

  public getUnreadCount(contactId: string): number {
    return this.unreadCounts.get(contactId) || 0;
  }

  public getTotalUnreadCount(): number {
    let total = 0;
    this.unreadCounts.forEach((count) => {
      total += count;
    });
    return total;
  }

  public markAsRead(contactId: string): void {
    if ((this.unreadCounts.get(contactId) || 0) > 0) {
      this.unreadCounts.set(contactId, 0);
      this.updateDocumentTitle();
      this.dispatchEvent(
        new CustomEvent('unread_change', {
          detail: { contactId, count: 0, total: this.getTotalUnreadCount() },
        })
      );
    }
  }

  private incrementUnread(contactId: string): number {
    const current = this.unreadCounts.get(contactId) || 0;
    const next = current + 1;
    this.unreadCounts.set(contactId, next);
    this.updateDocumentTitle();
    this.dispatchEvent(
      new CustomEvent('unread_change', {
        detail: { contactId, count: next, total: this.getTotalUnreadCount() },
      })
    );
    return next;
  }

  private updateDocumentTitle(): void {
    const total = this.getTotalUnreadCount();
    if (total > 0) {
      document.title = `(${total}) 💬 New Message - Family Connection`;
    } else {
      document.title = 'Family Connection - Private P2P Messenger';
    }
  }

  public onMessageStatusChange(cb: StatusUpdateCallback): () => void {
    this.statusCallbacks.add(cb);
    return () => this.statusCallbacks.delete(cb);
  }

  private notifyStatus(messageId: string, status: MessageStatus): void {
    this.statusCallbacks.forEach((cb) => cb({ messageId, status }));
  }

  // =========================================================================
  // MESSAGING OPERATIONS
  // =========================================================================

  public async sendGroupMessage(groupId: string, content: string): Promise<ChatMessage> {
    if (!this.identity) throw new Error('Identity not set');

    const msg: ChatMessage = {
      id: `grp-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      chatId: groupId,
      senderId: this.identity.identityHash,
      senderName: `${this.identity.firstName} ${this.identity.lastName}`,
      content,
      timestamp: Date.now(),
      status: 'sent',
    };

    // Save locally
    await storageManager.addMessage(groupId, msg);

    // Broadcast over Group Mesh topic (GossipSub equivalent)
    signaling.broadcast({
      type: 'GROUP_CHAT',
      senderId: this.identity.identityHash,
      senderProfile: {
        identityHash: this.identity.identityHash,
        firstName: this.identity.firstName,
        lastName: this.identity.lastName,
        publicKey: this.identity.publicKey,
        inviteCode: this.identity.inviteCode,
      },
      payload: {
        groupId,
        message: msg,
      },
      timestamp: Date.now(),
    });

    return msg;
  }

  public async sendDirectMessage(recipientHash: string, content: string): Promise<ChatMessage> {
    if (!this.identity) throw new Error('Identity not set');

    let recipient = this.members.get(recipientHash);
    if (!recipient) {
      const contacts = await storageManager.getContacts();
      recipient = contacts.find((c) => c.identityHash === recipientHash);
      if (recipient) this.members.set(recipientHash, recipient);
    }

    if (!recipient) throw new Error('Recipient not in family registry');

    const msg: ChatMessage = {
      id: `priv-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      chatId: recipientHash,
      senderId: this.identity.identityHash,
      senderName: `${this.identity.firstName} ${this.identity.lastName}`,
      content,
      timestamp: Date.now(),
      status: 'sending',
      encrypted: true,
    };

    // Save locally under the conversation ID
    await storageManager.addMessage(recipientHash, msg);

    // Instant Relay Send (Guarantees delivery immediately even if WebRTC is still connecting)
    await webrtcChannel.sendDirectMessage(recipientHash, recipient.publicKey, msg);

    const isDirectConnected = webrtcChannel.isConnected(recipientHash);
    if (isDirectConnected) {
      msg.status = 'sent';
      await storageManager.updateMessageStatus(recipientHash, msg.id, 'sent');
      this.notifyStatus(msg.id, 'sent');
    } else {
      await storageManager.enqueueOfflineMessage(msg);
      msg.status = 'sent';
      await storageManager.updateMessageStatus(recipientHash, msg.id, 'sent');
      this.notifyStatus(msg.id, 'sent');

      // Attempt background WebRTC connection if not connected
      webrtcChannel.connectToPeer(recipientHash, recipient.publicKey).catch(() => {});
    }

    return msg;
  }

  // =========================================================================
  // FAMILY REGISTRY (EXPLICIT USER-CONTROLLED MEMBERSHIP)
  // =========================================================================

  public getMembers(): FamilyMember[] {
    return Array.from(this.members.values());
  }

  public async addMember(member: FamilyMember): Promise<boolean> {
    const isNew = !this.members.has(member.identityHash);
    this.members.set(member.identityHash, member);
    await storageManager.saveContact(member);

    if (this.identity && member.identityHash !== this.identity.identityHash) {
      webrtcChannel.connectToPeer(member.identityHash, member.publicKey).catch(() => {});
    }

    this.dispatchEvent(new CustomEvent('member_added', { detail: member }));
    return isNew;
  }

  public async removeMember(identityHash: string): Promise<void> {
    this.members.delete(identityHash);
    await storageManager.removeContact(identityHash);
    webrtcChannel.closeSession(identityHash);
    this.privateChannelStates.set(identityHash, 'DISCONNECTED');
    this.dispatchEvent(new CustomEvent('member_removed', { detail: identityHash }));
  }

  public async muteMember(identityHash: string): Promise<void> {
    const member = this.members.get(identityHash);
    if (member) {
      member.isMuted = !member.isMuted;
      await storageManager.updateContact(identityHash, { isMuted: member.isMuted });
      this.dispatchEvent(new CustomEvent('member_updated', { detail: member }));
    }
  }

  public async blockMember(identityHash: string): Promise<void> {
    const member = this.members.get(identityHash);
    if (member) {
      member.isBlocked = !member.isBlocked;
      await storageManager.updateContact(identityHash, { isBlocked: member.isBlocked });
      webrtcChannel.closeSession(identityHash);
      this.privateChannelStates.set(identityHash, 'DISCONNECTED');
      this.dispatchEvent(new CustomEvent('member_updated', { detail: member }));
    }
  }

  public isMuted(identityHash: string): boolean {
    return this.members.get(identityHash)?.isMuted || false;
  }

  public isBlocked(identityHash: string): boolean {
    return this.members.get(identityHash)?.isBlocked || false;
  }

  public searchAndJoinByCode(inviteCode: string): void {
    if (!this.identity) return;
    const cleanCode = inviteCode.trim().toUpperCase();

    signaling.broadcast({
      type: 'JOIN_REQUEST',
      senderId: this.identity.identityHash,
      targetCode: cleanCode,
      senderProfile: {
        identityHash: this.identity.identityHash,
        firstName: this.identity.firstName,
        lastName: this.identity.lastName,
        publicKey: this.identity.publicKey,
        inviteCode: this.identity.inviteCode,
      },
      timestamp: Date.now(),
    });
  }

  // =========================================================================
  // SIGNALING & WEBRTC EVENT DISPATCHERS
  // =========================================================================

  private async handleSignaling(msg: SignalingPayload): Promise<void> {
    if (!this.identity) return;

    // Cache ephemeral sender public key if present (for decryption, without adding to member list)
    if (msg.senderProfile?.identityHash && msg.senderProfile.publicKey) {
      this.peerPublicKeys.set(msg.senderProfile.identityHash, {
        publicKey: msg.senderProfile.publicKey,
        firstName: msg.senderProfile.firstName,
        lastName: msg.senderProfile.lastName,
      });
    }

    if (msg.type === 'PRESENCE_HEARTBEAT') {
      const status: PeerPresence = msg.payload?.status === 'BACKGROUND'
        ? 'IDLE'
        : msg.payload?.status === 'IDLE'
        ? 'IDLE'
        : 'ONLINE';

      const prev = this.peerPresenceMap.get(msg.senderId);
      this.peerPresenceMap.set(msg.senderId, { state: status, lastSeen: Date.now() });

      if (prev?.state !== status) {
        this.dispatchEvent(
          new CustomEvent('presence_change', {
            detail: { contactId: msg.senderId, state: status },
          })
        );
        this.flushOfflineQueue(msg.senderId);
      }
    } else if (msg.type === 'JOIN_REQUEST') {
      // Explicit member join request using invite code
      if (msg.targetCode === this.identity.inviteCode && msg.senderProfile) {
        const newMember: FamilyMember = {
          identityHash: msg.senderProfile.identityHash!,
          firstName: msg.senderProfile.firstName || 'Family',
          lastName: msg.senderProfile.lastName || 'Member',
          publicKey: msg.senderProfile.publicKey!,
          inviteCode: msg.senderProfile.inviteCode || '',
          addedAt: Date.now(),
        };

        const isNew = await this.addMember(newMember);

        // Send JOIN_RESPONSE back
        signaling.broadcast({
          type: 'JOIN_RESPONSE',
          senderId: this.identity.identityHash,
          targetId: newMember.identityHash,
          senderProfile: {
            identityHash: this.identity.identityHash,
            firstName: this.identity.firstName,
            lastName: this.identity.lastName,
            publicKey: this.identity.publicKey,
            inviteCode: this.identity.inviteCode,
          },
          timestamp: Date.now(),
        });

        // Broadcast to mesh so other authorized family members learn about the new member
        if (isNew) {
          signaling.broadcast({
            type: 'MEMBER_SHARE',
            senderId: this.identity.identityHash,
            payload: { member: newMember },
            timestamp: Date.now(),
          });
        }
      }
    } else if (msg.type === 'JOIN_RESPONSE') {
      // Explicit response to our join request
      if (msg.targetId === this.identity.identityHash && msg.senderProfile) {
        const inviter: FamilyMember = {
          identityHash: msg.senderProfile.identityHash!,
          firstName: msg.senderProfile.firstName || 'Family',
          lastName: msg.senderProfile.lastName || 'Member',
          publicKey: msg.senderProfile.publicKey!,
          inviteCode: msg.senderProfile.inviteCode || '',
          addedAt: Date.now(),
        };

        await this.addMember(inviter);
        this.dispatchEvent(
          new CustomEvent('joined_family_success', {
            detail: inviter,
          })
        );
      }
    } else if (msg.type === 'MEMBER_SHARE' && msg.payload?.member) {
      // Explicit member shared by an existing trusted family member
      const shared: FamilyMember = msg.payload.member;
      if (shared.identityHash !== this.identity.identityHash && !this.members.has(shared.identityHash)) {
        await this.addMember(shared);
      }
    } else if (msg.type === 'GROUP_CHAT' && msg.payload?.message) {
      const chatMsg: ChatMessage = msg.payload.message;
      if (chatMsg.senderId !== this.identity.identityHash) {
        await storageManager.addMessage(chatMsg.chatId, chatMsg);
        this.dispatchEvent(new CustomEvent('group_message_received', { detail: chatMsg }));
      }
    }
  }

  private async handleDirectMessage(msg: ChatMessage): Promise<void> {
    if (!this.identity) return;

    if (msg.status === 'delivered') {
      await storageManager.updateMessageStatus(msg.chatId, msg.id, 'delivered');
      this.notifyStatus(msg.id, 'delivered');
      return;
    }

    if (this.isBlocked(msg.senderId)) return;

    // Save message locally in IndexedDB
    await storageManager.addMessage(msg.senderId, msg);

    const isCurrentActiveChat = this.activeChatPeerId === msg.senderId;

    if (!isCurrentActiveChat) {
      // 1. Increment Unread Count
      this.incrementUnread(msg.senderId);

      // 2. Play Audio Chime Alert
      playNotificationChime();
    }

    this.dispatchEvent(new CustomEvent('direct_message_received', { detail: msg }));
  }

  private handleWebRTCState(peerHash: string, state: 'connecting' | 'connected' | 'disconnected'): void {
    const isCurrentActive = this.activeChatPeerId === peerHash;
    const resolvedState: PrivateChannelState = isCurrentActive
      ? 'ACTIVE_CHAT'
      : state === 'connected'
      ? 'CONNECTED'
      : state === 'connecting'
      ? 'CONNECTING'
      : 'DISCONNECTED';

    this.privateChannelStates.set(peerHash, resolvedState);

    this.dispatchEvent(
      new CustomEvent('connection_state_change', {
        detail: { contactId: peerHash, state: resolvedState },
      })
    );

    if (state === 'connected') {
      this.peerPresenceMap.set(peerHash, { state: 'ONLINE', lastSeen: Date.now() });
      this.flushOfflineQueue(peerHash);
    }
  }

  private async flushOfflineQueue(peerHash: string): Promise<void> {
    const member = this.members.get(peerHash);
    if (!member) return;

    const queued = await storageManager.getOfflineMessages(peerHash);
    for (const msg of queued) {
      const ok = await webrtcChannel.sendDirectMessage(peerHash, member.publicKey, msg);
      if (ok) {
        await storageManager.removeOfflineMessage(msg.id);
        await storageManager.updateMessageStatus(peerHash, msg.id, 'sent');
        this.notifyStatus(msg.id, 'sent');
      }
    }
  }

  private reconnectActivePeers(): void {
    this.members.forEach((member) => {
      if (this.identity && member.identityHash !== this.identity.identityHash) {
        webrtcChannel.connectToPeer(member.identityHash, member.publicKey).catch(() => {});
      }
    });
  }

  public destroy(): void {
    if (this.heartbeatIntervalTimer) clearInterval(this.heartbeatIntervalTimer);
    if (this.peerPresenceCheckTimer) clearInterval(this.peerPresenceCheckTimer);
    clearTimeout(this.idleTimeoutTimer);
  }
}

export const connectionManager = new ConnectionManager();
