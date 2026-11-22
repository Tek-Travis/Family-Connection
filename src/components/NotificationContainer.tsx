/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { AppNotification } from '../types.ts';

class NotificationManager {
  private listeners: Set<(notifications: AppNotification[]) => void> = new Set();
  private list: AppNotification[] = [];

  public show(
    message: string,
    type: 'info' | 'success' | 'error' = 'info',
    onClick?: () => void,
    actionText?: string
  ): void {
    const item: AppNotification = {
      id: `${Date.now()}-${Math.random()}`,
      message,
      type,
      timestamp: Date.now(),
      onClick,
      actionText,
    };
    this.list = [...this.list, item];
    this.emit();

    setTimeout(() => {
      this.list = this.list.filter((n) => n.id !== item.id);
      this.emit();
    }, 5500);
  }

  public subscribe(cb: (notifications: AppNotification[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.list);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    this.listeners.forEach((cb) => cb(this.list));
  }
}

export const notificationManager = new NotificationManager();

export const NotificationContainer: React.FC = () => {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);

  useEffect(() => {
    return notificationManager.subscribe(setNotifications);
  }, []);

  return (
    <div className="fixed top-4 left-0 right-0 z-[100] flex flex-col items-center space-y-2 pointer-events-none px-4">
      <AnimatePresence>
        {notifications.map((n) => (
          <motion.div
            key={n.id}
            initial={{ opacity: 0, y: -20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.9 }}
            onClick={() => {
              if (n.onClick) {
                n.onClick();
              }
            }}
            className={`pointer-events-auto px-5 py-3 rounded-full shadow-2xl flex items-center gap-3 border-2 ${
              n.onClick ? 'cursor-pointer hover:scale-[1.02] transition-transform' : ''
            } ${
              n.type === 'error'
                ? 'bg-red-950/95 border-red-500/60 text-red-200'
                : n.type === 'success'
                ? 'bg-emerald-950/95 border-emerald-500/60 text-emerald-200'
                : 'bg-stone-900/95 border-stone-600/60 text-stone-200'
            }`}
          >
            {n.type === 'error' ? (
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
            ) : n.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <Info className="w-5 h-5 text-sky-400 shrink-0" />
            )}
            <span className="font-semibold text-sm tracking-wide">{n.message}</span>
            {n.actionText && (
              <span className="ml-1 text-xs font-bold underline opacity-90 hover:opacity-100 uppercase tracking-wider bg-white/10 px-2 py-0.5 rounded-full">
                {n.actionText} →
              </span>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
