// Discord webhook alerts — sends rich embeds to a per-server Discord
// webhook URL for the events an operator actually wants pinged about in
// real time: crashes, manual start/stop, and completed backups. This is
// deliberately narrower than the in-panel notification feed (which logs
// far more, like file renames) — Discord channels get noisy fast, so only
// the events worth an @here-style ping go out here.
//
// Each server has its own optional discordWebhookUrl + discordAlerts
// settings (configured in Server Settings), so different servers can post
// to different channels, or opt out entirely. Nothing is sent if a server
// has no webhook configured — this is fully additive to a panel that
// never sets one up.

type DiscordEvent = "server.start" | "server.stop" | "server.crash" | "backup.create";

interface DiscordAlertOptions {
  webhookUrl: string;
  event: DiscordEvent;
  serverName: string;
  detail?: string;
}

const EVENT_STYLE: Record<DiscordEvent, { title: string; color: number; emoji: string }> = {
  "server.start": { title: "Server started", color: 0x2dd4bf, emoji: "🟢" },
  "server.stop": { title: "Server stopped", color: 0x94a3b8, emoji: "⏹️" },
  "server.crash": { title: "Server crashed", color: 0xef4444, emoji: "🔴" },
  "backup.create": { title: "Backup completed", color: 0x38bdf8, emoji: "💾" },
};

/**
 * Fires a Discord webhook for a single server event. Best-effort and
 * fire-and-forget from the caller's perspective — a Discord outage or a
 * bad webhook URL should never block or fail the underlying panel action
 * (starting a server shouldn't error out because Discord is down).
 */
export async function sendDiscordAlert(opts: DiscordAlertOptions): Promise<void> {
  if (!opts.webhookUrl) return;

  // Basic shape validation so a malformed/placeholder URL fails fast and
  // quietly instead of let fetch() throw somewhere unexpected.
  let parsed: URL;
  try {
    parsed = new URL(opts.webhookUrl);
  } catch {
    return;
  }
  if (parsed.hostname !== "discord.com" && parsed.hostname !== "discordapp.com") {
    return;
  }

  const style = EVENT_STYLE[opts.event];

  try {
    const axios = (await import("axios")).default;
    await axios.post(
      opts.webhookUrl,
      {
        username: "FrostByte Panel",
        embeds: [
          {
            title: `${style.emoji} ${style.title}`,
            description: `**${opts.serverName}**${opts.detail ? `\n${opts.detail}` : ""}`,
            color: style.color,
            timestamp: new Date().toISOString(),
            footer: { text: "FrostByte Panel" },
          },
        ],
      },
      { timeout: 8000 }
    );
  } catch (err: any) {
    // Swallowed deliberately — see function comment. Logged server-side so
    // an admin debugging "my alerts stopped working" has something to go on.
    console.error(`Discord webhook failed for event ${opts.event}:`, err.message);
  }
}

/**
 * Convenience wrapper — looks up a server's configured webhook + which
 * event types it wants, and only sends if that event type is enabled.
 * Callers pass the full server object they already have in hand rather
 * than a serverId, since every call site already has it loaded.
 */
export async function notifyServerDiscord(server: any, event: DiscordEvent, detail?: string): Promise<void> {
  if (!server?.discordWebhookUrl) return;
  const enabled: string[] = Array.isArray(server.discordAlerts) ? server.discordAlerts : ["server.crash"];
  if (!enabled.includes(event)) return;

  await sendDiscordAlert({
    webhookUrl: server.discordWebhookUrl,
    event,
    serverName: server.name || "Unknown server",
    detail,
  });
}

/**
 * Sends a lightweight test message so a user configuring a webhook gets
 * immediate confirmation it's wired up correctly, instead of waiting for
 * a real server event to find out it's broken.
 */
export async function sendDiscordTestMessage(webhookUrl: string, serverName: string): Promise<{ success: boolean; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return { success: false, error: "That doesn't look like a valid URL." };
  }
  if (parsed.hostname !== "discord.com" && parsed.hostname !== "discordapp.com") {
    return { success: false, error: "Webhook URL must be a discord.com URL." };
  }

  try {
    const axios = (await import("axios")).default;
    await axios.post(
      webhookUrl,
      {
        username: "FrostByte Panel",
        embeds: [
          {
            title: "🔔 Test alert",
            description: `This is a test message from **${serverName}**'s FrostByte Panel webhook. If you can see this, alerts are wired up correctly.`,
            color: 0x5eead4,
            timestamp: new Date().toISOString(),
            footer: { text: "FrostByte Panel" },
          },
        ],
      },
      { timeout: 8000 }
    );
    return { success: true };
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 404) return { success: false, error: "Webhook not found — it may have been deleted in Discord." };
    if (status === 401 || status === 403) return { success: false, error: "Discord rejected this webhook (invalid token)." };
    return { success: false, error: "Could not reach Discord — check the URL and try again." };
  }
}
