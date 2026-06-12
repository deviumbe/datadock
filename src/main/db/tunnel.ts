import { Client, type ConnectConfig } from 'ssh2'
import { createServer, type AddressInfo, type Server } from 'net'
import { readFileSync } from 'fs'
import type { ConnectionConfig } from '@shared/types'

export interface Tunnel {
  localHost: string
  localPort: number
  close: () => void
}

const DEFAULT_DB_PORT: Record<string, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
  influxdb: 8086
}

/**
 * Open an SSH connection and a local TCP forward to the database host:port as
 * seen from the SSH server. The DB driver then connects to 127.0.0.1:localPort.
 */
export function openTunnel(config: ConnectionConfig): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const conn = new Client()

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
        connectCfg.privateKey = readFileSync(config.sshKeyPath)
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
        resolve({ localHost: '127.0.0.1', localPort: addr.port, close })
      })
    })

    conn.on('error', (err) => reject(err))
    conn.connect(connectCfg)
  })
}
