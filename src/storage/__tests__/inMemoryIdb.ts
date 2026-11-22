/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SeededStoreData {
  keyPath: string | null;
  indexes: Record<string, string>;
  records: Array<[unknown, unknown]>;
}

export interface InMemoryIdbOptions {
  initialVersion?: number;
  initialStores?: Record<string, SeededStoreData>;
}

interface PersistedStore {
  name: string;
  keyPath: string | null;
  indexes: Map<string, string>; // indexName -> keyPath
  records: Map<string, { key: unknown; value: unknown }>;
}

interface PersistedDb {
  name: string;
  version: number;
  stores: Map<string, PersistedStore>;
}

function serializeKey(key: unknown): string {
  if (typeof key === 'string') return `s:${key}`;
  if (typeof key === 'number') return `n:${key}`;
  return `j:${JSON.stringify(key)}`;
}

function cloneData<T>(val: T): T {
  return structuredClone(val);
}

function extractKey(keyPath: string, value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  return (value as Record<string, unknown>)[keyPath];
}

function unwrapQueryKey(query: unknown): unknown {
  if (query && typeof query === 'object' && 'lower' in query && 'upper' in query) {
    return (query as { lower: unknown }).lower;
  }
  return query;
}

function makeDomStringList(items: Iterable<string>): DOMStringList {
  const arr = Array.from(items);
  return {
    length: arr.length,
    contains: (name: string) => arr.includes(name),
    item: (index: number) => arr[index] ?? null,
    [Symbol.iterator]: () => arr[Symbol.iterator](),
  } as unknown as DOMStringList;
}

export class InMemoryIdbFactory {
  private databases = new Map<string, PersistedDb>();
  public failOnPutInStore: string | null = null;
  public forceAbortOnStore: string | null = null;
  public completedTransactions = 0;
  public abortedTransactions = 0;
  public deletedStores: string[] = [];
  public clearedStoresDuringUpgrade: string[] = [];

  public seedDatabase(name: string, options: InMemoryIdbOptions): void {
    const stores = new Map<string, PersistedStore>();
    for (const [storeName, cfg] of Object.entries(options.initialStores || {})) {
      const records = new Map<string, { key: unknown; value: unknown }>();
      for (const [k, v] of cfg.records) {
        records.set(serializeKey(k), { key: cloneData(k), value: cloneData(v) });
      }
      stores.set(storeName, {
        name: storeName,
        keyPath: cfg.keyPath,
        indexes: new Map(Object.entries(cfg.indexes)),
        records,
      });
    }
    this.databases.set(name, {
      name,
      version: options.initialVersion ?? 1,
      stores,
    });
  }

  public getDatabaseSnapshot(name: string): PersistedDb | undefined {
    return this.databases.get(name);
  }

  public createFactory(): IDBFactory {
    const self = this;

    const createIdbDatabaseWrapper = (persisted: PersistedDb): IDBDatabase => {
      const makeStoreHandle = (
        store: PersistedStore,
        isUpgrade: boolean,
        txState?: {
          mode: IDBTransactionMode;
          aborted: boolean;
          pendingOps: number;
          stagedStores: Map<string, PersistedStore>;
          scheduleOp: (fn: () => unknown) => IDBRequest;
          abortTx: (err: Error) => void;
        }
      ): IDBObjectStore => {
        const activeStore = txState ? txState.stagedStores.get(store.name)! : store;

        const makeIndexHandle = (indexName: string, keyPath: string): IDBIndex =>
          ({
            name: indexName,
            keyPath,
            getAll: (query?: unknown) => {
              if (!txState) throw new Error('Index access outside transaction');
              return txState.scheduleOp(() => {
                const targetKey = query !== undefined ? unwrapQueryKey(query) : undefined;
                const out: unknown[] = [];
                for (const entry of activeStore.records.values()) {
                  if (targetKey === undefined) {
                    out.push(cloneData(entry.value));
                  } else {
                    const idxVal = extractKey(keyPath, entry.value);
                    if (idxVal === targetKey) {
                      out.push(cloneData(entry.value));
                    }
                  }
                }
                return out;
              });
            },
          }) as unknown as IDBIndex;

        return {
          name: activeStore.name,
          keyPath: activeStore.keyPath,
          get indexNames() {
            return makeDomStringList(activeStore.indexes.keys());
          },
          createIndex: (indexName: string, keyPath: string) => {
            if (!isUpgrade) throw new Error('createIndex only allowed in upgrade');
            activeStore.indexes.set(indexName, keyPath);
            return makeIndexHandle(indexName, keyPath);
          },
          index: (indexName: string) => {
            const kp = activeStore.indexes.get(indexName);
            if (!kp) throw new Error(`Index not found: ${indexName}`);
            return makeIndexHandle(indexName, kp);
          },
          put: (value: unknown, explicitKey?: unknown) => {
            if (!txState || txState.mode !== 'readwrite') {
              throw new Error('put requires readwrite transaction');
            }
            return txState.scheduleOp(() => {
              if (self.failOnPutInStore === activeStore.name) {
                throw new Error(`Simulated disk write failure on store ${activeStore.name}`);
              }
              if (self.forceAbortOnStore === activeStore.name) {
                txState.abortTx(new Error(`Forced tx.abort() on store ${activeStore.name}`));
                throw new Error(`Forced tx.abort() on store ${activeStore.name}`);
              }
              const key =
                activeStore.keyPath !== null
                  ? extractKey(activeStore.keyPath, value)
                  : explicitKey;
              if (key === undefined || key === null) {
                throw new Error(`Missing key for put on ${activeStore.name}`);
              }
              activeStore.records.set(serializeKey(key), {
                key: cloneData(key),
                value: cloneData(value),
              });
              return cloneData(key);
            });
          },
          get: (key: unknown) => {
            if (!txState) throw new Error('get outside transaction');
            return txState.scheduleOp(() => {
              const found = activeStore.records.get(serializeKey(key));
              return found ? cloneData(found.value) : undefined;
            });
          },
          getAll: () => {
            if (!txState) throw new Error('getAll outside transaction');
            return txState.scheduleOp(() =>
              Array.from(activeStore.records.values()).map((e) => cloneData(e.value))
            );
          },
          delete: (key: unknown) => {
            if (!txState || txState.mode !== 'readwrite') {
              throw new Error('delete requires readwrite transaction');
            }
            return txState.scheduleOp(() => {
              activeStore.records.delete(serializeKey(key));
              return undefined;
            });
          },
          clear: () => {
            if (isUpgrade) {
              self.clearedStoresDuringUpgrade.push(activeStore.name);
              activeStore.records.clear();
              return {} as IDBRequest;
            }
            if (!txState || txState.mode !== 'readwrite') {
              throw new Error('clear requires readwrite transaction');
            }
            return txState.scheduleOp(() => {
              activeStore.records.clear();
              return undefined;
            });
          },
        } as unknown as IDBObjectStore;
      };

      const dbWrapper = {
        name: persisted.name,
        get version() {
          return persisted.version;
        },
        get objectStoreNames() {
          return makeDomStringList(persisted.stores.keys());
        },
        createObjectStore: (
          name: string,
          options?: IDBObjectStoreParameters
        ) => {
          const store: PersistedStore = {
            name,
            keyPath: typeof options?.keyPath === 'string' ? options.keyPath : null,
            indexes: new Map(),
            records: new Map(),
          };
          persisted.stores.set(name, store);
          return makeStoreHandle(store, true);
        },
        deleteObjectStore: (name: string) => {
          self.deletedStores.push(name);
          persisted.stores.delete(name);
        },
        transaction: (
          storeNames: string | string[],
          mode: IDBTransactionMode = 'readonly'
        ): IDBTransaction => {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          const stagedStores = new Map<string, PersistedStore>();
          for (const n of names) {
            const orig = persisted.stores.get(n);
            if (!orig) {
              throw new Error(`Object store not found: ${n}`);
            }
            const clonedRecords = new Map<string, { key: unknown; value: unknown }>();
            for (const [k, v] of orig.records.entries()) {
              clonedRecords.set(k, { key: cloneData(v.key), value: cloneData(v.value) });
            }
            stagedStores.set(n, {
              name: orig.name,
              keyPath: orig.keyPath,
              indexes: new Map(orig.indexes),
              records: clonedRecords,
            });
          }

          let finished = false;
          const txObj: Record<string, unknown> = {
            mode,
            error: null,
            oncomplete: null,
            onerror: null,
            onabort: null,
          };

          const txState = {
            mode,
            aborted: false,
            pendingOps: 0,
            stagedStores,
            abortTx: (err: Error) => {
              if (txState.aborted || finished) return;
              txState.aborted = true;
              finished = true;
              txObj.error = err;
              self.abortedTransactions++;
              queueMicrotask(() => {
                (txObj.onabort as ((ev: Event) => void) | null)?.({
                  target: txObj,
                } as unknown as Event);
              });
            },
            scheduleOp: (fn: () => unknown): IDBRequest => {
              const req: Record<string, unknown> = {
                result: undefined,
                error: null,
                onsuccess: null,
                onerror: null,
              };
              txState.pendingOps++;
              queueMicrotask(() => {
                if (txState.aborted || finished) {
                  txState.pendingOps--;
                  return;
                }
                try {
                  const res = fn();
                  req.result = res;
                  (req.onsuccess as ((ev: Event) => void) | null)?.({
                    target: req,
                  } as unknown as Event);
                  txState.pendingOps--;
                  maybeCommit();
                } catch (err) {
                  const e = err instanceof Error ? err : new Error(String(err));
                  req.error = e;
                  txObj.error = e;
                  (req.onerror as ((ev: Event) => void) | null)?.({
                    target: req,
                  } as unknown as Event);
                  txState.pendingOps--;
                  txState.abortTx(e);
                }
              });
              return req as unknown as IDBRequest;
            },
          };

          const maybeCommit = () => {
            if (txState.aborted || finished || txState.pendingOps > 0) return;
            finished = true;
            if (mode === 'readwrite') {
              for (const [storeName, staged] of stagedStores.entries()) {
                persisted.stores.set(storeName, staged);
              }
            }
            self.completedTransactions++;
            (txObj.oncomplete as ((ev: Event) => void) | null)?.({
              target: txObj,
            } as unknown as Event);
          };

          // Handle empty transactions with zero queued operations
          queueMicrotask(() => {
            if (!txState.aborted && !finished && txState.pendingOps === 0) {
              maybeCommit();
            }
          });

          txObj.objectStore = (name: string) => {
            const store = stagedStores.get(name);
            if (!store) throw new Error(`Store ${name} not in transaction scope`);
            return makeStoreHandle(store, false, txState);
          };

          txObj.abort = () => {
            txState.abortTx(new Error('Transaction aborted via tx.abort()'));
          };

          return txObj as unknown as IDBTransaction;
        },
        close: () => {
          // No-op: persisted state remains intact in self.databases
        },
      } as unknown as IDBDatabase;

      return dbWrapper;
    };

    return {
      open: (name: string, version = 1): IDBOpenDBRequest => {
        const req: Record<string, unknown> = {
          result: undefined,
          error: null,
          transaction: null,
          onupgradeneeded: null,
          onsuccess: null,
          onerror: null,
        };

        queueMicrotask(() => {
          let persisted = self.databases.get(name);
          const oldVersion = persisted ? persisted.version : 0;
          if (!persisted) {
            persisted = {
              name,
              version: 0,
              stores: new Map(),
            };
            self.databases.set(name, persisted);
          }

          const dbWrapper = createIdbDatabaseWrapper(persisted);
          req.result = dbWrapper;

          if (version > oldVersion) {
            persisted.version = version;
            const upgradeTx = {
              objectStore: (storeName: string) => {
                const store = persisted!.stores.get(storeName);
                if (!store) throw new Error(`Store not found during upgrade: ${storeName}`);
                return makeStoreHandle(store, true);
              },
            } as unknown as IDBTransaction;

            function makeStoreHandle(store: PersistedStore, isUpgrade: boolean) {
              return {
                name: store.name,
                keyPath: store.keyPath,
                get indexNames() {
                  return makeDomStringList(store.indexes.keys());
                },
                createIndex: (indexName: string, keyPath: string) => {
                  if (!isUpgrade) throw new Error('Upgrade only');
                  store.indexes.set(indexName, keyPath);
                  return {};
                },
                clear: () => {
                  self.clearedStoresDuringUpgrade.push(store.name);
                  store.records.clear();
                },
              } as unknown as IDBObjectStore;
            }

            req.transaction = upgradeTx;
            (req.onupgradeneeded as ((ev: IDBVersionChangeEvent) => void) | null)?.({
              target: req,
              oldVersion,
              newVersion: version,
            } as unknown as IDBVersionChangeEvent);
            req.transaction = null;
          }

          (req.onsuccess as ((ev: Event) => void) | null)?.({
            target: req,
          } as unknown as Event);
        });

        return req as unknown as IDBOpenDBRequest;
      },
    } as unknown as IDBFactory;
  }
}
