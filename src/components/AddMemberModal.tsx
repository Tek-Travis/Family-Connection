/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import { X, Copy, Check, QrCode, Search, UserCheck } from 'lucide-react';
import { UserIdentity } from '../types.ts';
import { QRCodeSVG } from './Illustrations.tsx';
import { notificationManager } from './NotificationContainer.tsx';
import { chitchatterFamilyBridge as connectionManager } from '../networking/chitchatterFamilyBridge.ts';
import { validateSharedInviteCode } from '../crypto/cryptoUtils.ts';
import { formatInviteInputWithStage2Rules } from '../networking/familyProtocol.ts';

interface AddMemberModalProps {
  myIdentity: UserIdentity;
  onClose: () => void;
}

export const AddMemberModal: React.FC<AddMemberModalProps> = ({ myIdentity, onClose }) => {
  const [inviteInput, setInviteInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [isSearching, setIsSearching] = useState(false);

  const handleCopyCode = async () => {
    try {
      await navigator.clipboard.writeText(myIdentity.inviteCode);
      setCopied(true);
      notificationManager.show('Invite code copied to clipboard!', 'success');
      setTimeout(() => setCopied(false), 2500);
    } catch {
      notificationManager.show(`Invite code: ${myIdentity.inviteCode}`, 'info');
    }
  };

  const handleFormatInput = (val: string) => {
    setInviteInput(formatInviteInputWithStage2Rules(val));
  };

  const handleAdd = async () => {
    const cleanCode = inviteInput.trim();
    if (!cleanCode) return;

    if (!validateSharedInviteCode(cleanCode)) {
      notificationManager.show(
        'Invalid invite code format (expected XXXX-XXXX-XXXX-XXXX with 3 alphanumeric + 1 symbol per block)',
        'error'
      );
      return;
    }

    const activeFam = connectionManager.getActiveFamily();
    if (cleanCode === myIdentity.inviteCode || (activeFam && cleanCode === activeFam.inviteCode)) {
      notificationManager.show('Cannot add your own invite code', 'error');
      return;
    }

    setIsSearching(true);
    notificationManager.show('Connecting to family invite rendezvous...', 'info');
    try {
      await connectionManager.joinFamilyByInviteCode(cleanCode);
      setIsSearching(false);
      onClose();
    } catch (err) {
      setIsSearching(false);
      notificationManager.show(
        err instanceof Error ? err.message : 'Family onboarding failed',
        'error'
      );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        className="relative w-full max-w-sm rounded-[2.5rem] p-6 shadow-2xl border-4 border-white/20 text-center"
        style={{ backgroundColor: 'var(--bg-color)', color: 'rgb(var(--text-color))' }}
      >
        <button
          onClick={onClose}
          className="absolute top-5 right-5 p-2 rounded-full hover:bg-white/10 opacity-70 hover:opacity-100 transition-opacity"
          aria-label="Close"
        >
          <X className="w-6 h-6" />
        </button>

        <h2 className="text-2xl font-bold font-display tracking-tight mb-1">
          Connect with Family
        </h2>
        <p className="text-sm opacity-75 mb-6">
          Enter their invite code or share yours to establish an encrypted link.
        </p>

        {/* Input Form */}
        <div className="space-y-3 mb-6">
          <div className="relative">
            <input
              className="w-full bg-black/25 border-2 border-white/20 rounded-2xl py-3.5 px-4 text-center font-mono text-xl tracking-widest placeholder:opacity-30 focus:outline-none focus:border-white/60 transition-colors"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              value={inviteInput}
              onChange={(e) => handleFormatInput(e.target.value)}
              maxLength={24}
            />
          </div>

          <button
            onClick={() => void handleAdd()}
            disabled={inviteInput.trim().length < 4 || isSearching}
            className="w-full py-4 rounded-full text-base font-bold shadow-xl transition-all btn-uniform flex items-center justify-center gap-2"
            style={{
              backgroundColor: 'var(--bubble-me-bg)',
              color: 'var(--bubble-me-text)',
            }}
          >
            {isSearching ? (
              <Search className="w-5 h-5 animate-pulse" />
            ) : (
              <UserCheck className="w-5 h-5" />
            )}
            Add Family Member
          </button>

          <button
            type="button"
            onClick={async () => {
              const { createNewIdentity } = await import('../crypto/cryptoUtils.ts');
              const { storageManager } = await import('../storage/indexedDB.ts');
              const demoIdentity = await createNewIdentity('Bob', 'Miller');
              await connectionManager.addMember({
                identityHash: demoIdentity.identityHash,
                firstName: demoIdentity.firstName,
                lastName: demoIdentity.lastName,
                publicKey: demoIdentity.publicKey,
                inviteCode: demoIdentity.inviteCode,
                addedAt: Date.now(),
              });
              notificationManager.show('Connected with family member Bob Miller!', 'success');
              onClose();

              setTimeout(async () => {
                const demoMsg = {
                  id: `grp-demo-${Date.now()}`,
                  chatId: 'global',
                  senderId: demoIdentity.identityHash,
                  senderName: 'Bob Miller',
                  content: 'Hey everyone! Glad to be connected on our private family space! 👋',
                  timestamp: Date.now(),
                  status: 'delivered' as const,
                };
                await storageManager.addMessage('global', demoMsg);
                connectionManager.dispatchEvent(new CustomEvent('group_message_received', { detail: demoMsg }));
              }, 1200);
            }}
            className="w-full py-2.5 rounded-full text-xs font-bold border border-white/20 hover:bg-white/10 opacity-80 hover:opacity-100 transition-all flex items-center justify-center gap-1.5"
          >
            <span>+ Quick Add Demo Contact (Bob) for Testing</span>
          </button>
        </div>

        {/* User's own invite code */}
        <div className="bg-black/20 p-4 rounded-2xl border border-white/15 text-left mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">
              Your Family Invite Code
            </span>
            <button
              onClick={() => setShowQR(!showQR)}
              className="text-[11px] font-semibold flex items-center gap-1 opacity-80 hover:opacity-100 transition-opacity"
            >
              <QrCode className="w-3.5 h-3.5" />
              {showQR ? 'Hide QR' : 'Show QR'}
            </button>
          </div>

          {showQR ? (
            <div className="flex flex-col items-center justify-center py-2">
              <QRCodeSVG value={myIdentity.inviteCode} size={160} />
              <p className="text-xs font-mono font-bold mt-2 opacity-80 tracking-widest">
                {myIdentity.inviteCode}
              </p>
            </div>
          ) : (
            <div className="flex items-center justify-between mt-1">
              <p className="text-lg font-mono font-bold tracking-wider">
                {myIdentity.inviteCode}
              </p>
              <button
                onClick={handleCopyCode}
                className="p-2 rounded-xl bg-white/10 hover:bg-white/20 transition-colors"
                title="Copy code"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
          )}
        </div>

        <p className="text-[11px] opacity-60 italic">
          Connections are established directly peer-to-peer with zero central server logs.
        </p>
      </motion.div>
    </div>
  );
};
