/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FileHandle } from 'core/chat/fileOffers';
import { FileTransferAdapter } from 'core/adapters/types';
import type { FileTransferService } from 'services/FileTransfer';
import { rtcConfig as defaultRtcConfig } from 'config/rtcConfig';

export interface WebFileTransferAdapterOptions {
  rtcConfig?: RTCConfiguration;
  disableWebTorrent?: boolean;
}

/**
 * Chitchatter FileTransferAdapter wrapping upstream FileTransferService (`secure-file-transfer`).
 * Uses lazy initialization and dynamic import so headless Node tests or non-media sessions
 * do not evaluate browser-only streamsaver/WebTorrent globals prematurely.
 */
export function createWebFileTransferAdapter(
  options: WebFileTransferAdapterOptions = {}
): FileTransferAdapter {
  let service: FileTransferService | null = null;
  const activeOffers = new Set<string>();
  const originatedMagnets = new Set<string>();
  const inlineMediaMagnets = new Set<string>();

  const getService = async (): Promise<FileTransferService> => {
    if (options.disableWebTorrent || typeof document === 'undefined') {
      throw new Error('FileTransfer disabled in current environment');
    }
    if (!service) {
      const { FileTransferService: Svc } = await import(
        'services/FileTransfer'
      );
      service = new Svc(options.rtcConfig || defaultRtcConfig);
    }
    return service;
  };

  return {
    offer: async (
      files: readonly FileHandle[],
      fileKey: string
    ): Promise<string> => {
      const svc = await getService();
      const magnetURI = await svc.fileTransfer.offer(
        files as File[],
        fileKey
      );
      activeOffers.add(magnetURI);
      originatedMagnets.add(magnetURI);
      return magnetURI;
    },
    rescind: async (magnetURI: string): Promise<void> => {
      activeOffers.delete(magnetURI);
      inlineMediaMagnets.delete(magnetURI);
      if (service) {
        await service.fileTransfer.rescind(magnetURI);
      }
    },
    rescindAll: async (): Promise<void> => {
      const toRescind = [...activeOffers];
      activeOffers.clear();
      inlineMediaMagnets.clear();
      if (service) {
        await Promise.all(
          toRescind.map((uri) => service!.fileTransfer.rescind(uri))
        );
      }
    },
    isOffering: (magnetURI: string): boolean => activeOffers.has(magnetURI),
    isOriginated: (magnetURI: string): boolean =>
      originatedMagnets.has(magnetURI),
    trackInlineMedia: (magnetURI: string): void => {
      inlineMediaMagnets.add(magnetURI);
    },
    untrackInlineMedia: (magnetURI: string): void => {
      inlineMediaMagnets.delete(magnetURI);
    },
    isInlineMedia: (magnetURI: string): boolean =>
      inlineMediaMagnets.has(magnetURI),
  };
}
