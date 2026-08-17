import fs from "fs-extra";
import path from "path";
import axios from "axios";
import { pipeline } from "stream/promises";

// Downloads a Minecraft server JAR straight to the host filesystem. Only
// needed by the local process engine — the Docker engine gets its JAR from
// inside the container image's own entrypoint script instead, so this file
// has no equivalent in docker.ts. Ports (with attribution in spirit, not
// code) the multi-mirror download strategy from the upstream JTG project
// this panel was originally forked from, adapted to FrostByte's fs-extra /
// axios conventions already used elsewhere (installModpack, worldManager).

const DEFAULT_HEADERS = {
  "User-Agent": "FrostByte-Panel/1.0 (+https://github.com/ProXLegend-YT/FrostByte-Panel)",
  "Accept": "*/*",
};

/**
 * Streams a candidate URL to a temp file and only accepts it if the result
 * looks like a real JAR (>500KB) — API endpoints sometimes return a JSON
 * error body with a 200 status, and this catches that case before it gets
 * treated as a valid server.jar.
 */
async function pipeDownloadToFile(url: string, tempPath: string): Promise<boolean> {
  try {
    const response = await axios({
      method: "GET",
      url,
      responseType: "stream",
      headers: DEFAULT_HEADERS,
      timeout: 60000,
      maxRedirects: 8,
    });
    if (response.status !== 200) return false;

    const writer = fs.createWriteStream(tempPath);
    await pipeline(response.data, writer);

    const stat = await fs.stat(tempPath);
    if (stat.size > 500 * 1024) return true;
    await fs.remove(tempPath).catch(() => {});
    return false;
  } catch {
    await fs.remove(tempPath).catch(() => {});
    return false;
  }
}

/**
 * Downloads the appropriate server JAR for a given Minecraft server type +
 * version to destPath, trying several official mirrors in order and
 * falling back to a known-good recent version if the exact one requested
 * can't be resolved. Throws only if every candidate fails.
 */
export const downloadJar = async (type: string, version: string, destPath: string): Promise<void> => {
  const normType = (type || "paper").toLowerCase().trim();
  let normVersion = (version || "latest").trim();
  if (normVersion === "latest" || normVersion === "" || normVersion === "default") {
    normVersion = "1.21.1";
  }

  const tempPath = `${destPath}.tmp.${Date.now()}`;
  const urls: string[] = [];

  if (normType === "bungeecord" || normType === "waterfall") {
    urls.push(
      "https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar",
      "https://hub.spigotmc.org/jenkins/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar"
    );
  } else if (normType === "velocity") {
    for (const veloVer of ["3.4.0-SNAPSHOT", "3.3.0-SNAPSHOT"]) {
      try {
        const meta = await axios.get(`https://fill.papermc.io/v3/projects/velocity/versions/${veloVer}/builds/latest`, {
          headers: DEFAULT_HEADERS,
          timeout: 8000,
        });
        const dlUrl = meta.data?.downloads?.["server:default"]?.url || meta.data?.downloads?.application?.url;
        if (dlUrl) urls.push(dlUrl);
      } catch { /* try next mirror */ }
    }
    urls.push("https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar");
  } else if (normType === "forge") {
    const forgePromoVer =
      normVersion === "1.20.1" ? "47.3.0" :
      normVersion === "1.19.2" ? "43.3.0" :
      normVersion === "1.18.2" ? "40.2.0" :
      normVersion === "1.16.5" ? "36.2.39" :
      normVersion === "1.12.2" ? "14.23.5.2860" : "latest";
    urls.push(
      `https://maven.minecraftforge.net/net/minecraftforge/forge/${normVersion}-${forgePromoVer}/forge-${normVersion}-${forgePromoVer}-installer.jar`,
      `https://maven.minecraftforge.net/net/minecraftforge/forge/${normVersion}-${forgePromoVer}/forge-${normVersion}-${forgePromoVer}-universal.jar`
    );
  } else if (normType === "fabric") {
    try {
      const metaRes = await axios.get(`https://meta.fabricmc.net/v2/versions/loader/${normVersion}`, {
        headers: DEFAULT_HEADERS,
        timeout: 10000,
      });
      const loaderVer = Array.isArray(metaRes.data) && metaRes.data[0]?.loader?.version;
      urls.push(`https://meta.fabricmc.net/v2/versions/loader/${normVersion}/${loaderVer || "0.16.10"}/1.0.1/server/jar`);
    } catch {
      urls.push(`https://meta.fabricmc.net/v2/versions/loader/${normVersion}/0.16.10/1.0.1/server/jar`);
    }
  } else if (normType === "vanilla") {
    try {
      const manifestRes = await axios.get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", {
        headers: DEFAULT_HEADERS,
        timeout: 8000,
      });
      const versionsList = manifestRes.data?.versions;
      if (Array.isArray(versionsList)) {
        const targetEntry = versionsList.find((v: any) => v.id === normVersion) || versionsList.find((v: any) => v.id === "1.21.1");
        if (targetEntry?.url) {
          const versionPackage = await axios.get(targetEntry.url, { headers: DEFAULT_HEADERS, timeout: 8000 });
          const serverUrl = versionPackage.data?.downloads?.server?.url;
          if (serverUrl) urls.push(serverUrl);
        }
      }
    } catch { /* fall through to Paper mirrors below */ }
  } else if (normType === "spigot") {
    urls.push(`https://download.getbukkit.org/spigot/spigot-${normVersion}.jar`);
  }

  // Paper (fill.papermc.io) is both the primary mirror for "paper" and the
  // catch-all fallback for any type above that failed to produce a URL —
  // a Paper jar is a safe, broadly-compatible default to try before giving up.
  try {
    const paperMeta = await axios.get(`https://fill.papermc.io/v3/projects/paper/versions/${normVersion}/builds/latest`, {
      headers: DEFAULT_HEADERS,
      timeout: 8000,
    });
    const dlUrl = paperMeta.data?.downloads?.["server:default"]?.url || paperMeta.data?.downloads?.application?.url;
    if (dlUrl) urls.push(dlUrl);
  } catch { /* try the builds-list fallback below */ }

  try {
    const buildsList = await axios.get(`https://fill.papermc.io/v3/projects/paper/versions/${normVersion}/builds`, {
      headers: DEFAULT_HEADERS,
      timeout: 8000,
    });
    if (Array.isArray(buildsList.data) && buildsList.data.length > 0) {
      const latestBuild = buildsList.data[0];
      const dlUrl = latestBuild?.downloads?.["server:default"]?.url || latestBuild?.downloads?.application?.url;
      if (dlUrl && !urls.includes(dlUrl)) urls.push(dlUrl);
    }
  } catch { /* try the hardcoded-version fallback below */ }

  if (normVersion !== "1.21.1") {
    try {
      const fallbackMeta = await axios.get("https://fill.papermc.io/v3/projects/paper/versions/1.21.1/builds/latest", {
        headers: DEFAULT_HEADERS,
        timeout: 8000,
      });
      const dlUrl = fallbackMeta.data?.downloads?.["server:default"]?.url || fallbackMeta.data?.downloads?.application?.url;
      if (dlUrl && !urls.includes(dlUrl)) urls.push(dlUrl);
    } catch { /* all mirrors exhausted, handled below */ }
  }

  let success = false;
  let lastErr = "";
  for (const candidateUrl of urls) {
    try {
      const ok = await pipeDownloadToFile(candidateUrl, tempPath);
      if (ok) {
        await fs.ensureDir(path.dirname(destPath));
        await fs.move(tempPath, destPath, { overwrite: true });
        await fs.chmod(destPath, 0o777).catch(() => {});
        success = true;
        break;
      }
    } catch (err: any) {
      lastErr = err?.message || String(err);
    }
  }

  if (!success) {
    await fs.remove(tempPath).catch(() => {});
    throw new Error(`Failed to download server JAR for ${normType} ${normVersion}. ${lastErr || "All download mirrors failed"}`);
  }
};
