/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { UserIdentity, FamilyMember, EarthyTheme, ChatMessage } from './types.ts';
import { getSavedIdentity, clearIdentity } from './crypto/cryptoUtils.ts';
import {
  chitchatterFamilyBridge as connectionManager,
  ActiveCallSession,
} from './networking/chitchatterFamilyBridge.ts';
import { storageManager } from './storage/indexedDB.ts';
import { NotificationContainer, notificationManager } from './components/NotificationContainer.tsx';
import { SplashScreen } from './components/SplashScreen.tsx';
import { SettingsScreen } from './components/SettingsScreen.tsx';
import { GroupChatScreen } from './components/GroupChatScreen.tsx';
import { PrivateChatScreen } from './components/PrivateChatScreen.tsx';
import { ProfileSetupModal } from './components/ProfileSetupModal.tsx';
import { AddMemberModal } from './components/AddMemberModal.tsx';
import { ThemeModal } from './components/ThemeModal.tsx';

type Screen = 'splash' | 'settings' | 'group-chat' | 'private-chat';

export default function App() {
  const [currentScreen, setCurrentScreen] = useState<Screen>('splash');
  const [myIdentity, setMyIdentity] = useState<UserIdentity | null>(null);
  const [familyMembers, setFamilyMembers] = useState<FamilyMember[]>([]);
  const [selectedPeer, setSelectedPeer] = useState<FamilyMember | null>(null);
  const [pendingCallRequest, setPendingCallRequest] = useState<{
    peerId: string;
    type: 'voice' | 'video';
    nonce: number;
  } | null>(null);
  const [showAddMember, setShowAddMember] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [theme, setTheme] = useState<EarthyTheme>(() => {
    return (localStorage.getItem('fm_theme') as EarthyTheme) || 'theme-earthy-3';
  });

  // Apply theme to document
  useEffect(() => {
    document.documentElement.className = theme;
    localStorage.setItem('fm_theme', theme);
  }, [theme]);

  // Load identity and initialize app subsystems
  useEffect(() => {
    const initApp = async () => {
      await storageManager.init();
      const saved = getSavedIdentity();

      if (saved && saved.firstName) {
        setMyIdentity(saved);
        await connectionManager.init(saved);
        const contacts = await storageManager.getContacts();
        setFamilyMembers(contacts);
      } else {
        setShowProfileModal(true);
      }
    };

    initApp();
  }, []);

  // Set up connection manager event listeners
  useEffect(() => {
    if (!myIdentity) return;

    const onMemberAdded = (e: Event) => {
      const custom = e as CustomEvent<FamilyMember>;
      setFamilyMembers(connectionManager.getMembers());
      notificationManager.show(`New family member added: ${custom.detail.firstName}!`, 'success');
    };

    const onMemberRemoved = () => {
      setFamilyMembers(connectionManager.getMembers());
    };

    const onMemberUpdated = () => {
      setFamilyMembers(connectionManager.getMembers());
    };

    const onJoinedFamily = (e: Event) => {
      const custom = e as CustomEvent<FamilyMember>;
      setFamilyMembers(connectionManager.getMembers());
      const activeId = connectionManager.getSelfMemberId();
      if (activeId) {
        import('./crypto/cryptoUtils.ts').then(({ getSavedIdentity }) => {
          const latest = getSavedIdentity();
          if (latest) setMyIdentity(latest);
        });
      }
      notificationManager.show(
        `Connected to family member: ${custom.detail.firstName}!`,
        'success'
      );
    };

    const onOnboardingFailed = (e: Event) => {
      const custom = e as CustomEvent<{ reason?: string }>;
      notificationManager.show(
        custom.detail?.reason || 'Family onboarding could not complete',
        'error'
      );
    };

    const onDirectMsg = (e: Event) => {
      const custom = e as CustomEvent<ChatMessage>;
      const msg = custom.detail;
      if (!msg.content) return; // Ignore internal delivery-ACK status frames
      const selectedPeerId = selectedPeer?.memberId || selectedPeer?.identityHash;
      // Show interactive notification if user is not currently in this private chat
      if (
        currentScreen !== 'private-chat' ||
        !connectionManager.isSameMember(selectedPeerId, msg.senderId)
      ) {
        const sender =
          familyMembers.find((m) =>
            connectionManager.isSameMember(m.memberId || m.identityHash, msg.senderId)
          ) ||
          connectionManager
            .getMembers()
            .find((m) =>
              connectionManager.isSameMember(m.memberId || m.identityHash, msg.senderId)
            );

        notificationManager.show(
          `💬 ${msg.senderName || sender?.firstName || 'Family'}: "${msg.content.slice(0, 32)}${
            msg.content.length > 32 ? '...' : ''
          }"`,
          'info',
          sender ? () => handleOpenPrivateChat(sender) : undefined,
          sender ? 'Open Chat' : undefined
        );
      }
    };

    const onGroupMsg = (e: Event) => {
      const custom = e as CustomEvent<ChatMessage>;
      const msg = custom.detail;
      if (currentScreen !== 'group-chat') {
        notificationManager.show(
          `👥 Family Group: ${msg.senderName}: "${msg.content.slice(0, 25)}${
            msg.content.length > 25 ? '...' : ''
          }"`,
          'info',
          () => setCurrentScreen('group-chat'),
          'Open Group'
        );
      }
    };

    const unsubIncomingCall = connectionManager.onIncomingCall((call: ActiveCallSession) => {
      const caller =
        familyMembers.find((m) =>
          connectionManager.isSameMember(m.memberId || m.identityHash, call.peerId)
        ) ||
        connectionManager
          .getMembers()
          .find((m) =>
            connectionManager.isSameMember(m.memberId || m.identityHash, call.peerId)
          );
      if (caller) {
        const selectedPeerId = selectedPeer?.memberId || selectedPeer?.identityHash;
        if (
          currentScreen !== 'private-chat' ||
          !connectionManager.isSameMember(selectedPeerId, call.peerId)
        ) {
          notificationManager.show(
            `Incoming ${call.mediaType} call from ${caller.firstName}`,
            'info',
            () => {
              setSelectedPeer(caller);
              setCurrentScreen('private-chat');
            },
            'Open Call'
          );
          // Open PrivateChatScreen so Answer / Decline overlay is immediately reachable
          setSelectedPeer(caller);
          setCurrentScreen('private-chat');
        }
      }
    });

    connectionManager.addEventListener('member_added', onMemberAdded);
    connectionManager.addEventListener('member_removed', onMemberRemoved);
    connectionManager.addEventListener('member_updated', onMemberUpdated);
    connectionManager.addEventListener('joined_family_success', onJoinedFamily);
    connectionManager.addEventListener('onboarding_failed', onOnboardingFailed);
    connectionManager.addEventListener('direct_message_received', onDirectMsg);
    connectionManager.addEventListener('group_message_received', onGroupMsg);

    return () => {
      unsubIncomingCall();
      connectionManager.removeEventListener('member_added', onMemberAdded);
      connectionManager.removeEventListener('member_removed', onMemberRemoved);
      connectionManager.removeEventListener('member_updated', onMemberUpdated);
      connectionManager.removeEventListener('joined_family_success', onJoinedFamily);
      connectionManager.removeEventListener('onboarding_failed', onOnboardingFailed);
      connectionManager.removeEventListener('direct_message_received', onDirectMsg);
      connectionManager.removeEventListener('group_message_received', onGroupMsg);
    };
  }, [myIdentity, currentScreen, selectedPeer, familyMembers]);

  const handleProfileCreated = async (newIdentity: UserIdentity) => {
    setMyIdentity(newIdentity);
    setShowProfileModal(false);
    await connectionManager.init(newIdentity);
    const contacts = await storageManager.getContacts();
    setFamilyMembers(contacts);
    notificationManager.show(`Welcome, ${newIdentity.firstName}!`, 'success');
  };

  const handleSwitchIdentity = () => {
    if (confirm('Create a new profile or switch identity? (Useful for testing multiple peers)')) {
      clearIdentity();
      setShowProfileModal(true);
    }
  };

  const handleOpenPrivateChat = (peer: FamilyMember) => {
    setPendingCallRequest(null);
    setSelectedPeer(peer);
    setCurrentScreen('private-chat');
  };

  const handleStartCallFromList = (peer: FamilyMember, type: 'voice' | 'video') => {
    const peerId = peer.memberId || peer.identityHash;
    setSelectedPeer(peer);
    setPendingCallRequest({ peerId, type, nonce: Date.now() });
    setCurrentScreen('private-chat');
  };

  return (
    <div className="w-full h-screen overflow-hidden relative">
      <NotificationContainer />

      <AnimatePresence mode="wait">
        {currentScreen === 'splash' && (
          <SplashScreen key="splash" onFinish={() => setCurrentScreen('settings')} />
        )}

        {currentScreen === 'settings' && myIdentity && (
          <motion.div
            key="settings"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.25 }}
            className="w-full h-full overflow-y-auto"
          >
            <SettingsScreen
              myIdentity={myIdentity}
              familyMembers={familyMembers}
              onOpenGroupChat={() => setCurrentScreen('group-chat')}
              onOpenPrivateChat={handleOpenPrivateChat}
              onOpenAddMember={() => setShowAddMember(true)}
              onOpenThemeModal={() => setShowThemeModal(true)}
              onSwitchIdentity={handleSwitchIdentity}
              onStartCall={handleStartCallFromList}
            />
          </motion.div>
        )}

        {currentScreen === 'group-chat' && myIdentity && (
          <motion.div
            key="group-chat"
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.25 }}
            className="w-full h-full"
          >
            <GroupChatScreen
              myIdentity={myIdentity}
              familyMembers={familyMembers}
              onBack={() => setCurrentScreen('settings')}
            />
          </motion.div>
        )}

        {currentScreen === 'private-chat' && myIdentity && selectedPeer && (
          <motion.div
            key={`private-chat-${selectedPeer.memberId || selectedPeer.identityHash}`}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.25 }}
            className="w-full h-full"
          >
            <PrivateChatScreen
              myIdentity={myIdentity}
              peer={selectedPeer}
              initialCallRequest={
                pendingCallRequest &&
                connectionManager.isSameMember(
                  pendingCallRequest.peerId,
                  selectedPeer.memberId || selectedPeer.identityHash
                )
                  ? pendingCallRequest
                  : undefined
              }
              onConsumeCallRequest={() => setPendingCallRequest(null)}
              onBack={() => {
                setPendingCallRequest(null);
                setSelectedPeer(null);
                setCurrentScreen('settings');
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Modals */}
      <AnimatePresence>
        {showProfileModal && (
          <ProfileSetupModal
            onComplete={handleProfileCreated}
            isSwitching={!!myIdentity}
          />
        )}

        {showAddMember && myIdentity && (
          <AddMemberModal
            myIdentity={myIdentity}
            onClose={() => setShowAddMember(false)}
          />
        )}

        {showThemeModal && (
          <ThemeModal
            currentTheme={theme}
            onSelectTheme={setTheme}
            onClose={() => setShowThemeModal(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
