/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ArrowLeft,
  Send,
  Phone,
  Video,
  PhoneOff,
  Mic,
  MicOff,
  VideoOff,
  Shield,
  Check,
  CheckCheck,
  Clock,
  Sparkles,
} from 'lucide-react';
import { UserIdentity, FamilyMember, ChatMessage } from '../types.ts';
import {
  chitchatterFamilyBridge as connectionManager,
  ActiveCallSession,
} from '../networking/chitchatterFamilyBridge.ts';
import { notificationManager } from './NotificationContainer.tsx';
import { silenceIncomingCallRingtone } from '../services/incomingCallRingtone.ts';

interface PrivateChatScreenProps {
  myIdentity: UserIdentity;
  peer: FamilyMember;
  initialCallRequest?: {
    peerId: string;
    type: 'voice' | 'video';
    nonce: number;
  };
  onConsumeCallRequest?: () => void;
  onBack: () => void;
}

export const PrivateChatScreen: React.FC<PrivateChatScreenProps> = ({
  myIdentity,
  peer,
  initialCallRequest,
  onConsumeCallRequest,
  onBack,
}) => {
  const peerId = peer.memberId || peer.identityHash;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [isConnected, setIsConnected] = useState(false);
  const [activeCall, setActiveCall] = useState<ActiveCallSession | null>(() => {
    const existing = connectionManager.getActiveCall();
    return existing && connectionManager.isSameMember(existing.peerId, peerId)
      ? existing
      : null;
  });

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastConsumedCallNonceRef = useRef<number | null>(null);

  const attachLocalPreview = () => {
    const stream = connectionManager.getLocalStream();
    if (stream && localVideoRef.current && localVideoRef.current.srcObject !== stream) {
      localVideoRef.current.srcObject = stream;
    }
  };

  const attachRemoteMedia = (stream: MediaStream | null) => {
    if (!stream) return;
    if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== stream) {
      remoteVideoRef.current.srcObject = stream;
    }
    if (remoteAudioRef.current && remoteAudioRef.current.srcObject !== stream) {
      remoteAudioRef.current.srcObject = stream;
    }
  };

  useEffect(() => {
    // 1. Promote to active chat in Chitchatter bridge
    connectionManager.promoteToActiveChat(peerId);

    // 2. Load historical messages across memberId and legacy identityHash keys
    connectionManager.getConversationMessages(peerId).then((history) => {
      setMessages(history);
      scrollToBottom();
    });

    // 3. Check connection status & any in-progress call/remote stream
    setIsConnected(connectionManager.isConnected(peerId));
    const currentCall = connectionManager.getActiveCall();
    if (currentCall && connectionManager.isSameMember(currentCall.peerId, peerId)) {
      setActiveCall(currentCall);
      attachLocalPreview();
      attachRemoteMedia(connectionManager.getRemoteStream());
    }

    // 4. Listen for direct messages, status updates, call states, and remote media
    const unsubMsg = connectionManager.onMessage((msg) => {
      if (
        connectionManager.isSameMember(msg.chatId, peerId) ||
        connectionManager.isSameMember(msg.senderId, peerId)
      ) {
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === msg.id);
          if (idx >= 0) {
            const copy = [...prev];
            copy[idx] = { ...copy[idx], status: msg.status };
            return copy;
          }
          if (!msg.content) return prev;
          return [...prev, msg];
        });
        scrollToBottom();
      }
    });

    const unsubState = connectionManager.onConnectionState((cbPeerId, state) => {
      if (connectionManager.isSameMember(cbPeerId, peerId)) {
        setIsConnected(state === 'connected');
      }
    });

    const unsubStatus = connectionManager.onMessageStatusChange((update) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === update.messageId ? { ...m, status: update.status } : m))
      );
    });

    const unsubTrack = connectionManager.onTrack((cbPeerId, stream) => {
      if (connectionManager.isSameMember(cbPeerId, peerId)) {
        attachRemoteMedia(stream);
      }
    });

    const unsubCallState = connectionManager.onCallStateChange((call) => {
      if (!connectionManager.isSameMember(call.peerId, peerId)) return;
      if (call.state === 'connected') {
        setActiveCall(call);
        attachLocalPreview();
        attachRemoteMedia(connectionManager.getRemoteStream());
        notificationManager.show(
          `Connected ${call.mediaType} call with ${peer.firstName}`,
          'success'
        );
      } else if (
        call.state === 'ringing_outgoing' ||
        call.state === 'ringing_incoming' ||
        call.state === 'connecting'
      ) {
        setActiveCall(call);
        attachLocalPreview();
      } else {
        setActiveCall(null);
        if (call.state === 'rejected') {
          notificationManager.show(call.errorReason || 'Call declined', 'info');
        } else if (call.state === 'failed') {
          notificationManager.show(
            call.errorReason || 'Call connection failed',
            'error'
          );
        }
      }
    });

    return () => {
      unsubMsg();
      unsubState();
      unsubStatus();
      unsubTrack();
      unsubCallState();
      connectionManager.demoteFromActiveChat(peerId);
    };
  }, [peerId]);

  useEffect(() => {
    if (activeCall) {
      attachLocalPreview();
      attachRemoteMedia(connectionManager.getRemoteStream());
    }
  }, [activeCall]);

  useEffect(() => {
    if (
      initialCallRequest &&
      initialCallRequest.nonce !== lastConsumedCallNonceRef.current
    ) {
      lastConsumedCallNonceRef.current = initialCallRequest.nonce;
      onConsumeCallRequest?.();
      void startCall(initialCallRequest.type);
    }
  }, [initialCallRequest]);

  const scrollToBottom = () => {
    setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 50);
  };

  const isSendingRef = useRef(false);

  const handleSend = async () => {
    if (isSendingRef.current) return;
    const text = inputText.trim();
    if (!text) return;

    isSendingRef.current = true;
    setInputText('');

    try {
      const sentMsg = await connectionManager.sendDirectMessage(peerId, text);
      setMessages((prev) => {
        if (prev.some((m) => m.id === sentMsg.id)) return prev;
        return [...prev, sentMsg];
      });
      scrollToBottom();
    } catch (err) {
      notificationManager.show(
        err instanceof Error ? err.message : 'Failed to send private message',
        'error'
      );
    } finally {
      setTimeout(() => {
        isSendingRef.current = false;
      }, 250);
    }
  };

  // --- Authenticated Target-Scoped WebRTC Audio / Video Call Initiation ---
  const startCall = async (type: 'voice' | 'video') => {
    if (!connectionManager.isConnected(peerId)) {
      notificationManager.show(
        `Cannot start ${type} call: ${peer.firstName} is offline or unauthenticated`,
        'error'
      );
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video',
      });
    } catch {
      notificationManager.show(
        'Microphone or camera access denied or unavailable',
        'error'
      );
      return;
    }

    try {
      const callSession = await connectionManager.startCall(
        peerId,
        type === 'voice' ? 'audio' : 'video',
        stream
      );
      setActiveCall(callSession);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setActiveCall(null);
      notificationManager.show(
        err instanceof Error ? err.message : 'Failed to initiate call',
        'error'
      );
    }
  };

  const answerIncomingCall = async () => {
    if (!activeCall || activeCall.state !== 'ringing_incoming') return;
    silenceIncomingCallRingtone(activeCall.callId);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: activeCall.mediaType === 'video',
      });
    } catch {
      notificationManager.show(
        'Microphone or camera permission required to answer call',
        'error'
      );
      await connectionManager.rejectCall(
        activeCall.callId,
        'Media permission denied'
      );
      setActiveCall(null);
      return;
    }

    try {
      const accepted = await connectionManager.acceptCall(activeCall.callId, stream);
      setActiveCall(accepted);
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      setActiveCall(null);
      notificationManager.show(
        err instanceof Error ? err.message : 'Failed to answer call',
        'error'
      );
    }
  };

  const declineIncomingCall = async () => {
    if (!activeCall) return;
    silenceIncomingCallRingtone(activeCall.callId);
    await connectionManager.rejectCall(activeCall.callId);
    setActiveCall(null);
  };

  const endCall = async () => {
    await connectionManager.endCall(activeCall?.callId);
    setActiveCall(null);
  };

  const toggleMute = () => {
    connectionManager.toggleMute();
  };

  const toggleVideo = () => {
    connectionManager.toggleVideo();
  };

  return (
    <div
      className="h-screen flex flex-col font-publicSans"
      style={{ backgroundColor: 'var(--bg-color)', color: 'rgb(var(--text-color))' }}
    >
      {/* Header */}
      <header
        className="flex items-center justify-between p-4 border-b border-white/15 sticky top-0 z-10 backdrop-blur-md"
        style={{ backgroundColor: 'rgba(var(--bg-color), 0.85)' }}
      >
        <button
          onClick={onBack}
          className="p-2 rounded-full hover:bg-white/10 transition-colors"
          aria-label="Back"
        >
          <ArrowLeft className="w-6 h-6" />
        </button>

        <div className="flex flex-col items-center">
          <h1 className="font-bold text-xl font-display tracking-tight">
            {peer.firstName} {peer.lastName}
          </h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={`w-2 h-2 rounded-full ${
                isConnected
                  ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.7)]'
                  : 'bg-amber-400 animate-pulse'
              }`}
            />
            <span className="text-[10px] font-bold uppercase tracking-wider opacity-75">
              {isConnected ? 'Direct WebRTC' : 'Offline / Sender Outbox'}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => void startCall('voice')}
            className="p-2 rounded-full hover:bg-white/10 transition-colors"
            title="Start Voice Call"
          >
            <Phone className="w-5 h-5" />
          </button>
          <button
            onClick={() => void startCall('video')}
            className="p-2 rounded-full hover:bg-white/10 transition-colors"
            title="Start Video Call"
          >
            <Video className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Messages */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
        <div className="text-center py-2">
          <span className="text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-black/20 border border-white/10 opacity-70 flex items-center justify-center gap-1.5 w-fit mx-auto">
            <Shield className="w-3 h-3 text-emerald-400" />
            End-to-End Encrypted (TweetNaCl Curve25519)
          </span>
        </div>

        {messages.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center opacity-60 space-y-2">
            <Shield className="w-12 h-12 stroke-[1.5]" />
            <p className="text-base font-medium">Encrypted Line Ready</p>
            <p className="text-xs max-w-xs">
              Direct peer-to-peer messaging with {peer.firstName}. No intermediaries.
            </p>
          </div>
        ) : (
          messages.map((msg) => {
            const isMe = connectionManager.isSelfId(msg.senderId);

            return (
              <motion.div
                key={msg.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex items-start gap-2.5 max-w-[85%] ${
                  isMe ? 'ml-auto flex-row-reverse' : ''
                }`}
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 border border-white/20 shadow-sm"
                  style={{
                    backgroundColor: isMe ? 'rgba(var(--text-color), 0.2)' : 'rgba(0,0,0,0.3)',
                    color: 'rgb(var(--text-color))',
                  }}
                >
                  {isMe
                    ? myIdentity.firstName.substring(0, 1).toUpperCase()
                    : peer.firstName.substring(0, 1).toUpperCase()}
                </div>

                <div className={`space-y-1 ${isMe ? 'items-end' : 'items-start'}`}>
                  <div
                    className={`p-3.5 px-4 rounded-3xl shadow-md ${
                      isMe ? 'rounded-tr-sm chat-bubble-me' : 'rounded-tl-sm chat-bubble-other'
                    }`}
                  >
                    <p className="text-base leading-relaxed break-words">{msg.content}</p>
                  </div>

                  <div
                    className={`flex items-center gap-1.5 text-[10px] opacity-60 px-2 ${
                      isMe ? 'justify-end' : 'justify-start'
                    }`}
                  >
                    <span>
                      {new Date(msg.timestamp).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {isMe && (
                      <span className="inline-flex items-center">
                        {msg.status === 'sending' && <Clock className="w-3 h-3 animate-spin" />}
                        {msg.status === 'queued' && <Clock className="w-3 h-3" />}
                        {msg.status === 'sent' && <Check className="w-3 h-3 text-emerald-400" />}
                        {msg.status === 'delivered' && (
                          <CheckCheck className="w-3.5 h-3.5 text-emerald-400" />
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </motion.div>
            );
          })
        )}
        <div ref={messagesEndRef} />
      </main>

      {/* Input */}
      <footer
        className="p-3 border-t border-white/15 backdrop-blur-md"
        style={{ backgroundColor: 'rgba(var(--bg-color), 0.9)' }}
      >
        <div className="max-w-2xl mx-auto flex items-center gap-2">
          <input
            className="flex-1 bg-black/25 border-2 border-white/20 rounded-full py-3.5 px-5 text-base placeholder:opacity-40 focus:outline-none focus:border-white/50 transition-colors"
            placeholder={`Secure message to ${peer.firstName}...`}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                handleSend();
              }
            }}
          />

          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              handleSend();
            }}
            disabled={!inputText.trim()}
            className={`w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all btn-uniform shrink-0 ${
              !inputText.trim() ? 'opacity-40 cursor-not-allowed' : ''
            }`}
            style={{
              backgroundColor: 'var(--bubble-me-bg)',
              color: 'var(--bubble-me-text)',
            }}
            aria-label="Send Message"
          >
            <Send className="w-5 h-5 ml-0.5" />
          </button>
        </div>
      </footer>

      {/* Real Authenticated Audio / Video Call Overlay */}
      <AnimatePresence>
        {activeCall && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center justify-between py-12 px-6 text-white font-publicSans"
          >
            <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />

            {/* Call Header */}
            <div className="text-center space-y-2 mt-4">
              <span className="text-xs uppercase tracking-widest font-bold px-3 py-1 rounded-full bg-white/10 border border-white/20">
                P2P {activeCall.mediaType.toUpperCase()} CALL
              </span>
              <h2 className="text-3xl font-bold font-display mt-3">
                {peer.firstName} {peer.lastName}
              </h2>
              <p className="text-sm opacity-60">
                {activeCall.state === 'ringing_outgoing'
                  ? 'Ringing secure line...'
                  : activeCall.state === 'ringing_incoming'
                  ? `Incoming ${activeCall.mediaType} call...`
                  : activeCall.state === 'connecting'
                  ? 'Establishing WebRTC media...'
                  : 'Call Connected (Direct WebRTC)'}
              </p>
            </div>

            {/* Video Streams / Avatar Centerpiece */}
            <div className="relative w-full max-w-sm aspect-square my-auto flex items-center justify-center">
              {activeCall.mediaType === 'video' ? (
                <div className="w-full h-full relative rounded-3xl overflow-hidden bg-stone-900 border-2 border-white/20 shadow-2xl flex items-center justify-center">
                  {/* Remote Video Track */}
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    playsInline
                    className="w-full h-full object-cover"
                  />

                  {/* Fallback avatar if no video received yet */}
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none opacity-40">
                    <div className="w-24 h-24 rounded-full bg-white/20 flex items-center justify-center text-4xl font-bold">
                      {peer.firstName.substring(0, 1)}
                    </div>
                  </div>

                  {/* PiP Local Video Track */}
                  <div className="absolute bottom-3 right-3 w-28 h-36 rounded-2xl overflow-hidden bg-black/60 border border-white/40 shadow-xl">
                    <video
                      ref={localVideoRef}
                      autoPlay
                      playsInline
                      muted
                      className="w-full h-full object-cover"
                    />
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center">
                  <div className="w-36 h-36 rounded-full bg-stone-800 border-4 border-white/30 flex items-center justify-center text-5xl font-bold font-display shadow-2xl relative">
                    {peer.firstName.substring(0, 1).toUpperCase()}
                    <span className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-emerald-400 border-2 border-stone-900" />
                  </div>
                  <div className="flex items-center gap-2 mt-6">
                    <Sparkles className="w-4 h-4 text-emerald-400 animate-pulse" />
                    <span className="text-xs uppercase tracking-widest font-semibold opacity-70">
                      DTLS-SRTP Encrypted Media
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Call Controls */}
            {activeCall.state === 'ringing_incoming' ? (
              <div className="flex items-center gap-8 mb-4">
                <button
                  onClick={() => void declineIncomingCall()}
                  className="w-20 h-20 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center shadow-2xl transition-all scale-105 active:scale-95"
                  title="Decline Call"
                  aria-label="Decline Call"
                >
                  <PhoneOff className="w-9 h-9" />
                </button>

                <button
                  onClick={() => void answerIncomingCall()}
                  className="w-20 h-20 rounded-full bg-emerald-600 hover:bg-emerald-500 flex items-center justify-center shadow-2xl transition-all scale-105 active:scale-95"
                  title="Answer Call"
                  aria-label="Answer Call"
                >
                  {activeCall.mediaType === 'video' ? (
                    <Video className="w-9 h-9" />
                  ) : (
                    <Phone className="w-9 h-9" />
                  )}
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-6 mb-4">
                <button
                  onClick={toggleMute}
                  className={`w-14 h-14 rounded-full flex items-center justify-center border-2 border-white/20 shadow-xl transition-all ${
                    activeCall.muted ? 'bg-red-500/80' : 'bg-white/10 hover:bg-white/20'
                  }`}
                  title="Mute / Unmute"
                >
                  {activeCall.muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                </button>

                <button
                  onClick={() => void endCall()}
                  className="w-20 h-20 rounded-full bg-red-600 hover:bg-red-500 flex items-center justify-center shadow-2xl transition-all scale-105 active:scale-95"
                  title="End Call"
                >
                  <PhoneOff className="w-9 h-9" />
                </button>

                {activeCall.mediaType === 'video' && (
                  <button
                    onClick={toggleVideo}
                    className={`w-14 h-14 rounded-full flex items-center justify-center border-2 border-white/20 shadow-xl transition-all ${
                      !activeCall.videoEnabled ? 'bg-red-500/80' : 'bg-white/10 hover:bg-white/20'
                    }`}
                    title="Toggle Video"
                  >
                    {!activeCall.videoEnabled ? (
                      <VideoOff className="w-6 h-6" />
                    ) : (
                      <Video className="w-6 h-6" />
                    )}
                  </button>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
