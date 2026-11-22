/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { signaling, SignalingPayload } from './signaling.ts';
import { UserIdentity, ChatMessage } from '../types.ts';
import { encryptE2EE, decryptE2EE, EncryptedPayload } from '../crypto/cryptoUtils.ts';

const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.services.mozilla.com' },
  ],
};

export type DirectMessageCallback = (message: ChatMessage) => void;
export type TrackCallback = (peerId: string, stream: MediaStream) => void;
export type ConnectionStateCallback = (peerId: string, state: 'connecting' | 'connected' | 'disconnected') => void;
export type PeerPublicKeyLookup = (peerId: string) => string | undefined;

interface PeerSession {
  peerHash: string;
  peerPublicKey: string;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  state: 'connecting' | 'connected' | 'disconnected';
  remoteStream: MediaStream;
  isMakingOffer: boolean;
}

export class WebRTCChannelManager {
  private identity: UserIdentity | null = null;
  private sessions: Map<string, PeerSession> = new Map();
  private pendingCandidates: Map<string, RTCIceCandidateInit[]> = new Map();
  private onMessageCallbacks: Set<DirectMessageCallback> = new Set();
  private onTrackCallbacks: Set<TrackCallback> = new Set();
  private onStateCallbacks: Set<ConnectionStateCallback> = new Set();
  private unsubSignaling: (() => void) | null = null;
  private localStream: MediaStream | null = null;
  private getPeerPublicKeyFn: PeerPublicKeyLookup | null = null;

  constructor() {
    this.unsubSignaling = signaling.subscribe(this.handleSignalingPayload.bind(this));
  }

  public setIdentity(identity: UserIdentity): void {
    this.identity = identity;
  }

  public setGetPeerPublicKey(fn: PeerPublicKeyLookup): void {
    this.getPeerPublicKeyFn = fn;
  }

  public setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    if (stream) {
      this.sessions.forEach((session) => {
        stream.getTracks().forEach((track) => {
          session.pc.addTrack(track, stream);
        });
      });
    }
  }

  public getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  public onMessage(cb: DirectMessageCallback): () => void {
    this.onMessageCallbacks.add(cb);
    return () => this.onMessageCallbacks.delete(cb);
  }

  public onTrack(cb: TrackCallback): () => void {
    this.onTrackCallbacks.add(cb);
    return () => this.onTrackCallbacks.delete(cb);
  }

  public onConnectionState(cb: ConnectionStateCallback): () => void {
    this.onStateCallbacks.add(cb);
    return () => this.onStateCallbacks.delete(cb);
  }

  public isConnected(peerHash: string): boolean {
    const session = this.sessions.get(peerHash);
    return session?.state === 'connected' || false;
  }

  public getSession(peerHash: string): PeerSession | undefined {
    return this.sessions.get(peerHash);
  }

  /**
   * Connect to peer via WebRTC
   */
  public async connectToPeer(peerHash: string, peerPublicKey: string): Promise<void> {
    if (!this.identity || peerHash === this.identity.identityHash) return;

    let session = this.sessions.get(peerHash);
    if (session && (session.state === 'connected' || session.state === 'connecting')) {
      return;
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    const remoteStream = new MediaStream();

    session = {
      peerHash,
      peerPublicKey,
      pc,
      dataChannel: null,
      state: 'connecting',
      remoteStream,
      isMakingOffer: false,
    };
    this.sessions.set(peerHash, session);
    this.notifyState(peerHash, 'connecting');

    // Create Data Channel for Chat
    const dc = pc.createDataChannel('family_e2ee_chat', { ordered: true });
    this.setupDataChannel(peerHash, dc);
    session.dataChannel = dc;

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream!);
      });
    }

    this.setupPeerConnectionEvents(peerHash, pc, remoteStream);

    try {
      session.isMakingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      signaling.broadcast({
        type: 'PRIVATE_SIGNAL',
        senderId: this.identity.identityHash,
        targetId: peerHash,
        payload: {
          subType: 'OFFER',
          sdp: offer,
          senderPublicKey: this.identity.publicKey,
        },
        timestamp: Date.now(),
      });
    } catch (err) {
      console.warn('Failed to create WebRTC offer:', err);
      session.state = 'disconnected';
      this.notifyState(peerHash, 'disconnected');
    } finally {
      session.isMakingOffer = false;
    }
  }

  private setupPeerConnectionEvents(
    peerHash: string,
    pc: RTCPeerConnection,
    remoteStream: MediaStream
  ): void {
    pc.onicecandidate = (event) => {
      if (event.candidate && this.identity) {
        signaling.broadcast({
          type: 'PRIVATE_SIGNAL',
          senderId: this.identity.identityHash,
          targetId: peerHash,
          payload: {
            subType: 'ICE',
            candidate: event.candidate.toJSON(),
          },
          timestamp: Date.now(),
        });
      }
    };

    pc.ontrack = (event) => {
      event.streams[0]?.getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
      this.onTrackCallbacks.forEach((cb) => cb(peerHash, remoteStream));
    };

    pc.ondatachannel = (event) => {
      this.setupDataChannel(peerHash, event.channel);
      const session = this.sessions.get(peerHash);
      if (session) session.dataChannel = event.channel;
    };

    pc.onconnectionstatechange = () => {
      const session = this.sessions.get(peerHash);
      if (!session) return;

      if (pc.connectionState === 'connected') {
        session.state = 'connected';
        this.notifyState(peerHash, 'connected');
      } else if (
        pc.connectionState === 'disconnected' ||
        pc.connectionState === 'failed' ||
        pc.connectionState === 'closed'
      ) {
        session.state = 'disconnected';
        this.notifyState(peerHash, 'disconnected');
      }
    };
  }

  private setupDataChannel(peerHash: string, dc: RTCDataChannel): void {
    dc.onopen = () => {
      const session = this.sessions.get(peerHash);
      if (session) {
        session.state = 'connected';
        this.notifyState(peerHash, 'connected');
      }
    };

    dc.onclose = () => {
      const session = this.sessions.get(peerHash);
      if (session) {
        session.state = 'disconnected';
        this.notifyState(peerHash, 'disconnected');
      }
    };

    dc.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data);
        const session = this.sessions.get(peerHash);
        this.handleEncryptedMessage(peerHash, raw, session?.peerPublicKey);
      } catch (err) {
        console.error('Failed to parse incoming direct message:', err);
      }
    };
  }

  private async drainPendingCandidates(peerHash: string, pc: RTCPeerConnection): Promise<void> {
    const candidates = this.pendingCandidates.get(peerHash) || [];
    this.pendingCandidates.delete(peerHash);

    for (const cand of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (err) {
        console.warn('Error adding queued ICE candidate:', err);
      }
    }
  }

  private async handleSignalingPayload(msg: SignalingPayload): Promise<void> {
    if (!this.identity || msg.type !== 'PRIVATE_SIGNAL' || msg.targetId !== this.identity.identityHash) {
      return;
    }

    const { senderId, payload } = msg;
    if (!payload) return;

    if (payload.subType === 'OFFER') {
      let session = this.sessions.get(senderId);
      const isCollision = session?.isMakingOffer || (session && session.pc.signalingState !== 'stable');
      const isPolite = this.identity.identityHash > senderId;

      if (isCollision && !isPolite) {
        // Impolite peer ignores colliding incoming offer
        return;
      }

      const pc = session?.pc || new RTCPeerConnection(ICE_SERVERS);
      const remoteStream = session?.remoteStream || new MediaStream();

      session = {
        peerHash: senderId,
        peerPublicKey: payload.senderPublicKey || session?.peerPublicKey || '',
        pc,
        dataChannel: session?.dataChannel || null,
        state: 'connecting',
        remoteStream,
        isMakingOffer: false,
      };
      this.sessions.set(senderId, session);
      this.setupPeerConnectionEvents(senderId, pc, remoteStream);

      if (this.localStream) {
        this.localStream.getTracks().forEach((track) => {
          pc.addTrack(track, this.localStream!);
        });
      }

      try {
        if (pc.signalingState !== 'stable') {
          await pc.setLocalDescription({ type: 'rollback' });
        }
        await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await this.drainPendingCandidates(senderId, pc);

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        signaling.broadcast({
          type: 'PRIVATE_SIGNAL',
          senderId: this.identity.identityHash,
          targetId: senderId,
          payload: {
            subType: 'ANSWER',
            sdp: answer,
          },
          timestamp: Date.now(),
        });
      } catch (err) {
        console.warn('Failed to handle incoming offer:', err);
      }
    } else if (payload.subType === 'ANSWER') {
      const session = this.sessions.get(senderId);
      if (session && session.pc.signalingState === 'have-local-offer') {
        try {
          await session.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          await this.drainPendingCandidates(senderId, session.pc);
        } catch (err) {
          console.warn('Failed to set remote answer:', err);
        }
      }
    } else if (payload.subType === 'ICE') {
      const session = this.sessions.get(senderId);
      if (session && payload.candidate) {
        if (session.pc.remoteDescription) {
          try {
            await session.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
          } catch (err) {
            console.warn('Failed to add ICE candidate:', err);
          }
        } else {
          // Queue candidate until remote description is ready
          const queue = this.pendingCandidates.get(senderId) || [];
          queue.push(payload.candidate);
          this.pendingCandidates.set(senderId, queue);
        }
      }
    } else if (payload.subType === 'RELAY_E2EE_MESSAGE') {
      // 1:1 message sent via signaling relay (works with or without active WebRTC DataChannel)
      this.handleEncryptedMessage(senderId, payload.data, payload.senderPublicKey);
    } else if (payload.subType === 'DELIVERY_ACK') {
      if (payload.messageId) {
        this.onMessageCallbacks.forEach((cb) => {
          cb({
            id: payload.messageId,
            chatId: senderId,
            senderId: this.identity!.identityHash,
            senderName: '',
            content: '',
            timestamp: Date.now(),
            status: 'delivered',
          });
        });
      }
    }
  }

  public handleEncryptedMessage(
    senderId: string,
    raw: { encrypted: EncryptedPayload; messageId: string },
    senderPublicKey?: string
  ): void {
    if (!this.identity || !raw.encrypted) return;

    let peerPubKey = senderPublicKey || this.sessions.get(senderId)?.peerPublicKey;
    if (!peerPubKey && this.getPeerPublicKeyFn) {
      peerPubKey = this.getPeerPublicKeyFn(senderId);
    }

    if (!peerPubKey) {
      console.warn('Cannot decrypt private message: sender public key unknown for', senderId);
      return;
    }

    const decryptedJson = decryptE2EE(raw.encrypted, peerPubKey, this.identity.secretKey);
    if (!decryptedJson) {
      console.warn('Decryption failed for private message from', senderId);
      return;
    }

    try {
      const chatMsg: ChatMessage = JSON.parse(decryptedJson);
      chatMsg.status = 'delivered';
      this.onMessageCallbacks.forEach((cb) => cb(chatMsg));

      // Send delivery ACK back to sender
      this.sendDeliveryAck(senderId, chatMsg.id);
    } catch (err) {
      console.error('Failed to parse decrypted message:', err);
    }
  }

  private sendDeliveryAck(targetId: string, messageId: string): void {
    if (!this.identity) return;
    const session = this.sessions.get(targetId);
    const payload = { subType: 'DELIVERY_ACK', messageId };

    if (session?.dataChannel?.readyState === 'open') {
      session.dataChannel.send(JSON.stringify(payload));
    } else {
      signaling.broadcast({
        type: 'PRIVATE_SIGNAL',
        senderId: this.identity.identityHash,
        targetId,
        payload,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Sends E2EE message over direct DataChannel or encrypted signaling relay
   */
  public async sendDirectMessage(
    recipientHash: string,
    recipientPublicKey: string,
    message: ChatMessage
  ): Promise<boolean> {
    if (!this.identity) return false;

    // Encrypt payload with recipient's public key
    const encrypted = encryptE2EE(JSON.stringify(message), recipientPublicKey, this.identity.secretKey);
    const packet = { encrypted, messageId: message.id };
    const session = this.sessions.get(recipientHash);

    // 1. Try sending over direct WebRTC DataChannel if open
    if (session?.dataChannel?.readyState === 'open') {
      try {
        session.dataChannel.send(JSON.stringify(packet));
        return true;
      } catch (err) {
        console.warn('DataChannel send failed, falling back to encrypted relay:', err);
      }
    }

    // 2. Encrypted fallback via DualLayerSignaling (BroadcastChannel / Trackers)
    signaling.broadcast({
      type: 'PRIVATE_SIGNAL',
      senderId: this.identity.identityHash,
      targetId: recipientHash,
      payload: {
        subType: 'RELAY_E2EE_MESSAGE',
        senderPublicKey: this.identity.publicKey,
        data: packet,
      },
      timestamp: Date.now(),
    });

    return true;
  }

  private notifyState(peerHash: string, state: 'connecting' | 'connected' | 'disconnected'): void {
    this.onStateCallbacks.forEach((cb) => cb(peerHash, state));
  }

  public closeSession(peerHash: string): void {
    const session = this.sessions.get(peerHash);
    if (session) {
      session.dataChannel?.close();
      session.pc.close();
      this.sessions.delete(peerHash);
      this.notifyState(peerHash, 'disconnected');
    }
  }

  public destroy(): void {
    if (this.unsubSignaling) this.unsubSignaling();
    this.sessions.forEach((s) => {
      s.dataChannel?.close();
      s.pc.close();
    });
    this.sessions.clear();
    this.pendingCandidates.clear();
    this.onMessageCallbacks.clear();
    this.onTrackCallbacks.clear();
    this.onStateCallbacks.clear();
  }
}

export const webrtcChannel = new WebRTCChannelManager();
