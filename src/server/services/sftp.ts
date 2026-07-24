import ssh2 from "ssh2";
const { Server } = ssh2;
const SSH2_STATUS = (ssh2 as any).SFTP_STATUS_CODE || {
  OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4, OP_UNSUPPORTED: 8,
};
const SSH2_OPEN_MODE = (ssh2 as any).SFTP_OPEN_MODE || {
  READ: 0x00000001, WRITE: 0x00000002, APPEND: 0x00000004, CREAT: 0x00000008,
  TRUNC: 0x00000010, EXCL: 0x00000020,
};
import crypto from "crypto";
import fs from "fs-extra";
import path from "path";
import bcrypt from "bcrypt";
import { readJSON, writeJSON } from "./db.js";

/**
 * Returns true only if `target` is exactly `base` or a genuine descendant of
 * it. Mirrors the same guard used by the HTTP file manager controller —
 * guards against prefix-matching bypasses (base ".../abc" incorrectly
 * matching target ".../abc-evil").
 */
function isWithinBase(target: string, base: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedBase || resolvedTarget.startsWith(resolvedBase + path.sep);
}

/**
 * Resolves a client-supplied SFTP path (always POSIX-style, relative to the
 * virtual root "/") to a real filesystem path inside baseDir. Returns null
 * if the resolved path would escape baseDir.
 */
function resolveVirtualPath(baseDir: string, sftpPath: string): string | null {
  const normalized = sftpPath.startsWith("/") ? sftpPath : "/" + sftpPath;
  const real = path.join(baseDir, path.normalize(normalized));
  if (!isWithinBase(real, baseDir)) return null;
  return real;
}

function toVirtualPath(baseDir: string, realPath: string): string {
  const rel = path.relative(baseDir, realPath).split(path.sep).join("/");
  return "/" + rel;
}

function statsToAttrs(stats: fs.Stats) {
  return {
    mode: stats.mode,
    uid: stats.uid || 0,
    gid: stats.gid || 0,
    size: stats.size,
    atime: Math.floor(stats.atimeMs / 1000),
    mtime: Math.floor(stats.mtimeMs / 1000),
  };
}

/**
 * Binds real SFTP protocol handlers to an sftpStream, backed by the real
 * filesystem, chrooted to baseDir. Every path from the client is resolved
 * and bounds-checked before touching disk.
 */
function bindSftpHandlers(sftpStream: any, baseDir: string) {
  // Open file handles, keyed by a random handle buffer we hand back to the client.
  const openFiles = new Map<string, { fd: number; flags: number; realPath: string }>();
  // Open directory handles, keyed similarly — holds the (already-read) entry list and a cursor.
  const openDirs = new Map<string, { entries: fs.Dirent[]; realDir: string; offset: number }>();

  const newHandleId = () => crypto.randomBytes(8).toString("hex");
  const handleBuffer = (id: string) => Buffer.from(id);
  const handleId = (handle: Buffer) => handle.toString();

  const reject = (reqid: number, code: number = SSH2_STATUS.FAILURE) => sftpStream.status(reqid, code);
  const ok = (reqid: number) => sftpStream.status(reqid, SSH2_STATUS.OK);

  const sftpFlagsToNodeFlags = (flags: number): string => {
    const O = SSH2_OPEN_MODE;
    if (flags & O.APPEND) return (flags & O.CREAT) ? "a+" : "a";
    if ((flags & O.WRITE) && (flags & O.READ)) {
      if (flags & O.EXCL) return "wx+";
      if (flags & O.TRUNC) return "w+";
      if (flags & O.CREAT) return "a+"; // create-if-missing, don't truncate, allow read+write
      return "r+";
    }
    if (flags & O.WRITE) {
      if (flags & O.EXCL) return "wx";
      if (flags & O.TRUNC || flags & O.CREAT) return "w";
      return "r+";
    }
    return "r";
  };

  sftpStream.on("OPEN", async (reqid: number, filename: string, flags: number) => {
    try {
      const realPath = resolveVirtualPath(baseDir, filename);
      if (!realPath) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);

      const nodeFlags = sftpFlagsToNodeFlags(flags);
      await fs.ensureDir(path.dirname(realPath));
      const fd = await new Promise<number>((resolve, rej) => {
        fs.open(realPath, nodeFlags, 0o644, (err, fd) => (err ? rej(err) : resolve(fd)));
      });

      const id = newHandleId();
      openFiles.set(id, { fd, flags, realPath });
      sftpStream.handle(reqid, handleBuffer(id));
    } catch (err: any) {
      reject(reqid, err.code === "ENOENT" ? SSH2_STATUS.NO_SUCH_FILE : SSH2_STATUS.FAILURE);
    }
  });

  sftpStream.on("READ", async (reqid: number, handle: Buffer, offset: number, length: number) => {
    const entry = openFiles.get(handleId(handle));
    if (!entry) return reject(reqid);
    try {
      const buffer = Buffer.alloc(length);
      const bytesRead = await new Promise<number>((resolve, rej) => {
        fs.read(entry.fd, buffer, 0, length, offset, (err, n) => (err ? rej(err) : resolve(n)));
      });
      if (bytesRead === 0) return reject(reqid, SSH2_STATUS.EOF);
      sftpStream.data(reqid, buffer.slice(0, bytesRead));
    } catch {
      reject(reqid);
    }
  });

  sftpStream.on("WRITE", async (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
    const entry = openFiles.get(handleId(handle));
    if (!entry) return reject(reqid);
    try {
      await new Promise<void>((resolve, rej) => {
        fs.write(entry.fd, data, 0, data.length, offset, (err) => (err ? rej(err) : resolve()));
      });
      ok(reqid);
    } catch {
      reject(reqid);
    }
  });

  sftpStream.on("CLOSE", async (reqid: number, handle: Buffer) => {
    const id = handleId(handle);
    const fileEntry = openFiles.get(id);
    if (fileEntry) {
      openFiles.delete(id);
      fs.close(fileEntry.fd, () => {});
      return ok(reqid);
    }
    if (openDirs.has(id)) {
      openDirs.delete(id);
      return ok(reqid);
    }
    reject(reqid);
  });

  sftpStream.on("OPENDIR", async (reqid: number, dirPath: string) => {
    try {
      const realDir = resolveVirtualPath(baseDir, dirPath);
      if (!realDir) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);

      const entries = await fs.readdir(realDir, { withFileTypes: true });
      const id = newHandleId();
      openDirs.set(id, { entries, realDir, offset: 0 });
      sftpStream.handle(reqid, handleBuffer(id));
    } catch (err: any) {
      reject(reqid, err.code === "ENOENT" ? SSH2_STATUS.NO_SUCH_FILE : SSH2_STATUS.FAILURE);
    }
  });

  sftpStream.on("READDIR", async (reqid: number, handle: Buffer) => {
    const dir = openDirs.get(handleId(handle));
    if (!dir) return reject(reqid);

    if (dir.offset >= dir.entries.length) {
      return reject(reqid, SSH2_STATUS.EOF);
    }

    const batch = dir.entries.slice(dir.offset, dir.offset + 100);
    dir.offset += batch.length;

    try {
      const names = await Promise.all(batch.map(async (entry) => {
        const entryRealPath = path.join(dir.realDir, entry.name);
        let stats: fs.Stats;
        try {
          stats = await fs.stat(entryRealPath);
        } catch {
          stats = await fs.lstat(entryRealPath);
        }
        return {
          filename: entry.name,
          longname: `${stats.isDirectory() ? "d" : "-"}rw-r--r-- 1 owner owner ${stats.size} ${entry.name}`,
          attrs: statsToAttrs(stats),
        };
      }));
      sftpStream.name(reqid, names);
    } catch {
      reject(reqid);
    }
  });

  sftpStream.on("REALPATH", (reqid: number, requestedPath: string) => {
    const realPath = resolveVirtualPath(baseDir, requestedPath);
    if (!realPath) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);
    const virtualPath = toVirtualPath(baseDir, realPath) || "/";
    sftpStream.name(reqid, [{ filename: virtualPath, longname: virtualPath, attrs: {} }]);
  });

  const handleStat = (followSymlinks: boolean) => async (reqid: number, requestedPath: string) => {
    try {
      const realPath = resolveVirtualPath(baseDir, requestedPath);
      if (!realPath) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);
      const stats = followSymlinks ? await fs.stat(realPath) : await fs.lstat(realPath);
      sftpStream.attrs(reqid, statsToAttrs(stats));
    } catch (err: any) {
      reject(reqid, err.code === "ENOENT" ? SSH2_STATUS.NO_SUCH_FILE : SSH2_STATUS.FAILURE);
    }
  };
  sftpStream.on("STAT", handleStat(true));
  sftpStream.on("LSTAT", handleStat(false));

  sftpStream.on("FSTAT", async (reqid: number, handle: Buffer) => {
    const entry = openFiles.get(handleId(handle));
    if (!entry) return reject(reqid);
    try {
      const stats = await fs.fstat(entry.fd);
      sftpStream.attrs(reqid, statsToAttrs(stats));
    } catch {
      reject(reqid);
    }
  });

  sftpStream.on("SETSTAT", async (reqid: number, requestedPath: string, attrs: any) => {
    try {
      const realPath = resolveVirtualPath(baseDir, requestedPath);
      if (!realPath) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);
      if (attrs.mode !== undefined) await fs.chmod(realPath, attrs.mode);
      if (attrs.atime !== undefined && attrs.mtime !== undefined) {
        await fs.utimes(realPath, attrs.atime, attrs.mtime);
      }
      ok(reqid);
    } catch {
      reject(reqid);
    }
  });

  sftpStream.on("REMOVE", async (reqid: number, requestedPath: string) => {
    try {
      const realPath = resolveVirtualPath(baseDir, requestedPath);
      if (!realPath) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);
      await fs.unlink(realPath);
      ok(reqid);
    } catch (err: any) {
      reject(reqid, err.code === "ENOENT" ? SSH2_STATUS.NO_SUCH_FILE : SSH2_STATUS.FAILURE);
    }
  });

  sftpStream.on("RMDIR", async (reqid: number, requestedPath: string) => {
    try {
      const realPath = resolveVirtualPath(baseDir, requestedPath);
      if (!realPath) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);
      await fs.rmdir(realPath);
      ok(reqid);
    } catch (err: any) {
      reject(reqid, err.code === "ENOENT" ? SSH2_STATUS.NO_SUCH_FILE : SSH2_STATUS.FAILURE);
    }
  });

  sftpStream.on("MKDIR", async (reqid: number, requestedPath: string) => {
    try {
      const realPath = resolveVirtualPath(baseDir, requestedPath);
      if (!realPath) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);
      await fs.mkdir(realPath, { recursive: true });
      ok(reqid);
    } catch {
      reject(reqid);
    }
  });

  sftpStream.on("RENAME", async (reqid: number, oldPath: string, newPath: string) => {
    try {
      const realOld = resolveVirtualPath(baseDir, oldPath);
      const realNew = resolveVirtualPath(baseDir, newPath);
      if (!realOld || !realNew) return reject(reqid, SSH2_STATUS.PERMISSION_DENIED);
      await fs.move(realOld, realNew, { overwrite: false });
      ok(reqid);
    } catch (err: any) {
      reject(reqid, err.code === "ENOENT" ? SSH2_STATUS.NO_SUCH_FILE : SSH2_STATUS.FAILURE);
    }
  });

  sftpStream.on("SYMLINK", async (reqid: number, linkPath: string, targetPath: string) => {
    // Symlinks inside a chrooted server directory create an easy escape
    // vector (a link can point anywhere on the host filesystem), so this
    // operation is intentionally not supported.
    reject(reqid, SSH2_STATUS.OP_UNSUPPORTED);
  });

  sftpStream.on("READLINK", async (reqid: number) => {
    reject(reqid, SSH2_STATUS.OP_UNSUPPORTED);
  });

  // Guard against leaked file descriptors if the client disconnects without
  // sending CLOSE for every handle it opened (network drop, crash, etc.).
  const cleanupAllHandles = () => {
    for (const [, entry] of openFiles) {
      fs.close(entry.fd, () => {});
    }
    openFiles.clear();
    openDirs.clear();
  };
  sftpStream.on("close", cleanupAllHandles);
  sftpStream.on("error", cleanupAllHandles);
}

const SFTP_PORT = 6868;
const HOST_KEYS_DIR = path.join(process.cwd(), ".data", "ssh");
const SFTP_DB_FILE = "sftp_users.json";

// Initialize SSH keys and DB
export async function initSFTPServer() {
  await fs.ensureDir(HOST_KEYS_DIR);
  
  let hostKeyPath = path.join(HOST_KEYS_DIR, "host_rsa");
  if (!fs.existsSync(hostKeyPath)) {
    const { privateKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
    });
    fs.writeFileSync(hostKeyPath, privateKey);
  }

  if (!fs.existsSync(path.join(process.cwd(), ".data", SFTP_DB_FILE))) {
    await writeJSON(SFTP_DB_FILE, []);
  }

  const hostKey = fs.readFileSync(hostKeyPath);

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    let sftpUser: any = null;

    client.on("authentication", async (ctx) => {
      try {
        if (ctx.method !== "password") {
          return ctx.reject();
        }

        const users = await readJSON(SFTP_DB_FILE) || [];
        const user = users.find((u: any) => u.username === ctx.username);

        if (!user) {
          return ctx.reject();
        }

        const match = await bcrypt.compare(ctx.password, user.passwordHash);
        if (match) {
          sftpUser = user;
          ctx.accept();
        } else {
          ctx.reject();
        }
      } catch (err) {
        console.error("SFTP auth error:", err);
        ctx.reject();
      }
    });

    client.on("ready", () => {
      client.on("session", (accept, reject) => {
        const session = accept();
        session.on("sftp", (accept, reject) => {
          if (!sftpUser) {
            return reject();
          }

          const sftpStream = accept();
          const baseDir = path.join(process.cwd(), ".data", "servers", sftpUser.serverId);
          fs.ensureDirSync(baseDir);

          console.log("SFTP session started for user", sftpUser.username);
          bindSftpHandlers(sftpStream, baseDir);
        });
      });
    });
    
    client.on("error", (err) => {
      // Ignore client connection errors like disconnects
    });
  });

  server.listen(SFTP_PORT, "0.0.0.0", () => {
    console.log(`SFTP server listening on port ${SFTP_PORT}`);
  });
}

export async function createSftpUser(serverId: string) {
  const users = await readJSON(SFTP_DB_FILE) || [];
  
  if (users.find((u: any) => u.serverId === serverId)) {
    throw new Error("SFTP user already exists for this server");
  }

  const username = "srv_" + crypto.randomBytes(3).toString("hex");
  const password = crypto.randomBytes(8).toString("hex") + "!";
  const passwordHash = await bcrypt.hash(password, 10);

  const newUser = {
    id: crypto.randomUUID(),
    serverId,
    username,
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  users.push(newUser);
  await writeJSON(SFTP_DB_FILE, users);

  return { username, password };
}

export async function resetSftpPassword(serverId: string) {
  const users = await readJSON(SFTP_DB_FILE) || [];
  const userIndex = users.findIndex((u: any) => u.serverId === serverId);
  
  if (userIndex === -1) {
    throw new Error("SFTP user not found");
  }

  const password = crypto.randomBytes(8).toString("hex") + "!";
  users[userIndex].passwordHash = await bcrypt.hash(password, 10);
  users[userIndex].updatedAt = new Date().toISOString();

  await writeJSON(SFTP_DB_FILE, users);

  return { username: users[userIndex].username, password };
}

export async function getSftpUser(serverId: string) {
  const users = await readJSON(SFTP_DB_FILE) || [];
  return users.find((u: any) => u.serverId === serverId);
}

export async function deleteSftpUser(serverId: string) {
  const users = await readJSON(SFTP_DB_FILE) || [];
  const filtered = users.filter((u: any) => u.serverId !== serverId);
  await writeJSON(SFTP_DB_FILE, filtered);
}
