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

  console.log(`Pairing request for number: ${num}`);

  // AlphaPair with improved connection handling
  async function AlphaPair(retryCount = 0) {
    if (retryCount > MAX_RETRIES) {
      console.error("Max retries reached for AlphaPair");
      if (!res.headersSent) return res.status(503).json({ error: "Max retries reached" });
      return;
    }

    try {
      console.log("Creating auth state...");
      const { state, saveCreds } = await useMultiFileAuthState(`./session`);
      console.log("Auth state created successfully");

      const AlphaPairWeb = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }).child({ level: "fatal" })),
        },
        printQRInTerminal: false,
        logger: pino({ level: "fatal" }).child({ level: "fatal" }),
        browser: Browsers.macOS("Safari"),
      });

      console.log("Socket created, setting up event handlers...");

      // Set up connection event handler first
      AlphaPairWeb.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log("Connection update:", connection);

        if (connection === "open") {
          console.log("Connection opened successfully");
          
          // Check if already registered
          if (AlphaPairWeb.authState?.creds?.registered) {
            console.log("Already registered, proceeding with session handling...");
            // Handle existing session...
            handleExistingSession(AlphaPairWeb, res);
          }
        } else if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          console.log("Connection closed, status code:", statusCode);
          
          if (statusCode && statusCode === 401) {
            console.error("Auth failure (401). Not retrying");
            if (!res.headersSent) return res.status(401).json({ error: "Authentication failure" });
            return;
          }

          // Retry connection
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

      // Keep creds updated
      AlphaPairWeb.ev.on("creds.update", saveCreds);

      // Check if we need pairing code (not registered)
      if (!AlphaPairWeb.authState?.creds?.registered) {
        console.log("Not registered, waiting for connection before requesting pairing code...");
        
        // Wait for connection to be established
        const waitForConnection = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Connection timeout"));
          }, 30000); // 30 second timeout

          const checkConnection = () => {
            if (AlphaPairWeb.user || AlphaPairWeb.authState?.creds?.registered) {
              clearTimeout(timeout);
              resolve();
            } else {
              setTimeout(checkConnection, 100);
            }
          };
          
          checkConnection();
        });

        try {
          // Wait a moment for socket to initialize
          await delay(2000);
          console.log("Requesting pairing code...");
          
          const code = await AlphaPairWeb.requestPairingCode(num);
          console.log("Pairing code generated:", code);
          
          if (!res.headersSent) {
            return res.status(200).json({ code: code });
          }
        } catch (err) {
          console.error("requestPairingCode failed:", err.message || err);
          if (!res.headersSent) return res.status(500).json({ error: "Failed to request pairing code: " + (err.message || err) });
        }
      }

    } catch (err) {
      console.error("AlphaPair outer error:", err);
      safePm2Restart();
      removeFileSync("./session");
      if (!res.headersSent) return res.status(503).json({ error: "Service Unavailable" });
    }
  }

  async function handleExistingSession(socket, res) {
    try {
      await delay(3000);

      const authPath = path.resolve("./session");
      const credsFile = path.join(authPath, "creds.json");

      if (!fs.existsSync(credsFile)) {
        console.error("creds.json not found after connection open");
        if (!res.headersSent) return res.status(500).json({ error: "creds.json not found" });
        return;
      }

      const user_jid = jidNormalizedUser(socket.user?.id || "");
      if (!user_jid) {
        console.error("user_jid not available");
        if (!res.headersSent) return res.status(500).json({ error: "user id not available" });
        return;
      }

      // Create a safer filename and upload
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
        if (!res.headersSent) return res.status(500).json({ error: "Failed to upload creds" });
        return;
      }

      const string_session = mega_url.replace("https://mega.nz/file/", "");
      const sid = `*ALPHA [The powerful WA BOT]*\n\n👉 ${string_session} 👈\n\n*This is your Session ID. Copy this ID and paste into config.js file.*\n\n*You can ask any question using this link:*\n\n*wa.me/message/0722737727*`;
      const mg = `🛑 Do not share this code with anyone. Keep it private. 🛑`;

      // Send messages to the user
      try {
        await socket.sendMessage(user_jid, { text: sid });
        await socket.sendMessage(user_jid, { text: string_session });
