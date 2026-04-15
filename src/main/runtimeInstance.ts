const BASE_TRANSFER_PORT = 37862
const MAX_INSTANCE_ID_LENGTH = 32

type RuntimeInstanceConfig = {
  instanceId: string | null
  preferredTransferPort: number
}

function readArgValue(name: string) {
  const prefix = `--${name}=`
  const exactIndex = process.argv.findIndex((arg) => arg === `--${name}`)
  if (exactIndex >= 0) {
    const nextValue = process.argv[exactIndex + 1]
    return typeof nextValue === 'string' ? nextValue : undefined
  }

  const matchedArg = process.argv.find((arg) => arg.startsWith(prefix))
  return matchedArg ? matchedArg.slice(prefix.length) : undefined
}

function normalizeInstanceId(value: string | undefined) {
  if (!value) {
    return null
  }

  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!normalized) {
    return null
  }

  return normalized.slice(0, MAX_INSTANCE_ID_LENGTH)
}

function parsePort(value: string | undefined) {
  if (!value) {
    return undefined
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid transfer port: ${value}`)
  }

  return parsed
}

function hashInstanceId(value: string) {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }

  return hash
}

function resolvePreferredTransferPort(instanceId: string | null) {
  const explicitPort =
    parsePort(process.env.P2P_TRANSFER_PORT) ??
    parsePort(readArgValue('transfer-port'))

  if (typeof explicitPort === 'number') {
    return explicitPort
  }

  if (!instanceId) {
    return BASE_TRANSFER_PORT
  }

  return BASE_TRANSFER_PORT + (hashInstanceId(instanceId) % 200)
}

const instanceId =
  normalizeInstanceId(process.env.P2P_INSTANCE_ID) ??
  normalizeInstanceId(readArgValue('instance-id'))

export const runtimeInstanceConfig: RuntimeInstanceConfig = {
  instanceId,
  preferredTransferPort: resolvePreferredTransferPort(instanceId)
}
