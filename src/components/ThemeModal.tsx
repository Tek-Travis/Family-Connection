/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { motion } from 'motion/react';
import { X, Check } from 'lucide-react';
import { EarthyTheme } from '../types.ts';

interface ThemeModalProps {
  currentTheme: EarthyTheme;
  onSelectTheme: (theme: EarthyTheme) => void;
  onClose: () => void;
}

const THEMES: { id: EarthyTheme; name: string; bg: string; text: string; border: string }[] = [
  { id: 'theme-earthy-1', name: '1. Lime', bg: '#ecebe9', text: '#202020', border: 'rgba(155,155,153,0.4)' },
  { id: 'theme-earthy-2', name: '2. Granite', bg: '#9b9b99', text: '#151515', border: 'rgba(245,245,245,0.4)' },
  { id: 'theme-earthy-3', name: '3. Sand Stone', bg: '#7f7963', text: '#ffffff', border: 'rgba(255,255,255,0.4)' },
  { id: 'theme-earthy-4', name: '4. Clay', bg: '#655d50', text: '#ffffff', border: 'rgba(255,255,255,0.3)' },
  { id: 'theme-earthy-5', name: '5. Earth', bg: '#393323', text: '#ffffff', border: 'rgba(255,255,255,0.25)' },
];

export const ThemeModal: React.FC<ThemeModalProps> = ({ currentTheme, onSelectTheme, onClose }) => {
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
          Appearance
        </h2>
        <p className="text-sm opacity-75 mb-6">
          Select your preferred earthy color palette.
        </p>

        <div className="space-y-3">
          {THEMES.map((theme) => {
            const isSelected = currentTheme === theme.id;
            return (
              <button
                key={theme.id}
                onClick={() => {
                  onSelectTheme(theme.id);
                  onClose();
                }}
                className={`w-full py-3.5 px-6 rounded-full font-bold flex items-center justify-between shadow-md transition-all border-2 ${
                  isSelected ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-black/40' : ''
                }`}
                style={{
                  backgroundColor: theme.bg,
                  color: theme.text,
                  borderColor: theme.border,
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-5 h-5 rounded-full border border-black/20 shadow-inner"
                    style={{ backgroundColor: theme.bg }}
                  />
                  <span className="text-base">{theme.name}</span>
                </div>
                {isSelected && <Check className="w-5 h-5" />}
              </button>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
};
