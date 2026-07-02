import { Client, type ConnectConfig } from 'ssh2'
import { createServer, type AddressInfo, type Server } from 'net'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ConnectionConfig } from '@shared/types'

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p
}

/** Read a private key file, with a clear error for the common mistake of
 * selecting the public (.pub) key. */
function readPrivateKey(keyPath: string): string {
  const path = expandHome(keyPath)
  const contents = readFileSync(path, 'utf8')
  if (!contents.includes('PRIVATE KEY')) {
    const hint = path.endsWith('.pub')
      ? ' — that looks like a public key; select the matching private key (without the .pub extension)'
      : ''
    throw new Error(`"${path}" does not contain a private key${hint}`)
  }
  return contents
}

export interface Tunnel {
  localHost: string
  localPort: number
  close: () => void
}

const DEFAULT_DB_PORT: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  cockroachdb: 26257,
  timescaledb: 5432,
  redshift: 5439,
  influxdb: 8086
}

/**
 * Open an SSH connection and a local TCP forward to the database host:port as
 * seen from the SSH server. The DB driver then connects to 127.0.0.1:localPort.
 *
 * `onClose` fires if the tunnel drops *after* it was established (SSH socket
 * closed, server torn down) — the manager uses it to mark the connection
 * unhealthy immediately rather than waiting for the next query to fail.
 */
export function openTunnel(
  config: ConnectionConfig,
  onClose?: (err?: Error) => void
): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const conn = new Client()
    let established = false
    const dropped = (err?: Error): void => {
      if (established) {
        established = false
        onClose?.(err)
      }
    }

    const connectCfg: ConnectConfig = {
      host: config.sshHost,
      port: config.sshPort ?? 22,
      username: config.sshUser,
      readyTimeout: 20_000,
      keepaliveInterval: 15_000
    }

    try {
      if (config.sshAuthMethod === 'password') {
        connectCfg.password = config.sshPassword
      } else if (config.sshAuthMethod === 'agent') {
        const sock = process.env.SSH_AUTH_SOCK
        if (!sock) throw new Error('SSH agent not available (SSH_AUTH_SOCK unset)')
        connectCfg.agent = sock
      } else {
        if (!config.sshKeyPath) throw new Error('No SSH private key path configured')
        connectCfg.privateKey = readPrivateKey(config.sshKeyPath)
        if (config.sshPassphrase) connectCfg.passphrase = config.sshPassphrase
      }
    } catch (err) {
      reject(err)
      return
    }

    const dbHost = config.host || '127.0.0.1'
    const dbPort = config.port ?? DEFAULT_DB_PORT[config.driver] ?? 0

    let server: Server | undefined
    const close = (): void => {
      try {
        server?.close()
      } catch {
        /* ignore */
      }
      conn.end()
    }

    conn.on('ready', () => {
      server = createServer((sock) => {
        conn.forwardOut(
          sock.remoteAddress || '127.0.0.1',
          sock.remotePort || 0,
          dbHost,
          dbPort,
          (err, stream) => {
            if (err) {
              sock.destroy()
              return
            }
            sock.pipe(stream)
            stream.pipe(sock)
            stream.on('error', () => sock.destroy())
            sock.on('error', () => stream.end())
          }
        )
      })
      server.on('error', (err) => {
        close()
        reject(err)
      })
      server.listen(0, '127.0.0.1', () => {
        const addr = server!.address() as AddressInfo
        established = true
        resolve({ localHost: '127.0.0.1', localPort: addr.port, close })
      })
    })

    // Before `ready` these reject the connect promise; after it, they signal a drop.
    conn.on('error', (err) => (established ? dropped(err) : reject(err)))
    conn.on('close', () => dropped())
    conn.connect(connectCfg)
  })
}
