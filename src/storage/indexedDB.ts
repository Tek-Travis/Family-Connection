/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ChatMessage,
  DeviceMigrationPayload,
  FamilyGroupConfig,
  FamilyMember,
  ImportMigrationMode,
  ImportMigrationResult,
  MessageStatus,
  MigrationCheckpointEntry,
  PendingAdoptionRecord,
  PendingDeviceReplacementRequest,
  RosterSnapshot,
  UserIdentity,
} from '../types.ts';
import {
  decryptMigrationArchive,
  exportMigrationArchive,
  isCredentialRevokedInSnapshots,
  isDevMode,
  prepareReplacementDeviceCandidate,
  saveIdentity,
  upgradeLegacyIdentity,
  verifyAdoptionRecordForPromotion,
  verifySnapshotAuthorityChainFromAnchor,
} from '../crypto/cryptoUtils.ts';

export const DB_VERSION = 3;

function getDbName(): string {
  if (isDevMode() && typeof sessionStorage !== 'undefined') {
    let tabId = sessionStorage.getItem('fm_tab_session_id');
    if (!tabId) {
      tabId = Math.random().toString(36).substring(2, 9);
      sessionStorage.setItem('fm_tab_session_id', tabId);
    }
    return `FamilyMeeting_Dev_${tabId}`;
  }
  return 'FamilyMeeting';
}

function getWebStorage(): Storage | null {
  if (isDevMode()) {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : null;
  }
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function getContactsFallbackKey(): string {
  if (isDevMode() && typeof sessionStorage !== 'undefined') {
    return `fm_contacts_${sessionStorage.getItem('fm_tab_session_id') || 'default'}`;
  }
  return 'fm_contacts';
}

export function applyNonDestructiveSchemaUpgrade(
  db: IDBDatabase,
  upgradeTx: IDBTransaction | null
): void {
  // v1 / v2 stores — NEVER deleted or cleared on upgrade
  if (!db.objectStoreNames.contains('messages')) {
    const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
    msgStore.createIndex('chatId', 'chatId', { unique: false });
    msgStore.createIndex('timestamp', 'timestamp', { unique: false });
    msgStore.createIndex('lamportClock', 'lamportClock', { unique: false });
  } else if (upgradeTx) {
    const msgStore = upgradeTx.objectStore('messages');
    if (!msgStore.indexNames.contains('chatId')) {
      msgStore.createIndex('chatId', 'chatId', { unique: false });
    }
    if (!msgStore.indexNames.contains('timestamp')) {
      msgStore.createIndex('timestamp', 'timestamp', { unique: false });
    }
    if (!msgStore.indexNames.contains('lamportClock')) {
      msgStore.createIndex('lamportClock', 'lamportClock', { unique: false });
    }
  }

  if (!db.objectStoreNames.contains('contacts')) {
    db.createObjectStore('contacts', { keyPath: 'identityHash' });
  }

  if (!db.objectStoreNames.contains('offlineQueue')) {
    const queueStore = db.createObjectStore('offlineQueue', { keyPath: 'id' });
    queueStore.createIndex('recipientId', 'chatId', { unique: false });
  }

  if (!db.objectStoreNames.contains('settings')) {
    db.createObjectStore('settings');
  }

  // v3 additive stores — preserving all existing user data
  if (!db.objectStoreNames.contains('familyState')) {
    db.createObjectStore('familyState', { keyPath: 'familyId' });
  }

  if (!db.objectStoreNames.contains('rosterSnapshots')) {
    const snapStore = db.createObjectStore('rosterSnapshots', {
      keyPath: 'snapshotKey',
    });
    snapStore.createIndex('byFamilyId', 'familyId', { unique: false });
  }

  if (!db.objectStoreNames.contains('seenNonces')) {
    db.createObjectStore('seenNonces', { keyPath: 'nonceKey' });
  }

  if (!db.objectStoreNames.contains('migrationCheckpoints')) {
    const cpStore = db.createObjectStore('migrationCheckpoints', {
      keyPath: 'checkpointKey',
    });
    cpStore.createIndex('byFamilyId', 'familyId', { unique: false });
  }

  if (!db.objectStoreNames.contains('pendingAdoptions')) {
    db.createObjectStore('pendingAdoptions', { keyPath: 'adoptionId' });
  }
}

export class StorageManager {
  private idbFactoryOverride: IDBFactory | null | undefined;
  private dbPromise: Promise<IDBDatabase> | null = null;
  // In-memory caches (synchronized strictly AFTER tx.oncomplete)
  private messageCache = new Map<string, ChatMessage[]>();
  private contactsCache: FamilyMember[] = [];
  private offlineQueueCache = new Map<string, ChatMessage>();
  private settingsCache = new Map<string, unknown>();
  private familyStateCache = new Map<string, FamilyGroupConfig>();
  private rosterSnapshotCache = new Map<string, RosterSnapshot>();
  private seenNonceCache = new Set<string>();
  private checkpointCache = new Map<string, MigrationCheckpointEntry>();
  private pendingAdoptionCache = new Map<string, PendingAdoptionRecord>();
  private isInitialized = false;

  constructor(options?: { idbFactory?: IDBFactory | null }) {
    this.idbFactoryOverride = options?.idbFactory;
  }

  public configureForTest(idbFactory?: IDBFactory | null): void {
    this.idbFactoryOverride = idbFactory;
    this.dbPromise = null;
    this.messageCache.clear();
    this.contactsCache = [];
    this.offlineQueueCache.clear();
    this.settingsCache.clear();
    this.familyStateCache.clear();
    this.rosterSnapshotCache.clear();
    this.seenNonceCache.clear();
    this.checkpointCache.clear();
    this.pendingAdoptionCache.clear();
    this.isInitialized = false;
  }

  private resolveIdbFactory(): IDBFactory | null {
    if (this.idbFactoryOverride !== undefined) return this.idbFactoryOverride;
    if (typeof indexedDB !== 'undefined') return indexedDB;
    return null;
  }

  public async init(): Promise<void> {
    if (this.isInitialized) return;

    const factory = this.resolveIdbFactory();
    if (!factory) {
      this.isInitialized = true;
      await this.getContacts();
      return;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      try {
        const request = factory.open(getDbName(), DB_VERSION);

        request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
          const req = event.target as IDBOpenDBRequest;
          const db = req.result;
          applyNonDestructiveSchemaUpgrade(db, req.transaction);
        };

        request.onsuccess = () => {
          resolve(request.result);
        };

        request.onerror = () => {
          console.warn(
            'IndexedDB unavailable, falling back to memory storage'
          );
          reject(request.error);
        };
      } catch (err) {
        reject(err);
      }
    });

    try {
      await this.dbPromise;
      this.isInitialized = true;
      await this.getContacts();
    } catch {
      this.dbPromise = null;
      this.isInitialized = true;
    }
  }

  private async getDb(): Promise<IDBDatabase | null> {
    try {
      if (!this.isInitialized && !this.dbPromise) await this.init();
      if (!this.dbPromise) return null;
      return await this.dbPromise;
    } catch {
      return null;
    }
  }

  private sortMessagesDeterministic(msgs: ChatMessage[]): void {
    msgs.sort((a, b) => {
      const lA = a.lamportClock ?? 0;
      const lB = b.lamportClock ?? 0;
      if (lA !== lB) return lA - lB;
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.id.localeCompare(b.id);
    });
  }

  private runTransaction(
    db: IDBDatabase,
    stores: string[],
    fn: (tx: IDBTransaction) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finishError = (err: unknown) => {
        if (settled) return;
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err || 'IndexedDB transaction failed')));
      };
      try {
        const tx = db.transaction(stores, 'readwrite');
        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        tx.onerror = () => finishError(tx.error || new Error('IndexedDB transaction error'));
        tx.onabort = () => finishError(tx.error || new Error('IndexedDB transaction aborted'));
        fn(tx);
      } catch (err) {
        finishError(err);
      }
    });
  }

  // --- Messages API ---

  public async addMessage(chatId: string, message: ChatMessage): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['messages'], (tx) => {
        tx.objectStore('messages').put({ ...message, chatId });
      });
    }

    const existing = [...(this.messageCache.get(chatId) || [])];
    const idx = existing.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      existing[idx] = { ...existing[idx], ...message };
    } else {
      existing.push(message);
    }
    this.sortMessagesDeterministic(existing);
    this.messageCache.set(chatId, existing);
  }

  public async getMessages(chatId: string): Promise<ChatMessage[]> {
    const db = await this.getDb();
    if (!db) {
      const cached = this.messageCache.get(chatId);
      return cached ? [...cached] : [];
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['messages'], 'readonly');
        const store = tx.objectStore('messages');
        const index = store.index('chatId');
        const range =
          typeof IDBKeyRange !== 'undefined'
            ? IDBKeyRange.only(chatId)
            : (chatId as unknown as IDBValidKey);
        const request = index.getAll(range);

        request.onsuccess = () => {
          const msgs: ChatMessage[] = request.result || [];
          const seen = new Set<string>();
          const deduped: ChatMessage[] = [];
          for (const m of msgs) {
            if (!seen.has(m.id)) {
              seen.add(m.id);
              deduped.push(m);
            }
          }
          this.sortMessagesDeterministic(deduped);
          this.messageCache.set(chatId, deduped);
          resolve([...deduped]);
        };

        request.onerror = () => resolve([...(this.messageCache.get(chatId) || [])]);
      } catch {
        resolve([...(this.messageCache.get(chatId) || [])]);
      }
    });
  }

  public async getAllMessages(): Promise<ChatMessage[]> {
    const db = await this.getDb();
    if (!db) {
      const all: ChatMessage[] = [];
      for (const list of this.messageCache.values()) {
        all.push(...list);
      }
      this.sortMessagesDeterministic(all);
      return all;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['messages'], 'readonly');
        const store = tx.objectStore('messages');
        const req = store.getAll();
        req.onsuccess = () => {
          const all: ChatMessage[] = req.result || [];
          this.sortMessagesDeterministic(all);
          resolve(all);
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  public async updateMessageStatus(
    chatId: string,
    messageId: string,
    status: MessageStatus
  ): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['messages'], (tx) => {
        const store = tx.objectStore('messages');
        const getReq = store.get(messageId);
        getReq.onsuccess = () => {
          const item = getReq.result;
          if (item) {
            store.put({ ...item, status });
          }
        };
      });
    }

    const list = this.messageCache.get(chatId);
    if (list) {
      const msg = list.find((m) => m.id === messageId);
      if (msg) msg.status = status;
    }
  }

  // --- Contacts / Family Members API ---

  public async getContacts(): Promise<FamilyMember[]> {
    const db = await this.getDb();
    if (!db) {
      const storage = getWebStorage();
      const stored = storage?.getItem(getContactsFallbackKey());
      if (stored) {
        try {
          this.contactsCache = JSON.parse(stored);
        } catch {
          this.contactsCache = [];
        }
      }
      return [...this.contactsCache];
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['contacts'], 'readonly');
        const store = tx.objectStore('contacts');
        const req = store.getAll();

        req.onsuccess = () => {
          this.contactsCache = (req.result || []).map((m: FamilyMember) => ({
            role: 'member' as const,
            status: 'active' as const,
            ...m,
          }));
          resolve([...this.contactsCache]);
        };
        req.onerror = () => resolve([...this.contactsCache]);
      } catch {
        resolve([...this.contactsCache]);
      }
    });
  }

  public async saveContact(member: FamilyMember): Promise<void> {
    const normalized: FamilyMember = {
      role: 'member',
      status: 'active',
      ...member,
    };

    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['contacts'], (tx) => {
        tx.objectStore('contacts').put(normalized);
      });
    }

    const idx = this.contactsCache.findIndex(
      (c) => c.identityHash === normalized.identityHash
    );
    if (idx >= 0) {
      this.contactsCache[idx] = { ...this.contactsCache[idx], ...normalized };
    } else {
      this.contactsCache.push(normalized);
    }

    const storage = getWebStorage();
    storage?.setItem(
      getContactsFallbackKey(),
      JSON.stringify(this.contactsCache)
    );
  }

  public async removeContact(identityHash: string): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['contacts'], (tx) => {
        tx.objectStore('contacts').delete(identityHash);
      });
    }

    this.contactsCache = this.contactsCache.filter(
      (c) => c.identityHash !== identityHash
    );
    const storage = getWebStorage();
    storage?.setItem(
      getContactsFallbackKey(),
      JSON.stringify(this.contactsCache)
    );
  }

  public async updateContact(
    identityHash: string,
    updates: Partial<FamilyMember>
  ): Promise<void> {
    const existing = this.contactsCache.find(
      (c) => c.identityHash === identityHash
    );
    if (!existing) return;
    const updated = { ...existing, ...updates };
    await this.saveContact(updated);
  }

  // --- Offline Outbox Queue ---

  public async enqueueOfflineMessage(msg: ChatMessage): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['offlineQueue'], (tx) => {
        tx.objectStore('offlineQueue').put(msg);
      });
    }
    this.offlineQueueCache.set(msg.id, msg);
  }

  public async getOfflineMessages(recipientId: string): Promise<ChatMessage[]> {
    const db = await this.getDb();
    if (!db) {
      return [...this.offlineQueueCache.values()].filter(
        (m) => m.chatId === recipientId
      );
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['offlineQueue'], 'readonly');
        const store = tx.objectStore('offlineQueue');
        const index = store.index('recipientId');
        const range =
          typeof IDBKeyRange !== 'undefined'
            ? IDBKeyRange.only(recipientId)
            : (recipientId as unknown as IDBValidKey);
        const req = index.getAll(range);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  public async getAllOfflineMessages(): Promise<ChatMessage[]> {
    const db = await this.getDb();
    if (!db) return [...this.offlineQueueCache.values()];

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['offlineQueue'], 'readonly');
        const store = tx.objectStore('offlineQueue');
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  public async removeOfflineMessage(messageId: string): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['offlineQueue'], (tx) => {
        tx.objectStore('offlineQueue').delete(messageId);
      });
    }
    this.offlineQueueCache.delete(messageId);
  }

  // --- Stage 2 Family Authority, Epoch, Pending Adoption & Migration Persistence ---

  public async setSetting<T>(key: string, value: T): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['settings'], (tx) => {
        tx.objectStore('settings').put(value, key);
      });
    }
    this.settingsCache.set(key, value);
  }

  public async getSetting<T>(key: string): Promise<T | null> {
    const db = await this.getDb();
    if (!db) {
      return (this.settingsCache.get(key) as T) ?? null;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['settings'], 'readonly');
        const req = tx.objectStore('settings').get(key);
        req.onsuccess = () => resolve((req.result as T) ?? null);
        req.onerror = () => resolve((this.settingsCache.get(key) as T) ?? null);
      } catch {
        resolve((this.settingsCache.get(key) as T) ?? null);
      }
    });
  }

  public async saveFamilyConfig(config: FamilyGroupConfig): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['familyState', 'settings'], (tx) => {
        tx.objectStore('familyState').put(config);
        tx.objectStore('settings').put(config.familyId, 'active_family_id');
      });
    }
    this.familyStateCache.set(config.familyId, config);
    this.settingsCache.set('active_family_id', config.familyId);
  }

  public async getActiveFamilyConfig(): Promise<FamilyGroupConfig | null> {
    const activeId = await this.getSetting<string>('active_family_id');
    const db = await this.getDb();
    if (!db) {
      if (activeId && this.familyStateCache.has(activeId)) {
        return this.familyStateCache.get(activeId)!;
      }
      const first = this.familyStateCache.values().next();
      return first.done ? null : first.value;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['familyState'], 'readonly');
        const store = tx.objectStore('familyState');
        if (activeId) {
          const req = store.get(activeId);
          req.onsuccess = () => resolve((req.result as FamilyGroupConfig) ?? null);
          req.onerror = () => resolve(null);
        } else {
          const req = store.getAll();
          req.onsuccess = () => {
            const items = (req.result as FamilyGroupConfig[]) || [];
            resolve(items[0] ?? null);
          };
          req.onerror = () => resolve(null);
        }
      } catch {
        resolve(null);
      }
    });
  }

  public async getFamilyConfigById(
    familyId: string
  ): Promise<FamilyGroupConfig | null> {
    const db = await this.getDb();
    if (!db) {
      return this.familyStateCache.get(familyId) ?? null;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['familyState'], 'readonly');
        const req = tx.objectStore('familyState').get(familyId);
        req.onsuccess = () =>
          resolve((req.result as FamilyGroupConfig) ?? null);
        req.onerror = () => resolve(this.familyStateCache.get(familyId) ?? null);
      } catch {
        resolve(this.familyStateCache.get(familyId) ?? null);
      }
    });
  }

  public async hasValidatedFamilyAuthority(familyId: string): Promise<boolean> {
    const cfg = await this.getFamilyConfigById(familyId);
    if (!cfg || cfg.authorityState !== 'verified_current') {
      return false;
    }
    const snaps = await this.getRosterSnapshots(familyId);
    return snaps.some((s) => s.trustState === 'verified_current');
  }

  public async getHighestVerifiedEpoch(familyId: string): Promise<number> {
    const val = await this.getSetting<number>(`highest_epoch:${familyId}`);
    return typeof val === 'number' ? val : 0;
  }

  public async setHighestVerifiedEpoch(
    familyId: string,
    epoch: number
  ): Promise<void> {
    const current = await this.getHighestVerifiedEpoch(familyId);
    if (epoch > current) {
      await this.setSetting(`highest_epoch:${familyId}`, epoch);
    }
  }

  public async saveRosterSnapshot(snapshot: RosterSnapshot): Promise<void> {
    const key =
      snapshot.snapshotKey ||
      `${snapshot.familyId}:${snapshot.epoch}:${snapshot.stateHash}`;
    const stored: RosterSnapshot = { ...snapshot, snapshotKey: key };

    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['rosterSnapshots'], (tx) => {
        tx.objectStore('rosterSnapshots').put(stored);
      });
    }
    this.rosterSnapshotCache.set(key, stored);
  }

  public async getRosterSnapshots(familyId: string): Promise<RosterSnapshot[]> {
    const db = await this.getDb();
    if (!db) {
      return [...this.rosterSnapshotCache.values()]
        .filter((s) => s.familyId === familyId)
        .sort((a, b) => a.epoch - b.epoch);
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['rosterSnapshots'], 'readonly');
        const index = tx.objectStore('rosterSnapshots').index('byFamilyId');
        const range =
          typeof IDBKeyRange !== 'undefined'
            ? IDBKeyRange.only(familyId)
            : (familyId as unknown as IDBValidKey);
        const req = index.getAll(range);
        req.onsuccess = () => {
          const items = ((req.result as RosterSnapshot[]) || []).sort(
            (a, b) => a.epoch - b.epoch
          );
          resolve(items);
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  public async getLatestRosterSnapshot(
    familyId: string
  ): Promise<RosterSnapshot | null> {
    const all = await this.getRosterSnapshots(familyId);
    return all.length ? all[all.length - 1] : null;
  }

  public async markNonceSeen(familyId: string, nonce: string): Promise<void> {
    const nonceKey = `${familyId}:${nonce}`;
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['seenNonces'], (tx) => {
        tx.objectStore('seenNonces').put({ nonceKey, seenAt: Date.now() });
      });
    }
    this.seenNonceCache.add(nonceKey);
  }

  public async hasSeenNonce(familyId: string, nonce: string): Promise<boolean> {
    const nonceKey = `${familyId}:${nonce}`;
    const db = await this.getDb();
    if (!db) return this.seenNonceCache.has(nonceKey);

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['seenNonces'], 'readonly');
        const req = tx.objectStore('seenNonces').get(nonceKey);
        req.onsuccess = () => resolve(Boolean(req.result));
        req.onerror = () => resolve(this.seenNonceCache.has(nonceKey));
      } catch {
        resolve(this.seenNonceCache.has(nonceKey));
      }
    });
  }

  public async saveMigrationCheckpoint(
    entry: MigrationCheckpointEntry
  ): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['migrationCheckpoints'], (tx) => {
        tx.objectStore('migrationCheckpoints').put(entry);
      });
    }
    this.checkpointCache.set(entry.checkpointKey, entry);
  }

  public async getMigrationCheckpoints(
    familyId: string
  ): Promise<MigrationCheckpointEntry[]> {
    const db = await this.getDb();
    if (!db) {
      return [...this.checkpointCache.values()]
        .filter((c) => c.familyId === familyId)
        .sort((a, b) => a.fromEpoch - b.fromEpoch);
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['migrationCheckpoints'], 'readonly');
        const index = tx
          .objectStore('migrationCheckpoints')
          .index('byFamilyId');
        const range =
          typeof IDBKeyRange !== 'undefined'
            ? IDBKeyRange.only(familyId)
            : (familyId as unknown as IDBValidKey);
        const req = index.getAll(range);
        req.onsuccess = () => {
          const items = ((req.result as MigrationCheckpointEntry[]) || []).sort(
            (a, b) => a.fromEpoch - b.fromEpoch
          );
          resolve(items);
        };
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  // --- Two-Phase Pending-Adoption Storage (For Success-Confirmed Onboarding in Stage 3) ---

  public async savePendingAdoption(
    record: PendingAdoptionRecord
  ): Promise<void> {
    const sanitized: PendingAdoptionRecord = {
      ...record,
      onboardingMessages: record.onboardingMessages
        .slice(-5)
        .map((m) => ({ ...m, isOnboardingContext: true })),
    };

    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['pendingAdoptions'], (tx) => {
        tx.objectStore('pendingAdoptions').put(sanitized);
      });
    }
    this.pendingAdoptionCache.set(sanitized.adoptionId, sanitized);
  }

  public async getPendingAdoption(
    adoptionId: string
  ): Promise<PendingAdoptionRecord | null> {
    const db = await this.getDb();
    if (!db) {
      return this.pendingAdoptionCache.get(adoptionId) ?? null;
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['pendingAdoptions'], 'readonly');
        const req = tx.objectStore('pendingAdoptions').get(adoptionId);
        req.onsuccess = () =>
          resolve((req.result as PendingAdoptionRecord) ?? null);
        req.onerror = () =>
          resolve(this.pendingAdoptionCache.get(adoptionId) ?? null);
      } catch {
        resolve(this.pendingAdoptionCache.get(adoptionId) ?? null);
      }
    });
  }

  public async getPendingAdoptions(): Promise<PendingAdoptionRecord[]> {
    const db = await this.getDb();
    if (!db) {
      return [...this.pendingAdoptionCache.values()];
    }

    return new Promise((resolve) => {
      try {
        const tx = db.transaction(['pendingAdoptions'], 'readonly');
        const req = tx.objectStore('pendingAdoptions').getAll();
        req.onsuccess = () =>
          resolve((req.result as PendingAdoptionRecord[]) || []);
        req.onerror = () => resolve([...this.pendingAdoptionCache.values()]);
      } catch {
        resolve([...this.pendingAdoptionCache.values()]);
      }
    });
  }

  public async abortPendingAdoption(adoptionId: string): Promise<void> {
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(db, ['pendingAdoptions'], (tx) => {
        tx.objectStore('pendingAdoptions').delete(adoptionId);
      });
    }
    this.pendingAdoptionCache.delete(adoptionId);
  }

  /**
   * Finalizes a previously staged PendingAdoptionRecord ONLY after permanent-room
   * authentication succeeds in Stage 3 and passes strict family, identity, invite,
   * revocation, and moderator-device signature validation.
   *
   * Resolves on `tx.oncomplete`, meaning the IndexedDB transaction has committed logically
   * (physical disk durability depends on browser/OS flushing behavior); a subsequent
   * network failure does not roll back an already committed transaction.
   * Note: In-page storage functions do not defend against malicious same-origin JS code.
   */
  public async finalizePendingAdoption(
    adoptionId: string,
    options?: {
      expectedMemberId?: string;
      expectedDeviceKeyId?: string;
    }
  ): Promise<void> {
    const record = await this.getPendingAdoption(adoptionId);
    if (!record) {
      throw new Error(`Pending adoption not found: ${adoptionId}`);
    }

    const existingTargetSnaps = await this.getRosterSnapshots(
      record.newFamilyConfig.familyId
    );
    const existingOldSnaps = await this.getRosterSnapshots(record.oldFamilyId);
    const existingRevokedKeyIds = [
      ...existingTargetSnaps.flatMap((s) => s.revokedKeyIds),
      ...existingOldSnaps.flatMap((s) => s.revokedKeyIds),
    ];

    const validation = await verifyAdoptionRecordForPromotion(record, {
      expectedMemberId: options?.expectedMemberId,
      expectedDeviceKeyId: options?.expectedDeviceKeyId,
      existingRevokedKeyIds,
    });
    if (!validation.valid) {
      throw new Error(
        `Rejected invalid or unauthenticated adoption promotion: ${validation.reason}`
      );
    }

    const existingHighestEpoch = await this.getHighestVerifiedEpoch(
      record.newFamilyConfig.familyId
    );
    if (record.initialSnapshot.epoch < existingHighestEpoch) {
      throw new Error(
        'Rejected stale adoption promotion: epoch is lower than existing verified family epoch'
      );
    }

    const snapKey =
      record.initialSnapshot.snapshotKey ||
      `${record.initialSnapshot.familyId}:${record.initialSnapshot.epoch}:${record.initialSnapshot.stateHash}`;
    const verifiedConfig: FamilyGroupConfig = {
      ...record.newFamilyConfig,
      isUnusedDefault: false,
      authorityState: 'verified_current',
    };
    const verifiedSnapshot: RosterSnapshot = {
      ...record.initialSnapshot,
      snapshotKey: snapKey,
      trustState: 'verified_current',
    };
    const slicedMsgs = record.onboardingMessages
      .slice(-5)
      .map((m) => ({ ...m, isOnboardingContext: true }));

    const db = await this.getDb();
    if (db) {
      await this.runTransaction(
        db,
        [
          'familyState',
          'rosterSnapshots',
          'contacts',
          'messages',
          'settings',
          'pendingAdoptions',
        ],
        (tx) => {
          tx.objectStore('familyState').delete(record.oldFamilyId);
          tx.objectStore('familyState').put(verifiedConfig);

          tx.objectStore('rosterSnapshots').put(verifiedSnapshot);

          const contactsStore = tx.objectStore('contacts');
          contactsStore.clear();
          for (const c of record.initialContacts) {
            contactsStore.put(c);
          }

          const msgStore = tx.objectStore('messages');
          for (const msg of slicedMsgs) {
            msgStore.put(msg);
          }

          const settingsStore = tx.objectStore('settings');
          settingsStore.put(verifiedConfig.familyId, 'active_family_id');
          settingsStore.put(
            verifiedSnapshot.epoch,
            `highest_epoch:${verifiedConfig.familyId}`
          );
          settingsStore.delete(`highest_epoch:${record.oldFamilyId}`);

          tx.objectStore('pendingAdoptions').delete(adoptionId);
        }
      );
    }

    // Update memory caches strictly AFTER transaction completes
    this.familyStateCache.delete(record.oldFamilyId);
    this.familyStateCache.set(verifiedConfig.familyId, verifiedConfig);
    for (const [k, s] of this.rosterSnapshotCache.entries()) {
      if (s.familyId === record.oldFamilyId) this.rosterSnapshotCache.delete(k);
    }
    this.rosterSnapshotCache.set(snapKey, verifiedSnapshot);
    this.contactsCache = record.initialContacts.map((c) => ({ ...c }));
    const storage = getWebStorage();
    storage?.setItem(
      getContactsFallbackKey(),
      JSON.stringify(this.contactsCache)
    );
    this.settingsCache.set('active_family_id', verifiedConfig.familyId);
    this.settingsCache.set(
      `highest_epoch:${verifiedConfig.familyId}`,
      verifiedSnapshot.epoch
    );
    this.settingsCache.delete(`highest_epoch:${record.oldFamilyId}`);
    for (const msg of slicedMsgs) {
      const chatList = [...(this.messageCache.get(msg.chatId) || [])];
      if (!chatList.some((m) => m.id === msg.id)) {
        chatList.push(msg);
      }
      this.sortMessagesDeterministic(chatList);
      this.messageCache.set(msg.chatId, chatList);
    }
    this.pendingAdoptionCache.delete(adoptionId);
  }

  /**
   * Direct single-call wrapper over pendingAdoptions + finalizePendingAdoption
   * when adoption has already been authenticated with an AuthenticatedOnboardingProof.
   */
  public async replaceUnusedDefaultFamily(params: {
    oldFamilyId: string;
    newFamilyConfig: FamilyGroupConfig;
    initialSnapshot: RosterSnapshot;
    initialContacts: FamilyMember[];
    onboardingMessages: ChatMessage[];
    permanentAuthProof: NonNullable<PendingAdoptionRecord['permanentAuthProof']>;
  }): Promise<void> {
    const adoptionId = `adopt:${params.oldFamilyId}->${params.newFamilyConfig.familyId}`;
    await this.savePendingAdoption({
      adoptionId,
      oldFamilyId: params.oldFamilyId,
      inviteCode: params.newFamilyConfig.inviteCode,
      newFamilyConfig: params.newFamilyConfig,
      initialSnapshot: params.initialSnapshot,
      initialContacts: params.initialContacts,
      onboardingMessages: params.onboardingMessages,
      status: 'authenticated',
      permanentAuthProof: params.permanentAuthProof,
      createdAt: Date.now(),
    });
    await this.finalizePendingAdoption(adoptionId);
  }

  // --- Replacement-Phone Encrypted Migration Export / Import ---

  public async exportMigrationBundle(
    passphrase: string,
    identity: UserIdentity
  ): Promise<string> {
    const upgradedIdentity = await upgradeLegacyIdentity(identity);
    const familyConfig = await this.getActiveFamilyConfig();
    const highestVerifiedEpoch = familyConfig
      ? await this.getHighestVerifiedEpoch(familyConfig.familyId)
      : 0;
    const rosterSnapshots = familyConfig
      ? await this.getRosterSnapshots(familyConfig.familyId)
      : [];
    const migrationCheckpoints = familyConfig
      ? await this.getMigrationCheckpoints(familyConfig.familyId)
      : [];
    const contacts = await this.getContacts();
    const messages = await this.getAllMessages();
    const offlineQueue = await this.getAllOfflineMessages();

    const payload: DeviceMigrationPayload = {
      version: 1,
      exportedAt: Date.now(),
      identity: upgradedIdentity,
      familyConfig,
      highestVerifiedEpoch,
      rosterSnapshots,
      contacts,
      messages,
      offlineQueue,
      migrationCheckpoints,
    };

    return exportMigrationArchive(passphrase, payload);
  }

  public async getHistoricalBackupContacts(
    familyId: string
  ): Promise<FamilyMember[]> {
    return (
      (await this.getSetting<FamilyMember[]>(
        `historical_backup_contacts:${familyId}`
      )) ?? []
    );
  }

  public async getQuarantinedImportConflicts(
    familyId: string
  ): Promise<RosterSnapshot[]> {
    return (
      (await this.getSetting<RosterSnapshot[]>(
        `quarantined_import_conflicts:${familyId}`
      )) ?? []
    );
  }

  public async importMigrationBundle(
    passphrase: string,
    rawArchiveJson: string,
    mode: ImportMigrationMode = 'replace_device'
  ): Promise<ImportMigrationResult> {
    // 1. Decrypt & validate completely in memory BEFORE inspecting/mutating local storage
    const payload = await decryptMigrationArchive(passphrase, rawArchiveJson);
    const upgradedPayloadIdentity = await upgradeLegacyIdentity(payload.identity);
    const memberId =
      upgradedPayloadIdentity.memberId || upgradedPayloadIdentity.identityHash;
    const archivedDeviceKeyId = upgradedPayloadIdentity.deviceKeyId!;

    // 2. Compare authority & epochs STRICTLY within the same targetFamilyId,
    //    and forbid merging contacts/messages across unrelated active non-default families.
    const targetFamilyId = payload.familyConfig?.familyId;
    const localActiveFamilyConfig = await this.getActiveFamilyConfig();
    if (
      localActiveFamilyConfig &&
      !localActiveFamilyConfig.isUnusedDefault &&
      targetFamilyId &&
      localActiveFamilyConfig.familyId !== targetFamilyId
    ) {
      throw new Error(
        'Cannot merge backup across unrelated active family: imported familyId differs from local active family'
      );
    }

    const localSameFamilyConfig = targetFamilyId
      ? await this.getFamilyConfigById(targetFamilyId)
      : null;
    const localHighestEpoch = targetFamilyId
      ? await this.getHighestVerifiedEpoch(targetFamilyId)
      : 0;
    const localSnapshots = targetFamilyId
      ? await this.getRosterSnapshots(targetFamilyId)
      : [];

    const combinedAuthoritySnapshots = [
      ...localSnapshots,
      ...payload.rosterSnapshots,
    ];
    if (
      isCredentialRevokedInSnapshots(
        combinedAuthoritySnapshots,
        memberId,
        archivedDeviceKeyId
      )
    ) {
      throw new Error(
        'Cannot import or replace credential: archived member or device is revoked'
      );
    }

    const payloadEpoch = Math.max(
      payload.highestVerifiedEpoch || 0,
      payload.familyConfig?.epoch || 0
    );
    const verifiedLocalSnapshots = localSnapshots.filter(
      (s) => s.trustState !== 'historical_unvalidated'
    );
    const localVerifiedLatestSnap = verifiedLocalSnapshots.length
      ? verifiedLocalSnapshots[verifiedLocalSnapshots.length - 1]
      : null;
    const localSameFamilyVerifiedEpoch = Math.max(
      localHighestEpoch,
      localSameFamilyConfig?.authorityState === 'verified_current'
        ? localSameFamilyConfig.epoch
        : 0,
      localVerifiedLatestSnap?.epoch || 0
    );
    const hasLocalVerifiedAuthority = Boolean(
      targetFamilyId &&
        (localSameFamilyConfig?.authorityState === 'verified_current' ||
          verifiedLocalSnapshots.length > 0 ||
          localHighestEpoch > 0)
    );
    const comparedEpochScope: 'same_family' | 'no_local_same_family' =
      localSameFamilyConfig || localSnapshots.length > 0 || localHighestEpoch > 0
        ? 'same_family'
        : 'no_local_same_family';

    // Determine exact protection status against existing verified local authority:
    // - Lower epoch
    // - Equal epoch with identical snapshot
    // - Equal epoch with conflicting snapshot
    // - Higher claimed epoch WITHOUT a validated moderator-device authority chain from local anchor
    let authorityStatus: ImportMigrationResult['authorityStatus'] =
      'historical_unvalidated';
    let preserveExistingVerifiedAuthority = false;
    let quarantinedSnapshots: RosterSnapshot[] = [];

    if (hasLocalVerifiedAuthority) {
      if (payloadEpoch < localSameFamilyVerifiedEpoch) {
        preserveExistingVerifiedAuthority = true;
        authorityStatus = 'preserved_higher_local';
      } else if (payloadEpoch === localSameFamilyVerifiedEpoch) {
        preserveExistingVerifiedAuthority = true;
        const importedEqualSnap = payload.rosterSnapshots.find(
          (s) =>
            s.familyId === targetFamilyId &&
            s.epoch === localSameFamilyVerifiedEpoch
        );
        const matchesIdentical = Boolean(
          importedEqualSnap &&
            localVerifiedLatestSnap &&
            importedEqualSnap.stateHash === localVerifiedLatestSnap.stateHash &&
            importedEqualSnap.signature === localVerifiedLatestSnap.signature
        );
        if (matchesIdentical) {
          authorityStatus = 'preserved_equal_local';
        } else {
          authorityStatus = 'quarantined_conflict_or_unvalidated_higher';
          quarantinedSnapshots = payload.rosterSnapshots.map((s) => ({
            ...s,
            trustState: 'historical_unvalidated' as const,
          }));
        }
      } else {
        // payloadEpoch > localSameFamilyVerifiedEpoch:
        // Never allow an unvalidated claimed higher epoch number to override current trust!
        const hasValidAnchorChain = Boolean(
          localVerifiedLatestSnap &&
            verifySnapshotAuthorityChainFromAnchor(
              localVerifiedLatestSnap,
              payload.rosterSnapshots
            )
        );
        if (!hasValidAnchorChain) {
          preserveExistingVerifiedAuthority = true;
          authorityStatus = 'quarantined_conflict_or_unvalidated_higher';
          quarantinedSnapshots = payload.rosterSnapshots.map((s) => ({
            ...s,
            trustState: 'historical_unvalidated' as const,
          }));
        } else {
          // Even when an archive carries a signed historical chain, backup restore itself
          // keeps local existing verified authority intact or marks imported chain historical until online validation.
          preserveExistingVerifiedAuthority = true;
          authorityStatus = 'quarantined_conflict_or_unvalidated_higher';
          quarantinedSnapshots = payload.rosterSnapshots.map((s) => ({
            ...s,
            trustState: 'historical_unvalidated' as const,
          }));
        }
      }
    }

    const authoritativeSnapshots = preserveExistingVerifiedAuthority
      ? localSnapshots
      : payload.rosterSnapshots;

    // 3. Prepare replacement candidate credentials (NEVER self-authorizing!)
    let finalIdentity = upgradedPayloadIdentity;
    let oldDeviceKeyId: string | undefined;
    let pendingReplacementRequest: PendingDeviceReplacementRequest | undefined;

    if (mode === 'replace_device') {
      const candidate = await prepareReplacementDeviceCandidate(
        finalIdentity,
        authoritativeSnapshots
      );
      finalIdentity = candidate.updatedIdentity;
      oldDeviceKeyId = candidate.oldDeviceKeyId;
      pendingReplacementRequest = candidate.pendingReplacementRequest;
    }

    const newDeviceKeyId = finalIdentity.deviceKeyId!;

    // Never auto-promote imported backup state to verified_current.
    const effectiveFamilyConfig: FamilyGroupConfig | null =
      preserveExistingVerifiedAuthority
        ? localSameFamilyConfig
        : payload.familyConfig
          ? {
              ...payload.familyConfig,
              authorityState: 'historical_unverified',
              historicalImportedAt: Date.now(),
            }
          : null;

    const snapshotsToWrite: RosterSnapshot[] = preserveExistingVerifiedAuthority
      ? []
      : payload.rosterSnapshots
          .filter((s) => !targetFamilyId || s.familyId === targetFamilyId)
          .map((s) => ({
            ...s,
            trustState: 'historical_unvalidated' as const,
          }));

    // Scope messages cleanly to known target-family members or 'global' (never cross-family/unknown DM leak)
    const allowedFamilyPeerIds = new Set<string>([memberId]);
    for (const c of payload.contacts) {
      allowedFamilyPeerIds.add(c.identityHash);
      if (c.memberId) allowedFamilyPeerIds.add(c.memberId);
    }
    for (const snap of payload.rosterSnapshots) {
      if (!targetFamilyId || snap.familyId === targetFamilyId) {
        for (const m of snap.members) {
          allowedFamilyPeerIds.add(m.identityHash);
          if (m.memberId) allowedFamilyPeerIds.add(m.memberId);
        }
      }
    }
    const messagesToWrite = payload.messages.filter(
      (m) => m.chatId === 'global' || allowedFamilyPeerIds.has(m.chatId)
    );
    const queueToWrite = payload.offlineQueue.filter(
      (q) => q.chatId === 'global' || allowedFamilyPeerIds.has(q.chatId)
    );

    // 4. Write atomically inside ONE IndexedDB transaction resolving strictly on tx.oncomplete.
    //    (tx.oncomplete indicates logical commit of the transaction; physical disk
    //     durability depends on browser/OS storage flushing behavior.)
    const db = await this.getDb();
    if (db) {
      await this.runTransaction(
        db,
        [
          'familyState',
          'rosterSnapshots',
          'contacts',
          'messages',
          'offlineQueue',
          'migrationCheckpoints',
          'settings',
        ],
        (tx) => {
          const settingsStore = tx.objectStore('settings');

          if (effectiveFamilyConfig) {
            tx.objectStore('familyState').put(effectiveFamilyConfig);
            settingsStore.put(effectiveFamilyConfig.familyId, 'active_family_id');
            if (preserveExistingVerifiedAuthority) {
              settingsStore.put(
                localSameFamilyVerifiedEpoch,
                `highest_epoch:${effectiveFamilyConfig.familyId}`
              );
            } else {
              settingsStore.put(
                payloadEpoch,
                `historical_backup_epoch:${effectiveFamilyConfig.familyId}`
              );
            }
          }

          if (quarantinedSnapshots.length > 0 && targetFamilyId) {
            settingsStore.put(
              quarantinedSnapshots,
              `quarantined_import_conflicts:${targetFamilyId}`
            );
          }

          const snapStore = tx.objectStore('rosterSnapshots');
          for (const snap of snapshotsToWrite) {
            const snapshotKey =
              snap.snapshotKey ||
              `${snap.familyId}:${snap.epoch}:${snap.stateHash}`;
            snapStore.put({ ...snap, snapshotKey });
          }

          if (!preserveExistingVerifiedAuthority && targetFamilyId) {
            settingsStore.put(
              payload.contacts,
              `historical_backup_contacts:${targetFamilyId}`
            );
          }

          const msgStore = tx.objectStore('messages');
          for (const m of messagesToWrite) {
            msgStore.put(m);
          }

          const qStore = tx.objectStore('offlineQueue');
          for (const q of queueToWrite) {
            qStore.put(q);
          }

          const cpStore = tx.objectStore('migrationCheckpoints');
          for (const cp of payload.migrationCheckpoints) {
            if (!targetFamilyId || cp.familyId === targetFamilyId) {
              cpStore.put(cp);
            }
          }

          if (pendingReplacementRequest) {
            settingsStore.put(
              pendingReplacementRequest,
              'pending_device_replacement_request'
            );
          }
        }
      );
    }

    // 5. Sync memory caches & durable local identity store strictly AFTER tx.oncomplete
    if (effectiveFamilyConfig) {
      this.familyStateCache.set(
        effectiveFamilyConfig.familyId,
        effectiveFamilyConfig
      );
      this.settingsCache.set('active_family_id', effectiveFamilyConfig.familyId);
      if (preserveExistingVerifiedAuthority) {
        this.settingsCache.set(
          `highest_epoch:${effectiveFamilyConfig.familyId}`,
          localSameFamilyVerifiedEpoch
        );
      } else {
        this.settingsCache.set(
          `historical_backup_epoch:${effectiveFamilyConfig.familyId}`,
          payloadEpoch
        );
      }
    }
    if (quarantinedSnapshots.length > 0 && targetFamilyId) {
      this.settingsCache.set(
        `quarantined_import_conflicts:${targetFamilyId}`,
        quarantinedSnapshots
      );
    }
    for (const snap of snapshotsToWrite) {
      const snapshotKey =
        snap.snapshotKey || `${snap.familyId}:${snap.epoch}:${snap.stateHash}`;
      this.rosterSnapshotCache.set(snapshotKey, { ...snap, snapshotKey });
    }
    if (!preserveExistingVerifiedAuthority && targetFamilyId) {
      this.settingsCache.set(
        `historical_backup_contacts:${targetFamilyId}`,
        payload.contacts
      );
    }
    for (const m of messagesToWrite) {
      const list = [...(this.messageCache.get(m.chatId) || [])];
      if (!list.some((x) => x.id === m.id)) list.push(m);
      this.sortMessagesDeterministic(list);
      this.messageCache.set(m.chatId, list);
    }
    for (const q of queueToWrite) {
      this.offlineQueueCache.set(q.id, q);
    }
    for (const cp of payload.migrationCheckpoints) {
      if (!targetFamilyId || cp.familyId === targetFamilyId) {
        this.checkpointCache.set(cp.checkpointKey, cp);
      }
    }
    if (pendingReplacementRequest) {
      this.settingsCache.set(
        'pending_device_replacement_request',
        pendingReplacementRequest
      );
    }

    const webStorage = getWebStorage();
    if (webStorage) {
      saveIdentity(finalIdentity);
    }

    return {
      mode,
      identity: finalIdentity,
      memberId,
      oldDeviceKeyId,
      newDeviceKeyId,
      pendingReplacementRequest,
      authorityStatus,
      comparedEpochScope,
      preservedHigherLocalEpoch: preserveExistingVerifiedAuthority
        ? localSameFamilyVerifiedEpoch
        : undefined,
      quarantinedSnapshotCount: quarantinedSnapshots.length,
      importedContacts: 0,
      importedHistoricalContacts: preserveExistingVerifiedAuthority
        ? 0
        : payload.contacts.length,
      importedMessages: messagesToWrite.length,
      importedSnapshots: snapshotsToWrite.length,
    };
  }
}

export const storageManager = new StorageManager();
