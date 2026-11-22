/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { motion } from 'motion/react';
import { Lock } from 'lucide-react';
import { SplashEmblem } from './Illustrations.tsx';

interface SplashScreenProps {
  onFinish: () => void;
}

export const SplashScreen: React.FC<SplashScreenProps> = ({ onFinish }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onFinish();
    }, 2800);
    return () => clearTimeout(timer);
  }, [onFinish]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, x: -20 }}
      transition={{ duration: 0.3 }}
      onClick={onFinish}
      className="w-full h-screen flex flex-col items-center justify-between p-8 text-center cursor-pointer select-none"
      style={{ backgroundColor: 'var(--bg-color)', color: 'rgb(var(--text-color))' }}
    >
      <div className="h-6" />

      {/* Main Brand Section */}
      <motion.div
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ delay: 0.15, duration: 0.4 }}
        className="space-y-4 flex flex-col items-center"
      >
        <SplashEmblem className="w-40 h-40 filter drop-shadow-xl" />

        <h1 className="text-4xl font-bold font-display tracking-tight mt-2">
          Family Connection
        </h1>

        <p className="text-lg font-medium opacity-90 max-w-xs leading-snug">
          Your Private and Secure Family Space.
        </p>
      </motion.div>

      {/* Loading & Encryption Status */}
      <div className="w-full max-w-[240px] mb-8 flex flex-col items-center space-y-4">
        <div className="w-full h-1.5 bg-black/25 rounded-full overflow-hidden border border-white/10">
          <div className="loading-bar h-full rounded-full" style={{ backgroundColor: 'var(--accent-color)' }} />
        </div>

        <div className="flex flex-col items-center space-y-1">
          <span className="text-[11px] font-bold uppercase tracking-widest opacity-80">
            Establishing Mesh
          </span>
          <div className="flex items-center gap-1.5 text-emerald-400 font-bold">
            <Lock className="w-3.5 h-3.5" />
            <span className="text-[11px] tracking-wider">
              P2P E2EE SECURED
            </span>
          </div>
        </div>

        <span className="text-[10px] opacity-50 tracking-wider">Tap anywhere to continue</span>
      </div>

      <div className="h-4" />
    </motion.div>
  );
};
