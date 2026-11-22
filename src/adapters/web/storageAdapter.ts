/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { StorageAdapter } from 'core/adapters/types';
import { StorageManager, storageManager } from '../../storage/indexedDB.ts';

const CHITCHATTER_STORAGE_PREFIX = 'fc:chitchatter:';

/**
 * Chitchatter StorageAdapter backed by Family Connection's IndexedDB StorageManager.
 * Quota and write errors propagate cleanly without clearing or overwriting existing entries.
 */
export function createIndexedDbStorageAdapter(
  manager: StorageManager = storageManager
): StorageAdapter {
  return {
    getItem: async <T>(key: string): Promise<T | null> => {
      await manager.init();
      return manager.getSetting<T>(`${CHITCHATTER_STORAGE_PREFIX}${key}`);
    },
    setItem: async <T>(key: string, value: T): Promise<T> => {
      await manager.init();
      await manager.setSetting(`${CHITCHATTER_STORAGE_PREFIX}${key}`, value);
      return value;
    },
    removeItem: async (key: string): Promise<void> => {
      await manager.init();
      await manager.setSetting(`${CHITCHATTER_STORAGE_PREFIX}${key}`, null);
    },
  };
}
