/*
 * Adapted from Chitchatter (jeremyckahn/chitchatter @ a9bcd934b94bf1a0e270203851910784296dfbb2)
 * License: GPL-2.0-or-later
 * Modification: Replaced fun-animal-names fallback with deterministic Family Connection fallback
 * label while preserving Chitchatter's NameResolutionContext API.
 */
import { Peer } from 'core/models/chat'

export const getPeerName = (userId: string) => `Family-${userId.slice(0, 6)}`

export interface NameResolutionContext {
  selfUserId: string
  selfCustomUsername: string
  peers: readonly Peer[]
}

export const isPeerSelf = (
  userId: string,
  { selfUserId }: NameResolutionContext
) => selfUserId === userId

export const getCustomUsername = (
  userId: string,
  context: NameResolutionContext
): string =>
  isPeerSelf(userId, context)
    ? context.selfCustomUsername
    : (context.peers.find(peer => peer.userId === userId)?.customUsername ?? '')

export const getFriendlyName = (
  userId: string,
  context: NameResolutionContext
) => getCustomUsername(userId, context) || getPeerName(userId)

const formatDisplayName = (customUsername: string, userId: string) =>
  customUsername
    ? `${customUsername} (${getPeerName(userId)})`
    : getPeerName(userId)

export const getDisplayUsername = (
  userId: string,
  context: NameResolutionContext
) => formatDisplayName(getCustomUsername(userId, context), userId)

export const getPeerDisplayName = (peer: Peer) =>
  formatDisplayName(peer.customUsername, peer.userId)
