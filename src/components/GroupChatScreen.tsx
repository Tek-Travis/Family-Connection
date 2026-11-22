/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, Send, Users, Shield, Check, CheckCheck, Clock } from 'lucide-react';
import { UserIdentity, ChatMessage, FamilyMember } from '../types.ts';
import { storageManager } from '../storage/indexedDB.ts';
import { chitchatterFamilyBridge as connectionManager } from '../networking/chitchatterFamilyBridge.ts';

interface GroupChatScreenProps {
  myIdentity: UserIdentity;
  familyMembers: FamilyMember[];
  onBack: () => void;
}

export const GroupChatScreen: React.FC<GroupChatScreenProps> = ({
  myIdentity,
  familyMembers,
  onBack,
}) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputText, setInputText] = useState('');
  const [peerCount, setPeerCount] = useState(0);
  const [isConnected, setIsConnected] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load message history and listen for real-time messages
  useEffect(() => {
    storageManager.getMessages('global').then((history) => {
      setMessages(history);
      scrollToBottom();
    });

    const updatePresenceAndPeers = () => {
      const activeMembers = familyMembers.filter(
        (m) =>
          !connectionManager.isSelfId(m.memberId || m.identityHash) &&
          connectionManager.getPresence(m.memberId || m.identityHash) === 'online'
      );
      setPeerCount(activeMembers.length);
      setIsConnected(
        connectionManager.getGroupMeetingState() === 'CONNECTED' || activeMembers.length > 0
      );
    };

    updatePresenceAndPeers();

    const handleGroupMsg = (e: Event) => {
      const custom = e as CustomEvent<ChatMessage>;
      if (custom.detail && custom.detail.chatId === 'global') {
        setMessages((prev) => {
          if (prev.some((m) => m.id === custom.detail.id)) return prev;
          return [...prev, custom.detail];
        });
        scrollToBottom();
      }
    };

    const handlePresence = () => {
      updatePresenceAndPeers();
    };

    connectionManager.addEventListener('group_message_received', handleGroupMsg);
    connectionManager.addEventListener('group_state_change', handlePresence);
    connectionManager.addEventListener('presence_change', handlePresence);
    connectionManager.addEventListener('member_added', handlePresence);

    const interval = setInterval(updatePresenceAndPeers, 3000);

    return () => {
      connectionManager.removeEventListener('group_message_received', handleGroupMsg);
      connectionManager.removeEventListener('group_state_change', handlePresence);
      connectionManager.removeEventListener('presence_change', handlePresence);
      connectionManager.removeEventListener('member_added', handlePresence);
      clearInterval(interval);
    };
  }, [familyMembers, myIdentity.identityHash, myIdentity.memberId]);

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
      const sentMsg = await connectionManager.sendGroupMessage('global', text);
      setMessages((prev) => {
        if (prev.some((m) => m.id === sentMsg.id)) return prev;
        return [...prev, sentMsg];
      });
      scrollToBottom();
    } catch (err) {
      console.error('Failed to send group message:', err);
    } finally {
      setTimeout(() => {
        isSendingRef.current = false;
      }, 250);
    }
  };

  const getMemberName = (senderId: string): string => {
    if (connectionManager.isSelfId(senderId)) return 'You';
    const member = familyMembers.find((m) =>
      connectionManager.isSameMember(m.memberId || m.identityHash, senderId)
    );
    return member ? `${member.firstName} ${member.lastName}` : 'Family Member';
  };

  const getMemberInitial = (senderId: string): string => {
    if (connectionManager.isSelfId(senderId)) {
      return myIdentity.firstName.substring(0, 1).toUpperCase();
    }
    const member = familyMembers.find((m) =>
      connectionManager.isSameMember(m.memberId || m.identityHash, senderId)
    );
    return member ? member.firstName.substring(0, 1).toUpperCase() : '?';
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
          <h1 className="font-bold text-xl font-display tracking-tight">Family Group</h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span
              className={`w-2 h-2 rounded-full ${
                peerCount > 0 ? 'bg-emerald-400' : isConnected ? 'bg-amber-400' : 'bg-red-500'
              }`}
            />
            <span className="text-[10px] font-bold uppercase tracking-wider opacity-75">
              {peerCount > 0
                ? `${peerCount} Peer${peerCount === 1 ? '' : 's'} Online`
                : isConnected
                ? 'Mesh Waiting for Peers'
                : 'Offline'}
            </span>
          </div>
        </div>

        <div className="w-10 flex items-center justify-end">
          <span title="GossipSub Encrypted Group Mesh">
            <Shield className="w-5 h-5 opacity-60" />
          </span>
        </div>
      </header>

      {/* Message Feed */}
      <main className="flex-1 overflow-y-auto p-4 space-y-4 max-w-2xl w-full mx-auto">
        <div className="text-center py-2">
          <span className="text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded-full bg-black/20 border border-white/10 opacity-70">
            Decentralized GossipSub Mesh • fm:group:global
          </span>
        </div>

        {messages.length === 0 ? (
          <div className="h-64 flex flex-col items-center justify-center text-center opacity-60 space-y-2">
            <Users className="w-12 h-12 stroke-[1.5]" />
            <p className="text-base font-medium">Welcome to your family chat</p>
            <p className="text-xs max-w-xs">
              Messages broadcast peer-to-peer to all connected family members on the mesh.
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
                {/* Avatar Initial */}
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-sm shrink-0 border border-white/20 shadow-sm"
                  style={{
                    backgroundColor: isMe ? 'rgba(var(--text-color), 0.2)' : 'rgba(0,0,0,0.3)',
                    color: 'rgb(var(--text-color))',
                  }}
                >
                  {getMemberInitial(msg.senderId)}
                </div>

                {/* Message Bubble */}
                <div className={`space-y-1 ${isMe ? 'items-end' : 'items-start'}`}>
                  {!isMe && (
                    <span className="text-[11px] font-bold opacity-75 ml-2 block">
                      {getMemberName(msg.senderId)}
                    </span>
                  )}

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

      {/* Input Bar */}
      <footer
        className="p-3 border-t border-white/15 backdrop-blur-md"
        style={{ backgroundColor: 'rgba(var(--bg-color), 0.9)' }}
      >
        <div className="max-w-2xl mx-auto flex items-center gap-2">
          <input
            className="flex-1 bg-black/25 border-2 border-white/20 rounded-full py-3.5 px-5 text-base placeholder:opacity-40 focus:outline-none focus:border-white/50 transition-colors"
            placeholder="Broadcast to family..."
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
    </div>
  );
};
