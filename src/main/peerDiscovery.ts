import dgram from 'node:dgram'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { PeerDiscoveryState, DiscoveredPeer } from '../shared/types'
import { devLogger } from './logger'

const DISCOVERY_PORT = 37861
const ANNOUNCE_INTERVAL_MS = 2500
const STALE_PEER_MS = 10000
const PROTOCOL = 'p2p-dicom-viewer-presence'

type PresenceMessage = {
  protocol: string
  peerId: string
  displayName: string
  transferPort: number
}

const localPeerId = randomUUID()
let displayName = os.hostname()
let transferPort = 37862

let socket: dgram.Socket | null = null
let announceTimer: NodeJS.Timeout | null = null
let pruneTimer: NodeJS.Timeout | null = null
const peers = new Map<string, DiscoveredPeer>()

function ipv4ToInt(ipv4: string) {
  const parts = ipv4.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null
  }

  return (((parts[0] << 24) >>> 0) | ((parts[1] << 16) >>> 0) | ((parts[2] << 8) >>> 0) | (parts[3] >>> 0)) >>> 0
}

function intToIpv4(value: number) {
  return `${(value >>> 24) & 255}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`
}

function getBroadcastTargets() {
  const targets = new Set<string>(['255.255.255.255'])
  const interfaces = os.networkInterfaces()

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) {
        continue
      }

      const addressInt = ipv4ToInt(entry.address)
      const netmaskInt = ipv4ToInt(entry.netmask)
      if (addressInt === null || netmaskInt === null) {
        continue
      }

      const broadcastInt = (addressInt & netmaskInt) | (~netmaskInt >>> 0)
      targets.add(intToIpv4(broadcastInt >>> 0))
    }
  }

  return [...targets.values()]
}

function buildState(): PeerDiscoveryState {
  return {
    isRunning: Boolean(socket),
    localPeerId,
    displayName,
    port: DISCOVERY_PORT,
    transferPort,
    peers: [...peers.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt)
  }
}

function pruneStalePeers() {
  const now = Date.now()
  for (const [peerId, peer] of peers.entries()) {
    if (now - peer.lastSeenAt > STALE_PEER_MS) {
      peers.delete(peerId)
    }
  }
}

function toPresenceMessage(): string {
  const payload: PresenceMessage = {
    protocol: PROTOCOL,
    peerId: localPeerId,
    displayName,
    transferPort
  }

  return JSON.stringify(payload)
}

function announcePresence() {
  if (!socket) {
    return
  }

  const payload = Buffer.from(toPresenceMessage())
  for (const target of getBroadcastTargets()) {
    socket.send(payload, DISCOVERY_PORT, target)
  }
}

function handleMessage(raw: Buffer, remoteAddress: string) {
  let payload: PresenceMessage

  try {
    payload = JSON.parse(raw.toString('utf8')) as PresenceMessage
  } catch (error) {
    devLogger.debug('[peerDiscovery] Failed to parse presence message', error)
    return
  }

  if (payload.protocol !== PROTOCOL || payload.peerId === localPeerId) {
    return
  }

  peers.set(payload.peerId, {
    peerId: payload.peerId,
    displayName: payload.displayName || 'Unknown peer',
    address: remoteAddress,
    transferPort:
      typeof payload.transferPort === 'number' && Number.isInteger(payload.transferPort) && payload.transferPort > 0
        ? payload.transferPort
        : 37862,
    lastSeenAt: Date.now()
  })
}

export function configurePeerDiscovery(options: { displayNameSuffix?: string; transferPort?: number }) {
  const displayNameSuffix = options.displayNameSuffix?.trim()
  displayName = `${os.hostname()}${displayNameSuffix ? displayNameSuffix : ''}`
  if (typeof options.transferPort === 'number' && Number.isInteger(options.transferPort) && options.transferPort > 0) {
    transferPort = options.transferPort
  }
}

export async function startPeerDiscovery() {
  if (socket) {
    return buildState()
  }

  peers.clear()

  const nextSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true })

  await new Promise<void>((resolve, reject) => {
    nextSocket.once('error', reject)
    nextSocket.bind(DISCOVERY_PORT, () => {
      nextSocket.off('error', reject)
      resolve()
    })
  })

  nextSocket.on('message', (buffer, remoteInfo) => {
    handleMessage(buffer, remoteInfo.address)
  })

  nextSocket.on('error', (error) => {
    devLogger.debug('[peerDiscovery] UDP socket error', error)
  })

  nextSocket.setBroadcast(true)
  socket = nextSocket

  announcePresence()

  announceTimer = setInterval(() => {
    announcePresence()
  }, ANNOUNCE_INTERVAL_MS)

  pruneTimer = setInterval(() => {
    pruneStalePeers()
  }, ANNOUNCE_INTERVAL_MS)

  return buildState()
}

export async function stopPeerDiscovery() {
  if (!socket) {
    return buildState()
  }

  if (announceTimer) {
    clearInterval(announceTimer)
    announceTimer = null
  }

  if (pruneTimer) {
    clearInterval(pruneTimer)
    pruneTimer = null
  }

  const socketToClose = socket
  socket = null

  await new Promise<void>((resolve) => {
    socketToClose.close(() => resolve())
  })

  peers.clear()
  return buildState()
}

export function getPeerDiscoveryState() {
  pruneStalePeers()
  return buildState()
}
