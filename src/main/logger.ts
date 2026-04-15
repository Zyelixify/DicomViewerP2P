const isDevEnvironment = !process.env.NODE_ENV || process.env.NODE_ENV !== 'production'

function write(method: 'debug' | 'warn' | 'error', message: string, error?: unknown) {
  if (!isDevEnvironment) {
    return
  }

  if (typeof error === 'undefined') {
    console[method](message)
    return
  }

  console[method](message, error)
}

export const devLogger = {
  debug(message: string, error?: unknown) {
    write('debug', message, error)
  },
  warn(message: string, error?: unknown) {
    write('warn', message, error)
  },
  error(message: string, error?: unknown) {
    write('error', message, error)
  }
}
