import fs from "fs-extra";
import path from "path";

const DATA_DIR = path.join(process.cwd(), ".data");

export const readJSON = async (filename: string) => {
  const filePath = path.join(DATA_DIR, filename);
  try {
    return await fs.readJson(filePath);
  } catch (err) {
    return null;
  }
};

export const writeJSON = async (filename: string, data: any) => {
  const filePath = path.join(DATA_DIR, filename);
  await fs.writeJson(filePath, data, { spaces: 2 });
};

// Serializes writes per-file so concurrent read-modify-write sequences (e.g.
// two requests appending to the same log at once) can't race and silently
// drop one of the writes. Each call chains onto the previous promise for
// that filename.
const writeQueues = new Map<string, Promise<any>>();

/**
 * Atomically reads a JSON file, applies `mutator` to it, and writes the
 * result back — with all callers for the same filename serialized so
 * concurrent appends/updates can't clobber each other.
 */
export const updateJSON = async <T = any>(filename: string, mutator: (current: T) => T | Promise<T>): Promise<T> => {
  const prior = writeQueues.get(filename) || Promise.resolve();
  const task = prior
    .catch(() => {}) // don't let a previous failure block this write
    .then(async () => {
      const current = (await readJSON(filename)) as T;
      const updated = await mutator(current);
      await writeJSON(filename, updated);
      return updated;
    });
  writeQueues.set(filename, task);
  return task;
};
