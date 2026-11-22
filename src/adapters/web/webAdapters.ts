/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LoggerAdapter,
  NotifierAdapter,
  PlatformAdapters,
  SoundAdapter,
} from 'core/adapters/types';
import { noopFileTransfer, systemClock } from 'core/adapters/noop';
import { playNotificationChime } from '../../crypto/cryptoUtils.ts';
import { StorageManager, storageManager } from '../../storage/indexedDB.ts';
import { createIndexedDbStorageAdapter } from './storageAdapter.ts';
import { createWebFileTransferAdapter } from './fileTransferAdapter.ts';

const SENSITIVE_PATTERN =
  /([A-Za-z0-9!@#$%^&*+?]{4}-){3}[A-Za-z0-9!@#$%^&*+?]{4}|"secretKey"\s*:|"signSecretKey"\s*:|"deviceSignSecretKey"\s*:|"rsaPrivateKeyPkcs8"\s*:|"groupSecretKey"\s*:|"passphrase"\s*:|"content"\s*:/gi;

export function redactSensitiveDiagnostic(input: string): string {
  if (!input) return '';
  return input.replace(SENSITIVE_PATTERN, '[REDACTED]');
}

export function createSanitizedLogger(
  sink?: Partial<LoggerAdapter>
): LoggerAdapter {
  const format = (msg: string): string => redactSensitiveDiagnostic(msg);
  return {
    warn: (message: string, ...rest: unknown[]) => {
      if (sink?.warn) {
        sink.warn(format(message));
        return;
      }
      if (rest.length > 0 && rest[0] instanceof Error) {
        console.warn(`[FamilyBridge] ${format(message)}: ${format(rest[0].message)}`);
      } else {
        console.warn(`[FamilyBridge] ${format(message)}`);
      }
    },
    error: (message: string, ...rest: unknown[]) => {
      if (sink?.error) {
        sink.error(format(message));
        return;
      }
      if (rest.length > 0 && rest[0] instanceof Error) {
        console.error(`[FamilyBridge] ${format(message)}: ${format(rest[0].message)}`);
      } else {
        console.error(`[FamilyBridge] ${format(message)}`);
      }
    },
  };
}

export interface WebPlatformAdapterOptions {
  storageManager?: StorageManager;
  rtcConfig?: RTCConfiguration;
  disableFileTransfer?: boolean;
  onNotify?: (message: string) => void;
  onPlaySound?: () => void;
  logger?: Partial<LoggerAdapter>;
}

/**
 * Builds Chitchatter PlatformAdapters wired into Family Connection's IndexedDB storage,
 * encrypted FileTransfer service, Web Audio chime, and redacted diagnostic logger.
 */
export function createWebPlatformAdapters(
  options: WebPlatformAdapterOptions = {}
): PlatformAdapters {
  const notifier: NotifierAdapter = {
    notify: (message: string) => {
      if (options.onNotify) {
        options.onNotify(message);
      }
    },
  };

  const sound: SoundAdapter = {
    playNewMessageSound: () => {
      if (options.onPlaySound) {
        options.onPlaySound();
      } else {
        playNotificationChime();
      }
    },
  };

  return {
    notifier,
    sound,
    storage: createIndexedDbStorageAdapter(
      options.storageManager ?? storageManager
    ),
    fileTransfer: options.disableFileTransfer
      ? noopFileTransfer
      : createWebFileTransferAdapter({ rtcConfig: options.rtcConfig }),
    clock: systemClock,
    ids: {
      uuid: () => crypto.randomUUID(),
    },
    logger: createSanitizedLogger(options.logger),
  };
}
