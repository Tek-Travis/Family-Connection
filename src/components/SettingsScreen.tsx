/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  MessageSquare,
  Phone,
  Video,
  UserPlus,
  MoreVertical,
  VolumeX,
  Volume2,
  UserX,
  Ban,
  Palette,
  ShieldCheck,
  Copy,
  Check,
  QrCode,
  Users,
  Radio,
  ArrowRight,
  Sparkles,
} from 'lucide-react';
import { UserIdentity, FamilyMember } from '../types.ts';
import { FamilyDinnerIllustration } from './Illustrations.tsx';
import { notificationManager } from './NotificationContainer.tsx';
import { chitchatterFamilyBridge as connectionManager } from '../networking/chitchatterFamilyBridge.ts';
import { isDevMode, setDevMode } from '../crypto/cryptoUtils.ts';

interface SettingsScreenProps {
  myIdentity: UserIdentity;
  familyMembers: FamilyMember[];
  onOpenGroupChat: () => void;
  onOpenPrivateChat: (peer: FamilyMember) => void;
  onOpenAddMember: () => void;
  onOpenThemeModal: () => void;
  onSwitchIdentity: () => void;
  onStartCall: (peer: FamilyMember, type: 'voice' | 'video') => void;
}

export const SettingsScreen: React.FC<SettingsScreenProps> = ({
  myIdentity,
  familyMembers,
  onOpenGroupChat,
  onOpenPrivateChat,
  onOpenAddMember,
  onOpenThemeModal,
  onSwitchIdentity,
  onStartCall,
}) => {
  // Retain testing controls in source, but hide them from the UI.
  const showTestingControls = false;
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [showNetworkInfo, setShowNetworkInfo] = useState(false);
  const [, setRefreshTick] = useState(0);

  // Subscribe to real-time Level 1, 2, 3 connection and alert state updates
  React.useEffect(() => {
    const handleUpdate = () => {
      setRefreshTick((t) => t + 1);
    };

    connectionManager.addEventListener('presence_change', handleUpdate);
    connectionManager.addEventListener('unread_change', handleUpdate);
    connectionManager.addEventListener('app_power_state_change', handleUpdate);
    connectionManager.addEventListener('group_state_change', handleUpdate);
    connectionManager.addEventListener('connection_state_change', handleUpdate);

    return () => {
      connectionManager.removeEventListener('presence_change', handleUpdate);
      connectionManager.removeEventListener('unread_change', handleUpdate);
      connectionManager.removeEventListener('app_power_state_change', handleUpdate);
      connectionManager.removeEventListener('group_state_change', handleUpdate);
      connectionManager.removeEventListener('connection_state_change', handleUpdate);
    };
  }, []);

  const totalUnread = connectionManager.getTotalUnreadCount();
  const appPowerState = connectionManager.getAppPowerState();
  const groupOnlineCount = connectionManager.getGroupOnlinePeerCount();

  const handleCopyInviteCode = async () => {
    try {
      await navigator.clipboard.writeText(myIdentity.inviteCode);
      setCopiedCode(true);
      notificationManager.show('Invite code copied to clipboard!', 'success');
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      notificationManager.show(`Invite code: ${myIdentity.inviteCode}`, 'info');
    }
  };

  const handleToggleDevMode = () => {
    const current = isDevMode();
    setDevMode(!current);
    notificationManager.show(
      !current
        ? 'Dev Mode enabled: Tab-isolated identity for multi-tab testing!'
        : 'Normal Mode enabled: Shared identity',
      'info'
    );
    setTimeout(() => {
      window.location.reload();
    }, 400);
  };

  // Filter out self using canonical memberId / identityHash matching
  const activeMembers = familyMembers.filter(
    (m) => !connectionManager.isSelfId(m.memberId || m.identityHash)
  );

  return (
    <div
      className="min-h-screen pb-16 font-publicSans transition-colors"
      style={{ backgroundColor: 'var(--bg-color)', color: 'rgb(var(--text-color))' }}
    >
      {/* Top Header */}
      <header
        className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center p-4 border-b border-white/15 sticky top-0 z-20 backdrop-blur-md"
        style={{ backgroundColor: 'rgba(var(--bg-color), 0.85)' }}
      >
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.7)]" />
          <span className="text-xs font-bold tracking-wider uppercase opacity-80">
            P2P Mesh
          </span>
        </div>

        <div className="flex items-center gap-2">
          <h1 className="font-bold text-2xl font-display tracking-tight text-center">
            Family Connection
          </h1>
          {totalUnread > 0 && (
            <span
              className="bg-red-500 text-white text-[11px] font-black rounded-full min-w-5 h-5 px-1.5 flex items-center justify-center border-2 border-black/40 shadow-lg animate-pulse"
              title={`${totalUnread} unread messages`}
            >
              {totalUnread}
            </span>
          )}
        </div>

        {/* Dev Mode Identity Switcher Button */}
        {showTestingControls && (
        <button
          onClick={onSwitchIdentity}
          className="text-xs font-bold px-3 py-1.5 rounded-full border border-white/20 hover:bg-white/10 transition-colors flex items-center gap-1.5"
          title="Switch profile or test multi-tab peer"
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-300" />
          <span>Switch</span>
        </button>
        )}
      </header>

      <div className="max-w-md mx-auto px-4 pt-4 space-y-6">
        {/* User Profile Card (Level 1 Background Idle/Active State) */}
        <div className="bg-black/20 rounded-3xl p-5 border-2 border-white/15 shadow-xl flex items-center gap-4">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center text-3xl font-bold font-display shadow-inner shrink-0 border-2 border-white/30"
            style={{
              backgroundColor: 'var(--bubble-me-bg)',
              color: 'var(--bubble-me-text)',
            }}
          >
            {myIdentity.firstName.substring(0, 1).toUpperCase()}
          </div>

          <div className="flex-1 min-w-0">
            <h2 className="text-xl font-bold truncate">
              {myIdentity.firstName} {myIdentity.lastName}
            </h2>
            <p className="text-[10px] font-bold uppercase tracking-wider opacity-60 mt-0.5">
              Your Invite Code
            </p>
            <div className="flex items-center gap-2 mt-1">
              <span className="font-mono text-xs font-bold bg-black/30 px-2.5 py-1 rounded-lg border border-white/10 tracking-wider">
                {myIdentity.inviteCode}
              </span>
              <button
                onClick={handleCopyInviteCode}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 transition-colors shrink-0"
                title="Copy Invite Code"
              >
                {copiedCode ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="flex flex-col items-center">
            <span
              className={`w-2.5 h-2.5 rounded-full ${
                appPowerState === 'ONLINE'
                  ? 'bg-emerald-400 animate-pulse'
                  : appPowerState === 'IDLE'
                  ? 'bg-amber-400 animate-pulse'
                  : 'bg-sky-400'
              }`}
            />
            <span
              className={`text-[8px] font-bold mt-1 uppercase tracking-tighter ${
                appPowerState === 'ONLINE'
                  ? 'text-emerald-400'
                  : appPowerState === 'IDLE'
                  ? 'text-amber-300'
                  : 'text-sky-300'
              }`}
            >
              {appPowerState === 'ONLINE'
                ? 'Active'
                : appPowerState === 'IDLE'
                ? 'Idle'
                : 'Background'}
            </span>
          </div>
        </div>

        {/* Enter Family Chat Hero Card (Level 2 Group Meeting State) */}
        <motion.div
          whileHover={{ scale: 1.01 }}
          whileTap={{ scale: 0.98 }}
          onClick={onOpenGroupChat}
          className="cursor-pointer rounded-3xl overflow-hidden border-2 border-white/20 shadow-2xl bg-black/25 transition-transform"
        >
          <FamilyDinnerIllustration className="w-full h-44 object-cover" />
        </motion.div>

        {/* Family Members Section (Level 1 Peer Presence & Level 3 Private Channel State) */}
        <section className="space-y-3">
          <div className="flex items-center justify-between px-1">
            <h2 className="text-xs font-bold uppercase tracking-widest opacity-80">
              Family Members ({activeMembers.length})
            </h2>
            <span className="text-[11px] opacity-60">End-to-End Encrypted</span>
          </div>

          <div className="bg-black/20 rounded-3xl shadow-lg border-2 border-white/15 overflow-visible">
            {activeMembers.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <Users className="w-12 h-12 mx-auto opacity-30" />
                <p className="text-sm opacity-60">No family members added yet.</p>
                <button
                  onClick={onOpenAddMember}
                  className="btn-uniform px-5 py-2.5 rounded-full text-sm font-bold gap-2"
                >
                  <UserPlus className="w-4 h-4" />
                  Add First Member
                </button>
              </div>
            ) : (
              <ul className="divide-y divide-white/15">
                {activeMembers.map((member) => {
                  const contactId = member.memberId || member.identityHash;
                  const presence = connectionManager.getPresence(contactId);
                  const isOnline = presence === 'online';
                  const isAway = presence === 'away';
                  const privateState = connectionManager.getPrivateChannelState(contactId);
                  const unread = connectionManager.getUnreadCount(contactId);
                  const isMuted = connectionManager.isMuted(contactId);

                  return (
                    <li
                      key={contactId}
                      className="flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
                    >
                      {/* Member Info */}
                      <div
                        onClick={() => onOpenPrivateChat(member)}
                        className="flex items-center gap-3.5 flex-1 min-w-0 cursor-pointer"
                      >
                        <div className="relative shrink-0">
                          <div className="w-12 h-12 rounded-full flex items-center justify-center font-bold text-lg font-display bg-white/15 border-2 border-white/30 shadow-md">
                            {member.firstName.substring(0, 1).toUpperCase()}
                          </div>
                          <span
                            className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full border-2 border-black/40 ${
                              isOnline
                                ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
                                : isAway
                                ? 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]'
                                : 'bg-stone-500'
                            }`}
                          />
                          {unread > 0 && (
                            <span className="absolute -top-1 -left-1 bg-red-500 text-white text-[10px] font-black rounded-full min-w-5 h-5 px-1 flex items-center justify-center border-2 border-black/40 shadow-lg animate-bounce">
                              {unread}
                            </span>
                          )}
                        </div>

                        <div className="min-w-0">
                          <p className="font-bold text-base truncate">
                            {member.firstName} {member.lastName}
                          </p>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs font-semibold ${
                                isOnline
                                  ? 'text-emerald-400'
                                  : isAway
                                  ? 'text-amber-300'
                                  : 'opacity-60'
                              }`}
                            >
                              {isOnline ? 'Online' : isAway ? 'Away (Idle)' : 'Offline'}
                            </span>

                            {privateState === 'CONNECTED' && (
                              <span className="text-[10px] bg-emerald-500/20 text-emerald-300 px-1.5 py-0.5 rounded-full font-bold">
                                1:1 Direct
                              </span>
                            )}
                            {privateState === 'CONNECTING' && (
                              <span className="text-[10px] bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded-full font-bold">
                                Connecting
                              </span>
                            )}

                            {isMuted && (
                              <span className="text-[10px] opacity-60 flex items-center gap-0.5">
                                <VolumeX className="w-3 h-3" /> Muted
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Action Buttons */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        {/* 1:1 Chat with Unread Badge */}
                        <div className="relative">
                          <button
                            onClick={() => onOpenPrivateChat(member)}
                            className="w-10 h-10 rounded-full btn-uniform text-inherit"
                            title="Private Chat"
                          >
                            <MessageSquare className="w-4 h-4" />
                          </button>
                          {unread > 0 && (
                            <span className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] font-black rounded-full min-w-4 h-4 px-1 flex items-center justify-center border border-black/40 shadow pointer-events-none">
                              {unread}
                            </span>
                          )}
                        </div>

                        {/* Voice Call */}
                        <button
                          onClick={() => onStartCall(member, 'voice')}
                          className="w-10 h-10 rounded-full btn-uniform text-inherit"
                          title="Voice Call"
                        >
                          <Phone className="w-4 h-4" />
                        </button>

                        {/* Video Call */}
                        <button
                          onClick={() => onStartCall(member, 'video')}
                          className="w-10 h-10 rounded-full btn-uniform text-inherit"
                          title="Video Call"
                        >
                          <Video className="w-4 h-4" />
                        </button>

                        {/* Dropdown Options */}
                        <div className="relative">
                          <button
                            onClick={() =>
                              setMenuOpenId(menuOpenId === member.identityHash ? null : member.identityHash)
                            }
                            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-white/10 opacity-70 hover:opacity-100 transition-opacity"
                          >
                            <MoreVertical className="w-4 h-4" />
                          </button>

                          {menuOpenId === member.identityHash && (
                            <div className="absolute right-0 top-11 bg-stone-900 text-stone-100 rounded-2xl shadow-2xl border border-stone-700 w-44 overflow-hidden z-30 py-1">
                              <button
                                onClick={() => {
                                  connectionManager.muteMember(member.identityHash);
                                  setMenuOpenId(null);
                                  notificationManager.show(
                                    isMuted ? 'Unmuted member' : 'Muted member',
                                    'info'
                                  );
                                }}
                                className="w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 hover:bg-stone-800"
                              >
                                {isMuted ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                                {isMuted ? 'Unmute' : 'Mute'}
                              </button>

                              <button
                                onClick={() => {
                                  if (confirm(`Remove ${member.firstName} from family registry?`)) {
                                    connectionManager.removeMember(member.identityHash);
                                    setMenuOpenId(null);
                                    notificationManager.show('Member removed', 'info');
                                  }
                                }}
                                className="w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 text-red-400 hover:bg-stone-800"
                              >
                                <UserX className="w-4 h-4" />
                                Remove
                              </button>

                              <button
                                onClick={() => {
                                  if (confirm(`Block ${member.firstName}?`)) {
                                    connectionManager.blockMember(member.identityHash);
                                    setMenuOpenId(null);
                                    notificationManager.show('Member blocked', 'error');
                                  }
                                }}
                                className="w-full px-4 py-2.5 text-left text-sm flex items-center gap-2 text-red-400 font-semibold hover:bg-stone-800"
                              >
                                <Ban className="w-4 h-4" />
                                Block
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Add Family Member Button */}
          <button
            onClick={onOpenAddMember}
            className="w-full py-4 rounded-full text-base font-bold shadow-xl transition-all btn-uniform flex items-center justify-center gap-2.5"
            style={{
              backgroundColor: 'var(--bubble-me-bg)',
              color: 'var(--bubble-me-text)',
            }}
          >
            <UserPlus className="w-5 h-5" />
            ADD FAMILY MEMBER
          </button>
        </section>

        {/* Settings / Preferences Menu */}
        <section className="space-y-3">
          <h2 className="text-xs font-bold uppercase tracking-widest opacity-80 px-1">
            App Settings
          </h2>

          <div className="bg-black/20 rounded-3xl shadow-lg border-2 border-white/15 overflow-hidden">
            <ul className="divide-y divide-white/15">
              <li
                onClick={onOpenThemeModal}
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Palette className="w-5 h-5 opacity-80" />
                  <span className="font-medium text-base">Appearance Themes</span>
                </div>
                <span className="text-xs opacity-60">5 Earthy Styles</span>
              </li>

              <li
                onClick={() => setShowNetworkInfo(!showNetworkInfo)}
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <ShieldCheck className="w-5 h-5 opacity-80" />
                  <span className="font-medium text-base">P2P Network & Privacy</span>
                </div>
                <span className="text-xs opacity-60">
                  {showNetworkInfo ? 'Hide' : 'Inspect'}
                </span>
              </li>

              {showTestingControls && (
              <li
                onClick={handleToggleDevMode}
                className="flex items-center justify-between p-4 cursor-pointer hover:bg-white/5 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Radio className="w-5 h-5 opacity-80" />
                  <span className="font-medium text-base">Multi-Tab Simulation Mode</span>
                </div>
                <span
                  className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                    isDevMode()
                      ? 'bg-emerald-500/30 text-emerald-300 border border-emerald-500/40'
                      : 'bg-white/10 opacity-60'
                  }`}
                >
                  {isDevMode() ? 'ON' : 'OFF'}
                </span>
              </li>
              )}
            </ul>
          </div>
        </section>

        {/* Network & Privacy Diagnostic Panel */}
        <AnimatePresence>
          {showNetworkInfo && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="bg-black/30 rounded-3xl p-5 border border-white/15 space-y-3 text-xs"
            >
              <h3 className="font-bold text-sm">Decentralized P2P Diagnostics</h3>
              <p className="opacity-80 leading-relaxed">
                • <strong>Discovery & Signaling:</strong> Chitchatter Trystero WebRTC signaling via BitTorrent WSS trackers (signed Ed25519 PeerSessionBindings).
              </p>
              <p className="opacity-80 leading-relaxed">
                • <strong>Group Mesh:</strong> Chitchatter ChatRoom with authenticated Ed25519 + NaCl secretbox envelopes.
              </p>
              <p className="opacity-80 leading-relaxed">
                • <strong>Private Channels:</strong> Direct WebRTC <code className="bg-black/30 px-1 py-0.5 rounded">RTCPeerConnection</code> with TweetNaCl Curve25519 E2EE, signed delivery ACKs, and target-scoped 1:1 audio/video streaming.
              </p>
              <p className="opacity-80 leading-relaxed">
                • <strong>Migration Backups:</strong> Portable <code className="bg-black/30 px-1 py-0.5 rounded">.migration.json</code> archives use PBKDF2-SHA256 (310,000 iterations) + AES-256-GCM encryption.
              </p>
              <p className="opacity-70 leading-relaxed text-[11px]">
                Local application storage (IndexedDB / localStorage) is not encrypted by the app; browser origin isolation and OS/device configuration controls apply.
              </p>
              <div className="pt-2 border-t border-white/10 flex items-center justify-between text-[11px] opacity-70">
                <span>Local Database: IndexedDB (v3)</span>
                <span className="text-emerald-400 font-bold">Offline Contacts & Outbox Ready</span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
};
