function write(method: 'debug' | 'warn' | 'error', message: string, error?: unknown) {
  if (!import.meta.env.DEV) {
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
