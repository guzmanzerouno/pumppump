import axios from "axios";
import WebSocket from "ws";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { Connection } from "@solana/web3.js";
import { Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { DateTime } from "luxon";
import bs58 from "bs58";

// 🔹 Configuración
const TELEGRAM_BOT_TOKEN = "8167837961:AAFipBvWbQtFWHV_uZt1lmG4CVVnc_z8qJU";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const USERS_FILE = "users.json";
const RUGCHECK_API_BASE = "https://api.rugcheck.xyz/v1/tokens";
const connection = new Connection("https://ros-5f117e-fast-mainnet.helius-rpc.com", "confirmed");

const INSTANTNODES_WS_URL = "wss://solana-api.instantnodes.io/token-hL8J457Dhvr7qc4c1GJ91VtxVaFnHzzW";
const MIGRATION_PROGRAM_ID = "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg";
const JUPITER_API_URL = "https://quote-api.jup.ag/v6/swap";
const LOG_FILE = "transactions.log";
const SWAPS_FILE = "swaps.json";
const buyReferenceMap = {};
const refreshingTokens = {};
const refreshIntervals = {};
global.ADMIN_CHAT_ID = global.ADMIN_CHAT_ID || 472101348;

let ws;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// ==========================================
// VARIABLE GLOBAL PARA AUTO CREACIÓN DE ATA
// (Por defecto DESACTIVADA)
// ==========================================
let ataAutoCreationEnabled = false;

// Comando para activar/desactivar el auto-creado de ATA
bot.onText(/\/ata (on|off)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const command = match[1].toLowerCase();

  if (command === 'on') {
    ataAutoCreationEnabled = true;
    bot.sendMessage(chatId, "✅ Auto creation of ATAs is now ENABLED.");
  } else if (command === 'off') {
    ataAutoCreationEnabled = false;
    bot.sendMessage(chatId, "❌ Auto creation of ATAs is now DISABLED.");
  }
});

// 🔥 Cargar usuarios desde el archivo JSON
function loadUsers() {
    if (fs.existsSync(USERS_FILE)) {
        try {
            const data = fs.readFileSync(USERS_FILE, "utf8");
            users = JSON.parse(data);
            console.log(`✅ ${Object.keys(users).length} usuarios cargados.`);
        } catch (error) {
            console.error("❌ Error cargando usuarios:", error);
        }
    }
}

// 📁 Cargar usuarios y referidos
let users = JSON.parse(fs.readFileSync("users.json"));

function saveUsers() {
  fs.writeFileSync("users.json", JSON.stringify(users, null, 2));
}

function isUserActive(user) {
  const active = user.expired === "never" || Date.now() < user.expired;
  user.subscribed = active;
  saveUsers();
  return active;
}

function showPaymentButtons(chatId) {
  return bot.sendPhoto(chatId, "https://cdn.shopify.com/s/files/1/0784/6966/0954/files/pumppay.jpg?v=1743797016", {
    caption: "💳 Please select a subscription plan:",
    reply_markup: {
      inline_keyboard: [
        [{ text: "1 Day - 0.05 SOL", callback_data: "pay_1d" }],
        [{ text: "15 Days - 0.60 SOL", callback_data: "pay_15d" }],
        [{ text: "1 Month - 1.10 SOL", callback_data: "pay_month" }],
        [{ text: "6 Months - 6.00 SOL", callback_data: "pay_6m" }],
        [{ text: "1 Year - 11.00 SOL", callback_data: "pay_year" }]
      ]
    }
  });
}

async function activateMembership(chatId, days, solAmount) {
  const user = users[chatId];
  const now = Date.now();
  const expiration = now + days * 24 * 60 * 60 * 1000;

  const sender = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
  const receiver = new PublicKey("8VCEaTpyg12kYHAH1oEAuWm7EHQ62e147UPrJzRZZeps");

  const connection = new Connection("https://ros-5f117e-fast-mainnet.helius-rpc.com", "confirmed");

  // ✅ Verificamos fondos suficientes
  const balance = await connection.getBalance(sender.publicKey);
  if (balance < solAmount * 1e9) {
    return bot.sendMessage(chatId, `❌ *Insufficient funds.*\nYour wallet has ${(balance / 1e9).toFixed(4)} SOL but needs ${solAmount} SOL.`, {
      parse_mode: "Markdown"
    });
  }

  // ✅ Mostramos "Processing Payment..."
  const processingMsg = await bot.sendMessage(chatId, "🕐 *Processing your payment...*", {
    parse_mode: "Markdown"
  });

  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: sender.publicKey,
        toPubkey: receiver,
        lamports: solAmount * 1e9
      })
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [sender]);

user.expired = expiration;
user.subscribed = true;
saveUsers();
savePaymentRecord(chatId, sig, days, solAmount);

const expirationDate = new Date(expiration).toLocaleDateString();
const now = Date.now();
const statusLine = expiration === "never"
  ? "✅ Unlimited"
  : `✅ Active for ${Math.round((expiration - now) / (1000 * 60 * 60 * 24))} day(s)`;

// ✅ Texto final unificado para el caption del mensaje con imagen
const fullConfirmation = `✅ *User Registered!*
👤 *Name:* ${user.name}
📱 *Phone:* ${user.phone}
📧 *Email:* ${user.email}
💼 *Wallet:* \`${user.walletPublicKey}\`
🔐 *Referral:* ${user.rcode || "None"}
⏳ *Status:* ${statusLine}`;

// ✅ Editamos el mensaje anterior con una imagen + caption
await bot.editMessageMedia(
  {
    type: "photo",
    media: "https://cdn.shopify.com/s/files/1/0784/6966/0954/files/pumppay.jpg?v=1743797016",
    caption: fullConfirmation,
    parse_mode: "Markdown"
  },
  {
    chat_id: chatId,
    message_id: processingMsg.message_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: "⚙️ Settings", callback_data: "settings_menu" }],
        [{ text: "📘 How to Use the Bot", url: "https://pumpultra.fun/docs" }]
      ]
    }
  }
);

// ✅ Eliminar mensaje de botones de pago anterior si existe
if (user.lastPaymentMsgId) {
  try {
    await bot.deleteMessage(chatId, user.lastPaymentMsgId);
    user.lastPaymentMsgId = null;
    saveUsers();
  } catch (err) {
    console.error("⚠️ No se pudo borrar el mensaje de pago:", err.message);
  }
}

// ✅ Notificación al admin
const adminMsg = `✅ *Payment received successfully!*
👤 *User:* ${user.name || "Unknown"}
💼 *Wallet:* \`${user.walletPublicKey}\`
💳 *Paid:* ${solAmount} SOL for ${days} days
🗓️ *Expires:* ${expirationDate}
🔗 [View Tx](https://solscan.io/tx/${sig})`;

bot.sendMessage(ADMIN_CHAT_ID, adminMsg, {
  parse_mode: "Markdown",
  disable_web_page_preview: true
});

  } catch (err) {
    bot.editMessageText(`❌ Transaction failed: ${err.message}`, {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });
  }
}

function savePaymentRecord(chatId, txId, days, solAmount) {
  const paymentsFile = "payments.json";
  let records = [];

  if (fs.existsSync(paymentsFile)) {
    records = JSON.parse(fs.readFileSync(paymentsFile));
  }

  records.push({
    chatId,
    wallet: users[chatId].walletPublicKey,
    tx: txId,
    amountSol: solAmount,
    days,
    timestamp: Date.now()
  });

  fs.writeFileSync(paymentsFile, JSON.stringify(records, null, 2));
}

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (!users[chatId] || !users[chatId].walletPublicKey || !users[chatId].privateKey) {
    return bot.sendMessage(chatId, "❌ You must complete registration before paying.");
  }

  switch (data) {
    case "pay_1d":
      await activateMembership(chatId, 1, 0.05);
      break;
    case "pay_15d":
      await activateMembership(chatId, 15, 0.60);
      break;
    case "pay_month":
      await activateMembership(chatId, 30, 1.10);
      break;
    case "pay_6m":
      await activateMembership(chatId, 180, 6.00);
      break;
    case "pay_year":
      await activateMembership(chatId, 365, 11.00);
      break;
    case "pay_menu":
      showPaymentButtons(chatId);
      break;
  }
});

bot.onText(/\/payments/, (msg) => {
  const chatId = msg.chat.id;

  if (!users[chatId] || !users[chatId].walletPublicKey) {
    return bot.sendMessage(chatId, "❌ You must be registered to view your payment history.");
  }

  const paymentsFile = "payments.json";
  if (!fs.existsSync(paymentsFile)) {
    return bot.sendMessage(chatId, "📭 No payment records found.");
  }

  const records = JSON.parse(fs.readFileSync(paymentsFile));
  const userPayments = records.filter(p => p.chatId === chatId);

  if (userPayments.length === 0) {
    return bot.sendMessage(chatId, "📭 You haven’t made any payments yet.");
  }

  let message = `📜 *Your Payment History:*\n\n`;

  for (let p of userPayments.reverse()) {
    const date = new Date(p.timestamp).toLocaleDateString();
    message += `🗓️ *${date}*\n`;
    message += `💼 Wallet: \`${p.wallet}\`\n`;
    message += `💳 Paid: *${p.amountSol} SOL* for *${p.days} days*\n`;
    message += `🔗 [Tx Link](https://solscan.io/tx/${p.tx})\n\n`;
  }

  bot.sendMessage(chatId, message, { parse_mode: "Markdown", disable_web_page_preview: true });
});

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || "there";

  if (users[chatId]?.walletPublicKey) {
    const expired = users[chatId].expired;
    const stillActive = expired === "never" || (expired && Date.now() < expired);

    users[chatId].subscribed = stillActive; // Actualizar el campo subscribed
    saveUsers();

    if (stillActive) {
      return bot.sendMessage(chatId, `✅ You are already registered, *${firstName}*!`, {
        parse_mode: "Markdown"
      });
    }

    return bot.sendMessage(chatId, `⚠️ Your subscription has *expired*, *${firstName}*.\n\nPlease choose a plan to continue:`, {
      parse_mode: "Markdown"
    }).then(() => showPaymentButtons(chatId));
  }

  users[chatId] = { step: 1, name: firstName };
  saveUsers();

  const sent = await bot.sendMessage(chatId, `👋 Hello *${firstName}*! Welcome to *PUMPUltra.fun Bot*.\n\n📱 Please enter your *phone number*:`, {
    parse_mode: "Markdown"
  });

  users[chatId].msgId = sent.message_id;
  saveUsers();
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  const messageId = msg.message_id;

  if (!users[chatId] || !users[chatId].step) return;

  bot.deleteMessage(chatId, messageId).catch(() => {});

  const user = users[chatId];
  const msgId = user.msgId;

  switch (user.step) {
    case 1:
      user.phone = text;
      user.step = 2;
      saveUsers();
      bot.editMessageText("📧 Please enter your *email address*:", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      });
      break;

    case 2:
      user.email = text;
      user.step = 3;
      saveUsers();
      bot.editMessageText("🔑 Please enter your *Solana Private Key*:", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      });
      break;

    case 3:
      try {
        const keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(text)));
        user.privateKey = text;
        user.walletPublicKey = keypair.publicKey.toBase58();
        user.step = 4;
        saveUsers();

        bot.editMessageText("🎟️ Do you have a *referral code*? Reply with Yes or No.", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        });
      } catch (err) {
        bot.editMessageText("❌ Invalid private key. Please try again:", {
          chat_id: chatId,
          message_id: msgId
        });
      }
      break;

    case 4:
      if (/^yes$/i.test(text)) {
        user.step = 5;
        saveUsers();
        bot.editMessageText("🔠 Please enter your *referral code*:", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        });
      } else {
        user.expired = null;
        user.step = 0;
        user.subscribed = false;
        saveUsers();
    
        // 🔄 Primero editamos el mensaje actual con advertencia
        await bot.editMessageText("⚠️ No referral code provided. Please *purchase a subscription* to activate your account.", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        });
    
        // 💳 Mostramos el mensaje con los planes y guardamos el message_id
        const paymentMsg = await showPaymentButtons(chatId);
        user.lastPaymentMsgId = paymentMsg.message_id;
        saveUsers();
    
        // ⏳ Pausa breve para evitar conflictos al borrar
        await new Promise(res => setTimeout(res, 300));
    
        // 🗑️ Borramos el mensaje anterior (el de advertencia)
        await bot.deleteMessage(chatId, msgId);
      }
      break;

      case 5:
  const result = validateReferralCode(text);
  if (result.valid) {
    user.referrer = result.referrer || "Unknown";
    user.rcode = result.code;
    user.expired = result.expiration;
    user.step = 0;
    user.subscribed = result.expiration === "never" || Date.now() < result.expiration;

    saveUsers();

    const activeStatus = result.expiration === "never"
      ? "✅ Unlimited"
      : `✅ Active for ${Math.round((result.expiration - Date.now()) / (1000 * 60 * 60 * 24))} day(s)`;

    const confirmation = `✅ *User Registered!*
👤 *Name:* ${user.name}
📱 *Phone:* ${user.phone}
📧 *Email:* ${user.email}
💼 *Wallet:* \`${user.walletPublicKey}\`
🔐 *Referral:* ${result.code} (${user.referrer})
⏳ *Status:* ${activeStatus}`;

    await bot.deleteMessage(chatId, msgId).catch(() => {});

    bot.sendPhoto(chatId, "https://cdn.shopify.com/s/files/1/0784/6966/0954/files/pumppay.jpg?v=1743797016", {
      caption: confirmation,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "⚙️ Settings", callback_data: "settings_menu" }],
          [{ text: "📘 How to Use the Bot", url: "https://pumpultra.fun/docs" }]
        ]
      }
    });

  } else {
    user.expired = null;
    user.step = 0;
    user.subscribed = false;
    saveUsers();

    bot.editMessageText("⚠️ Invalid or expired code. Please *purchase a subscription* to activate your account.", {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: "Markdown"
    }).then(() => showPaymentButtons(chatId));
  }
  break;
  }
});

// ✅ Funciones para manejo de códigos
function loadRcodes() {
  return JSON.parse(fs.readFileSync("rcodes.json"));
}

function saveRcodes(rcodes) {
  fs.writeFileSync("rcodes.json", JSON.stringify(rcodes, null, 2));
}

function validateReferralCode(code) {
  const rcodes = loadRcodes();
  const entry = rcodes.find(c => c.code === code);

  if (entry && (entry.uses === null || entry.used < entry.uses)) {
    entry.used += 1;
    saveRcodes(rcodes);

    const expiration = entry.days === null ? "never" : Date.now() + entry.days * 24 * 60 * 60 * 1000;

    return {
      valid: true,
      referrer: entry.name,
      code: entry.code,
      expiration
    };
  }

  return { valid: false };
}

// ✅ Bloquear funciones si el usuario no está activo
function ensureActiveUser(msg, callback) {
  const chatId = msg.chat.id;
  const user = users[chatId];

  if (!user || !isUserActive(user)) {
    bot.sendMessage(chatId, "🔒 *Access Denied.* Please activate your account to use this feature.", { parse_mode: "Markdown" });
    showPaymentButtons(chatId);
    return;
  }

  callback();
}

// ✅ Revisión periódica de expiración (ahora cada 10 minutos)
setInterval(() => {
  const now = Date.now();
  for (const [chatId, user] of Object.entries(users)) {
    if (user.expired !== "never" && now > user.expired) {
      if (user.subscribed !== false) {
        user.subscribed = false;
        saveUsers(); // 👈 Guardamos el cambio
        bot.sendMessage(chatId, "🔔 Your access has expired. Please renew your subscription:");
        showPaymentButtons(chatId);
      }
    }
  }
}, 10 * 60 * 1000); // ⏱️ Cada 10 minutos

function notifyAdminOfPayment(user, sig, days, solAmount, expiration) {
  const expirationDate = new Date(expiration).toLocaleDateString();

  const msg = `🟢 *New Membership Payment*

👤 *User:* ${user.name || "Unknown"}
💼 *Wallet:* \`${user.walletPublicKey}\`
💳 *Paid:* ${solAmount} SOL for ${days} days
🗓️ *Expires:* ${expirationDate}
🔗 [View Tx](https://solscan.io/tx/${sig})`;

  bot.sendMessage(ADMIN_CHAT_ID, msg, { parse_mode: "Markdown", disable_web_page_preview: true });
}

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const user = users[chatId];

  if (!user || !user.walletPublicKey) {
    return bot.sendMessage(chatId, "❌ You are not registered. Use /start to begin.");
  }

  const now = Date.now();
  let message = `👤 *Account Status*\n\n`;
  message += `💼 Wallet: \`${user.walletPublicKey}\`\n`;

  if (user.expired === "never") {
    message += `✅ *Status:* Unlimited Membership`;
  } else if (user.expired && now < user.expired) {
    const expirationDate = new Date(user.expired).toLocaleDateString();
    const remainingDays = Math.ceil((user.expired - now) / (1000 * 60 * 60 * 24));
    message += `✅ *Status:* Active\n📅 *Expires:* ${expirationDate} (${remainingDays} day(s) left)`;
  } else {
    const expiredDate = user.expired ? new Date(user.expired).toLocaleDateString() : "N/A";
    message += `❌ *Status:* Expired\n📅 *Expired On:* ${expiredDate}`;
  }

  bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});



// 🔹 Conexión WebSocket con reconexión automática
function connectWebSocket() {
    if (ws) {
        ws.removeAllListeners();
    }

    ws = new WebSocket(INSTANTNODES_WS_URL);

    ws.on("open", () => {
        console.log("✅ Conectado al WebSocket de InstantNodes");

        const subscribeMessage = {
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
                { mentions: [MIGRATION_PROGRAM_ID] },
                { commitment: "finalized" }
            ]
        };

        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(subscribeMessage));
        }
    });

    ws.on("message", (data) => {
        try {
            const transaction = JSON.parse(data);
            if (transaction) {
                processTransaction(transaction);
            }
        } catch (error) {
            console.error("❌ Error al procesar el mensaje:", error);
        }
    });

    ws.on("close", (code, reason) => {
        console.warn(`⚠️ Conexión cerrada (Código: ${code}, Razón: ${reason || "Desconocida"})`);
        setTimeout(() => {
            console.log("🔄 Intentando reconectar...");
            connectWebSocket();
        }, 5000);
    });

    ws.on("error", (error) => {
        console.error("❌ Error en WebSocket:", error);
    });

    // 💓 Mantener conexión viva
    ws.on("pong", () => {
        console.log("💓 Recibido PONG desde el servidor.");
    });
}

// 🔥 Cargar suscriptores antes de iniciar el WebSocket y Heartbeat
loadUsers();
connectWebSocket();

// 💓 Mantener la conexión activa enviando ping cada 30s
function startHeartbeat() {
    setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.ping(); // 🔥 Ahora usa `ping()` en lugar de `ws.send("ping")`
            console.log("💓 Enviando ping al WebSocket");
        }
    }, 30000);
}

startHeartbeat();

// ⏳ Configuración del tiempo de espera antes de ejecutar el análisis
let DELAY_BEFORE_ANALYSIS = 1 * 1000; // 1 segundos por defecto

bot.onText(/\/delay (\d+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const newDelay = parseInt(match[1]);

    if (isNaN(newDelay) || newDelay < 0 || newDelay > 300) {
        bot.sendMessage(chatId, "⚠️ *Tiempo inválido.* Introduce un número entre 0 y 300 segundos.", { parse_mode: "Markdown" });
        return;
    }

    DELAY_BEFORE_ANALYSIS = newDelay * 1000;
    bot.sendMessage(chatId, `⏳ *Nuevo tiempo de espera configurado:* ${newDelay} segundos.`, { parse_mode: "Markdown" });

    console.log(`🔧 Delay actualizado a ${newDelay} segundos por el usuario.`);
});

// 🔹 Procesar transacciones WebSocket y ejecutar análisis después de un delay
function processTransaction(transaction) {
    try {
        const logs = transaction?.params?.result?.value?.logs || [];
        const signature = transaction?.params?.result?.value?.signature;

        if (!logs.length || !signature) return;

        if (logs.some(log => log.includes("Program log: Instruction: CreatePool"))) {
            console.log(`📌 Transacción detectada: ${signature}`);
            console.log(`⏳ Esperando ${DELAY_BEFORE_ANALYSIS / 1000} segundos antes de ejecutar el análisis...`);

            setTimeout(async () => {
                console.log(`🚀 Ejecutando análisis para la transacción: ${signature}`);
                await analyzeTransaction(signature);
            }, DELAY_BEFORE_ANALYSIS);
        }
    } catch (error) {
        console.error("❌ Error en processTransaction:", error);
    }
}

// Actualización de getMintAddressFromTransaction:
// Se recorre primero postTokenBalances y, si no se encuentra, se recorre preTokenBalances.
async function getMintAddressFromTransaction(signature) {
  try {
    const transaction = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed"
    });

    if (!transaction || !transaction.meta) {
      console.error("❌ No se pudo obtener la transacción.");
      return null;
    }

    const blockTime = transaction.blockTime; // timestamp en segundos
    const timestamp = blockTime * 1000; // timestamp en milisegundos
    const status = transaction.meta.err ? "Failed ❌" : "Confirmed ✅";

    let mintAddress = null;

    if (transaction.meta.postTokenBalances?.length > 0) {
      for (const tokenBalance of transaction.meta.postTokenBalances) {
        if (tokenBalance.mint?.toLowerCase().endsWith("pump")) {
          mintAddress = tokenBalance.mint;
          break;
        }
      }
      if (!mintAddress) {
        mintAddress = transaction.meta.postTokenBalances[0].mint;
      }
    }

    if (!mintAddress && transaction.meta.preTokenBalances?.length > 0) {
      for (const tokenBalance of transaction.meta.preTokenBalances) {
        if (tokenBalance.mint?.toLowerCase().endsWith("pump")) {
          mintAddress = tokenBalance.mint;
          break;
        }
      }
      if (!mintAddress) {
        mintAddress = transaction.meta.preTokenBalances[0].mint;
      }
    }

    if (!mintAddress) {
      console.warn("⚠️ No se encontró ningún mint en la transacción.");
      return null;
    }

    return {
      mintAddress,
      date: timestamp,  // 👈 Guardamos timestamp en milisegundos
      status,
      blockTime         // también puedes dejar blockTime si quieres (segundos)
    };
  } catch (error) {
    console.error("❌ Error al obtener Mint Address:", error);
    return null;
  }
}

function escapeMarkdown(text) {
    if (typeof text !== "string") {
        return String(text || "N/A"); // Asegurar que siempre sea string
    }

    return text
        .replace(/_/g, "\\_")
        .replace(/\*/g, "\\*")
        .replace(/\[/g, "\\[")
        .replace(/\]/g, "\\]")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)")
        .replace(/~/g, "\\~")
        .replace(/`/g, "\\`")
        .replace(/>/g, "\\>")
        .replace(/#/g, "\\#")
        // 🔥 Eliminamos el escape de `+` y `-` para evitar `\+` y `\-`
        .replace(/=/g, "\\=")
        .replace(/\|/g, "\\|")
        .replace(/\{/g, "\\{")
        .replace(/\}/g, "\\}")
        .replace(/!/g, "\\!");
}

const ADMIN_CHAT_ID = "472101348";

// getPairAddressFromSolanaTracker IMPORTANTE Para solicitar informacion de moralis.
async function getPairAddressFromSolanaTracker(tokenAddress) {
    try {
      const response = await axios.get(`https://data.solanatracker.io/tokens/${tokenAddress}`, {
        headers: {
          "x-api-key": "cecd6680-9645-4f89-ab5e-e93d57daf081"
        }
      });
  
      const data = response.data;
  
      if (!data || !Array.isArray(data.pools) || data.pools.length === 0) {
        console.warn("⚠️ No se encontraron pools en SolanaTracker.");
        return null;
      }
  
      // Buscar el primer pool con liquidez > 0
      const validPool = data.pools.find(pool =>
        typeof pool.liquidity?.usd === "number" && pool.liquidity.usd > 0
      );
  
      if (validPool?.poolId) {
        console.log(`✅ Pair address encontrado: ${validPool.poolId}`);
        return validPool.poolId;
      } else {
        console.warn("⚠️ No se encontró un pool válido con liquidez.");
        return null;
      }
    } catch (error) {
      console.error("❌ Error obteniendo el pair address desde SolanaTracker:", error.message);
      return null;
    }
  }

// 🔹 Obtener datos desde Moralis
async function getDexScreenerData(pairAddress) {
    const url = `https://solana-gateway.moralis.io/token/mainnet/pairs/${pairAddress}/stats`;
    const headers = {
        accept: "application/json",
        "X-API-Key": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJub25jZSI6IjNkNDUyNGViLWE2N2ItNDBjZi1hOTBiLWE0NDI0ZmU3Njk4MSIsIm9yZ0lkIjoiNDI3MDc2IiwidXNlcklkIjoiNDM5Mjk0IiwidHlwZUlkIjoiZWNhZDFiODAtODRiZS00ZTlmLWEzZjgtYTZjMGQ0MjVhNGMwIiwidHlwZSI6IlBST0pFQ1QiLCJpYXQiOjE3Mzc1OTc1OTYsImV4cCI6NDg5MzM1NzU5Nn0.y9bv5sPVgcR4xCwgs8qvy2LOzZQMN3LSebEYfR9I_ks"
      };
  
    const maxRetries = 10;
    const delayMs = 1000;
  
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Intento ${attempt} para obtener datos de Moralis...`);
        const response = await axios.get(url, { headers });
        const data = response.data;
  
        if (data && data.tokenAddress && data.tokenSymbol) {
          console.log(`✅ Datos de Moralis recibidos en el intento ${attempt}`);
  
          // 🔄 Normalizar symbol y name
          const symbol = typeof data.tokenSymbol === "string" ? data.tokenSymbol.trim().toUpperCase() : "N/A";
          const name = typeof data.tokenName === "string" ? data.tokenName.trim() : "Unknown";
  
          return {
            // 🪙 Token info (formato DexScreener)
            name: name,
            symbol: symbol,
            tokenAddress: data.tokenAddress || "N/A",
            tokenLogo: data.tokenLogo || "",
  
            // 📊 Precios y liquidez
            priceUsd: data.currentUsdPrice || "N/A",
            priceSol: data.currentNativePrice || "N/A",
            liquidity: data.totalLiquidityUsd || "N/A",
            liquidityChange24h: data.liquidityPercentChange?.["24h"] ?? "N/A",
  
            // 📈 Estadísticas 24h
            buyVolume24h: data.buyVolume?.["24h"] ?? "N/A",
            sellVolume24h: data.sellVolume?.["24h"] ?? "N/A",
            totalVolume24h: data.totalVolume?.["24h"] ?? "N/A",
            buys24h: typeof data.buys?.["24h"] === "number" ? data.buys["24h"] : 0,
            sells24h: typeof data.sells?.["24h"] === "number" ? data.sells["24h"] : 0,
            buyers24h: typeof data.buyers?.["24h"] === "number" ? data.buyers["24h"] : 0,
            sellers24h: typeof data.sellers?.["24h"] === "number" ? data.sellers["24h"] : 0,
            priceChange24h: data.pricePercentChange?.["24h"] ?? "N/A",
  
            // 🧩 DEX info
            pairAddress: data.pairAddress || pairAddress,
            dex: data.exchange || "N/A",
            exchangeAddress: data.exchangeAddress || "N/A",
            exchangeLogo: data.exchangeLogo || "",
            pairLabel: data.pairLabel || "N/A",
  
            // Extra
            chain: "Solana"
          };
        } else {
          console.warn(`⚠️ Moralis devolvió respuesta incompleta en el intento ${attempt}`);
        }
      } catch (error) {
        console.error(`❌ Error en intento ${attempt} de Moralis:`, error.message);
      }
  
      // Esperar antes del siguiente intento
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  
    console.warn("⏱️ Moralis: Se alcanzó el máximo de reintentos sin obtener datos válidos.");
    return null;
  }

// 🔹 Obtener datos de riesgo desde RugCheck API con reintentos automáticos
async function fetchRugCheckData(tokenAddress) {
  // 🔸 PRIMER INTENTO: RugCheck
  try {
    console.log("🔍 Intentando obtener datos desde RugCheck...");
    const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`);
    const data = response.data;

    if (!data) throw new Error("No se recibió data de RugCheck.");

    const normalizedScore = data.score_normalised || 0;
    let riskLevel = "🟢 GOOD";
    if (normalizedScore >= 41) {
      riskLevel = "🔴 DANGER";
    } else if (normalizedScore >= 21) {
      riskLevel = "🟠 WARNING";
    }

    const freezeAuthority = data.token?.freezeAuthority === null ? "✅ Disabled" : "🔒 Enabled";
    const mintAuthority = data.token?.mintAuthority === null ? "✅ Revoked" : "⚠️ Exists";

    const lpLocked = (typeof data.markets?.[0]?.lp?.lpLockedPct === "number")
      ? `${data.markets[0].lp.lpLockedPct}`
      : "no data";

    const riskDescription = data.risks?.map(r => r.description).join(", ") || "No risks detected";

    return {
      riskLevel,
      riskDescription,
      lpLocked,
      freezeAuthority,
      mintAuthority
    };

  } catch (error) {
    console.warn(`⚠️ RugCheck falló: ${error.message}`);
  }

  // 🔁 SEGUNDO INTENTO: SolanaTracker
  try {
    console.log("🔄 RugCheck falló. Intentando con SolanaTracker...");
    const response = await axios.get(`https://data.solanatracker.io/tokens/${tokenAddress}`, {
      headers: {
        "x-api-key": "cecd6680-9645-4f89-ab5e-e93d57daf081"
      }
    });

    const data = response.data;
    if (!data) throw new Error("No se recibió data de SolanaTracker.");

    const pool = data.pools?.[0];
    const score = data.risk?.score || 0;
    let riskLevel = "🟢 GOOD";
    if (score >= 5) {
      riskLevel = "🔴 DANGER";
    } else if (score >= 3) {
      riskLevel = "🟠 WARNING";
    }

    const risks = data.risk?.risks || [];
    const filteredRisks = risks.filter(r => r.name !== "No social media");

    const riskDescription = filteredRisks.length > 0
      ? filteredRisks.map(r => r.description).join(", ")
      : "No risks detected";

    const lpLocked = (typeof pool?.lpBurn === "number")
      ? `${pool.lpBurn}`
      : "no data";

    const freezeAuthority = pool?.security?.freezeAuthority === null ? "✅ Disabled" : "🔒 Enabled";
    const mintAuthority = pool?.security?.mintAuthority === null ? "✅ Revoked" : "⚠️ Exists";

    return {
      riskLevel,
      riskDescription,
      lpLocked,
      freezeAuthority,
      mintAuthority
    };

  } catch (error) {
    console.error(`❌ SolanaTracker también falló: ${error.message}`);
    return null;
  }
}

function saveTokenData(dexData, mintData, rugCheckData, age, priceChange24h) {
    console.log("🔄 Intentando guardar datos en tokens.json...");
  
    if (!dexData || !mintData || !rugCheckData) {
      console.error("❌ Error: Datos inválidos, no se guardará en tokens.json");
      return;
    }
  
    console.log("✅ Datos validados correctamente.");
    console.log("🔹 Datos recibidos para guardar:", JSON.stringify({ dexData, mintData, rugCheckData, age, priceChange24h }, null, 2));
  
    const tokenInfo = {
      // 🪙 Token
      name: dexData.name || "Unknown",
      symbol: dexData.symbol || "Unknown",
      tokenAddress: dexData.tokenAddress || "N/A",
      tokenLogo: dexData.tokenLogo || "",
  
      // 📊 Precios
      USD: dexData.priceUsd || "N/A",
      SOL: dexData.priceSol || "N/A",
      liquidity: dexData.liquidity || "N/A",
      liquidityChange24h: dexData.liquidityChange24h || "N/A",
  
      // 📈 Stats 24h
      priceChange24h: dexData.priceChange24h || "N/A",
      buyVolume24h: dexData.buyVolume24h || "N/A",
      sellVolume24h: dexData.sellVolume24h || "N/A",
      totalVolume24h: dexData.totalVolume24h || "N/A",
      buys24h: dexData.buys24h || "0",
      sells24h: dexData.sells24h || "0",
      buyers24h: dexData.buyers24h || "0",
      sellers24h: dexData.sellers24h || "0",
  
      // 🔐 Seguridad
      riskLevel: rugCheckData.riskLevel || "N/A",
      warning: rugCheckData.riskDescription || "No risks detected",
      LPLOCKED: rugCheckData.lpLocked || "N/A",
      freezeAuthority: rugCheckData.freezeAuthority || "N/A",
      mintAuthority: rugCheckData.mintAuthority || "N/A",
  
      // 🧩 DEX info
      chain: dexData.chain || "solana",
      dex: dexData.dex || "N/A",
      pair: dexData.pairAddress || "N/A",
      pairLabel: dexData.pairLabel || "N/A",
      exchangeAddress: dexData.exchangeAddress || "N/A",
      exchangeLogo: dexData.exchangeLogo || "",
  
      // ⏱️ Metadata
      migrationDate: typeof mintData.date === "number" ? mintData.date : null,
      status: mintData.status || "N/A",
      token: mintData.mintAddress || "N/A"
    };
  
    console.log("🔹 Datos formateados para guardar:", JSON.stringify(tokenInfo, null, 2));
  
    const filePath = 'tokens.json';
    let tokens = {};
  
    if (fs.existsSync(filePath)) {
      try {
        const fileContent = fs.readFileSync(filePath, 'utf-8');
        tokens = fileContent.trim() ? JSON.parse(fileContent) : {};
        console.log("📂 Archivo tokens.json leído correctamente.");
      } catch (error) {
        console.error("❌ Error leyendo tokens.json:", error);
        console.log("🔄 Restaurando tokens.json vacío...");
        fs.writeFileSync(filePath, "{}", 'utf-8');
        tokens = {};
      }
    } else {
      console.log("📂 Archivo tokens.json no existe, se creará uno nuevo.");
    }
  
    if (!mintData.mintAddress || mintData.mintAddress === "N/A") {
      console.error("❌ Error: Mint Address inválido, no se guardará en tokens.json.");
      return;
    }
  
    console.log("🔹 Mint Address a usar como clave:", mintData.mintAddress);
  
    tokens[mintData.mintAddress] = tokenInfo;
  
    try {
      fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), 'utf-8');
      console.log(`✅ Token ${dexData.symbol} almacenado en tokens.json`);
    } catch (error) {
      console.error("❌ Error guardando token en tokens.json:", error);
    }
  
    try {
      fs.accessSync(filePath, fs.constants.W_OK);
      console.log("✅ Permisos de escritura en tokens.json verificados.");
    } catch (error) {
      console.error("❌ Error: No hay permisos de escritura en tokens.json.");
      console.log("🔄 Ejecuta este comando para arreglarlo:");
      console.log(`chmod 666 ${filePath}`);
    }
  }

  function getTokenInfo(mintAddress) {
    if (!fs.existsSync('tokens.json')) return { symbol: "N/A", name: "N/A" };
  
    const tokens = JSON.parse(fs.readFileSync('tokens.json', 'utf-8')) || {};
  
    return tokens[mintAddress] || { symbol: "N/A", name: "N/A" };
  }

// 🔹 Función para comprar tokens usando Jupiter API con transacciones versionadas
async function buyToken(chatId, mint, amountSOL, attempt = 1) {
    try {
      const user = users[chatId];
      if (!user || !user.privateKey) {
        throw new Error("User not registered or missing privateKey.");
      }
  
      // Obtener keypair y conexión usando el endpoint rápido de Helius
      const userKeypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
      const userPublicKey = userKeypair.publicKey;
      const connection = new Connection("https://ros-5f117e-fast-mainnet.helius-rpc.com", "confirmed");
  
      // Ejecutar de forma concurrente la verificación/creación de la ATA y la consulta de balance
      const [ata, balanceLamports] = await Promise.all([
        ensureAssociatedTokenAccount(userKeypair, mint, connection),
        connection.getBalance(userPublicKey)
      ]);
  
      if (!ata) {
        // Si no se obtuvo la ATA, reintentar después de 3 segundos
        await new Promise(resolve => setTimeout(resolve, 3000));
        return await buyToken(chatId, mint, amountSOL, attempt + 1);
      }
  
      const balance = balanceLamports / 1e9;
      if (balance < amountSOL) {
        throw new Error(`Not enough SOL. Balance: ${balance}, Required: ${amountSOL}`);
      }
  
      // Solicitar la cotización a la API de Jupiter
      const quoteResponse = await axios.get("https://quote-api.jup.ag/v6/quote", {
        params: {
          inputMint: "So11111111111111111111111111111111111111112",
          outputMint: mint,
          amount: Math.floor(amountSOL * 1e9),
          dynamicSlippage: true,
          swapMode: "ExactIn"
        }
      });
      if (!quoteResponse.data || !quoteResponse.data.routePlan) {
        throw new Error("Failed to retrieve a valid quote from Jupiter.");
      }
  
      // Solicitar la construcción de la transacción de swap a Jupiter
      const swapResponse = await axios.post(JUPITER_API_URL, {
        quoteResponse: quoteResponse.data,
        userPublicKey: userPublicKey.toBase58(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: 2000000
      });
      if (!swapResponse.data || !swapResponse.data.swapTransaction) {
        throw new Error("Failed to construct swap transaction.");
      }
  
      // Decodificar, firmar y enviar la transacción real
      const transactionBuffer = Buffer.from(swapResponse.data.swapTransaction, "base64");
      const versionedTransaction = VersionedTransaction.deserialize(transactionBuffer);
      versionedTransaction.sign([userKeypair]);
  
      const txId = await connection.sendTransaction(versionedTransaction, {
        skipPreflight: false,
        preflightCommitment: "confirmed"
      });
  
      return txId;
    } catch (error) {
      const errorMessage = error.message || "";
      // Filtrar el log si el error contiene "Simulation failed"
      if (!errorMessage.includes("Simulation failed")) {
        console.error(`❌ Error in purchase attempt ${attempt}:`, errorMessage, error.response?.data || "");
      }
      // Backoff exponencial para reintentos
      if (attempt < 3) {
        const delay = 3000 * Math.pow(2, attempt - 1); // 3s, 6s, 12s,...
        await new Promise(resolve => setTimeout(resolve, delay));
        return await buyToken(chatId, mint, amountSOL, attempt + 1);
      } else {
        return Promise.reject(error);
      }
    }
  }

async function getTokenBalance(chatId, mint) {
    try {
        if (!users[chatId] || !users[chatId].walletPublicKey) {
            console.error(`⚠️ No se encontró el usuario ${chatId} o no tiene walletPublicKey.`);
            return 0;
        }

        const userPublicKeyString = users[chatId].walletPublicKey;
        
        if (!userPublicKeyString || typeof userPublicKeyString !== "string") {
            console.error(`⚠️ walletPublicKey inválido para el usuario ${chatId}:`, userPublicKeyString);
            return 0;
        }

        const userPublicKey = new PublicKey(userPublicKeyString); // 🔥 Corrección aquí

        console.log(`🔎 Consultando balance del token ${mint} para la wallet ${userPublicKey.toBase58()}`);

        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPublicKey, {
            mint: new PublicKey(mint)
        });

        if (tokenAccounts.value.length > 0) {
            const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
            console.log(`✅ Balance encontrado: ${balance} tokens`);
            return balance;
        }

        console.log("⚠️ No se encontraron tokens en la wallet.");
        return 0;
    } catch (error) {
        console.error("❌ Error obteniendo balance:", error);
        return 0;
    }
}

async function executeJupiterSell(chatId, mint, amount, attempt = 1) {
    try {
        console.log(`🔄 Attempt ${attempt}: Preparing sale of ${amount} tokens for mint: ${mint}`);

        const user = users[chatId];
        if (!user || !user.privateKey) {
            console.error(`⚠ Private key not found for user: ${JSON.stringify(user || {})}`);
            return null;
        }

        const wallet = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
        const connection = new Connection("https://ros-5f117e-fast-mainnet.helius-rpc.com", "confirmed");

        console.log(`🔹 Wallet used for sale: ${wallet.publicKey.toBase58()}`);

        // 🔹 Asegurar que la ATA existe antes de vender
        const ata = await ensureAssociatedTokenAccount(wallet, mint, connection);
        if (!ata) {
            console.log(`⚠️ ATA not found, waiting for creation... Retrying sale.`);
            return await executeJupiterSell(chatId, mint, amount, attempt + 1); // Reintentar después de crear la ATA
        }

        console.log(`✅ ATA verified for ${mint}: ${ata.toBase58()}`);

        // 🔹 Obtener decimales del token
        const tokenDecimals = await getTokenDecimals(mint);
        console.log(`✅ Token ${mint} has ${tokenDecimals} decimals.`);

        // 🔹 Obtener balance actual en UI units
        let balance = await getTokenBalance(chatId, mint);
        console.log(`✅ Balance found: ${balance} tokens`);

        // 🔹 Convertir balance y cantidad a vender a unidades mínimas
        const balanceInUnits = Math.floor(balance * Math.pow(10, tokenDecimals));
        let amountInUnits = Math.floor(amount * Math.pow(10, tokenDecimals));

        console.log(`🔹 Balance en unidades mínimas: ${balanceInUnits}`);
        console.log(`🔹 Cantidad a vender en unidades mínimas: ${amountInUnits}`);

        // 🔹 Ajustar cantidad a vender si es mayor al balance disponible
        if (amountInUnits > balanceInUnits) {
            console.warn(`⚠ Adjusting sell amount: Trying to sell ${amountInUnits}, but only ${balanceInUnits} available.`);
            amountInUnits = balanceInUnits;
        }

        // 🔹 Validación adicional para evitar fallos
        if (!balanceInUnits || balanceInUnits < amountInUnits || amountInUnits <= 0) {
            console.error(`❌ Insufficient balance. Trying to sell ${amountInUnits}, but only ${balanceInUnits} available.`);
            return null;
        }

        console.log("🔹 Fetching Jupiter sell quote...");

        // 🔹 Obtener cotización de venta en Jupiter con optimización de slippage
        const quoteResponse = await axios.get("https://quote-api.jup.ag/v6/quote", {
            params: {
                inputMint: mint,
                outputMint: "So11111111111111111111111111111111111111112", // SOL
                amount: amountInUnits,
                dynamicSlippage: true,               // 🔄 Usa slippage dinámico
                // slippageBps: 1000,                // Alternativa: 2000 = 20% slippage manual
                swapMode: "ExactIn" // 🔹 Se garantiza que la cantidad vendida sea exacta
            }
        });

        if (!quoteResponse.data || !quoteResponse.data.routePlan) {
            console.error("❌ No valid quote retrieved from Jupiter.");
            return null;
        }

        console.log("✅ Successfully obtained sell quote.", quoteResponse.data);

        // 🔹 Solicitar transacción de swap a Jupiter con optimización de prioridad
        const swapResponse = await axios.post(JUPITER_API_URL, {
            quoteResponse: quoteResponse.data,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            prioritizationFeeLamports: 2000000 // 🔹 Asegura ejecución más rápida
        });

        if (!swapResponse.data || !swapResponse.data.swapTransaction) {
            console.error("❌ Failed to construct swap transaction.");
            return null;
        }

        console.log("✅ Swap transaction received from Jupiter.");

        // 🔹 Decodificar y firmar la transacción
        const transactionBuffer = Buffer.from(swapResponse.data.swapTransaction, "base64");
        const versionedTransaction = VersionedTransaction.deserialize(transactionBuffer);
        versionedTransaction.sign([wallet]);

        console.log("✅ Transaction successfully signed.");
        console.log("🚀 Sending transaction to Solana network...");

        // 🔹 Enviar transacción a Solana
        const txSignature = await connection.sendTransaction(versionedTransaction, {
            skipPreflight: false,
            preflightCommitment: "confirmed"
        });

        console.log(`✅ Sell transaction executed successfully: ${txSignature}`);
        return txSignature;

    } catch (error) {
        console.error(`❌ Error in sell attempt ${attempt}:`, error.message);

        // 🔄 Reintentar la venta si hay un error, hasta 3 intentos
        if (attempt < 3) {
            console.log(`🔄 Retrying sale (Attempt ${attempt + 1})...`);
            return await executeJupiterSell(chatId, mint, amount, attempt + 1);
        } else {
            console.error("❌ Maximum retries reached. Sale failed.");
            return null;
        }
    }
}

// 🔹 Obtener los decimales del token
async function getTokenDecimals(mint) {
    try {
        const tokenInfo = await connection.getParsedAccountInfo(new PublicKey(mint));
        
        if (!tokenInfo.value || !tokenInfo.value.data) {
            console.warn(`⚠️ No se encontró información del token ${mint}, usando 6 decimales por defecto.`);
            return 6; // Asume 6 si no encuentra info
        }

        const decimals = tokenInfo.value.data.parsed.info.decimals;
        console.log(`✅ Token ${mint} tiene ${decimals} decimales.`);
        return decimals;
    } catch (error) {
        console.error(`❌ Error obteniendo decimales del token ${mint}:`, error);
        return 6; // Devuelve 6 como fallback
    }
}

// 🔹 Función para verificar y crear la ATA si no existe
async function ensureAssociatedTokenAccount(wallet, mint, connection) {
    try {
      // Generar la dirección ATA para el mint y la wallet del usuario
      const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);
      
      // Consultar si la ATA ya existe en la blockchain
      const ataInfo = await connection.getAccountInfo(ata);
      if (ataInfo !== null) {
        return ata;
      }
      
      // Si no existe, crear la instrucción para la ATA
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,     // Payer: quien paga la transacción
          ata,                  // Dirección de la ATA a crear
          wallet.publicKey,     // Owner: dueño de la ATA (la misma wallet)
          new PublicKey(mint)   // Mint del token
        )
      );
      
      // Firmar y enviar la transacción
      await sendAndConfirmTransaction(connection, transaction, [wallet]);
      
      return ata;
    } catch (error) {
      // Puedes manejar el error aquí o propagarlo
      throw error;
    }
  }

// 🔥 Cargar swaps desde el archivo JSON
function loadSwaps() {
    if (fs.existsSync(SWAPS_FILE)) {
        try {
            const data = fs.readFileSync(SWAPS_FILE, "utf8");
            return JSON.parse(data);
        } catch (error) {
            console.error("❌ Error cargando swaps:", error);
            return {};
        }
    }
    return {};
}

// 📝 Guardar swaps en el archivo JSON
function saveSwaps(swaps) {
    try {
        fs.writeFileSync(SWAPS_FILE, JSON.stringify(swaps, null, 2));
        console.log("📂 Swaps actualizados.");
    } catch (error) {
        console.error("❌ Error guardando swaps:", error);
    }
}

// 🔥 Cargar swaps al iniciar
let swaps = loadSwaps();

/**
 * 🔹 Función para guardar un swap en swaps.json
 * @param {string} chatId - ID del usuario en Telegram
 * @param {string} type - Tipo de swap ("Buy" o "Sell")
 * @param {object} details - Detalles del swap
 */
function saveSwap(chatId, type, details) {
    if (!swaps[chatId]) {
        swaps[chatId] = [];
    }

    swaps[chatId].push({
        type,
        ...details,
        timestamp: new Date().toISOString()
    });

    saveSwaps(swaps);
}

// 🔹 Calcular el tiempo desde la creación del par en horas, minutos y segundos
function calculateAge(timestamp) {
  if (!timestamp) return "N/A";
  const now = Date.now();
  const elapsedMs = now - timestamp;

  const hours = Math.floor(elapsedMs / 3600000);
  const minutes = Math.floor((elapsedMs % 3600000) / 60000);
  const seconds = Math.floor((elapsedMs % 60000) / 1000);

  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}

const MINTS_FILE = "mint.json";
let processedMints = {};

// Cargar los mint procesados al iniciar (esto debe llamarse una sola vez al arrancar el bot)
function loadProcessedMints() {
    if (fs.existsSync(MINTS_FILE)) {
      try {
        const data = fs.readFileSync(MINTS_FILE, "utf8");
        processedMints = JSON.parse(data);
        console.log(`✅ ${Object.keys(processedMints).length} mints cargados.`);
      } catch (error) {
        console.error("❌ Error cargando mints:", error);
        processedMints = {};
      }
    } else {
      processedMints = {};
    }
  }

// Guardar los mint procesados en el archivo
function saveProcessedMints() {
    try {
      fs.writeFileSync(MINTS_FILE, JSON.stringify(processedMints, null, 2));
      console.log("📂 Mints actualizados.");
    } catch (error) {
      console.error("❌ Error guardando mints:", error);
    }
  }
  
  // Llamamos a loadProcessedMints() al inicio para cargar lo que ya se haya procesado
  loadProcessedMints();

// 🔹 Conjunto para almacenar firmas ya procesadas automáticamente
const processedSignatures = new Set();

// Función principal que ejecuta todo el proceso de análisis
async function analyzeTransaction(signature, forceCheck = false) {
    if (!forceCheck && processedSignatures.has(signature)) return;
    if (!forceCheck) processedSignatures.add(signature);
  
    const mintData = await getMintAddressFromTransaction(signature);
    if (!mintData || !mintData.mintAddress) return;
  
    if (processedMints[mintData.mintAddress]) return;
    processedMints[mintData.mintAddress] = true;
    saveProcessedMints();
  
    // Llamar a la pre-creación de ATA en modo fire-and-forget si está activada
    if (ataAutoCreationEnabled) {
        preCreateATAsForToken(mintData.mintAddress)
          .catch(err => console.error("❌ Error pre-creating ATAs:", err.message));
      }
  
    const alertMessages = {};
    for (const userId in users) {
      const user = users[userId];
      if (user && user.subscribed && user.privateKey) {
        try {
          const msg = await bot.sendMessage(userId, "🚨 Token incoming. *Prepare to Buy‼️* 🚨", {
            parse_mode: "Markdown"
          });
          alertMessages[userId] = msg.message_id;
          setTimeout(() => {
            bot.deleteMessage(userId, msg.message_id).catch(() => {});
          }, 80000);
        } catch (_) {}
      }
    }
  
    const pairAddress = await getPairAddressFromSolanaTracker(mintData.mintAddress);
    if (!pairAddress) return;
    const dexData = await getDexScreenerData(pairAddress);
    if (!dexData) {
      for (const userId in alertMessages) {
        try {
          await bot.editMessageText("⚠️ Token discarded due to insufficient info for analysis.", {
            chat_id: userId,
            message_id: alertMessages[userId],
            parse_mode: "Markdown"
          });
        } catch (_) {}
      }
      return;
    }
    const rugCheckData = await fetchRugCheckData(mintData.mintAddress);
    if (!rugCheckData) return;
    const priceChange24h = dexData.priceChange24h !== "N/A"
      ? `${dexData.priceChange24h > 0 ? "🟢 +" : "🔴 "}${Number(dexData.priceChange24h).toFixed(2)}%`
      : "N/A";
    const liquidityChange = dexData.liquidityChange24h || 0;
    const liquidity24hFormatted = `${liquidityChange >= 0 ? "🟢 +" : "🔴 "}${Number(liquidityChange).toFixed(2)}%`;
    const migrationTimestamp = mintData.date || Date.now();
    const age = calculateAge(migrationTimestamp);
    const createdDate = formatTimestampToUTCandEST(migrationTimestamp);
    const buys24h = typeof dexData.buys24h === "number" ? dexData.buys24h : 0;
    const sells24h = typeof dexData.sells24h === "number" ? dexData.sells24h : 0;
    const buyers24h = typeof dexData.buyers24h === "number" ? dexData.buyers24h : 0;
    const sellers24h = typeof dexData.sellers24h === "number" ? dexData.sellers24h : 0;
    
    saveTokenData(dexData, mintData, rugCheckData, age, priceChange24h);
  
    let message = `💎 **Symbol:** ${escapeMarkdown(dexData.symbol)}\n`;
    message += `💎 **Name:** ${escapeMarkdown(dexData.name)}\n`;
    message += `⏳ **Age:** ${escapeMarkdown(age)} 📊 **24H:** ${escapeMarkdown(liquidity24hFormatted)}\n\n`;
    message += `💲 **USD:** ${escapeMarkdown(dexData.priceUsd)}\n`;
    message += `💰 **SOL:** ${escapeMarkdown(dexData.priceSol)}\n`;
    message += `💧 **Liquidity:** $${Number(dexData.liquidity).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n`;
    message += `🟩 Buys 24h: ${escapeMarkdown(buys24h)} 🟥 Sells 24h: ${escapeMarkdown(sells24h)}\n`;
    message += `💵 Buy Vol 24h: $${Number(dexData.buyVolume24h).toLocaleString(undefined, { maximumFractionDigits: 2 })}\n`;
    message += `💸 Sell Vol 24h: $${Number(dexData.sellVolume24h).toLocaleString(undefined, { maximumFractionDigits: 2 })}\n`;
    message += `🧑‍🤝‍🧑 Buyers: ${escapeMarkdown(buyers24h)} 👤 Sellers: ${escapeMarkdown(sellers24h)}\n\n`;
    message += `**${escapeMarkdown(rugCheckData.riskLevel)}:** ${escapeMarkdown(rugCheckData.riskDescription)}\n`;
    message += `🔒 **LPLOCKED:** ${escapeMarkdown(rugCheckData.lpLocked)}%\n`;
    message += `🔐 **Freeze Authority:** ${escapeMarkdown(rugCheckData.freezeAuthority)}\n`;
    message += `🪙 **Mint Authority:** ${escapeMarkdown(rugCheckData.mintAuthority)}\n\n`;
    message += `⛓️ **Chain:** ${escapeMarkdown(dexData.chain)} ⚡ **Dex:** ${escapeMarkdown(dexData.dex)}\n`;
    message += `📆 **Created:** ${createdDate}\n\n`;
    message += `🔗 **Token:** \`${escapeMarkdown(mintData.mintAddress)}\`\n\n`;
    
    await notifySubscribers(message, dexData.tokenLogo, mintData.mintAddress);
  }
  
  async function notifySubscribers(message, imageUrl, mint) {
    if (!mint) {
      console.error("⚠️ Mint inválido, no se enviará notificación.");
      return;
    }
    const actionButtons = [
      [
        { text: "🔄 Refresh Info", callback_data: `refresh_${mint}` },
        { text: "📊 Chart+Txns", url: `https://pumpultra.fun/solana/${mint}.html` }
      ],
      [
        { text: "💰 0.01 Sol", callback_data: `buy_${mint}_0.01` },
        { text: "💰 0.05 Sol", callback_data: `buy_${mint}_0.05` },
        { text: "💰 0.1 Sol", callback_data: `buy_${mint}_0.1` }
      ],
      [
        { text: "💰 0.2 Sol", callback_data: `buy_${mint}_0.2` },
        { text: "💰 0.5 Sol", callback_data: `buy_${mint}_0.5` },
        { text: "💰 1.0 Sol", callback_data: `buy_${mint}_1.0` }
      ],
      [
        { text: "💰 2.0 Sol", callback_data: `buy_${mint}_2.0` },
        { text: "💯 Sell MAX", callback_data: `sell_${mint}_max` }
      ]
    ];
    for (const userId in users) {
      const user = users[userId];
      if (!user || !user.subscribed || !user.privateKey) continue;
      try {
        let sentMsg;
        if (imageUrl) {
          sentMsg = await bot.sendPhoto(userId, imageUrl, {
            caption: message,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: actionButtons }
          });
        } else {
          sentMsg = await bot.sendMessage(userId, message, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: actionButtons }
          });
        }
        console.log(`✅ Mensaje enviado a ${userId}`);
      } catch (error) {
        console.error(`❌ Error enviando mensaje a ${userId}:`, error);
      }
    }
  }

// ====================================================
// Función para pre-crear el ATA para un token nuevo (versión concurrente)
// ====================================================
async function preCreateATAsForToken(mintAddress) {
    console.log(`Iniciando pre-creación de ATA para el token: ${mintAddress}`);
    
    // Filtramos los usuarios que están suscritos y tienen clave privada
    const usersToProcess = Object.entries(users).filter(([chatId, user]) => 
      user.subscribed && user.privateKey
    );
  
    // Ejecutamos en paralelo usando Promise.all
    await Promise.all(usersToProcess.map(async ([chatId, user]) => {
      try {
        const userKeypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
        const connection = new Connection("https://mainnet.helius-rpc.com/?api-key=0c964f01-0302-4d00-a86c-f389f87a3f35", "confirmed");
  
        const ata = await getAssociatedTokenAddress(new PublicKey(mintAddress), userKeypair.publicKey);
        const ataInfo = await connection.getAccountInfo(ata);
        if (ataInfo === null) {
          console.log(`No se encontró ATA para el usuario ${chatId} para el token ${mintAddress}. Creándola...`);
          const transaction = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              userKeypair.publicKey,     // Payer
              ata,                       // ATA a crear
              userKeypair.publicKey,     // Owner
              new PublicKey(mintAddress) // Mint del token
            )
          );
          const txSignature = await sendAndConfirmTransaction(connection, transaction, [userKeypair]);
          console.log(`ATA creada para el usuario ${chatId}. TX: ${txSignature}`);
        } else {
          console.log(`El usuario ${chatId} ya tiene ATA para el token ${mintAddress}: ${ata.toBase58()}`);
        }
      } catch (error) {
        console.error(`❌ Error al crear ATA para el usuario ${chatId}:`, error.message);
      }
    }));
  }

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;
  
    try {
      // ─────────────────────────────────────────────
      // REFRESH DE CONFIRMACIÓN DE COMPRA
      // ─────────────────────────────────────────────
      if (data.startsWith("refresh_buy_")) {
        const tokenMint = data.split("_")[2];
        await refreshBuyConfirmationV2(chatId, messageId, tokenMint);
        await bot.answerCallbackQuery(query.id, { text: "✅ Compra actualizada." });
        return;
      }
  
      // ─────────────────────────────────────────────
      // REFRESH DE INFO GENERAL DE TOKEN
      // ─────────────────────────────────────────────
      if (data.startsWith("refresh_")) {
        const mint = data.split("_")[1];
  
        // Se obtienen los datos guardados (estáticos) en tokens.json
        const originalTokenData = getTokenInfo(mint);
        if (!originalTokenData) {
          await bot.answerCallbackQuery(query.id, { text: "Token no encontrado." });
          return;
        }
  
        // Se obtiene el pairAddress almacenado en el token
        const pairAddress = originalTokenData.pair || originalTokenData.pairAddress;
        if (!pairAddress) {
          await bot.answerCallbackQuery(query.id, { text: "Par no disponible." });
          return;
        }
  
        // Obtenemos datos “live” a través de getDexScreenerData (esta función retorna priceUsd, priceSol, liquidity, etc.)
        let updatedDexData;
        try {
          updatedDexData = await getDexScreenerData(pairAddress);
        } catch (err) {
          await bot.answerCallbackQuery(query.id, { text: "Error al actualizar datos." });
          return;
        }
        if (!updatedDexData) {
          await bot.answerCallbackQuery(query.id, { text: "No se pudieron obtener datos actualizados." });
          return;
        }
  
        // Obtener datos de riesgo actualizados
        const rugCheckData = await fetchRugCheckData(mint);
        const updatedRiskLevel = rugCheckData?.riskLevel || originalTokenData.riskLevel;
        const updatedWarning = rugCheckData?.riskDescription || originalTokenData.warning;
  
        // Usamos migrationDate para calcular la edad y la fecha de creación
        const age = calculateAge(originalTokenData.migrationDate) || "N/A";
        const createdDate = formatTimestampToUTCandEST(originalTokenData.migrationDate);
  
        // Para el cambio 24h, se formatea si es numérico
        const priceChange24h = updatedDexData.priceChange24h !== "N/A" && !isNaN(Number(updatedDexData.priceChange24h))
          ? `${Number(updatedDexData.priceChange24h) > 0 ? "🟢 +" : "🔴 "}${Number(updatedDexData.priceChange24h).toFixed(2)}%`
          : "N/A";
  
        // Construir el mensaje actualizado combinando datos guardados y en vivo
        let updatedMessage = `💎 **Symbol:** ${escapeMarkdown(originalTokenData.symbol)}\n`;
        updatedMessage += `💎 **Name:** ${escapeMarkdown(originalTokenData.name)}\n\n`;
        updatedMessage += `🕒 **Saved at Notification:**\n`;
        updatedMessage += `⏳ **Notified:** ${formatTimestampToUTCandEST(originalTokenData.creationTimestamp)}\n`;
        updatedMessage += `📊 **24H:** ${escapeMarkdown(originalTokenData["24H"] || "N/A")}\n`;
        updatedMessage += `💲 **USD:** ${escapeMarkdown(String(originalTokenData.USD))}\n`;
        updatedMessage += `💰 **SOL:** ${escapeMarkdown(String(originalTokenData.SOL))}\n\n`;
  
        updatedMessage += `📊 **Live Market Update:**\n`;
        updatedMessage += `⏳ **Age:** ${escapeMarkdown(age)} 📊 **24H:** ${escapeMarkdown(priceChange24h)}\n`;
  
        // Convertir de manera segura los valores en vivo (si son numéricos)
        const liveUsd = !isNaN(Number(updatedDexData.priceUsd)) ? Number(updatedDexData.priceUsd).toFixed(6) : "N/A";
        const liveSol = !isNaN(Number(updatedDexData.priceSol)) ? Number(updatedDexData.priceSol).toFixed(9) : "N/A";
        const liveLiquidity = !isNaN(Number(updatedDexData.liquidity)) ? Number(updatedDexData.liquidity).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "N/A";
  
        updatedMessage += `💲 **USD:** ${escapeMarkdown(liveUsd)}\n`;
        updatedMessage += `💰 **SOL:** ${escapeMarkdown(liveSol)}\n`;
        updatedMessage += `💧 **Liquidity:** $${escapeMarkdown(liveLiquidity)}\n\n`;
  
        updatedMessage += `🟩 **Buys 24h:** ${updatedDexData.buys24h ?? "N/A"} 🟥 **Sells 24h:** ${updatedDexData.sells24h ?? "N/A"}\n`;
        updatedMessage += `💵 Buy Vol 24h: $${Number(updatedDexData.buyVolume24h ?? 0).toLocaleString()}\n`;
        updatedMessage += `💸 Sell Vol 24h: $${Number(updatedDexData.sellVolume24h ?? 0).toLocaleString()}\n`;
        updatedMessage += `🧑‍🤝‍🧑 Buyers: ${updatedDexData.buyers24h ?? "N/A"} 👤 Sellers: ${updatedDexData.sellers24h ?? "N/A"}\n`;
  
        // Liquidity change (Live) — usamos liquidityChange24h del objeto actualizado
        const liqChange = updatedDexData.liquidityChange24h !== "N/A" && !isNaN(Number(updatedDexData.liquidityChange24h))
          ? `${Number(updatedDexData.liquidityChange24h) >= 0 ? "🟢 +" : "🔴 "}${Number(updatedDexData.liquidityChange24h).toFixed(2)}%`
          : "N/A";
        updatedMessage += `📊 **Liquidity Δ 24h:** ${liqChange}\n\n`;
  
        updatedMessage += `**${escapeMarkdown(updatedRiskLevel)}:** ${escapeMarkdown(updatedWarning)}\n`;
        updatedMessage += `🔒 **LPLOCKED:** ${escapeMarkdown(String(originalTokenData.LPLOCKED))}%\n`;
        updatedMessage += `🔐 **Freeze Authority:** ${escapeMarkdown(String(originalTokenData.freezeAuthority || "N/A"))}\n`;
        updatedMessage += `🪙 **Mint Authority:** ${escapeMarkdown(String(originalTokenData.mintAuthority || "N/A"))}\n\n`;
  
        updatedMessage += `⛓️ **Chain:** ${escapeMarkdown(originalTokenData.chain)} ⚡ **Dex:** ${escapeMarkdown(originalTokenData.dex)}\n`;
        updatedMessage += `📆 **Created:** ${escapeMarkdown(createdDate)}\n\n`;
        updatedMessage += `🔗 **Token:** \`${escapeMarkdown(mint)}\`\n`;
        if (originalTokenData.signature) {
          updatedMessage += `🔗 **Signature:** \`${escapeMarkdown(originalTokenData.signature)}\``;
        }
  
        const reply_markup = {
          inline_keyboard: [
            [
              { text: "🔄 Refresh Info", callback_data: `refresh_${mint}` },
              { text: "📊 Chart+Txns", url: `https://pumpultra.fun/solana/${mint}.html` }
            ],
            [
              { text: "💰 0.01 Sol", callback_data: `buy_${mint}_0.01` },
              { text: "💰 0.05 Sol", callback_data: `buy_${mint}_0.05` },
              { text: "💰 0.1 Sol", callback_data: `buy_${mint}_0.1` }
            ],
            [
              { text: "💰 0.2 Sol", callback_data: `buy_${mint}_0.2` },
              { text: "💰 0.5 Sol", callback_data: `buy_${mint}_0.5` },
              { text: "💰 1.0 Sol", callback_data: `buy_${mint}_1.0` }
            ],
            [
              { text: "💰 2.0 Sol", callback_data: `buy_${mint}_2.0` },
              { text: "💯 Sell MAX", callback_data: `sell_${mint}_max` }
            ]
          ]
        };
  
        if (query.message.photo) {
          await bot.editMessageCaption(updatedMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup
          });
        } else {
          await bot.editMessageText(updatedMessage, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            reply_markup
          });
        }
  
        await bot.answerCallbackQuery(query.id, { text: "Datos actualizados." });
      } else {
        await bot.answerCallbackQuery(query.id);
      }
    } catch (err) {
      console.error("❌ Error en callback_query:", err);
      await bot.answerCallbackQuery(query.id, { text: "Ocurrió un error." });
    }
  });


function formatTimestampToUTCandEST(timestamp) {
  const date = new Date(timestamp);

  const utcTime = date.toLocaleTimeString("en-GB", {
    hour12: false,
    timeZone: "UTC"
  });

  const estTime = date.toLocaleTimeString("en-US", {
    hour12: false,
    timeZone: "America/New_York"
  });

  return `${utcTime} UTC | ${estTime} EST`;
}

async function getSwapDetailsHybrid(signature, expectedMint, chatId) {
  const FAST_RPC = "https://ros-5f117e-fast-mainnet.helius-rpc.com";
  const V0_API = "https://api.helius.xyz/v0/transactions/?api-key=0c964f01-0302-4d00-a86c-f389f87a3f35";

  // Paso 1: Confirmar existencia rápida con getTransaction
  let fastConfirmed = false;
  let attempt = 0;
  let delay = 3000;

  while (attempt < 5 && !fastConfirmed) {
    attempt++;
    try {
      console.log(`⚡ Fast RPC check for tx: ${signature} (Attempt ${attempt})`);
      const result = await axios.post(FAST_RPC, {
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0 }]
      });

      if (result.data && result.data.result) {
        fastConfirmed = true;
        break;
      }
    } catch (e) {
      console.warn(`⏳ Retry getTransaction (${attempt})...`);
    }
    await new Promise(res => setTimeout(res, delay));
    delay *= 1.2;
  }

  if (!fastConfirmed) {
    console.error("❌ Fast confirmation failed. Skipping to fallback.");
    return null;
  }

  // Paso 2: Obtener detalles desde el endpoint V0 con lógica actual
  return await getSwapDetailsFromHeliusV0(signature, expectedMint, chatId);
}

async function getSwapDetailsFromHeliusV0(signature, expectedMint, chatId) {
    const HELIUS_V0_URL = "https://api.helius.xyz/v0/transactions/?api-key=0c964f01-0302-4d00-a86c-f389f87a3f35";
    let retryAttempts = 0;
    let delay = 10000;
  
    while (retryAttempts < 6) {
      try {
        console.log(`🔍 Fetching v0 transaction details from Helius: ${signature} (Attempt ${retryAttempts + 1})`);
  
        const response = await axios.post(HELIUS_V0_URL, {
          transactions: [signature]
        });
  
        const tx = response.data[0];
        if (!tx || tx.transactionError) {
          throw new Error(`❌ Transaction ${signature} failed or not found.`);
        }
  
        const fee = tx.fee / 1e9;
        const walletAddress = tx.feePayer;
        const tokenTransfers = tx.tokenTransfers;
  
        if (!tokenTransfers || tokenTransfers.length === 0) {
          throw new Error("❌ No token transfers found in transaction.");
        }
  
        // Detectar si es COMPRA o VENTA según el expectedMint
        const isBuy = tokenTransfers.some(t =>
          t.toUserAccount === walletAddress && t.mint === expectedMint
        );
  
        let received, sold;
  
        if (isBuy) {
          // COMPRA: recibimos expectedMint
          received = tokenTransfers.find(t =>
            t.toUserAccount === walletAddress && t.mint === expectedMint
          );
          sold = tokenTransfers.find(t =>
            t.fromUserAccount === walletAddress && t.mint !== expectedMint
          );
        } else {
          // VENTA: vendemos expectedMint
          sold = tokenTransfers.find(t =>
            t.fromUserAccount === walletAddress && t.mint === expectedMint
          );
          received = tokenTransfers.find(t =>
            t.toUserAccount === walletAddress && t.mint !== expectedMint
          );
        }
  
        if (!received || !sold) {
          throw new Error("❌ Could not determine sold/received tokens.");
        }
  
        const inputAmount = tx.nativeTransfers
          .filter(t => t.fromUserAccount === walletAddress)
          .reduce((sum, t) => sum + t.amount, 0) / 1e9;
  
        const soldTokenMint = sold.mint;
        const soldAmount = sold.tokenAmount;
        const receivedTokenMint = received.mint;
        const receivedAmount = received.tokenAmount;
  
        const soldTokenInfo = getTokenInfo(soldTokenMint);
        const receivedTokenInfo = getTokenInfo(receivedTokenMint);
  
        const soldTokenName = soldTokenInfo?.name || "Unknown";
        const soldTokenSymbol = soldTokenInfo?.symbol || "N/A";
        const receivedTokenName = receivedTokenInfo?.name || "Unknown";
        const receivedTokenSymbol = receivedTokenInfo?.symbol || "N/A";
  
        const dexPlatform = detectDexPlatform(tx.instructions.map(i => i.programId));
  
        const timestamp = tx.timestamp;
        const date = new Date(timestamp * 1000);
        const options = { timeZone: "America/New_York", hour12: false };
        const estTime = date.toLocaleString("en-US", options);
  
        return {
          inputAmount: inputAmount.toFixed(3),
          soldAmount: soldAmount,
          receivedAmount: receivedAmount.toString(),
          swapFee: fee.toFixed(5),
          soldTokenMint: soldTokenMint,
          receivedTokenMint: receivedTokenMint,
          soldTokenName: soldTokenName,
          soldTokenSymbol: soldTokenSymbol,
          receivedTokenName: receivedTokenName,
          receivedTokenSymbol: receivedTokenSymbol,
          dexPlatform: dexPlatform,
          walletAddress: walletAddress,
          timeStamp: estTime
        };
  
      } catch (err) {
        console.error(`❌ Error retrieving v0 transaction (Attempt ${retryAttempts + 1}):`, err.message);
        if (err.response && err.response.status === 429) delay *= 1.5;
        else delay *= 1.2;
        await new Promise(resolve => setTimeout(resolve, delay));
        retryAttempts++;
    }
} // 👈 AQUÍ FALTABA ESTA LLAVE
return null;
}

  function detectDexPlatform(accountKeys) {
    const dexIdentifiers = {
        "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter Aggregator v6",
        "mete1GCG6pESFVkMyfrgXW1UV3pR7xyF6LT1r6dTC4y": "Meteora",
        "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium Liquidity Pool V4",
        "9Wq5m2K2JhE7G7q8jK8HgyR7Atsj6qGkTRS8UnToV2pj": "Orca"
    };

    for (const key of accountKeys) {
        if (dexIdentifiers[key]) {
            return dexIdentifiers[key];
        }
    }
    return "Unknown DEX";
}

// 🔹 Obtener timestamp en EST
function getTimestampEST() {
    return DateTime.now().setZone("America/New_York").toFormat("MM/dd/yyyy HH:mm:ss 'EST'");
}

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data.startsWith("sell_")) {
        const parts = data.split("_");
        const mint = parts[1];
        const sellType = parts[2];

        console.log(`🔍 Debug - User before selling:`, JSON.stringify(users[chatId], null, 2));

        if (!users[chatId] || !users[chatId].privateKey) {
            console.error(`⚠ Private key not found for user: ${JSON.stringify(users[chatId])}`);
            bot.sendMessage(chatId, "⚠️ Error: Private key not found.");
            return;
        }

        const initialMsg = await bot.sendMessage(chatId, `🔄 Processing sale of ${sellType === "50" ? "50%" : "100%"} of your ${mint} tokens...`);
        const messageId = initialMsg.message_id;

        try {
            const wallet = Keypair.fromSecretKey(new Uint8Array(bs58.decode(users[chatId].privateKey)));
            const connection = new Connection("https://ros-5f117e-fast-mainnet.helius-rpc.com", "confirmed");

            const ata = await ensureAssociatedTokenAccount(wallet, mint, connection);
            if (!ata) throw new Error(`❌ Failed to create or retrieve the ATA for ${mint}`);
            console.log(`✅ ATA verified for selling: ${ata.toBase58()}`);

            const decimals = await getTokenDecimals(mint);
            console.log(`✅ Token ${mint} has ${decimals} decimals.`);

            let balance = await getTokenBalance(chatId, mint);
            console.log(`✅ Balance found: ${balance} tokens`);

            if (!balance || balance <= 0) {
                await bot.editMessageText("⚠️ You don't have enough balance to sell.", {
                    chat_id: chatId,
                    message_id: messageId,
                });
                return;
            }

            let balanceInLamports = Math.floor(balance * Math.pow(10, decimals));
            let amountToSell = sellType === "50" ? Math.floor(balanceInLamports / 2) : balanceInLamports;
            let soldAmount = sellType === "50" ? (balance / 2).toFixed(9) : balance.toFixed(3);
            console.log(`🔹 Selling amount in lamports: ${amountToSell}`);

            if (amountToSell < 1) {
                await bot.editMessageText("⚠️ The amount to sell is too low.", {
                    chat_id: chatId,
                    message_id: messageId,
                });
                return;
            }

            let txSignature = null;
            let attempts = 0;
            let delayBetweenAttempts = 5000;
            while (attempts < 3 && !txSignature) {
                attempts++;
                console.log(`🔄 Attempt ${attempts}/3 to execute sale...`);
                txSignature = await executeJupiterSell(chatId, mint, amountToSell);
                if (!txSignature) {
                    await new Promise(res => setTimeout(res, delayBetweenAttempts));
                    delayBetweenAttempts *= 1.5;
                }
            }

            if (!txSignature) {
                await bot.editMessageText("❌ The sale could not be completed after multiple attempts.", {
                    chat_id: chatId,
                    message_id: messageId,
                });
                return;
            }

            await bot.editMessageText(
              `✅ *Sell order confirmed on Solana!*\n🔗 [View in Solscan](https://solscan.io/tx/${txSignature})\n⏳ *Fetching sell details...*`,
              {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: "Markdown",
                disable_web_page_preview: true
              }
            );
            
            console.log("⏳ Waiting for Solana to confirm the transaction...");
            let sellDetails = null;
            let attempt = 0;
            delayBetweenAttempts = 5000;
            
            while (attempt < 5 && !sellDetails) {
                attempt++;
                console.log(`⏳ Fetching transaction details from Helius for: ${txSignature} (Attempt ${attempt})`);
                sellDetails = await getSwapDetailsHybrid(txSignature, mint, chatId); // <<--- NUEVA FUNCION
                if (!sellDetails) {
                    await new Promise(res => setTimeout(res, delayBetweenAttempts));
                    delayBetweenAttempts *= 1.2;
                }
            }

            if (!sellDetails) {
                await bot.editMessageText(
                    `⚠️ Sell details could not be retrieved after 5 attempts. Transaction: [View in Solscan](https://solscan.io/tx/${txSignature})`,
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: "Markdown",
                        disable_web_page_preview: true
                    }
                );
                return;
            }

            // Confirmación final en el mismo cuadro
            await confirmSell(chatId, sellDetails, soldAmount, messageId, txSignature);

        } catch (error) {
            console.error("❌ Error in sell process:", error);
            await bot.editMessageText("❌ The sale could not be completed.", {
                chat_id: chatId,
                message_id: messageId
            });
        }
    }

    bot.answerCallbackQuery(query.id);
});

async function confirmSell(chatId, sellDetails, soldAmount, messageId, txSignature) {
    const solPrice = await getSolPriceUSD();
  
    const soldTokenMint = sellDetails.soldTokenMint || "Unknown";
    const soldTokenData = getTokenInfo(soldTokenMint) || {};
    const tokenSymbol = typeof soldTokenData.symbol === "string" ? escapeMarkdown(soldTokenData.symbol) : "Unknown";
    const gotSol = parseFloat(sellDetails.receivedAmount); // SOL recibido
    const soldAmountFloat = parseFloat(soldAmount); // Asegurarse de que sea número
  
    let winLossDisplay = "N/A";
    if (buyReferenceMap[chatId]?.[soldTokenMint]?.solBeforeBuy) {
      const beforeBuy = parseFloat(buyReferenceMap[chatId][soldTokenMint].solBeforeBuy);
      const pnlSol = gotSol - beforeBuy;
      const emoji = pnlSol >= 0 ? "⬆️" : "⬇️";
      const pnlUsd = solPrice ? (pnlSol * solPrice) : null;
      winLossDisplay = `${emoji}${Math.abs(pnlSol).toFixed(3)} SOL ` +
                       `(USD ${pnlUsd >= 0 ? '+' : '-'}$${Math.abs(pnlUsd).toFixed(2)})`;
    }
  
    const usdValue = solPrice ? `USD $${(gotSol * solPrice).toFixed(2)}` : "N/A";
  
    // 🔥 Nuevo: Calcular el precio por token
    const tokenPrice = soldAmountFloat > 0 ? (gotSol / soldAmountFloat).toFixed(9) : "N/A";

    const confirmationMessage = `✅ *Sell completed successfully* 🔗 [View in Solscan](https://solscan.io/tx/${txSignature})\n` +
  `*${tokenSymbol}/SOL* (${escapeMarkdown(sellDetails.dexPlatform || "Unknown DEX")})\n` +
  `🕒 *Time:* ${sellDetails.timeStamp} (EST)\n\n` +
  `⚡️ SELL ⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n` +
  `💲 *Token Price:* ${tokenPrice} SOL\n` +
  `💰 *SOL PNL:* ${winLossDisplay}\n\n` +
  `💲 *Sold:* ${soldAmount} Tokens\n` +
  `💰 *Got:* ${gotSol} SOL (${usdValue})\n` +
  `🔄 *Sell Fee:* ${sellDetails.swapFee} SOL\n\n` +
  `🔗 *Sold Token ${tokenSymbol}:* \`${soldTokenMint}\`\n` +
  `🔗 *Wallet:* \`${sellDetails.walletAddress}\``;

await bot.editMessageText(confirmationMessage, {
  chat_id: chatId,
  message_id: messageId,
  parse_mode: "Markdown",
  disable_web_page_preview: true
});
  
    saveSwap(chatId, "Sell", {
      "Sell completed successfully": true,
      "Pair": `${tokenSymbol}/SOL`,
      "Sold": `${soldAmount} Tokens`,
      "Got": `${gotSol} SOL`,
      "Sell Fee": `${sellDetails.swapFee} SOL`,
      "Token Price": `${tokenPrice} SOL`,
      "Sold Token": tokenSymbol,
      "Sold Token Address": soldTokenMint,
      "Wallet": sellDetails.walletAddress,
      "Time": `${sellDetails.timeStamp}`,
      "Transaction": `https://solscan.io/tx/${txSignature}`,
      "SOL PNL": winLossDisplay,
      "messageText": confirmationMessage  // 🔥 agregar esto
    });
  
    console.log(`✅ Sell confirmation sent for ${soldAmount} ${tokenSymbol}`);
  }

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
  
    if (data.startsWith("buy_")) {
      const parts = data.split("_");
      const mint = parts[1];
      const amountSOL = parseFloat(parts[2]);
  
      if (!users[chatId] || !users[chatId].privateKey) {
        bot.sendMessage(chatId, "⚠️ You don't have a registered private key. Use /start to register.");
        return;
      }
  
      // Paso 1: Enviar mensaje inicial y guardar el message_id
      const sent = await bot.sendMessage(chatId, `🛒 Processing purchase of ${amountSOL} SOL for ${mint}...`);
      const messageId = sent.message_id;
  
      try {
        const txSignature = await buyToken(chatId, mint, amountSOL);
  
        if (!txSignature) {
          await bot.editMessageText(`❌ The purchase could not be completed.`, {
            chat_id: chatId,
            message_id: messageId
          });
          return;
        }
  
        // Paso 2: Confirmación en Solscan
        await bot.editMessageText(
          `✅ *Purchase order confirmed on Solana!*\n🔗 [View in Solscan](https://solscan.io/tx/${txSignature})\n⏳ *Fetching sell details...*`,
          {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: "Markdown",
            disable_web_page_preview: true
          }
        );
  
        // Paso 3: Esperar detalles del swap
        let swapDetails = null;
        let attempt = 0;
        const maxAttempts = 5;
        let delay = 3000;
  
        while (attempt < maxAttempts && !swapDetails) {
          attempt++;
          swapDetails = await getSwapDetailsHybrid(txSignature, mint, chatId);
          if (!swapDetails) {
            await new Promise(res => setTimeout(res, delay));
            delay *= 1.5;
          }
        }
  
        if (!swapDetails) {
          await bot.editMessageText(
            `⚠️ Swap details could not be retrieved after ${maxAttempts} attempts. Transaction: [View in Solscan](https://solscan.io/tx/${txSignature})`,
            {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: "Markdown",
              disable_web_page_preview: true
            }
          );
          return;
        }
  
        // Paso 4: Confirmación final
        await confirmBuy(chatId, swapDetails, messageId, txSignature);
  
      } catch (error) {
        console.error("❌ Error in purchase process:", error);
  
        const rawMessage =
          typeof error === "string"
            ? error
            : typeof error?.message === "string"
            ? error.message
            : error?.toString?.() || "❌ The purchase could not be completed.";
  
        const errorMsg = rawMessage.includes("Not enough SOL")
          ? rawMessage
          : "❌ The purchase could not be completed.";
  
        await bot.editMessageText(errorMsg, {
          chat_id: chatId,
          message_id: messageId
        });
      }
    }
  
    bot.answerCallbackQuery(query.id);
  });

// Este objeto guardará el "before" de cada compra por chat y token
global.buyReferenceMap = global.buyReferenceMap || {};

async function confirmBuy(chatId, swapDetails, messageId, txSignature) {
  const solPrice = await getSolPriceUSD();

  const receivedAmount = parseFloat(swapDetails.receivedAmount) || 0;
  const receivedTokenMint = swapDetails.receivedTokenMint;

  if (!receivedTokenMint || receivedTokenMint.length < 32) {
    console.error("❌ Error: No se pudo determinar un token recibido válido.");
    await bot.editMessageText("⚠️ Error: No se pudo identificar el token recibido.", {
      chat_id: chatId,
      message_id: messageId
    });
    return;
  }

  const swapTokenData = getTokenInfo(receivedTokenMint);
  const tokenSymbol = escapeMarkdown(swapTokenData.symbol || "Unknown");

  const inputAmount = parseFloat(swapDetails.inputAmount);
  const swapFee = parseFloat(swapDetails.swapFee);
  const spentTotal = (inputAmount + swapFee).toFixed(3);
  const usdBefore = solPrice ? `USD $${(spentTotal * solPrice).toFixed(2)}` : "N/A";

  const tokenPrice = receivedAmount > 0 ? (inputAmount / receivedAmount) : 0;

  const confirmationMessage = `✅ *Swap completed successfully* 🔗 [View in Solscan](https://solscan.io/tx/${txSignature})\n` +
    `*SOL/${tokenSymbol}* (${escapeMarkdown(swapDetails.dexPlatform || "Unknown DEX")})\n` +
    `🕒 *Time:* ${swapDetails.timeStamp} (EST)\n\n` +
    `⚡️ SWAP ⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n` +
    `💲 *Token Price:* ${tokenPrice.toFixed(9)} SOL\n\n` +
    `💲 *Spent:* ${spentTotal} SOL (${usdBefore})\n` +
    `💰 *Got:* ${receivedAmount.toFixed(3)} Tokens\n` +
    `🔄 *Swap Fee:* ${swapFee} SOL\n\n` +
    `🔗 *Received Token ${tokenSymbol}:* \`${receivedTokenMint}\`\n` +
    `🔗 *Wallet:* \`${swapDetails.walletAddress}\``;

  await bot.editMessageText(confirmationMessage, {
    chat_id: chatId,
    message_id: messageId,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🔄 Refresh", callback_data: `refresh_buy_${receivedTokenMint}` },
          { text: "💯 Sell MAX", callback_data: `sell_${receivedTokenMint}_100` }
        ],
        [
          { text: "📈 📊 Chart+Txns", url: `https://pumpultra.fun/solana/${receivedTokenMint}.html` }
        ]
      ]
    }
  });

  // Guardar referencia para refreshBuyConfirmation
  if (!buyReferenceMap[chatId]) buyReferenceMap[chatId] = {};
  buyReferenceMap[chatId][receivedTokenMint] = {
    solBeforeBuy: parseFloat(spentTotal),
    receivedAmount: receivedAmount,
    tokenPrice: tokenPrice,
    walletAddress: swapDetails.walletAddress,
    txSignature,
    time: Date.now()
  };

  // Guardar en swaps.json
  saveSwap(chatId, "Buy", {
    "Swap completed successfully": true,
    "Pair": `SOL/${tokenSymbol}`,
    "Spent": `${spentTotal} SOL`,
    "Got": `${receivedAmount.toFixed(3)} Tokens`,
    "Swap Fee": `${swapFee} SOL`,
    "Token Price": `${tokenPrice.toFixed(9)} SOL`,
    "Received Token": tokenSymbol,
    "Received Token Address": receivedTokenMint,
    "Wallet": swapDetails.walletAddress,
    "Time": swapDetails.timeStamp,
    "Transaction": `https://solscan.io/tx/${txSignature}`,
    "messageText": confirmationMessage
  });

  console.log(`✅ Swap confirmed and reference saved for ${tokenSymbol}`);
}
  
  // Función actualizada para refrescar la confirmación de compra sin Moralis
  async function refreshBuyConfirmationV2(chatId, messageId, tokenMint) {
    let tokenSymbol = "Unknown";
  
    try {
      const tokenInfo = getTokenInfo(tokenMint);
      tokenSymbol = escapeMarkdown(tokenInfo.symbol || "N/A");
  
      const original = buyReferenceMap[chatId]?.[tokenMint];
      if (!original || !original.solBeforeBuy) {
        console.warn(`⚠️ No previous buy reference found for ${tokenMint}`);
        await bot.sendMessage(chatId, "⚠️ No previous purchase data found for this token.");
        return;
      }
  
      const pairAddress = tokenInfo.pair || tokenInfo.pairAddress;
      if (!pairAddress || pairAddress === "N/A") {
        console.warn(`⚠️ Token ${tokenMint} does not have a valid pairAddress.`);
        await bot.sendMessage(chatId, "❌ This token does not have a pair address for refresh.");
        return;
      }
  
      // 1️⃣ Obtenemos la cotización desde Jupiter
      const jupRes = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}&outputMint=So11111111111111111111111111111111111111112&amount=1000000000&slippageBps=500&priorityFeeBps=20`
      );
      if (!jupRes.ok) throw new Error(`Error fetching Jupiter quote: ${jupRes.statusText}`);
      const jupData = await jupRes.json();
  
      const outAmount = parseFloat(jupData.outAmount);
      const priceSolNow = outAmount / 1e9;
  
      // 🧮 Funciones formateadoras
      const formatDefault = (val) => {
        return val >= 1 ? val.toFixed(6) : val.toFixed(9).replace(/0+$/, "");
      };
  
      const formatWithZeros = (val) => {
        if (val >= 1) return val.toFixed(6);
        const str = val.toFixed(12);
        const forced = "0.000" + str.slice(2);
        const match = forced.match(/0*([1-9]\d{0,2})/);
        if (!match) return forced;
        const idx = forced.indexOf(match[1]);
        return forced.slice(0, idx + match[1].length + 1);
      };
  
      const formattedOriginalPrice = formatDefault(original.tokenPrice);
      const formattedCurrentPrice = formatWithZeros(priceSolNow);
  
      const currentPriceShown = parseFloat(formattedCurrentPrice);
      const currentValue = (original.receivedAmount * currentPriceShown).toFixed(6);
  
      const visualPriceSolNow = parseFloat(formatWithZeros(priceSolNow));
  
      let changePercent = 0;
      if (original.tokenPrice > 0) {
        changePercent = ((visualPriceSolNow - original.tokenPrice) / original.tokenPrice) * 100;
        if (!isFinite(changePercent)) changePercent = 0;
      }
      changePercent = changePercent.toFixed(2);
  
      const emojiPrice = changePercent > 100 ? "🚀" : changePercent > 0 ? "🟢" : "🔻";
  
      const pnlSol = parseFloat(currentValue) - parseFloat(original.solBeforeBuy);
      const emojiPNL = pnlSol > 0 ? "🟢" : pnlSol < 0 ? "🔻" : "➖";
  
      const receivedTokenMint = escapeMarkdown(tokenMint);
      const timeFormatted = original.time
        ? new Date(original.time).toLocaleString("en-US", { timeZone: "America/New_York" })
        : "Unknown";
  
      // 📬 Construir el mensaje final (sin datos de Moralis)
      const updatedMessage =
        `✅ *Swap completed successfully* 🔗 [View in Solscan](https://solscan.io/tx/${original.txSignature})\n` +
        `*SOL/${tokenSymbol}* (${escapeMarkdown(tokenInfo.dex || "Unknown DEX")})\n` +
        `🕒 *Time:* ${timeFormatted} (EST)\n\n` +
        `⚡️ SWAP ⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n` +
        `💲 *Token Price:* ${formattedOriginalPrice} SOL\n` +
        `💰 *Got:* ${original.receivedAmount.toFixed(3)} Tokens\n` +
        `💲 *Spent:* ${original.solBeforeBuy} SOL\n\n` +
        `⚡️ TRADE ⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n` +
        `💲 *Price Actual:* ${emojiPrice} ${formattedCurrentPrice} SOL (${changePercent}%)\n` +
        `💰 *You Get:* ${emojiPNL} ${currentValue} SOL\n\n` +
        `🔗 *Received Token ${tokenSymbol}:* \`${receivedTokenMint}\`\n` +
        `🔗 *Wallet:* \`${original.walletAddress}\``;
  
      await bot.editMessageText(updatedMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Refresh", callback_data: `refresh_buy_${receivedTokenMint}` },
              { text: "💯 Sell MAX", callback_data: `sell_${receivedTokenMint}_100` }
            ],
            [
              { text: "📈 📊 Chart+Txns", url: `https://pumpultra.fun/solana/${receivedTokenMint}.html` }
            ]
          ]
        }
      });
  
      console.log(`🔄 Buy confirmation refreshed for ${tokenSymbol}`);
    } catch (error) {
      const errorMessage = error?.response?.body?.description || error.message;
      if (errorMessage.includes("message is not modified")) {
        console.log(`⏸ Message not modified for ${tokenSymbol}, skipping.`);
        return;
      }
      console.error("❌ Error in refreshBuyConfirmationV2:", errorMessage);
      await bot.sendMessage(chatId, "❌ Error while refreshing token info.");
    }
  }

async function getSolPriceUSD() {
  try {
    const response = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: {
        inputMint: "So11111111111111111111111111111111111111112", // SOL
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        amount: 100000000, // 0.1 SOL (100M lamports)
        slippageBps: 50
      }
    });

    const data = response.data;

    if (!data || !data.outAmount) {
      console.error("❌ No se encontró 'outAmount' en la respuesta.");
      return null;
    }

    const solInLamports = 100000000; // 0.1 SOL
    const usdcDecimals = 6;

    // Convertimos el outAmount (USDC con 6 decimales) a USD
    const usdcAmount = parseFloat(data.outAmount) / Math.pow(10, usdcDecimals);
    const solAmount = solInLamports / 1e9; // Convertimos lamports a SOL

    const solPrice = usdcAmount / solAmount; // Precio de 1 SOL en USD

    return solPrice;

  } catch (error) {
    console.error("❌ Error al obtener el precio de SOL desde Jupiter:", error.message);
    return null;
  }
}

getSolPriceUSD().then(price => {
  if (price !== null) {
    console.log(`💰 Precio actual de SOL: $${price.toFixed(2)}`);
  } else {
    console.log('⚠️ No se pudo obtener el precio de SOL.');
  }
});

// 🔹 Escuchar firmas de transacción o mint addresses en mensajes
bot.onText(/^check (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].trim(); // Obtiene la entrada después de "check"

    // Validar si es una firma de transacción (Base58 de 87+ caracteres)
    const isTransactionSignature = /^[A-HJ-NP-Za-km-z1-9]{87,}$/.test(input);

    bot.sendMessage(chatId, "🔄 Fetching details...");

    try {
        let transactionSignature = null;
        let mintAddress = input;

        if (isTransactionSignature) {
            // Caso 1: El usuario ingresó una firma de transacción, buscamos el Mint Address
            transactionSignature = input;
            const transactionData = await getMintAddressFromTransaction(transactionSignature);

            if (!transactionData || !transactionData.mintAddress) {
                bot.sendMessage(chatId, "⚠️ Could not retrieve transaction details.");
                return;
            }

            mintAddress = transactionData.mintAddress;
        }

        // Ejecutar la función principal analyzeTransaction() con el Mint Address
        const analysisMessage = await analyzeTransaction(mintAddress, chatId);

        // Enviar el resultado solo al usuario que hizo la consulta
        bot.sendMessage(chatId, analysisMessage, { parse_mode: "Markdown" });

    } catch (error) {
        console.error("❌ Error processing request:", error);
        bot.sendMessage(chatId, "❌ Error retrieving data.");
    }
});

// 🔥 Cargar suscriptores al iniciar
loadUsers();

console.log("🤖 Bot de Telegram iniciado.");
