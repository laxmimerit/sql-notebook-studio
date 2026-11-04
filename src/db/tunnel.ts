// SSH tunnel: forwards a local port to the database host through an SSH server.

import * as net from 'node:net';
import { readFileSync } from 'node:fs';
import { Client, type ConnectConfig } from 'ssh2';
import type { ResolvedConnection } from './types';

export interface Tunnel {
  localPort: number;
  close(): void;
}

export function openTunnel(conn: ResolvedConnection): Promise<Tunnel> {
  const ssh = conn.ssh!;
  const targetHost = conn.host || 'localhost';
  const targetPort = conn.port!;
  return new Promise((resolve, reject) => {
    const client = new Client();
    const cfg: ConnectConfig = {
      host: ssh.host,
      port: ssh.port || 22,
      username: ssh.user,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
    };
    if (ssh.auth === 'password') cfg.password = conn.secrets.sshPassword;
    else if (ssh.auth === 'key') {
      cfg.privateKey = readFileSync(ssh.keyFile!.trim());
      if (conn.secrets.sshPassphrase) cfg.passphrase = conn.secrets.sshPassphrase;
    } else {
      cfg.agent = process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK;
    }

    let settled = false;
    client.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(new Error(`SSH: ${err.message}`));
      }
    });
    client.on('ready', () => {
      const server = net.createServer((sock) => {
        client.forwardOut('127.0.0.1', 0, targetHost, targetPort, (err, stream) => {
          if (err) {
            sock.destroy();
            return;
          }
          sock.pipe(stream).pipe(sock);
          stream.on('close', () => sock.destroy());
          sock.on('close', () => stream.close());
        });
      });
      server.listen(0, '127.0.0.1', () => {
        settled = true;
        const port = (server.address() as net.AddressInfo).port;
        resolve({
          localPort: port,
          close: () => {
            server.close();
            client.end();
          },
        });
      });
    });
    client.connect(cfg);
  });
}
