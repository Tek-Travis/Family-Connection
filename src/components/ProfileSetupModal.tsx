/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Shield, Sparkles, User } from 'lucide-react';
import { createNewIdentity, saveIdentity } from '../crypto/cryptoUtils.ts';
import { UserIdentity } from '../types.ts';

interface ProfileSetupModalProps {
  onComplete: (identity: UserIdentity) => void;
  initialFirstName?: string;
  initialLastName?: string;
  isSwitching?: boolean;
}

export const ProfileSetupModal: React.FC<ProfileSetupModalProps> = ({
  onComplete,
  initialFirstName = '',
  initialLastName = '',
  isSwitching = false,
}) => {
  const [firstName, setFirstName] = useState(initialFirstName);
  const [lastName, setLastName] = useState(initialLastName);
  const [isGenerating, setIsGenerating] = useState(false);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName.trim() || !lastName.trim() || isGenerating) return;

    setIsGenerating(true);
    try {
      const identity = await createNewIdentity(firstName.trim(), lastName.trim());
      saveIdentity(identity);
      onComplete(identity);
    } catch (err) {
      console.error('Failed to create identity:', err);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md">
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 20 }}
        className="w-full max-w-sm rounded-[2.5rem] p-8 shadow-2xl border-4 border-white/20 text-center"
        style={{ backgroundColor: 'var(--bg-color)', color: 'rgb(var(--text-color))' }}
      >
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-white/10 border-2 border-white/20 flex items-center justify-center text-accent">
          <Shield className="w-8 h-8" />
        </div>

        <h1 className="text-3xl font-bold font-display tracking-tight mb-2">
          {isSwitching ? 'Switch Identity' : 'Setup Family Profile'}
        </h1>
        <p className="text-sm opacity-80 mb-6">
          Enter your name to generate your private Ed25519 & Curve25519 cryptographic keypair and family invite code.
        </p>

        <form onSubmit={handleSave} className="space-y-4">
          <div className="relative text-left">
            <span className="text-[11px] font-bold uppercase tracking-wider opacity-60 ml-3 mb-1 block">
              First Name
            </span>
            <div className="flex items-center bg-black/20 rounded-2xl border-2 border-white/15 px-4 py-3">
              <User className="w-5 h-5 opacity-50 mr-2 shrink-0" />
              <input
                className="w-full bg-transparent text-lg font-medium placeholder:opacity-40 focus:outline-none"
                placeholder="e.g. Alice"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          <div className="relative text-left">
            <span className="text-[11px] font-bold uppercase tracking-wider opacity-60 ml-3 mb-1 block">
              Last Name
            </span>
            <div className="flex items-center bg-black/20 rounded-2xl border-2 border-white/15 px-4 py-3">
              <User className="w-5 h-5 opacity-50 mr-2 shrink-0" />
              <input
                className="w-full bg-transparent text-lg font-medium placeholder:opacity-40 focus:outline-none"
                placeholder="e.g. Johnson"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={!firstName.trim() || !lastName.trim() || isGenerating}
            className="w-full py-4 rounded-full text-lg font-bold shadow-xl transition-all btn-uniform mt-6"
            style={{
              backgroundColor: 'var(--bubble-me-bg)',
              color: 'var(--bubble-me-text)',
            }}
          >
            {isGenerating ? (
              <span className="flex items-center justify-center gap-2">
                <Sparkles className="w-5 h-5 animate-spin" />
                Generating Keys...
              </span>
            ) : (
              'Start Family Connection'
            )}
          </button>
        </form>
      </motion.div>
    </div>
  );
};
