/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { UserIdentity, FamilyMember } from '../types.ts';
import { sha256Hex } from '../crypto/cryptoUtils.ts';

export type SignalingMessageType =
  | 'DISCOVERY_ANNOUNCE'
  | 'JOIN_REQUEST'
  | 'JOIN_RESPONSE'
  | 'MEMBER_SHARE'
  | 'GROUP_CHAT'
  | 'PRIVATE_SIGNAL'
  | 'PRESENCE_HEARTBEAT'
  | 'SYNC_REQUEST'
  | 'SYNC_RESPONSE';

export interface SignalingPayload {
  type: SignalingMessageType;
  senderId: string; // sender identityHash
  targetId?: string; // target identityHash (if direct)
  targetCode?: string; // target inviteCode (for JOIN_REQUEST)
  senderProfile?: Partial<FamilyMember>;
  payload?: any;
  timestamp: number;
  nonce?: string;
}

export type SignalingListener = (msg: SignalingPayload) => void;

const DEFAULT_TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.btorrent.xyz',
  'wss://tracker.files.fm:7073/announce',
];

export interface TrackerStatus {
  url: string;
  connected: boolean;
  lastPing: number;
}

export class DualLayerSignaling {
  private localChannel: BroadcastChannel | null = null;
  private listeners: Set<SignalingListener> = new Set();
  private sockets: Map<string, WebSocket> = new Map();
  private trackerHealth: Map<string, TrackerStatus> = new Map();
  private identity: UserIdentity | null = null;
  private heartbeatTimer: any = null;
  private isDestroyed = false;
  private infoHash: string = '';
  private seenMessageKeys: Set<string> = new Set();

  constructor() {
    this.initLocalBroadcast();
    this.initTrackers();
  }

  public setIdentity(identity: UserIdentity): void {
    this.identity = identity;
    sha256Hex(identity.inviteCode).then((hash) => {
      this.infoHash = hash.substring(0, 40);
      this.announcePresence();
    });
  }

  private initLocalBroadcast(): void {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.localChannel = new BroadcastChannel('family_connection_mesh_v1');
        this.localChannel.onmessage = (event) => {
          if (!event.data || typeof event.data !== 'object') return;
          this.handleIncoming(event.data as SignalingPayload);
        };
      }
    } catch (err) {
      console.warn('BroadcastChannel not supported:', err);
    }
  }

  private initTrackers(): void {
    DEFAULT_TRACKERS.forEach((url) => {
      this.trackerHealth.set(url, { url, connected: false, lastPing: 0 });
      this.connectTracker(url);
    });

    // Adaptive heartbeat
    this.heartbeatTimer = setInterval(() => {
      if (this.isDestroyed) return;
      this.announcePresence();
    }, 25000);
  }

  private connectTracker(url: string): void {
    try {
      const ws = new WebSocket(url);
      this.sockets.set(url, ws);

      ws.onopen = () => {
        const status = this.trackerHealth.get(url);
        if (status) {
          status.connected = true;
          status.lastPing = Date.now();
        }
        this.announcePresence();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data && data.payload && data.type) {
            this.handleIncoming(data as SignalingPayload);
          }
        } catch {
          // Ignore non-JSON tracker telemetry
        }
      };

      ws.onerror = () => {
        const status = this.trackerHealth.get(url);
        if (status) status.connected = false;
      };

      ws.onclose = () => {
        const status = this.trackerHealth.get(url);
        if (status) status.connected = false;
        setTimeout(() => {
          if (!this.isDestroyed) {
            this.connectTracker(url);
          }
        }, 10000 + Math.random() * 5000);
      };
    } catch {
      // Offline fallback
    }
  }

  public subscribe(listener: SignalingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public broadcast(msg: SignalingPayload): void {
    if (this.isDestroyed) return;

    if (!msg.nonce) {
      msg.nonce = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }

    // Record own outgoing message nonce to avoid processing echo
    const ownKey = msg.payload?.message?.id || msg.nonce;
    this.seenMessageKeys.add(ownKey);

    // 1. Send via local BroadcastChannel (instant multi-tab delivery)
    if (this.localChannel) {
      try {
        this.localChannel.postMessage(msg);
      } catch (err) {
        console.warn('Failed to post to local channel:', err);
      }
    }

    // 2. Relay via connected WebSockets trackers
    const raw = JSON.stringify(msg);
    this.sockets.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(raw);
        } catch {
          // ignore transient socket error
        }
      }
    });
  }

  public announcePresence(): void {
    if (!this.identity) return;
    const msg: SignalingPayload = {
      type: 'PRESENCE_HEARTBEAT',
      senderId: this.identity.identityHash,
      senderProfile: {
        identityHash: this.identity.identityHash,
        firstName: this.identity.firstName,
        lastName: this.identity.lastName,
        publicKey: this.identity.publicKey,
        inviteCode: this.identity.inviteCode,
      },
      timestamp: Date.now(),
    };
    this.broadcast(msg);
  }

  private handleIncoming(msg: SignalingPayload): void {
    // 1. Ignore self messages
    if (this.identity && msg.senderId === this.identity.identityHash) {
      return;
    }

    // 2. Check if targeted to another specific peer
    if (msg.targetId && this.identity && msg.targetId !== this.identity.identityHash) {
      return;
    }

    // 3. Strict Deduplication: Drop duplicate packet if already received
    const dedupeKey = msg.payload?.message?.id || msg.nonce || `${msg.senderId}_${msg.type}_${msg.timestamp}`;
    if (this.seenMessageKeys.has(dedupeKey)) {
      return;
    }
    this.seenMessageKeys.add(dedupeKey);

    // Bounded deduplication cache
    if (this.seenMessageKeys.size > 2000) {
      const it = this.seenMessageKeys.values();
      for (let i = 0; i < 500; i++) {
        const val = it.next().value;
        if (val) this.seenMessageKeys.delete(val);
      }
    }

    // 4. Dispatch to subscribers
    this.listeners.forEach((fn) => {
      try {
        fn(msg);
      } catch (err) {
        console.error('Error in signaling listener:', err);
      }
    });
  }

  public getTrackersHealth(): TrackerStatus[] {
    return Array.from(this.trackerHealth.values());
  }

  public isConnected(): boolean {
    const anyTracker = Array.from(this.trackerHealth.values()).some((t) => t.connected);
    return !!this.localChannel || anyTracker;
  }

  public destroy(): void {
    this.isDestroyed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.localChannel) this.localChannel.close();
    this.sockets.forEach((ws) => ws.close());
    this.sockets.clear();
    this.listeners.clear();
  }
}

export const signaling = new DualLayerSignaling();
