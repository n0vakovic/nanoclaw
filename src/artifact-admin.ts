/** Host-local credential administration. Never emits tokens unless explicitly issuing one. */
import Database from 'better-sqlite3';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { artifactConfig } from './artifact-server.js';
import { digest } from './artifact-store.js';
import { STORE_DIR } from './config.js';
const config = artifactConfig();
if (!config)
  throw new Error(
    'Enable and start artifact sharing before issuing credentials',
  );
const db = new Database(path.join(config.directory, 'artifacts.db'), {
  fileMustExist: true,
});
try {
  const [command, client, requestedJid] = process.argv.slice(2);
  let jid = requestedJid;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(client ?? ''))
    throw new Error('Client label required');
  if (command === 'issue') {
    if (!jid) {
      const messages = new Database(path.join(STORE_DIR, 'messages.db'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const owners = messages
          .prepare('SELECT jid FROM registered_groups WHERE is_main=1')
          .all() as { jid: string }[];
        if (owners.length !== 1)
          throw new Error('Specify a private main Telegram destination');
        jid = owners[0].jid;
      } finally {
        messages.close();
      }
    }
    if (!/^tg:[1-9][0-9]*$/.test(jid ?? ''))
      throw new Error('Private Telegram destination required');
    const previous = db
      .prepare('SELECT jid FROM credentials WHERE client=?')
      .get(client) as { jid: string } | undefined;
    if (previous && previous.jid !== jid)
      throw new Error('Client label already belongs to another destination');
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO credentials VALUES (?,?,?)').run(
      digest(token),
      client,
      jid,
    );
    process.stdout.write(token + '\n');
  } else if (command === 'revoke') {
    db.prepare('DELETE FROM credentials WHERE client=?').run(client);
    console.log('Client credentials revoked');
  } else
    throw new Error(
      'Usage: node dist/artifact-admin.js issue CLIENT [tg:CHAT_ID] | revoke CLIENT',
    );
} finally {
  db.close();
}
