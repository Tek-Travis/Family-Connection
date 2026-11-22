/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const APP_URL = process.env.E2E_APP_URL || 'http://127.0.0.1:3000';
const HARNESS_URL = `${APP_URL}/__stage2_harness__`;
const CACHED_CHROME = '/ms-playwright/chrome-headless-shell-linux64/chrome-headless-shell';

async function attachHarnessRoute(context) {
  await context.route(HARNESS_URL, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head><title>Stage 2 Browser IDB Harness</title></head><body></body></html>',
    });
  });
}

async function runRealBrowserStage2Tests() {
  const browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
      (fs.existsSync(CACHED_CHROME) ? CACHED_CHROME : undefined),
  });
  const consoleMessages = [];
  const pageErrors = [];

  try {
    // 1. Real Chromium IndexedDB v2 -> v3 non-destructive upgrade + reload persistence
    const ctx1 = await browser.newContext();
    await attachHarnessRoute(ctx1);
    const page1 = await ctx1.newPage();
    page1.on('console', (msg) => consoleMessages.push(msg.text()));
    page1.on('pageerror', (err) => pageErrors.push(err.message));

    await page1.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

    const upgradeRes = await page1.evaluate(async () => {
      // Seed a genuine Chromium IndexedDB version 2 database
      await new Promise((resolve, reject) => {
        const del = indexedDB.deleteDatabase('FamilyMeeting');
        del.onsuccess = () => resolve();
        del.onerror = () => reject(del.error);
      });

      await new Promise((resolve, reject) => {
        const req = indexedDB.open('FamilyMeeting', 2);
        req.onupgradeneeded = () => {
          const db = req.result;
          const msgStore = db.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('chatId', 'chatId', { unique: false });
          msgStore.createIndex('timestamp', 'timestamp', { unique: false });
          db.createObjectStore('contacts', { keyPath: 'identityHash' });
          const qStore = db.createObjectStore('offlineQueue', { keyPath: 'id' });
          qStore.createIndex('recipientId', 'chatId', { unique: false });
          db.createObjectStore('settings');
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['messages', 'contacts', 'offlineQueue', 'settings'], 'readwrite');
          tx.objectStore('messages').put({
            id: 'v2-browser-msg-1',
            chatId: 'global',
            senderId: 'legacy-alice',
            senderName: 'Alice Legacy',
            content: 'Chromium v2 persisted message',
            timestamp: 1700000000000,
            status: 'delivered',
          });
          tx.objectStore('contacts').put({
            identityHash: 'legacy-bob',
            firstName: 'Bob',
            lastName: 'Legacy',
            publicKey: 'bob-pub-v2',
            inviteCode: 'Ab3!-Cd4@-Ef5#-Gh6$',
            addedAt: 1700000000000,
          });
          tx.objectStore('offlineQueue').put({
            id: 'v2-browser-q-1',
            chatId: 'legacy-bob',
            senderId: 'legacy-alice',
            senderName: 'Alice Legacy',
            content: 'Chromium v2 queued note',
            timestamp: 1700000001000,
            status: 'queued',
          });
          tx.objectStore('settings').put('theme-earthy-3', 'ui_theme');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });

      // Boot StorageManager against v2 database to execute real v2 -> v3 upgrade
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const { createNewIdentity, createDefaultFamilyConfig } = await import('/src/crypto/cryptoUtils.ts');

      const sm = new StorageManager();
      await sm.init();

      const msgs = await sm.getMessages('global');
      const contacts = await sm.getContacts();
      const queued = await sm.getOfflineMessages('legacy-bob');
      const theme = await sm.getSetting('ui_theme');

      const alice = await createNewIdentity('Alice', 'Miller');
      const fam = await createDefaultFamilyConfig(alice);
      await sm.saveFamilyConfig(fam);

      // Inspect raw IDB stores & version directly via Chromium API
      const dbMeta = await new Promise((resolve, reject) => {
        const req = indexedDB.open('FamilyMeeting');
        req.onsuccess = () => {
          const db = req.result;
          const stores = Array.from(db.objectStoreNames);
          const tx = db.transaction(['messages'], 'readonly');
          const msgIndexes = Array.from(tx.objectStore('messages').indexNames);
          const version = db.version;
          db.close();
          resolve({ version, stores, msgIndexes });
        };
        req.onerror = () => reject(req.error);
      });

      return {
        msgsCount: msgs.length,
        msgContent: msgs[0]?.content,
        contactsCount: contacts.length,
        contactId: contacts[0]?.identityHash,
        queuedCount: queued.length,
        theme,
        familyId: fam.familyId,
        dbMeta,
      };
    });

    assert.equal(upgradeRes.dbMeta.version, 3);
    assert.ok(upgradeRes.dbMeta.stores.includes('familyState'));
    assert.ok(upgradeRes.dbMeta.stores.includes('rosterSnapshots'));
    assert.ok(upgradeRes.dbMeta.stores.includes('seenNonces'));
    assert.ok(upgradeRes.dbMeta.stores.includes('migrationCheckpoints'));
    assert.ok(upgradeRes.dbMeta.stores.includes('pendingAdoptions'));
    assert.ok(upgradeRes.dbMeta.msgIndexes.includes('lamportClock'));
    assert.equal(upgradeRes.msgsCount, 1);
    assert.equal(upgradeRes.msgContent, 'Chromium v2 persisted message');
    assert.equal(upgradeRes.contactsCount, 1);
    assert.equal(upgradeRes.contactId, 'legacy-bob');
    assert.equal(upgradeRes.queuedCount, 1);
    assert.equal(upgradeRes.theme, 'theme-earthy-3');

    // Full real browser reload and re-verification
    await page1.reload({ waitUntil: 'domcontentloaded' });

    const postReload1 = await page1.evaluate(async () => {
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const sm = new StorageManager();
      await sm.init();
      return {
        msgs: await sm.getMessages('global'),
        contacts: await sm.getContacts(),
        queued: await sm.getOfflineMessages('legacy-bob'),
        theme: await sm.getSetting('ui_theme'),
        activeFam: await sm.getActiveFamilyConfig(),
      };
    });

    assert.equal(postReload1.msgs.length, 1);
    assert.equal(postReload1.msgs[0].id, 'v2-browser-msg-1');
    assert.equal(postReload1.contacts[0].identityHash, 'legacy-bob');
    assert.equal(postReload1.queued[0].id, 'v2-browser-q-1');
    assert.equal(postReload1.theme, 'theme-earthy-3');
    assert.equal(postReload1.activeFam.familyId, upgradeRes.familyId);
    console.log('PASS [Browser Test 1]: Real Chromium IDB v2 -> v3 non-destructive upgrade & page.reload() persistence');

    // 2. Real Chromium Export, Wrong-Passphrase Rejection, Historical-Only Replace Import, PendingAdoption & Reload
    const exported = await page1.evaluate(async () => {
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const {
        createNewIdentity,
        createDefaultFamilyConfig,
        deriveInviteCommitment,
        signRosterSnapshotWithModeratorDevice,
      } = await import('/src/crypto/cryptoUtils.ts');

      const sm = new StorageManager();
      await sm.init();

      const clara = await createNewIdentity('Clara', 'Miller');
      const bob = await createNewIdentity('Bob', 'Miller');
      const fam = {
        ...(await createDefaultFamilyConfig(clara)),
        isUnusedDefault: false,
        authorityState: 'verified_current',
        epoch: 5,
      };
      const claraMember = {
        identityHash: clara.identityHash,
        memberId: clara.memberId,
        firstName: 'Clara',
        lastName: 'Miller',
        publicKey: clara.publicKey,
        signPublicKey: clara.signPublicKey,
        inviteCode: fam.inviteCode,
        addedAt: 1000,
        role: 'founder',
        status: 'active',
      };
      const bobMember = {
        identityHash: bob.identityHash,
        memberId: bob.memberId,
        firstName: 'Bob',
        lastName: 'Miller',
        publicKey: bob.publicKey,
        signPublicKey: bob.signPublicKey,
        inviteCode: fam.inviteCode,
        addedAt: 1000,
        role: 'moderator',
        status: 'active',
      };
      const snap = signRosterSnapshotWithModeratorDevice(
        {
          familyId: fam.familyId,
          founderId: clara.memberId,
          epoch: 5,
          prevSnapshotHash: 'prev-4',
          inviteCommitment: await deriveInviteCommitment(fam.inviteCode),
          stateHash: 'state-5',
          members: [claraMember, bobMember],
          moderators: [clara.memberId, bob.memberId],
          devices: [
            {
              deviceKeyId: clara.deviceKeyId,
              memberId: clara.memberId,
              boxPublicKey: clara.publicKey,
              deviceSignPublicKey: clara.deviceSignPublicKey,
              rsaUserId: clara.deviceKeyId,
              status: 'active',
              authorizedByModId: clara.memberId,
              authorizedAtEpoch: 1,
              addedAt: 1000,
            },
          ],
          broadcastAllowedIds: [clara.memberId],
          broadcastBlockedIds: [],
          revokedKeyIds: [],
          clockVector: { [clara.memberId]: 5 },
          signerModId: clara.memberId,
          signerDeviceKeyId: clara.deviceKeyId,
          trustState: 'verified_current',
        },
        clara
      );

      await sm.saveFamilyConfig(fam);
      await sm.setHighestVerifiedEpoch(fam.familyId, 5);
      await sm.saveRosterSnapshot(snap);
      await sm.saveContact(bobMember);
      await sm.addMessage('global', {
        id: 'browser-export-msg-1',
        chatId: 'global',
        senderId: bob.identityHash,
        senderName: 'Bob Miller',
        content: 'Real Chromium encrypted backup payload line',
        timestamp: 1700000100000,
        lamportClock: 8,
        status: 'delivered',
      });

      const archiveJson = await sm.exportMigrationBundle('BrowserPass!2026', clara);
      return {
        archiveJson,
        claraSecrets: [
          clara.secretKey,
          clara.signSecretKey,
          clara.deviceSignSecretKey,
          clara.rsaPrivateKeyPkcs8,
          fam.groupSecretKey,
        ],
        oldDeviceKeyId: clara.deviceKeyId,
        memberId: clara.memberId,
        familyId: fam.familyId,
        inviteCode: fam.inviteCode,
      };
    });

    for (const secret of exported.claraSecrets) {
      assert.ok(!exported.archiveJson.includes(secret), 'Archive leaked plaintext private key');
    }
    assert.ok(!exported.archiveJson.includes('Real Chromium encrypted backup payload line'));

    // Fresh isolated BrowserContext simulating replacement phone browser storage
    const ctx2 = await browser.newContext();
    await attachHarnessRoute(ctx2);
    const page2 = await ctx2.newPage();
    page2.on('console', (msg) => consoleMessages.push(msg.text()));
    page2.on('pageerror', (err) => pageErrors.push(err.message));

    await page2.goto(HARNESS_URL, { waitUntil: 'domcontentloaded' });

    const importRes = await page2.evaluate(async ({ archiveJson }) => {
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const sm = new StorageManager();
      await sm.init();

      let wrongPassRejected = false;
      try {
        await sm.importMigrationBundle('WrongBrowserPass', archiveJson, 'replace_device');
      } catch {
        wrongPassRejected = true;
      }

      const res = await sm.importMigrationBundle('BrowserPass!2026', archiveJson, 'replace_device');
      const activeAfterImport = await sm.getActiveFamilyConfig();
      const hasValidated = await sm.hasValidatedFamilyAuthority(activeAfterImport.familyId);
      return { wrongPassRejected, res, hasValidated };
    }, { archiveJson: exported.archiveJson });

    assert.equal(importRes.wrongPassRejected, true);
    assert.equal(importRes.hasValidated, false);
    assert.equal(importRes.res.authorityStatus, 'historical_unvalidated');
    assert.equal(importRes.res.importedContacts, 0);
    assert.equal(importRes.res.importedHistoricalContacts, 2);
    assert.notEqual(importRes.res.newDeviceKeyId, exported.oldDeviceKeyId);
    assert.equal(importRes.res.memberId, exported.memberId);
    assert.equal(importRes.res.pendingReplacementRequest.selfAuthorized, false);

    // Real Chromium reload after import: verify persisted historical quarantine + identity + messages + pendingAdoptions
    await page2.reload({ waitUntil: 'domcontentloaded' });

    const postReload2 = await page2.evaluate(async ({ familyId, expectedNewDeviceKeyId }) => {
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const {
        getSavedIdentity,
        createNewIdentity,
        createDefaultFamilyConfig,
        deriveInviteCommitment,
        signRosterSnapshotWithModeratorDevice,
        signAuthenticatedOnboardingProof,
      } = await import('/src/crypto/cryptoUtils.ts');

      const sm = new StorageManager();
      await sm.init();

      // Production identity must persist in localStorage, surviving sessionStorage loss
      const savedBeforeSessionClear = getSavedIdentity();
      const sessionIdentityBefore = sessionStorage.getItem('fm_user_identity');
      sessionStorage.clear();
      const savedIdentity = getSavedIdentity();

      const activeFam = await sm.getActiveFamilyConfig();
      const validated = await sm.hasValidatedFamilyAuthority(familyId);
      const highestVerifiedEpoch = await sm.getHighestVerifiedEpoch(familyId);
      const liveContacts = await sm.getContacts();
      const historicalContacts = await sm.getHistoricalBackupContacts(familyId);
      const latestSnap = await sm.getLatestRosterSnapshot(familyId);
      const msgs = await sm.getMessages('global');
      const pendingReq = await sm.getSetting('pending_device_replacement_request');

      // Storage-promotion test fixture (signed by a fixture moderator device; NOT live network onboarding):
      const fixtureMod = await createNewIdentity('Mod', 'Host');
      const adoptedFam = {
        ...(await createDefaultFamilyConfig(fixtureMod)),
        isUnusedDefault: false,
        epoch: 2,
      };
      const modMember = {
        identityHash: fixtureMod.identityHash,
        memberId: fixtureMod.memberId,
        firstName: 'Mod',
        lastName: 'Host',
        publicKey: fixtureMod.publicKey,
        signPublicKey: fixtureMod.signPublicKey,
        inviteCode: adoptedFam.inviteCode,
        addedAt: 1000,
        role: 'founder',
        status: 'active',
      };
      const localMember = {
        identityHash: savedIdentity.identityHash,
        memberId: savedIdentity.memberId,
        firstName: savedIdentity.firstName,
        lastName: savedIdentity.lastName,
        publicKey: savedIdentity.publicKey,
        signPublicKey: savedIdentity.signPublicKey,
        inviteCode: adoptedFam.inviteCode,
        addedAt: 1000,
        role: 'member',
        status: 'active',
      };
      const fixtureSnap = signRosterSnapshotWithModeratorDevice(
        {
          familyId: adoptedFam.familyId,
          founderId: fixtureMod.memberId,
          epoch: 2,
          prevSnapshotHash: 'prev-1',
          inviteCommitment: await deriveInviteCommitment(adoptedFam.inviteCode),
          stateHash: 'adopted-state-2',
          members: [modMember, localMember],
          moderators: [fixtureMod.memberId],
          devices: [
            {
              deviceKeyId: fixtureMod.deviceKeyId,
              memberId: fixtureMod.memberId,
              boxPublicKey: fixtureMod.publicKey,
              deviceSignPublicKey: fixtureMod.deviceSignPublicKey,
              rsaUserId: fixtureMod.deviceKeyId,
              status: 'active',
              authorizedByModId: fixtureMod.memberId,
              authorizedAtEpoch: 1,
              addedAt: 1000,
            },
            {
              deviceKeyId: savedIdentity.deviceKeyId,
              memberId: savedIdentity.memberId,
              boxPublicKey: savedIdentity.publicKey,
              deviceSignPublicKey: savedIdentity.deviceSignPublicKey,
              rsaUserId: savedIdentity.deviceKeyId,
              status: 'active',
              authorizedByModId: fixtureMod.memberId,
              authorizedAtEpoch: 2,
              addedAt: 1000,
            },
          ],
          broadcastAllowedIds: [fixtureMod.memberId],
          broadcastBlockedIds: [],
          revokedKeyIds: [],
          clockVector: { [fixtureMod.memberId]: 2 },
          signerModId: fixtureMod.memberId,
          signerDeviceKeyId: fixtureMod.deviceKeyId,
          trustState: 'verified_current',
        },
        fixtureMod
      );
      const fixtureAuthProof = signAuthenticatedOnboardingProof(
        {
          familyId: adoptedFam.familyId,
          epoch: 2,
          admittedMemberId: savedIdentity.memberId,
          admittedDeviceKeyId: savedIdentity.deviceKeyId,
          authorizingModId: fixtureMod.memberId,
          authorizingDeviceKeyId: fixtureMod.deviceKeyId,
          permanentRoomId: adoptedFam.familyRoomId,
          challengeNonce: 'browser-fixture-chal',
          authenticatedAt: Date.now(),
        },
        fixtureMod
      );

      // 1. Unauthenticated pending_permanent_auth record MUST fail promotion in real browser
      await sm.savePendingAdoption({
        adoptionId: 'adopt:browser-unauth',
        oldFamilyId: familyId,
        inviteCode: adoptedFam.inviteCode,
        newFamilyConfig: adoptedFam,
        initialSnapshot: fixtureSnap,
        initialContacts: [modMember, localMember],
        onboardingMessages: [],
        status: 'pending_permanent_auth',
        createdAt: Date.now(),
      });
      let unauthRejected = false;
      try {
        await sm.finalizePendingAdoption('adopt:browser-unauth');
      } catch {
        unauthRejected = true;
      }

      // 2. Wrong-family record MUST fail promotion in real browser
      await sm.savePendingAdoption({
        adoptionId: 'adopt:browser-wrong-family',
        oldFamilyId: familyId,
        inviteCode: adoptedFam.inviteCode,
        newFamilyConfig: adoptedFam,
        initialSnapshot: { ...fixtureSnap, familyId: 'other-wrong-fam' },
        initialContacts: [modMember],
        onboardingMessages: [],
        status: 'authenticated',
        permanentAuthProof: fixtureAuthProof,
        createdAt: Date.now(),
      });
      let wrongFamilyRejected = false;
      try {
        await sm.finalizePendingAdoption('adopt:browser-wrong-family');
      } catch {
        wrongFamilyRejected = true;
      }

      // 3. Stage valid authenticated fixture adoption for post-reload storage-promotion check
      const adoptionId = 'adopt:browser-test-1';
      await sm.savePendingAdoption({
        adoptionId,
        oldFamilyId: familyId,
        inviteCode: adoptedFam.inviteCode,
        newFamilyConfig: adoptedFam,
        initialSnapshot: fixtureSnap,
        initialContacts: [modMember, localMember],
        onboardingMessages: [
          {
            id: 'onboard-msg-1',
            chatId: 'global',
            senderId: fixtureMod.identityHash,
            senderName: 'Mod Host',
            content: 'Chromium onboarding message',
            timestamp: 1700000200000,
            lamportClock: 1,
            status: 'delivered',
          },
        ],
        status: 'authenticated',
        permanentAuthProof: fixtureAuthProof,
        createdAt: Date.now(),
      });

      return {
        sessionIdentityWasNull: sessionIdentityBefore === null,
        survivedSessionClear: Boolean(savedBeforeSessionClear && savedIdentity?.deviceKeyId === savedBeforeSessionClear.deviceKeyId),
        unauthRejected,
        wrongFamilyRejected,
        activeFam,
        validated,
        highestVerifiedEpoch,
        liveContactsCount: liveContacts.length,
        historicalContactsCount: historicalContacts.length,
        latestSnapTrustState: latestSnap?.trustState,
        msgIds: msgs.map((m) => m.id),
        pendingSelfAuthorized: pendingReq?.selfAuthorized,
        savedDeviceKeyIdMatches: savedIdentity?.deviceKeyId === expectedNewDeviceKeyId,
        adoptedFamilyId: adoptedFam.familyId,
        adoptionId,
      };
    }, { familyId: exported.familyId, expectedNewDeviceKeyId: importRes.res.newDeviceKeyId });

    assert.equal(postReload2.sessionIdentityWasNull, true);
    assert.equal(postReload2.survivedSessionClear, true);
    assert.equal(postReload2.unauthRejected, true);
    assert.equal(postReload2.wrongFamilyRejected, true);
    assert.equal(postReload2.activeFam.authorityState, 'historical_unverified');
    assert.equal(postReload2.validated, false);
    assert.equal(postReload2.highestVerifiedEpoch, 0);
    assert.equal(postReload2.liveContactsCount, 0);
    assert.equal(postReload2.historicalContactsCount, 2);
    assert.equal(postReload2.latestSnapTrustState, 'historical_unvalidated');
    assert.ok(postReload2.msgIds.includes('browser-export-msg-1'));
    assert.equal(postReload2.pendingSelfAuthorized, false);
    assert.equal(postReload2.savedDeviceKeyIdMatches, true);

    // Reload again, finalize authenticated-fixture adoption (storage-promotion test), reload again, and confirm atomic promotion
    await page2.reload({ waitUntil: 'domcontentloaded' });
    await page2.evaluate(async ({ adoptionId }) => {
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const sm = new StorageManager();
      await sm.init();
      const pending = await sm.getPendingAdoption(adoptionId);
      if (!pending) throw new Error('Pending adoption did not persist across reload');
      await sm.finalizePendingAdoption(adoptionId);
    }, { adoptionId: postReload2.adoptionId });

    await page2.reload({ waitUntil: 'domcontentloaded' });
    const postFinalizeReload = await page2.evaluate(async ({ adoptedFamilyId, adoptionId }) => {
      const { StorageManager } = await import('/src/storage/indexedDB.ts');
      const sm = new StorageManager();
      await sm.init();
      return {
        activeFam: await sm.getActiveFamilyConfig(),
        validated: await sm.hasValidatedFamilyAuthority(adoptedFamilyId),
        pendingAfter: await sm.getPendingAdoption(adoptionId),
        msgs: await sm.getMessages('global'),
      };
    }, { adoptedFamilyId: postReload2.adoptedFamilyId, adoptionId: postReload2.adoptionId });

    assert.equal(postFinalizeReload.activeFam.familyId, postReload2.adoptedFamilyId);
    assert.equal(postFinalizeReload.activeFam.authorityState, 'verified_current');
    assert.equal(postFinalizeReload.validated, true);
    assert.equal(postFinalizeReload.pendingAfter, null);
    assert.ok(postFinalizeReload.msgs.some((m) => m.id === 'onboard-msg-1' && m.isOnboardingContext === true));

    // Confirm zero private key leaks in browser console or errors
    const allOutput = [...consoleMessages, ...pageErrors].join('\n');
    for (const secret of exported.claraSecrets) {
      assert.ok(!allOutput.includes(secret), 'Console/error log exposed private key material');
    }

    console.log('PASS [Browser Test 2]: Real Chromium backup quarantine, unauth/wrong-family rejection, authenticated-fixture storage promotion & page.reload() persistence');
  } finally {
    await browser.close();
  }
}

runRealBrowserStage2Tests().catch((err) => {
  console.error('Real browser Stage 2 test failed:', err);
  process.exit(1);
});
