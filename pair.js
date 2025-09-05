const express = require("express");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
let router = express.Router();
const pino = require("pino");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  delay,
  makeCacheableSignalKeyStore,
  Browsers,
  jidNormalizedUser,
} = require("@whiskeysockets/baileys");
const { upload } = require("./mega");

// PM2 process name (consistent)
const PM2_PROCESS_NAME = process.env.PM2_PROCESS_NAME || "Alpha";
const MAX_RETRIES = 5;

function removeFileSync(targetPath) {
  try {
    if (!fs.existsSync(targetPath)) return false;
    fs.rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (e) {
    console.error("removeFileSync error:", e);
    return false;
  }
}

// Helper to attempt restart via pm2 (safe wrapper)
function safePm2Restart(name = PM2_PROCESS_NAME) {
  try {
    exec(`pm2 restart ${name}`, (err, stdout, stderr) => {
      if (err) console.error(`pm2 restart error (${name}):`, err);
      else console.log(`pm2 restart ${name} ->`, stdout || stderr);
    });
  } catch (e) {
    console.error("safePm2Restart failed:", e);
  }
}

router.get("/", async (req, res) => {
  const numRaw = req.query.number;
  if (!numRaw) return res.status(400).json({ error: "Missing 'number' query parameter" });
  let num = String(numRaw).replace(/[^0-9]/g, "");
  if (!num) return res.status(400).json({ error: "Invalid phone number" });

  // AlphaPair with retry count
  async function AlphaPair(retryCount = 0) {
    if (retryCount > MAX_RETRIES) {
      console.error("Max retries reached for AlphaPair");
      if (!res.headersSent) return res.status(503).json({ error: "Max retries reached" });
      return;
    }

    try {
      const { state, saveCreds } = await useMultiFileAuthState(`./session`);

      const AlphaPairWeb = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }).child({ level: "fatal" }),
        browser: Browsers.macOS("Safari"),
      });

      // If the session is not registered, request pairing code
      if (!AlphaPairWeb.authState?.creds?.registered) {
        try {
          const code = await AlphaPairWeb.requestPairingCode(num);
          if (!res.headersSent) {
            return res.status(200).json({ pairingCode: code });
          }
        } catch (err) {
          console.error("requestPairingCode failed:", err);
          if (!res.headersSent) return res.status(500).json({ error: "Failed to request pairing code" });
        }
      }

      // keep creds updated
      AlphaPairWeb.ev.on("creds.update", saveCreds);

      AlphaPairWeb.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        console.log("connection.update ->", connection);

        if (connection === "open") {
          try {
            // small wait to ensure session files are flushed
            await delay(3000);

            const authPath = path.resolve("./session");
            const credsFile = path.join(authPath, "creds.json");

            if (!fs.existsSync(credsFile)) {
              console.error("creds.json not found after connection open");
              // respond to HTTP caller if still waiting
              if (!res.headersSent) return res.status(500).json({ error: "creds.json not found" });
              return;
            }

            const user_jid = jidNormalizedUser(AlphaPairWeb.user?.id || "");
            if (!user_jid) {
              console.error("user_jid not available");
              if (!res.headersSent) return res.status(500).json({ error: "user id not available" });
              return;
            }

            // create a safer filename and upload
            function randomMegaId(length = 6, numberLength = 4) {
              const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
              let result = "";
              for (let i = 0; i < length; i++) result += characters.charAt(Math.floor(Math.random() * characters.length));
              const number = Math.floor(Math.random() * Math.pow(10, numberLength));
              return `${result}${number}`;
            }

            let mega_url;
            try {
              mega_url = await upload(fs.createReadStream(credsFile), `${randomMegaId()}.json`);
            } catch (e) {
              console.error("Mega upload failed:", e);
              // Do not expose raw creds if upload fails; notify caller
              if (!res.headersSent) return res.status(500).json({ error: "Failed to upload creds" });
              // continue without exiting
              return;
            }

            const string_session = mega_url.replace("https://mega.nz/file/", "");

            const sid = `*ALPHA [The powerful WA BOT]*\n\n👉 ${string_session} 👈\n\n*This is your Session ID. Copy this ID and paste into config.js file.*\n\n*You can ask any question using this link:*\n\n*wa.me/message/0722737727*`;

            const mg = `🛑 Do not share this code with anyone. Keep it private. 🛑`;

            // Make sure image URL is valid (replace with your own hosted image)
            const imageUrl = process.env.SESSION_IMAGE_URL || "https://i.imgur.com/yourimage.png";

            // send messages to the user (catch errors individually)
            try {
              await AlphaPairWeb.sendMessage(user_jid, { image: { url: imageUrl }, caption: sid });
            } catch (e) {
              console.error("sendMessage(image) failed:", e);
            }

            try {
              await AlphaPairWeb.sendMessage(user_jid, { text: string_session });
            } catch (e) {
              console.error("sendMessage(text session) failed:", e);
            }

            try {
              await AlphaPairWeb.sendMessage(user_jid, { text: mg });
            } catch (e) {
              console.error("sendMessage(mg) failed:", e);
            }

            // Remove session folder (optional). If you want to keep it, comment this out.
            try {
              removeFileSync(authPath);
              console.log("Session folder removed");
            } catch (e) {
              console.error("Failed to remove session:", e);
            }

            // respond to HTTP caller if still waiting
            if (!res.headersSent) return res.status(200).json({ ok: true, sessionLink: string_session });

            // note: do NOT call process.exit in a request handler on production web servers.
            // If you want pm2 to restart, call safePm2Restart and let pm2 manage restarts.
            // safePm2Restart();
          } catch (e) {
            console.error("Error in connection.open handler:", e);
            safePm2Restart();
            removeFileSync("./session");
            if (!res.headersSent) return res.status(500).json({ error: "Internal server error" });
          }
        } else if (connection === "close") {
          // only retry on non-auth failures
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          if (statusCode && statusCode === 401) {
            console.error("Auth failure (401). Not retrying");
            if (!res.headersSent) return res.status(401).json({ error: "Authentication failure" });
            return;
          }

          // schedule a retry with backoff
          const nextRetry = retryCount + 1;
          if (nextRetry <= MAX_RETRIES) {
            const delayMs = 5000 * nextRetry;
            console.log(`Scheduling reconnect attempt #${nextRetry} in ${delayMs}ms`);
            setTimeout(() => AlphaPair(nextRetry), delayMs);
          } else {
            console.error("Exceeded max reconnect attempts");
            if (!res.headersSent) return res.status(503).json({ error: "Unable to connect after retries" });
          }
        }
      });
    } catch (err) {
      console.error("AlphaPair outer error:", err);
      // attempt safe restart and cleanup, but avoid tight recursion
      safePm2Restart();
      removeFileSync("./session");
      if (!res.headersSent) return res.status(503).json({ error: "Service Unavailable" });
    }
  }

  // start pairing process
  return AlphaPair();
});

process.on("uncaughtException", function (err) {
  console.error("Caught exception: ", err);
  safePm2Restart();
});

module.exports = router;
