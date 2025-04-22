import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { Connection } from "@solana/web3.js";
import { Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, VersionedTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress, createCloseAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
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
let refreshRiskCount = {};
global.ADMIN_CHAT_ID = global.ADMIN_CHAT_ID || 472101348;
const proxyHost = "brd.superproxy.io";
const proxyPort = "33335";
const baseUsername = "brd-customer-hl_7a7f0241-zone-datacenter_proxy1";
const proxyPassword = "i75am5xil518";

// Lista de tus endpoints
const RPC_ENDPOINTS = [
    "https://mainnet.helius-rpc.com/?api-key=0c964f01-0302-4d00-a86c-f389f87a3f35",
    "https://mainnet.helius-rpc.com/?api-key=1b6d8190-08a4-48dd-8dbd-1a0f5861fa61",
    "https://mainnet.helius-rpc.com/?api-key=c42de7e4-9d4b-4d03-a866-9ce503b19b46",
    "https://mainnet.helius-rpc.com/?api-key=c62c4420-5caa-4e75-a727-7f1ca0925142"
  ];
  
  // Puntero para el siguiente endpoint a usar
  let nextRpcIndex = 0;
  // Set de endpoints ya asignados en la tanda concurrente
  const inUseRpc = new Set();
  
  function getNextRpc() {
    // Intentamos encontrar uno libre
    for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
      const idx = (nextRpcIndex + i) % RPC_ENDPOINTS.length;
      const url = RPC_ENDPOINTS[idx];
      if (!inUseRpc.has(url)) {
        // lo reservamos
        inUseRpc.add(url);
        nextRpcIndex = (idx + 1) % RPC_ENDPOINTS.length;
        return url;
      }
    }
    // Si todos están “in use”, simplemente usamos round‑robin sin bloqueo
    const url = RPC_ENDPOINTS[nextRpcIndex];
    nextRpcIndex = (nextRpcIndex + 1) % RPC_ENDPOINTS.length;
    return url;
  }
  
  function releaseRpc(url) {
    inUseRpc.delete(url);
  }

let ws;
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

/**
 * Cierra en background todas las ATAs vacías de un usuario SIN NOTIFICAR.
 * Diseñada para invocarse tras una venta.
 */
async function closeEmptyATAsAfterSell(chatId) {
    try {
      const user = users[chatId];
      if (!user?.privateKey || !user.walletPublicKey) return;
  
      const keypair    = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
      const connection = new Connection(
        "https://ros-5f117e-fast-mainnet.helius-rpc.com",
        "confirmed"
      );
  
      while (true) {
        const { value } = await connection.getParsedTokenAccountsByOwner(
          new PublicKey(user.walletPublicKey),
          { programId: TOKEN_PROGRAM_ID }
        );
        const empties = value
          .filter(acc => Number(acc.account.data.parsed.info.tokenAmount.amount) === 0)
          .slice(0, 25);
  
        if (empties.length === 0) break;
  
        const tx = new Transaction();
        for (let { pubkey } of empties) {
          tx.add(createCloseAccountInstruction(
            pubkey,
            new PublicKey(user.walletPublicKey),
            new PublicKey(user.walletPublicKey)
          ));
        }
  
        // Enviamos usando sendAndConfirmTransaction, que añade blockhash y feePayer
        await sendAndConfirmTransaction(
          connection,
          tx,
          [keypair],
          { skipPreflight: true }
        );
      }
    } catch (e) {
      console.error("closeEmptyATAsAfterSell error:", e);
    }
  }

// ==========================================
// VARIABLE GLOBAL PARA AUTO CREACIÓN DE ATA
// (Por defecto DESACTIVADA)
// ==========================================
let ataAutoCreationEnabled = false;

/**
 * Cierra todas las ATAs vacías de un usuario (en batchs de 25).
 * @param {string|number} chatId - ID de Telegram / clave en users[]
 * @returns {Promise<number>} total de ATAs cerradas
 */
async function closeEmptyATAs(chatId) {
  const user = users[chatId];
  if (!user?.privateKey || !user.walletPublicKey) return 0;

  const keypair    = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
  const connection = new Connection("https://ros-5f117e-fast-mainnet.helius-rpc.com", "confirmed");
  let closedTotal = 0;

  while (true) {
    const { value } = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(user.walletPublicKey),
      { programId: TOKEN_PROGRAM_ID }
    );
    const empties = value
      .filter(acc => Number(acc.account.data.parsed.info.tokenAmount.amount) === 0)
      .slice(0, 25);

    if (empties.length === 0) break;

    const tx = new Transaction();
    for (let { pubkey } of empties) {
      tx.add(createCloseAccountInstruction(
        pubkey,
        new PublicKey(user.walletPublicKey),
        new PublicKey(user.walletPublicKey)
      ));
    }
    await sendAndConfirmTransaction(connection, tx, [keypair]);
    closedTotal += empties.length;
  }

  return closedTotal;
}

// ─────────────────────────────────────────────
// Comando /ata on|off (individual por usuario + cierra ATAs al apagar)
// ─────────────────────────────────────────────
bot.onText(/\/ata/, async (msg) => {
  const chatId   = msg.chat.id;
  const cmdMsgId = msg.message_id;

  try {
    await bot.deleteMessage(chatId, cmdMsgId);
  } catch (err) {
    console.warn("Could not delete /ata command message:", err.message);
  }

  const text =
    "⚡️ *Turbo‑Charge ATA Mode!* ⚡️\n\n" +
    "Pre‑create your Associated Token Accounts before token drops hit Solana—no more delays at purchase time! " +
    "A small refundable fee applies, but you’ll get it all back the moment you switch *OFF* ATA auto‑creation.";

  await bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ ON",  callback_data: "ata_on"  },
          { text: "❌ OFF", callback_data: "ata_off" }
        ]
      ]
    }
  });
});

// 2) Handler para los botones ON / OFF
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;

  if (data === "ata_on") {
    users[chatId] = users[chatId] || {};
    users[chatId].ataAutoCreationEnabled = true;
    saveUsers();

    await bot.editMessageText("✅ Auto‑creation of ATAs is now *ENABLED*", {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "Markdown"
    });
    return bot.answerCallbackQuery(query.id);
  }

  if (data === "ata_off") {
    users[chatId] = users[chatId] || {};
    users[chatId].ataAutoCreationEnabled = false;
    saveUsers();

    // Confirmación inmediata
    await bot.editMessageText("❌ Auto‑creation of ATAs is now *DISABLED*", {
      chat_id: chatId,
      message_id: query.message.message_id,
      parse_mode: "Markdown"
    });
    await bot.answerCallbackQuery(query.id);

    // ➡️ Cerrar ATAs vacías
    const closed = await closeEmptyATAs(chatId);
    if (closed > 0) {
      await bot.sendMessage(chatId,
        `✅ Closed *${closed}* empty ATA account${closed !== 1 ? 's' : ''}. Rent deposits refunded!`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(chatId,
        `⚠️ No empty ATA accounts were found to close.`,
        { parse_mode: 'Markdown' }
      );
    }
    return;
  }

  // ... aquí seguirían otros callback_queries (buy_, sell_, etc.)
  return bot.answerCallbackQuery(query.id);
});

// ─────────────────────────────────────────────
// preCreateATAsForToken (filtra por each user.ataAutoCreationEnabled)
// ─────────────────────────────────────────────
async function preCreateATAsForToken(mintAddress) {
  const usersToProcess = Object.entries(users)
    .filter(([, user]) =>
      user.subscribed &&
      user.privateKey &&
      user.ataAutoCreationEnabled
    );

  await Promise.all(usersToProcess.map(async ([chatId, user]) => {
    const rpcUrl     = getNextRpc();
    const keypair    = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
    const connection = new Connection(rpcUrl, "processed");

    try {
      const ata     = await getAssociatedTokenAddress(new PublicKey(mintAddress), keypair.publicKey);
      const ataInfo = await connection.getAccountInfo(ata);
      if (ataInfo === null) {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            keypair.publicKey,
            ata,
            keypair.publicKey,
            new PublicKey(mintAddress)
          )
        );
        await sendAndConfirmTransaction(connection, tx, [keypair]);
      }
    } catch (err) {
      console.error(`❌ Error al crear ATA para ${chatId} usando ${rpcUrl}:`, err);
    } finally {
      releaseRpc(rpcUrl);
    }
  }));
}

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
        [{ text: "📘 How to Use the Bot", url: "https://gemsniping.com/docs" }]
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

// ────────────────────────────────
// 1) Comando /start y paso inicial
// ────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from.first_name || "there";
  
    if (users[chatId]?.walletPublicKey) {
      const expired = users[chatId].expired;
      const stillActive = expired === "never" || (expired && Date.now() < expired);
      users[chatId].subscribed = stillActive;
      saveUsers();
  
      if (stillActive) {
        return bot.sendMessage(chatId, `✅ You are already registered, *${firstName}*!`, { parse_mode: "Markdown" });
      }
      return bot.sendMessage(chatId, 
        `⚠️ Your subscription has *expired*, *${firstName}*.\n\nPlease choose a plan to continue:`, 
        { parse_mode: "Markdown" }
      ).then(() => showPaymentButtons(chatId));
    }
  
    // nuevo usuario
    users[chatId] = { step: 1, name: firstName };
    saveUsers();
  
    const m = await bot.sendMessage(chatId,
      `👋 Hello *${firstName}*! Welcome to *GEMSNIPING Bot*.\n\n📱 Please enter your *phone number*:`, 
      { parse_mode: "Markdown" }
    );
    users[chatId].msgId = m.message_id;
    saveUsers();
  });
  
  
  // ────────────────────────────────
  // 2) Handler de mensajes por paso
  // ────────────────────────────────
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    const messageId = msg.message_id;
  
    if (!users[chatId] || !users[chatId].step) return;
    const user = users[chatId];
    const msgId = user.msgId;
  
    // limpiamos el input del usuario
    await bot.deleteMessage(chatId, messageId).catch(() => {});
  
    switch (user.step) {
      case 1:
        // 📱 PHONE
        user.phone = text;
        user.step = 2;
        saveUsers();
        await bot.editMessageText("📧 Please enter your *email address*:", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        });
        break;
  
      case 2:
        // 📧 EMAIL
        user.email = text;
        user.step = 3;
        saveUsers();
        await bot.editMessageText("🆔 Please choose a *username*:", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        });
        break;
  
      case 3:
        // 🆔 USERNAME
        user.username = text;
        user.step = 4;
        saveUsers();
        await bot.editMessageText("🔑 Please enter your *Solana Private Key*:", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        });
        break;
  
      case 4:
        // 🔑 PRIVATE KEY
        try {
          const keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(text)));
          user.privateKey = text;
          user.walletPublicKey = keypair.publicKey.toBase58();
          user.step = 5;
          saveUsers();
  
          // ahora preguntamos por referral con botones
          await bot.editMessageText(
            "🎟️ Do you have a *referral code*?",
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ YES", callback_data: "referral_yes" },
                    { text: "❌ NO",   callback_data: "referral_no"  }
                  ]
                ]
              }
            }
          );
        } catch (err) {
          await bot.editMessageText("❌ Invalid private key. Please try again:", {
            chat_id: chatId,
            message_id: msgId
          });
        }
        break;
  
      // los pasos de código de referral ya no se manejan aquí,
      // pasan a callback_query abajo
  
      default:
        break;
    }
  });
  
  
  // ────────────────────────────────
  // 3) Handler de Yes/No para referral
  // ────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;
    const user   = users[chatId];
  
    // YES: pedimos el código
    if (data === "referral_yes") {
      user.step = 6;
      saveUsers();
      await bot.editMessageText("🔠 Please enter your *referral code*:", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      });
      return bot.answerCallbackQuery(query.id);
    }
  
    // NO: forzamos compra de suscripción
    if (data === "referral_no") {
      user.expired = null;
      user.step = 0;
      user.subscribed = false;
      saveUsers();
  
      await bot.editMessageText(
        "⚠️ No referral code provided. Please *purchase a subscription* to activate your account.",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        }
      );
      const paymentMsg = await showPaymentButtons(chatId);
      user.lastPaymentMsgId = paymentMsg.message_id;
      saveUsers();
  
      // evitamos parpadeos
      setTimeout(() => bot.deleteMessage(chatId, msgId).catch(() => {}), 300);
      return bot.answerCallbackQuery(query.id);
    }
  
    // respondemos otros callbacks sin texto
    await bot.answerCallbackQuery(query.id);
  });
  
  
  // ────────────────────────────────
  // 4) Handler de referral code (step 6)
  // ────────────────────────────────
  bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    const messageId = msg.message_id;
    const user = users[chatId];
    if (!user || user.step !== 6) return;
  
    // borramos input
    await bot.deleteMessage(chatId, messageId).catch(() => {});
  
    const msgId = user.msgId;
    const result = validateReferralCode(text);
    if (result.valid) {
      user.referrer   = result.referrer || "Unknown";
      user.rcode      = result.code;
      user.expired    = result.expiration;
      user.step       = 0;
      user.subscribed = result.expiration === "never" || Date.now() < result.expiration;
      saveUsers();
  
      const activeStatus = result.expiration === "never"
        ? "✅ Unlimited"
        : `✅ Active for ${Math.ceil((result.expiration - Date.now())/(1000*60*60*24))} day(s)`;
  
      const confirmation = `✅ *User Registered!*
👤 *Name:* ${user.name}
📱 *Phone:* ${user.phone}
📧 *Email:* ${user.email}
🆔 *Username:* ${user.username}
💼 *Wallet:* \`${user.walletPublicKey}\`
🔐 *Referral:* ${result.code} (${user.referrer})
⏳ *Status:* ${activeStatus}`;
  
      await bot.deleteMessage(chatId, msgId).catch(() => {});
      await bot.sendPhoto(chatId, "https://cdn.shopify.com/s/files/1/0784/6966/0954/files/pumppay.jpg?v=1743797016", {
        caption: confirmation,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚙️ Settings", callback_data: "settings_menu" }],
            [{ text: "📘 How to Use the Bot", url: "https://gemsniping.com/docs" }]
          ]
        }
      });
    } else {
      // código inválido
      user.expired    = null;
      user.step       = 0;
      user.subscribed = false;
      saveUsers();
      await bot.editMessageText(
        "⚠️ Invalid or expired code. Please *purchase a subscription* to activate your account.",
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      );
      showPaymentButtons(chatId);
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

// tras: const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
bot.setMyCommands([
    { command: 'autobuy',  description: '🚀 Enable auto‑buy (for a single token only) or stop auto‑buy' },
    { command: 'ata',         description: '⚡️ Accelerate Associated Token Account creation or stop auto-creation' },
    { command: 'close', description: '🔒 close empty ATAs and instantly reclaim your SOL rent deposits' },
]);

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
  
    const maxRetries = 30;
    const delayMs = 2000;
  
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

  async function fetchRugCheckData(tokenAddress) {
    // 🔸 PRIMER INTENTO: RugCheck con timeout de 2000 ms
    try {
      console.log("🔍 Intentando obtener datos desde RugCheck...");
      const response = await axios.get(`https://api.rugcheck.xyz/v1/tokens/${tokenAddress}/report`, {
        timeout: 2000 // 2 segundos de espera máximo
      });
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
      console.warn(`⚠️ RugCheck falló (2s timeout o error): ${error.message}`);
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
    // Validaciones iniciales
    if (!dexData || !mintData || !rugCheckData) {
      return;
    }

    // Formatear la información a guardar
    const tokenInfo = {
      name:                 dexData.name               || "Unknown",
      symbol:               dexData.symbol             || "Unknown",
      tokenAddress:         dexData.tokenAddress       || "N/A",
      tokenLogo:            dexData.tokenLogo          || "",
      USD:                  dexData.priceUsd           || "N/A",
      SOL:                  dexData.priceSol           || "N/A",
      liquidity:            dexData.liquidity          || "N/A",
      liquidityChange24h:   dexData.liquidityChange24h || "N/A",
      priceChange24h:       dexData.priceChange24h     || "N/A",
      buyVolume24h:         dexData.buyVolume24h       || "N/A",
      sellVolume24h:        dexData.sellVolume24h      || "N/A",
      totalVolume24h:       dexData.totalVolume24h     || "N/A",
      buys24h:              dexData.buys24h            || "0",
      sells24h:             dexData.sells24h           || "0",
      buyers24h:            dexData.buyers24h          || "0",
      sellers24h:           dexData.sellers24h         || "0",
      riskLevel:            rugCheckData.riskLevel     || "N/A",
      warning:              rugCheckData.riskDescription || "No risks detected",
      LPLOCKED:             rugCheckData.lpLocked      || "N/A",
      freezeAuthority:      rugCheckData.freezeAuthority || "N/A",
      mintAuthority:        rugCheckData.mintAuthority || "N/A",
      chain:                dexData.chain              || "solana",
      dex:                  dexData.dex                || "N/A",
      pair:                 dexData.pairAddress        || "N/A",
      pairLabel:            dexData.pairLabel          || "N/A",
      exchangeAddress:      dexData.exchangeAddress    || "N/A",
      exchangeLogo:         dexData.exchangeLogo       || "",
      migrationDate:        typeof mintData.date === "number" ? mintData.date : null,
      status:               mintData.status            || "N/A",
      token:                mintData.mintAddress       || "N/A"
    };

    const filePath = 'tokens.json';
    let tokens = {};

    // Leer o inicializar el archivo
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        tokens = content ? JSON.parse(content) : {};
      } catch {
        fs.writeFileSync(filePath, "{}", 'utf-8');
        tokens = {};
      }
    }

    // Validar que tengamos un mint válido
    const key = mintData.mintAddress;
    if (!key || key === "N/A") {
      return;
    }

    // Actualizar y guardar
    tokens[key] = tokenInfo;
    try {
      fs.writeFileSync(filePath, JSON.stringify(tokens, null, 2), 'utf-8');
    } catch {
      // Silenciar errores de escritura
    }
}

// Función de lectura sin logs
function getTokenInfo(mintAddress) {
  const filePath = 'tokens.json';
  if (!fs.existsSync(filePath)) {
    return { symbol: "N/A", name: "N/A" };
  }
  const tokens = JSON.parse(fs.readFileSync(filePath, 'utf-8')) || {};
  return tokens[mintAddress] || { symbol: "N/A", name: "N/A" };
}

// Función para comprar tokens usando Ultra API de Jupiter con conexión a Helius optimizada
async function buyToken(chatId, mint, amountSOL, attempt = 1) {
    let rpcUrl;
    try {
      const user = users[chatId];
      if (!user || !user.privateKey) {
        throw new Error("User not registered or missing privateKey.");
      }
  
      // 1) Reservar un RPC distinto
      rpcUrl = getNextRpc();
      const connection = new Connection(rpcUrl, "processed");
  
      // 2) Keypair y wallet
      const userKeypair   = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
      const userPublicKey = userKeypair.publicKey;
  
      // 3) Crear/asegurar ATA y chequear balance simultáneo
      const [ata, balanceLamports] = await Promise.all([
        ensureAssociatedTokenAccount(userKeypair, mint, connection),
        connection.getBalance(userPublicKey, "processed")
      ]);
      if (!ata) {
        await new Promise(r => setTimeout(r, 1000));
        return buyToken(chatId, mint, amountSOL, attempt + 1);
      }
      const balanceSOL = balanceLamports / 1e9;
      if (balanceSOL < amountSOL) {
        throw new Error(`Not enough SOL. Balance: ${balanceSOL}, Required: ${amountSOL}`);
      }
  
      // ── USANDO LOS ENDPOINTS ULTRA DE JUPITER ──
      const orderParams = {
        inputMint:  "So11111111111111111111111111111111111111112", // SOL (Wrapped SOL)
        outputMint: mint,
        amount:     Math.floor(amountSOL * 1e9).toString(),
        taker:      userPublicKey.toBase58(),
        dynamicSlippage: true
      };
      const orderRes = await axios.get("https://lite-api.jup.ag/ultra/v1/order", {
        params: orderParams,
        headers: { Accept: "application/json" }
      });
      if (!orderRes.data) {
        throw new Error("Failed to receive order details from Ultra API.");
      }
      let unsignedTx = orderRes.data.unsignedTransaction || orderRes.data.transaction;
      const requestId = orderRes.data.requestId;
      if (!unsignedTx || !requestId) {
        throw new Error("Invalid order response from Ultra API.");
      }
      unsignedTx = unsignedTx.trim();
  
      // Deserializar, firmar y volver a serializar la transacción
      const txBuf = Buffer.from(unsignedTx, "base64");
      let signedTxBase64;
      try {
        const vtx = VersionedTransaction.deserialize(txBuf);
        vtx.sign([userKeypair]);
        signedTxBase64 = Buffer.from(vtx.serialize()).toString("base64");
      } catch {
        const legacy = Transaction.from(txBuf);
        legacy.sign(userKeypair);
        signedTxBase64 = Buffer.from(legacy.serialize()).toString("base64");
      }
  
      // Ejecutar la transacción mediante Ultra Execute (incluyendo prioritizationFeeLamports)
      const executePayload = {
        signedTransaction:          signedTxBase64,
        requestId:                  requestId,
        prioritizationFeeLamports:  5000000 // Valor configurable
      };
      const execRes = await axios.post(
        "https://lite-api.jup.ag/ultra/v1/execute",
        executePayload,
        { headers: { "Content-Type": "application/json", Accept: "application/json" } }
      );
      const exec = execRes.data || {};
      if (exec.status !== "Success" || !(exec.txSignature || exec.signature)) {
        throw new Error("Invalid execute response from Ultra API: " + JSON.stringify(exec));
      }
      const txSignature = exec.txSignature || exec.signature;
  
      // ── GUARDAR EN buyReferenceMap ──
      buyReferenceMap[chatId] = buyReferenceMap[chatId] || {};
      buyReferenceMap[chatId][mint] = {
        txSignature,
        executeResponse: exec
      };
  
      return txSignature;
  
    } catch (error) {
      const errorMessage = error.message || "";
      console.error(
        `❌ Error in purchase attempt ${attempt}:`,
        errorMessage,
        error.response ? JSON.stringify(error.response.data) : ""
      );
      if (attempt < 6) {
        await new Promise(r => setTimeout(r, 500));
        return buyToken(chatId, mint, amountSOL, attempt + 1);
      }
      return Promise.reject(error);
  
    } finally {
      // Liberar el RPC para futuras llamadas
      if (rpcUrl) releaseRpc(rpcUrl);
    }
  }

async function getTokenBalance(chatId, mint) {
    try {
        if (!users[chatId] || !users[chatId].walletPublicKey) {
            return 0;
        }

        const userPublicKeyString = users[chatId].walletPublicKey;
        
        if (!userPublicKeyString || typeof userPublicKeyString !== "string") {
            return 0;
        }

        const userPublicKey = new PublicKey(userPublicKeyString); // 🔥 Corrección aquí


        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(userPublicKey, {
            mint: new PublicKey(mint)
        });

        if (tokenAccounts.value.length > 0) {
            const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
            return balance;
        }

        return 0;
    } catch (error) {
        return 0;
    }
}

// Función para vender tokens usando Ultra API de Jupiter
async function sellToken(chatId, mint, amount, attempt = 1) {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    let rpcUrl;
  
    try {
      const user = users[chatId];
      if (!user?.privateKey) return null;
  
      // 1) Reservar un endpoint distinto
      rpcUrl = getNextRpc();
      const connection = new Connection(rpcUrl, "processed");
  
      // 2) Keypair y pedir orden unsigned
      const wallet = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
      const orderRes = await axios.get("https://lite-api.jup.ag/ultra/v1/order", {
        params: {
          inputMint:  mint,
          outputMint: SOL_MINT,
          amount:     amount.toString(),
          taker:      wallet.publicKey.toBase58(),
          dynamicSlippage: true
        },
        headers: { Accept: "application/json" }
      });
      const { unsignedTransaction, requestId, transaction } = orderRes.data || {};
      const txData = (unsignedTransaction || transaction || "").trim();
      if (!txData || !requestId) {
        throw new Error("Invalid order response from Ultra API for sell.");
      }
  
      // 3) Deserializar y firmar localmente
      const txBuf = Buffer.from(txData, "base64");
      let signedTxBase64;
      try {
        const vtx = VersionedTransaction.deserialize(txBuf);
        vtx.sign([wallet]);
        signedTxBase64 = Buffer.from(vtx.serialize()).toString("base64");
      } catch {
        const legacy = Transaction.from(txBuf);
        legacy.sign(wallet);
        signedTxBase64 = Buffer.from(legacy.serialize()).toString("base64");
      }
  
      // 4) Ejecutar con Ultra Execute
      const executePayload = {
        signedTransaction:         signedTxBase64,
        requestId:                 requestId,
        prioritizationFeeLamports: 6000000
      };
      const execRes = await axios.post(
        "https://lite-api.jup.ag/ultra/v1/execute",
        executePayload,
        { headers: { "Content-Type": "application/json", Accept: "application/json" } }
      );
      const exec = execRes.data || {};
      if (exec.status !== "Success" || !(exec.txSignature || exec.signature)) {
        throw new Error("Invalid execute response from Ultra API for sell: " + JSON.stringify(exec));
      }
      const txSignatureFinal = exec.txSignature || exec.signature;
  
      // 5) Merge de la referencia sin perder solBeforeBuy
      buyReferenceMap[chatId] = buyReferenceMap[chatId] || {};
      buyReferenceMap[chatId][mint] = buyReferenceMap[chatId][mint] || {};
      Object.assign(buyReferenceMap[chatId][mint], {
        txSignature:     txSignatureFinal,
        executeResponse: exec
      });
  
      // 6) Disparar el cierre silencioso de ATAs tras la venta
      setImmediate(() => {
        closeEmptyATAsAfterSell(chatId);
      });
  
      return txSignatureFinal;
  
    } catch (error) {
      if (attempt < 6) {
        const delay = 500 * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
        return sellToken(chatId, mint, amount, attempt + 1);
      }
      return Promise.reject(error);
    } finally {
      // 7) Liberar el RPC
      if (rpcUrl) releaseRpc(rpcUrl);
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

// 🔹 Función para verificar y crear la ATA si no existe usando commitment "processed"
async function ensureAssociatedTokenAccount(wallet, mint, connection) {
    try {
      // Calcular la dirección ATA para el mint y la wallet del usuario.
      const ata = await getAssociatedTokenAddress(new PublicKey(mint), wallet.publicKey);
  
      // Consultar si la ATA ya existe en la blockchain usando commitment "processed" para respuesta rápida.
      const ataInfo = await connection.getAccountInfo(ata, "processed");
      if (ataInfo !== null) {
        return ata;
      }
  
      // Si no existe, se crea la instrucción para la ATA.
      const transaction = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,     // Payer: quien paga la transacción.
          ata,                  // Dirección de la ATA a crear.
          wallet.publicKey,     // Owner: dueño de la ATA (la misma wallet).
          new PublicKey(mint)   // Mint del token.
        )
      );
  
      // Enviar la transacción usando el commitment "processed" para acelerar la confirmación.
      await sendAndConfirmTransaction(connection, transaction, [wallet], { commitment: "processed" });
  
      return ata;
    } catch (error) {
      // Propagamos el error para que quien llame a esta función pueda manejarlo.
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
  
    // 1) Obtener mint desde la tx
    const mintData = await getMintAddressFromTransaction(signature);
    if (!mintData?.mintAddress) return;
  
    // 2) No procesar dos veces el mismo mint
    if (processedMints[mintData.mintAddress]) return;
    processedMints[mintData.mintAddress] = true;
    saveProcessedMints();
  
    // Pre‑creación de ATAs (fire‑and‑forget)
    preCreateATAsForToken(mintData.mintAddress)
      .catch(err => console.error("❌ Error pre‑creating ATAs:", err.message));
  
    // ——— AUTO‑BUY INMEDIATO AL DETECTAR TOKEN “POSITIVO” ———
    for (const [chatId, user] of Object.entries(users)) {
      if (
        user.subscribed &&
        user.privateKey &&
        user.autoBuyEnabled &&
        user.autoBuyTrigger === 'detect'
      ) {
        const amountSOL = user.autoBuyAmount;
        const mint      = mintData.mintAddress;
  
        // Desactivar auto‑buy para no repetirlo
        user.autoBuyEnabled = false;
        saveUsers();
  
        try {
          // Mensaje inicial
          const sent      = await bot.sendMessage(
            chatId,
            `🛒 Auto‑buying ${amountSOL} SOL for ${mint}…`
          );
          const messageId = sent.message_id;
  
          // Ejecutar compra
          const txSignature = await buyToken(chatId, mint, amountSOL);
          if (!txSignature) {
            await bot.editMessageText(
              `❌ Auto‑Buy failed for ${mint}.`,
              { chat_id: chatId, message_id }
            );
            continue;
          }
  
          // Obtener detalles y confirmar
          const swapDetails = await getSwapDetailsHybrid(txSignature, mint, chatId);
          await confirmBuy(chatId, swapDetails, messageId, txSignature);
        } catch (err) {
          console.error(`❌ Error en Auto‑Buy para ${chatId}:`, err);
          await bot.sendMessage(chatId, `❌ Auto‑Buy error: ${err.message}`);
        }
      }
    }
  
    // ——— Resto del flujo manual de análisis ———
    const alertMessages = {};
    for (const userId in users) {
      const user = users[userId];
      if (user.subscribed && user.privateKey) {
        try {
          const msg = await bot.sendMessage(
            userId,
            "🚨 Token incoming. *Prepare to Buy‼️* 🚨",
            { parse_mode: "Markdown" }
          );
          alertMessages[userId] = msg.message_id;
          setTimeout(() => bot.deleteMessage(userId, msg.message_id).catch(() => {}), 60_000);
        } catch (_) {}
      }
    }
  
    // 3) Obtener datos en SolanaTracker → Moralis → RugCheck
    const pairAddress = await getPairAddressFromSolanaTracker(mintData.mintAddress);
    if (!pairAddress) return;
  
    const dexData = await getDexScreenerData(pairAddress);
    if (!dexData) {
      for (const userId in alertMessages) {
        await bot.editMessageText(
          "⚠️ Token discarded due to insufficient info for analysis.",
          {
            chat_id: userId,
            message_id: alertMessages[userId],
            parse_mode: "Markdown"
          }
        ).catch(() => {});
      }
      return;
    }
  
    const rugCheckData = await fetchRugCheckData(mintData.mintAddress);
    if (!rugCheckData) return;
  
    // ——— AUTO‑BUY INMEDIATO AL NOTIFICAR EL TOKEN ———
    for (const [chatId, user] of Object.entries(users)) {
      if (
        user.subscribed &&
        user.privateKey &&
        user.autoBuyEnabled &&
        user.autoBuyTrigger === 'notify'
      ) {
        const amountSOL = user.autoBuyAmount;
        const mint      = mintData.mintAddress;
  
        // Desactivar auto‑buy para no repetirlo
        user.autoBuyEnabled = false;
        saveUsers();
  
        try {
          // Mensaje inicial
          const sent      = await bot.sendMessage(
            chatId,
            `🛒 Auto‑buying ${amountSOL} SOL for ${mint}…`
          );
          const messageId = sent.message_id;
  
          // Ejecutar compra
          const txSignature = await buyToken(chatId, mint, amountSOL);
          if (!txSignature) {
            await bot.editMessageText(
              `❌ Auto‑Buy failed for ${mint}.`,
              { chat_id: chatId, message_id }
            );
            continue;
          }
  
          // Obtener detalles y confirmar
          const swapDetails = await getSwapDetailsHybrid(txSignature, mint, chatId);
          await confirmBuy(chatId, swapDetails, messageId, txSignature);
        } catch (err) {
          console.error(`❌ Error en Auto‑Buy para ${chatId}:`, err);
          await bot.sendMessage(chatId, `❌ Auto‑Buy error: ${err.message}`);
        }
      }
    }
  
    // ——— Continuar con tu flujo de notificaciones ———
    const priceChange24h = dexData.priceChange24h !== "N/A"
      ? `${dexData.priceChange24h > 0 ? "🟢 +" : "🔴 "}${Number(dexData.priceChange24h).toFixed(2)}%`
      : "N/A";
    const liquidityChange = dexData.liquidityChange24h || 0;
    const liquidity24hFormatted = `${liquidityChange >= 0 ? "🟢 +" : "🔴 "}${Number(liquidityChange).toFixed(2)}%`;
    const migrationTimestamp = mintData.date || Date.now();
    const age = calculateAge(migrationTimestamp);
    const createdDate = formatTimestampToUTCandEST(migrationTimestamp);
    const buys24h   = Number(dexData.buys24h)   || 0;
    const sells24h  = Number(dexData.sells24h)  || 0;
    const buyers24h = Number(dexData.buyers24h) || 0;
    const sellers24h= Number(dexData.sellers24h)|| 0;
  
    saveTokenData(dexData, mintData, rugCheckData, age, priceChange24h);
  
    let message = `💎 **Symbol:** ${escapeMarkdown(dexData.symbol)}\n`;
    message += `💎 **Name:** ${escapeMarkdown(dexData.name)}\n`;
    message += `⏳ **Age:** ${escapeMarkdown(age)} 📊 **24H:** ${escapeMarkdown(liquidity24hFormatted)}\n\n`;
    message += `💲 **USD:** ${escapeMarkdown(dexData.priceUsd)}\n`;
    message += `💰 **SOL:** ${escapeMarkdown(dexData.priceSol)}\n`;
    message += `💧 **Liquidity:** $${Number(dexData.liquidity).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}\n\n`;
    message += `🟩 Buys 24h: ${buys24h} 🟥 Sells 24h: ${sells24h}\n`;
    message += `💵 Buy Vol 24h: $${Number(dexData.buyVolume24h).toLocaleString(undefined,{maximumFractionDigits:2})}\n`;
    message += `💸 Sell Vol 24h: $${Number(dexData.sellVolume24h).toLocaleString(undefined,{maximumFractionDigits:2})}\n`;
    message += `🧑‍🤝‍🧑 Buyers: ${buyers24h} 👤 Sellers: ${sellers24h}\n\n`;
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
        { text: "📊 Chart+Txns", url: `https://gemsniping.com/solana/${mint}` }
      ],
      [
        { text: "💰 0.1 Sol", callback_data: `buy_${mint}_0.1` },
        { text: "💰 0.2 Sol", callback_data: `buy_${mint}_0.2` },
        { text: "💰 0.3 Sol", callback_data: `buy_${mint}_0.3` }
      ],
      [
        { text: "💰 0.5 Sol", callback_data: `buy_${mint}_0.5` },
        { text: "💰 1.0 Sol", callback_data: `buy_${mint}_1.0` },
        { text: "💰 2.0 Sol", callback_data: `buy_${mint}_2.0` }
      ],
      [
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

 // Comando /autobuy
bot.onText(/\/autobuy/, async (msg) => {
    const chatId   = msg.chat.id;
    const cmdMsgId = msg.message_id;
  
    try {
      await bot.deleteMessage(chatId, cmdMsgId);
    } catch (err) {
      console.warn("Could not delete command message:", err.message);
    }
  
    const intro =
      "🚀 *Auto‑Buy Turbo Mode!* 🚀\n\n" +
      "Get fresh tokens the moment they land on Solana—hands‑free and lightning‑fast! " +
      "Turn it *ON*, pick your amount, and watch the bot work. " +
      "Turn it *OFF* anytime and I'll stop buying tokens.";
  
    const keyboard = [
      [
        { text: "✅ Enable",  callback_data: "autobuy_toggle_on"  },
        { text: "❌ Disable", callback_data: "autobuy_toggle_off" }
      ]
    ];
  
    await bot.sendMessage(chatId, intro, {
      parse_mode:   'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  });
  
  // Handler de toggles y selección de monto
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
  
    // ── Toggle OFF ──
    if (data === 'autobuy_toggle_off') {
      users[chatId] = users[chatId] || {};
      users[chatId].autoBuyEnabled = false;
      saveUsers();
      await bot.answerCallbackQuery(query.id, { text: '❌ Auto‑Buy disabled.' });
      return bot.editMessageText(
        '❌ *Auto‑Buy is now DISABLED!*',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown'
        }
      );
    }
  
    // ── Enable Auto‑Buy ──
    if (data === 'autobuy_toggle_on') {
      users[chatId] = users[chatId] || {};
      users[chatId].autoBuyEnabled = true;
      saveUsers();
      await bot.answerCallbackQuery(query.id, { text: '✅ Auto‑Buy enabled.' });
  
      // 👉 Nueva etapa: elegir momento de disparo
      const text = '⌚ *When should I trigger Auto‑Buy?*';
      const keyboard = [
        [{ text: '1️⃣ When a token is detected', callback_data: 'autobuy_trigger_detect' }],
        [{ text: '2️⃣ When the token is announced',           callback_data: 'autobuy_trigger_notify' }]
      ];
      return bot.editMessageText(text, {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  
    // ── Selección de trigger ──
    if (data === 'autobuy_trigger_detect' || data === 'autobuy_trigger_notify') {
      const trigger = data === 'autobuy_trigger_detect' ? 'detect' : 'notify';
      users[chatId].autoBuyTrigger = trigger;
      saveUsers();
      await bot.answerCallbackQuery(query.id);
  
      // Ahora preguntamos el monto
      const keyboard = [
        [0.1, 0.2, 0.3].map(x => ({ text: `💰 ${x} SOL`, callback_data: `autobuy_amt_${x}` })),
        [0.5, 1.0, 2.0].map(x => ({ text: `💰 ${x} SOL`, callback_data: `autobuy_amt_${x}` }))
      ];
      return bot.editMessageText(
        '✅ *Great!*  \n\n' +
        '💰 *How much SOL would you like me to auto‑buy each time?*',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: keyboard }
        }
      );
    }
  
    // ── Capturar monto seleccionado ──
    if (data.startsWith('autobuy_amt_')) {
      const amount = parseFloat(data.replace('autobuy_amt_',''));
      users[chatId].autoBuyAmount = amount;
      saveUsers();
      await bot.answerCallbackQuery(query.id, { text: `✅ Set to ${amount} SOL` });
      return bot.editMessageText(
        '🎉 *Auto‑Buy configured!*  \n\n' +
        `It will now automatically purchase *${amount} SOL* according to your preference.`,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }
      );
    }
  
    // Si no era un callback de Auto‑Buy, dejamos que otros handlers lo procesen
    return;
  });

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
        await bot.answerCallbackQuery(query.id, { text: "✅ Purchase updated." });
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
          await bot.answerCallbackQuery(query.id, { text: "Token not found." });
          return;
        }
  
        // Se obtiene el pairAddress almacenado en el token
        const pairAddress = originalTokenData.pair || originalTokenData.pairAddress;
        if (!pairAddress) {
          await bot.answerCallbackQuery(query.id, { text: "Pair not available." });
          return;
        }
  
        // Actualización de datos de riesgo solo cada 10 refresh para este token:
        if (!refreshRiskCount[mint]) {
          refreshRiskCount[mint] = 1;
        } else {
          refreshRiskCount[mint]++;
        }
        let updatedRiskLevel, updatedWarning;
        if (refreshRiskCount[mint] % 16 === 1) {
          // Solo en el primer refresh (y cada 16 refresh) se actualiza la data de riesgo
          const rugCheckData = await fetchRugCheckData(mint);
          if (rugCheckData) {
            updatedRiskLevel = rugCheckData.riskLevel;
            updatedWarning = rugCheckData.riskDescription;
            // Opcional: se podría actualizar la información en originalTokenData para cachear la nueva data
          } else {
            updatedRiskLevel = originalTokenData.riskLevel;
            updatedWarning = originalTokenData.warning;
          }
        } else {
          // En los refrescos intermedios se usa la data ya almacenada
          updatedRiskLevel = originalTokenData.riskLevel;
          updatedWarning = originalTokenData.warning;
        }
  
        // Obtener datos "live" de mercado (actualización siempre)
        let updatedDexData;
        try {
          updatedDexData = await getDexScreenerData(pairAddress);
        } catch (err) {
          await bot.answerCallbackQuery(query.id, { text: "Error updating data." });
          return;
        }
        if (!updatedDexData) {
          await bot.answerCallbackQuery(query.id, { text: "Could not fetch updated data." });
          return;
        }
  
        // Calcular y formatear datos
        const age = calculateAge(originalTokenData.migrationDate) || "N/A";
        const createdDate = formatTimestampToUTCandEST(originalTokenData.migrationDate);
        const priceChange24h = updatedDexData.priceChange24h !== "N/A" && !isNaN(Number(updatedDexData.priceChange24h))
          ? `${Number(updatedDexData.priceChange24h) > 0 ? "🟢 +" : "🔴 "}${Number(updatedDexData.priceChange24h).toFixed(2)}%`
          : "N/A";
        const liveUsd = !isNaN(Number(updatedDexData.priceUsd))
          ? Number(updatedDexData.priceUsd).toFixed(6)
          : "N/A";
        const liveSol = !isNaN(Number(updatedDexData.priceSol))
          ? Number(updatedDexData.priceSol).toFixed(9)
          : "N/A";
        const liveLiquidity = !isNaN(Number(updatedDexData.liquidity))
          ? Number(updatedDexData.liquidity).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : "N/A";
  
        // Construir el mensaje actualizado combinando datos guardados y en vivo
        let updatedMessage = `💎 **Symbol:** ${escapeMarkdown(originalTokenData.symbol)}\n`;
        updatedMessage += `💎 **Name:** ${escapeMarkdown(originalTokenData.name)}\n`;
        updatedMessage += `💲 **USD:** ${escapeMarkdown(String(originalTokenData.USD))}\n`;
        updatedMessage += `💰 **SOL:** ${escapeMarkdown(String(originalTokenData.SOL))}\n\n`;
        
        updatedMessage += `📊 **Live Market Update:**\n`;
        updatedMessage += `⏳ **Age:** ${escapeMarkdown(age)} 📊 **24H:** ${escapeMarkdown(priceChange24h)}\n`;
        updatedMessage += `💲 **USD:** ${escapeMarkdown(liveUsd)}\n`;
        updatedMessage += `💰 **SOL:** ${escapeMarkdown(liveSol)}\n`;
        updatedMessage += `💧 **Liquidity:** $${escapeMarkdown(liveLiquidity)}\n\n`;
        
        updatedMessage += `🟩 **Buys 24h:** ${updatedDexData.buys24h ?? "N/A"} 🟥 **Sells 24h:** ${updatedDexData.sells24h ?? "N/A"}\n`;
        updatedMessage += `💵 Buy Vol 24h: $${Number(updatedDexData.buyVolume24h ?? 0).toLocaleString()}\n`;
        updatedMessage += `💸 Sell Vol 24h: $${Number(updatedDexData.sellVolume24h ?? 0).toLocaleString()}\n`;
        updatedMessage += `🧑‍🤝‍🧑 Buyers: ${updatedDexData.buyers24h ?? "N/A"} 👤 Sellers: ${updatedDexData.sellers24h ?? "N/A"}\n`;
        const liqChange = updatedDexData.liquidityChange24h !== "N/A" && !isNaN(Number(updatedDexData.liquidityChange24h))
          ? `${Number(updatedDexData.liquidityChange24h) >= 0 ? "🟢 +" : "🔴 "}${Number(updatedDexData.liquidityChange24h).toFixed(2)}%`
          : "N/A";
        updatedMessage += `📊 **Liquidity Δ 24h:** ${liqChange}\n\n`;
        
        updatedMessage += `**${escapeMarkdown(updatedRiskLevel)}:** ${escapeMarkdown(updatedWarning)}\n`;
        updatedMessage += `🔒 **LPLOCKED:** ${escapeMarkdown(String(originalTokenData.LPLOCKED))}%\n`;
        updatedMessage += `🔐 **Freeze Authority:** ${escapeMarkdown(String(originalTokenData.freezeAuthority || "N/A"))}\n`;
        updatedMessage += `🪙 **Mint Authority:** ${escapeMarkdown(String(originalTokenData.mintAuthority || "N/A"))}\n\n`;
        
        updatedMessage += `⛓️ **Chain:** ${escapeMarkdown(originalTokenData.chain)} ⚡ **Dex:** ${escapeMarkdown(originalTokenData.dex)}\n`;
        updatedMessage += `📆 **Created:** ${createdDate}\n\n`;
        updatedMessage += `🔗 **Token:** \`${escapeMarkdown(mint)}\`\n`;
        if (originalTokenData.signature) {
          updatedMessage += `🔗 **Signature:** \`${escapeMarkdown(originalTokenData.signature)}\``;
        }
        
        const reply_markup = {
          inline_keyboard: [
            [
                { text: "🔄 Refresh Info", callback_data: `refresh_${mint}` },
                { text: "📊 Chart+Txns", url: `https://gemsniping.com/solana/${mint}` }
              ],
              [
                { text: "💰 0.1 Sol", callback_data: `buy_${mint}_0.1` },
                { text: "💰 0.2 Sol", callback_data: `buy_${mint}_0.2` },
                { text: "💰 0.3 Sol", callback_data: `buy_${mint}_0.3` }
      ],
      [
                { text: "💰 0.5 Sol", callback_data: `buy_${mint}_0.5` },
                { text: "💰 1.0 Sol", callback_data: `buy_${mint}_1.0` },
                { text: "💰 2.0 Sol", callback_data: `buy_${mint}_2.0` }
              ],
              [
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
  
        await bot.answerCallbackQuery(query.id, { text: "Data updated." });
      } else {
        await bot.answerCallbackQuery(query.id);
      }
    } catch (err) {
      console.error("❌ Error en callback_query:", err);
      await bot.answerCallbackQuery(query.id, { text: "An error occurred." });
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

// Constante para el mint de SOL envuelto
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Obtiene los detalles de un swap **solo** a partir de la respuesta de Jupiter Ultra
 * previamente guardada en buyReferenceMap.
 */
async function getSwapDetailsHybrid(signature, expectedMint, chatId) {
  // 1) Recuperar la respuesta Ultra de buyReferenceMap
  const ref = buyReferenceMap[chatId]?.[expectedMint];
  const jup = ref?.executeResponse;
  if (!jup || (jup.txSignature || jup.signature) !== signature) {
    throw new Error("Jupiter response not found or signature mismatch");
  }
  if (jup.status !== "Success") {
    throw new Error(`Swap not successful: ${jup.status}`);
  }

  // 2) Montos crudos en lamports
  const inLam  = BigInt(jup.inputAmountResult   || jup.totalInputAmount);
  const outLam = BigInt(jup.outputAmountResult  || jup.totalOutputAmount);
  const inMint  = jup.swapEvents[0].inputMint;
  const outMint = jup.swapEvents[0].outputMint;

  // 3) Decimales de cada lado
  const decIn  = inMint  === SOL_MINT ? 9 : await getTokenDecimals(inMint);
  const decOut = outMint === SOL_MINT ? 9 : await getTokenDecimals(outMint);

  // 4) Convertir a unidades humanas
  let inputAmount, soldAmount, receivedAmount;

  if (inMint === SOL_MINT) {
    // ➜ Compra: gastaste SOL y recibiste tokens
    inputAmount    = Number(inLam) / 1e9;            // SOL gastado
    soldAmount     = inputAmount;                   // lo "vendido" es SOL
    receivedAmount = Number(outLam) / (10 ** decOut);// tokens recibidos
  } else {
    // ➜ Venta: vendiste tokens y recibiste SOL
    inputAmount    = Number(inLam)  / (10 ** decIn); // tokens vendidos
    soldAmount     = inputAmount;                   // lo "vendido" es ese token
    receivedAmount = Number(outLam) / 1e9;          // SOL recibido
  }

  // 5) Símbolos y nombres
  const soldSym = inMint  === SOL_MINT
    ? "SOL"
    : (getTokenInfo(inMint).symbol || "Unknown");
  const recvSym = outMint === SOL_MINT
    ? "SOL"
    : (getTokenInfo(outMint).symbol || "Unknown");
  const soldName = getTokenInfo(inMint).name  || soldSym;
  const recvName = getTokenInfo(outMint).name || recvSym;

  // 6) Timestamp en EST
  const estTime = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour12: false
  });

  // 7) Devolver TODO lo que necesitan confirmBuy/confirmSell
  return {
    inputAmount,                // SOL gastado (compra) o tokens vendidos (venta)
    soldAmount,                 // igual a inputAmount, pero semántico para venta
    receivedAmount,             // tokens recibidos (compra) o SOL recibido (venta)
    soldTokenMint:     inMint,
    receivedTokenMint: outMint,
    soldTokenName:     soldName,
    soldTokenSymbol:   soldSym,
    receivedTokenName: recvName,
    receivedTokenSymbol:recvSym,
    dexPlatform:       "Jupiter Aggregator v6",
    walletAddress:     users[chatId].walletPublicKey,
    timeStamp:         estTime
  };
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

// CALLBACK QUERY PARA OPERACIONES DE VENTA
bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
  
    if (!data.startsWith("sell_")) {
      return bot.answerCallbackQuery(query.id);
    }
  
    // deshabilitar spinner inmediatamente
    await bot.answerCallbackQuery(query.id);
  
    const [_, expectedTokenMint, sellType] = data.split("_");
  
    // asegurarnos de que exista la clave
    if (!users[chatId]?.privateKey) {
      await bot.sendMessage(chatId, "⚠️ Error: Private key not found.");
      return;
    }
  
    // recuperar o enviar el mensaje "Waiting for sell"
    let msgId = buyReferenceMap[chatId]?.[expectedTokenMint]?.sellMessageId;
    if (!msgId) {
      const m = await bot.sendMessage(chatId, "⏳ Waiting for sell...", { parse_mode: "Markdown" });
      msgId = m.message_id;
      buyReferenceMap[chatId] = buyReferenceMap[chatId] || {};
      buyReferenceMap[chatId][expectedTokenMint] = buyReferenceMap[chatId][expectedTokenMint] || {};
      buyReferenceMap[chatId][expectedTokenMint].sellMessageId = msgId;
    }
  
    // indicar procesamiento
    await bot.editMessageText(
      `🔄 Processing sale of ${sellType === "50" ? "50%" : "100%"} of your ${expectedTokenMint} tokens...`,
      { chat_id: chatId, message_id: msgId }
    );
  
    let rpcUrl;
    try {
      // 1) escoger un RPC distinto
      rpcUrl = getNextRpc();
      const connection = new Connection(rpcUrl, "processed");
  
      // 2) Ya no chequeamos ni creamos la ATA, omitimos ensureAssociatedTokenAccount
      const wallet = Keypair.fromSecretKey(new Uint8Array(bs58.decode(users[chatId].privateKey)));
  
      // 3) Decimales y balance (seguimos usando getTokenBalance si lo necesitas)
      const decimals = await getTokenDecimals(expectedTokenMint);
      const balance  = await getTokenBalance(chatId, expectedTokenMint);
      if (!balance || balance <= 0) {
        await bot.editMessageText("⚠️ You don't have enough balance to sell.", {
          chat_id: chatId, message_id: msgId
        });
        setTimeout(() => bot.deleteMessage(chatId, msgId).catch(() => {}), 30_000);
        return;
      }
  
      // 4) preparar montos
      const balanceInLam = Math.floor(balance * 10 ** decimals);
      const amountToSell = sellType === "50"
        ? Math.floor(balanceInLam / 2)
        : balanceInLam;
      const soldAmount = sellType === "50"
        ? (balance / 2).toFixed(decimals)
        : balance.toFixed(decimals);
  
      if (amountToSell < 1) {
        await bot.editMessageText("⚠️ The amount to sell is too low.", {
          chat_id: chatId, message_id: msgId
        });
        return;
      }
  
      // 5) ejecutar la venta (hasta 3 intentos)
      let txSignature = null;
      for (let i = 0; i < 3 && !txSignature; i++) {
        txSignature = await sellToken(chatId, expectedTokenMint, amountToSell);
        if (!txSignature) await new Promise(r => setTimeout(r, 1000));
      }
      if (!txSignature) {
        await bot.editMessageText(
          "❌ The sale could not be completed after multiple attempts. Please check server logs.",
          { chat_id: chatId, message_id: msgId }
        );
        return;
      }
  
      // 6) detalles de la venta (hasta 5 intentos)
      let sellDetails = null;
      for (let i = 0; i < 5 && !sellDetails; i++) {
        sellDetails = await getSwapDetailsHybrid(txSignature, expectedTokenMint, chatId);
        if (!sellDetails) await new Promise(r => setTimeout(r, 1000));
      }
      if (!sellDetails) {
        await bot.editMessageText(
          `⚠️ Sell details could not be retrieved after 5 attempts.\n🔗 [View in Solscan](https://solscan.io/tx/${txSignature})`,
          {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: "Markdown",
            disable_web_page_preview: true
          }
        );
        return;
      }
  
      // 7) confirmar y actualizar
      await confirmSell(chatId, sellDetails, soldAmount, msgId, txSignature, expectedTokenMint);
  
    } catch (err) {
      console.error("❌ Error in sell process:", err);
      await bot.editMessageText(
        `❌ The sale could not be completed. Error: ${err.message}`,
        { chat_id: chatId, message_id: msgId }
      );
    } finally {
      // 8) liberar el RPC usado
      if (rpcUrl) releaseRpc(rpcUrl);
    }
  });

// ——— Función confirmSell actualizada ———
async function confirmSell(
    chatId,
    sellDetails,
    _soldAmountStr,
    messageId,
    txSignature,
    expectedTokenMint
  ) {
    const solPrice = await getSolPriceUSD();
  
    // — Parsear cantidades —
    const soldTokens = parseFloat(sellDetails.soldAmount) || 0;
    const gotSol     = parseFloat(sellDetails.receivedAmount) || 0;
  
    // — Calcular PnL —
    let pnlDisplay = "N/A";
    const ref = buyReferenceMap[chatId]?.[expectedTokenMint];
    if (ref?.solBeforeBuy != null) {
      const pnlSol = gotSol - ref.solBeforeBuy;
      const emoji  = pnlSol >= 0 ? "🟢" : "🔻";
      const usdPnL = solPrice != null ? pnlSol * solPrice : null;
      pnlDisplay = `${emoji}${Math.abs(pnlSol).toFixed(3)} SOL` +
        (usdPnL != null
          ? ` (USD ${usdPnL >= 0 ? "+" : "-"}$${Math.abs(usdPnL).toFixed(2)})`
          : ""
        );
    }
  
    // — Precio medio y hora —
    const tokenPrice = soldTokens > 0
      ? (gotSol / soldTokens).toFixed(9)
      : "N/A";
    const now       = Date.now();
    const utcTime   = new Date(now).toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
    const estTime   = new Date(now).toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
    const formattedTime = `${utcTime} UTC | ${estTime} EST`;
  
    // — Balance de la wallet —
    const rpcUrl     = getNextRpc();
    const connection = new Connection(rpcUrl, "processed");
    const balLam     = await connection.getBalance(new PublicKey(sellDetails.walletAddress));
    releaseRpc(rpcUrl);
    const walletSol = balLam / 1e9;
    const walletUsd = solPrice != null ? (walletSol * solPrice).toFixed(2) : "N/A";
  
    // — Símbolo —
    const tokenSymbol = escapeMarkdown(
      getTokenInfo(expectedTokenMint).symbol || "Unknown"
    );
  
    // — 1) Mensaje completo para Telegram —
    const confirmationMessage =
      `✅ *Sell completed successfully* 🔗 [View in Solscan](https://solscan.io/tx/${txSignature})\n` +
      `*${tokenSymbol}/SOL* (Jupiter Aggregator v6)\n` +
      `🕒 *Time:* ${formattedTime}\n\n` +
      `⚡️ SELL ⚡️\n` +
      `💲 *Token Price:* ${tokenPrice} SOL\n` +
      `💰 *SOL PnL:* ${pnlDisplay}\n\n` +
      `💲 *Sold:* ${soldTokens.toFixed(3)} ${tokenSymbol}\n` +
      `💰 *Got:* ${gotSol.toFixed(9)} SOL (USD $${(gotSol * solPrice).toFixed(2)})\n\n` +
      `🌑 *Wallet Balance:* ${walletSol.toFixed(2)} SOL (USD $${walletUsd})\n\n` +
      `🔗 *Sold Token ${tokenSymbol}:* \`${expectedTokenMint}\`\n` +
      `🔗 *Wallet:* \`${sellDetails.walletAddress}\``;
  
    // — 2) Texto corto para compartir en X/WhatsApp —
    let shareText =
      `✅ Sell completed ${tokenSymbol}/SOL\n` +
      `Token Price: ${tokenPrice} SOL\n` +
      `Sold: ${soldTokens.toFixed(3)} ${tokenSymbol}\n` +
      `SOL PnL: ${pnlDisplay}\n` +
      `Got: ${gotSol.toFixed(9)} SOL (USD $${(gotSol * solPrice).toFixed(2)})\n` +
      `🔗 https://solscan.io/tx/${txSignature}\n\n` +
      `💎 I got this result using Gemsniping – the best bot on Solana! https://gemsniping.com`;
  
    // Normalizar y quitar surrogates huérfanos
    shareText = shareText
      .normalize('NFC')
      .replace(/(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF]))/g, '');
  
    // URLs de compartir
    const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
    const waUrl    = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
  
    // — 3) Editamos el mensaje y añadimos botones —
    await bot.editMessageText(confirmationMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚀 Share on X",      url: tweetUrl },
            { text: "💬 WhatsApp", url: waUrl }
          ]
        ]
      }
    });
  
    // — 4) Guardar estado de la referencia y el swap —
    buyReferenceMap[chatId][expectedTokenMint] = {
      ...buyReferenceMap[chatId][expectedTokenMint],
      txSignature,
      time: Date.now()
    };
    saveSwap(chatId, "Sell", {
      "Sell completed successfully": true,
      Pair:         `${tokenSymbol}/SOL`,
      Sold:         `${soldTokens.toFixed(3)} ${tokenSymbol}`,
      Got:          `${gotSol.toFixed(9)} SOL`,
      "Token Price":`${tokenPrice} SOL`,
      "SOL PnL":    pnlDisplay,
      Time:         formattedTime,
      Transaction:  `https://solscan.io/tx/${txSignature}`,
      Wallet:       sellDetails.walletAddress,
      messageText:  confirmationMessage
    });
  }
  
  // ——— Listener general de callback_query ———
  bot.on("callback_query", async (query) => {
    // …otros handlers…
    await bot.answerCallbackQuery(query.id);
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
  
    if (data.startsWith("buy_")) {
      const [_, mint, amountStr] = data.split("_");
      const amountSOL = parseFloat(amountStr);
      const messageId = (await bot.sendMessage(
        chatId,
        `🛒 Processing purchase of ${amountSOL} SOL for ${mint}…`
      )).message_id;
  
      if (!users[chatId]?.privateKey) {
        await bot.editMessageText("⚠️ You don't have a registered private key. Use /start to register.", {
          chat_id: chatId,
          message_id
        });
        await bot.answerCallbackQuery(query.id);
        return;
      }
  
      try {
        // 1) Send order
        const txSignature = await buyToken(chatId, mint, amountSOL);
        if (!txSignature) {
          await bot.editMessageText(`❌ The purchase could not be completed.`, {
            chat_id: chatId,
            message_id
          });
          await bot.answerCallbackQuery(query.id);
          return;
        }
  
        // 2) Fetch swap details once
        const swapDetails = await getSwapDetailsHybrid(txSignature, mint, chatId);
        if (!swapDetails) {
          await bot.editMessageText(
            `⚠️ Swap details could not be retrieved. Transaction: [View in Solscan](https://solscan.io/tx/${txSignature})`,
            {
              chat_id: chatId,
              message_id,
              parse_mode: "Markdown",
              disable_web_page_preview: true
            }
          );
          await bot.answerCallbackQuery(query.id);
          return;
        }
  
        // 3) Final confirmation (updates the same message to the full summary)
        await confirmBuy(chatId, swapDetails, messageId, txSignature);
  
      } catch (error) {
        console.error("❌ Error in purchase process:", error);
        const msg = typeof error === "string"
          ? error
          : error.message.includes("Not enough SOL")
            ? error.message
            : "❌ The purchase could not be completed.";
        await bot.editMessageText(msg, {
          chat_id: chatId,
          message_id
        });
      }
  
      await bot.answerCallbackQuery(query.id);
    }
  });

  async function confirmBuy(chatId, swapDetails, messageId, txSignature) {
    const solPrice = await getSolPriceUSD(); // Precio actual de SOL en USD
  
    // 1) Extract y saneamiento de datos
    const inputAmount    = parseFloat(swapDetails.inputAmount)    || 0;    // SOL gastado
    const receivedAmount = parseFloat(swapDetails.receivedAmount) || 0;    // Tokens recibidos
    const receivedTokenMint = swapDetails.receivedTokenMint;
  
    // Validación básica
    if (!receivedTokenMint || receivedTokenMint.length < 32) {
      console.error("❌ Error: No se pudo determinar un token recibido válido.");
      await bot.editMessageText("⚠️ Error: No se pudo identificar el token recibido.", {
        chat_id: chatId,
        message_id: messageId
      });
      return;
    }
  
    // 2) Información estática del token
    const swapTokenData = getTokenInfo(receivedTokenMint);
    const tokenSymbol   = escapeMarkdown(swapTokenData.symbol || "Unknown");
  
    // 3) Formateo de valores para el mensaje
    const spentTotal = inputAmount.toFixed(3);
    const usdBefore  = solPrice != null
      ? `USD $${(inputAmount * solPrice).toFixed(2)}`
      : "N/A";
    const tokenPrice = receivedAmount > 0
      ? (inputAmount / receivedAmount).toFixed(9)
      : "N/A";
  
    // 4) Timestamp en UTC y EST
    const rawTime = swapDetails.rawTime || Date.now();
    const utcTime = new Date(rawTime).toLocaleTimeString("en-GB", {
      hour12: false,
      timeZone: "UTC"
    });
    const estTime = new Date(rawTime).toLocaleTimeString("en-US", {
      hour12: false,
      timeZone: "America/New_York"
    });
    const formattedTime = `${utcTime} UTC | ${estTime} EST`;
  
    // 5) Construcción del mensaje de confirmación
    const confirmationMessage =
      `✅ *Swap completed successfully* 🔗 [View in Solscan](https://solscan.io/tx/${txSignature})\n` +
      `*SOL/${tokenSymbol}* (Jupiter Aggregator v6)\n` +
      `🕒 *Time:* ${formattedTime}\n\n` +
      `⚡️ SWAP ⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n` +
      `💲 *Token Price:* ${tokenPrice} SOL\n\n` +
      `💲 *Spent:* ${spentTotal} SOL (${usdBefore})\n` +
      `💰 *Got:* ${receivedAmount.toFixed(3)} Tokens\n\n` +
      `🔗 *Received Token ${tokenSymbol}:* \`${receivedTokenMint}\`\n` +
      `🔗 *Wallet:* \`${swapDetails.walletAddress}\``;
  
    // 6) Editar el mensaje original
    await bot.editMessageText(confirmationMessage, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔄 Refresh",    callback_data: `refresh_buy_${receivedTokenMint}` },
            { text: "💯 Sell MAX", callback_data: `sell_${receivedTokenMint}_100` }
          ],
          [
            { text: "📈 📊 Chart+Txns", url: `https://gemsniping.com/solana/${receivedTokenMint}` }
          ]
        ]
      }
    });
  
    // 7) Enviar el mensaje de "Waiting for sell"
    const waitingSellMsg = await bot.sendMessage(chatId, "⏳ Waiting for sell...", {
      parse_mode: "Markdown"
    });
  
    // 8) Guardar en buyReferenceMap para la venta
    buyReferenceMap[chatId] = buyReferenceMap[chatId] || {};
    buyReferenceMap[chatId][receivedTokenMint] = {
      solBeforeBuy:  inputAmount,     // SOL que se gastó en la compra
      receivedAmount,
      tokenPrice:   parseFloat(tokenPrice) || 0,
      walletAddress: swapDetails.walletAddress,
      txSignature,
      time:         Date.now(),
      sellMessageId: waitingSellMsg.message_id
    };
  
    // 9) Guardar registro en swaps.json
    saveSwap(chatId, "Buy", {
      "Swap completed successfully": true,
      "Pair": `SOL/${tokenSymbol}`,
      "Spent": `${spentTotal} SOL`,
      "Got": `${receivedAmount.toFixed(3)} Tokens`,
      "Token Price": `${tokenPrice} SOL`,
      "Received Token": tokenSymbol,
      "Received Token Address": receivedTokenMint,
      "Wallet": swapDetails.walletAddress,
      "Time": formattedTime,
      "Transaction": `https://solscan.io/tx/${txSignature}`,
      "messageText": confirmationMessage
    });
  
    console.log(`✅ Swap confirmed and reference saved for ${tokenSymbol}`);
  }

// Variables para controlar la sesión y el contador de refrescos
let refreshRequestCount = 0;
let proxyAgent = createProxyAgentWithSession(baseUsername);  // Inicializamos con la sesión base

// Función para generar un nuevo session ID y crear un agente proxy
function createProxyAgentWithSession(usernameSuffix) {
  // Si se pasa un usernameSuffix, se añade al username base.
  const username = usernameSuffix ? `${baseUsername}-session-${usernameSuffix}` : baseUsername;
  const proxyUrl = `http://${username}:${proxyPassword}@${proxyHost}:${proxyPort}`;
  // Crea el agente proxy
  return new HttpsProxyAgent(proxyUrl);
}

// Función para "regenerar" la sesión del proxy: genera un nuevo session ID y actualiza el proxyAgent
function regenerateProxySession() {
  // Por ejemplo, usar la marca de tiempo para generar un identificador único
  const newSessionId = Date.now();  
  proxyAgent = createProxyAgentWithSession(newSessionId);
  console.log(`Actualizando sesión de proxy: ${baseUsername}-session-${newSessionId}`);
}

// Variables globales para el control de refresh y rotación de sesión
let lastJupRequestTime = 0;
const lastRefreshTime = {}; // Objeto para almacenar el cooldown por chat+token
const lastMessageContent = {};

// --- Función refreshBuyConfirmationV2 actualizada ---
async function refreshBuyConfirmationV2(chatId, messageId, tokenMint) {
    let tokenSymbol = "Unknown";
    
    try {
      // Incrementa contador y cada 20 rotar proxy
      refreshRequestCount++;
      if (refreshRequestCount % 20 === 0) {
        regenerateProxySession();
      }
  
      // Cooldown de 1 s por chat+token
      const refreshKey = `${chatId}_${tokenMint}`;
      if (lastRefreshTime[refreshKey] && Date.now() - lastRefreshTime[refreshKey] < 1000) {
        return;
      }
      lastRefreshTime[refreshKey] = Date.now();
  
      // Datos estáticos del token
      const tokenInfo = getTokenInfo(tokenMint);
      tokenSymbol = escapeMarkdown(tokenInfo.symbol || "N/A");
  
      // Datos de compra original
      const original = buyReferenceMap[chatId]?.[tokenMint];
      if (!original || !original.solBeforeBuy) {
        return;
      }
  
      // Rate‑limit Jupiter
      const now = Date.now();
      const elapsed = now - lastJupRequestTime;
      if (elapsed < 1000) {
        await new Promise(r => setTimeout(r, 1000 - elapsed));
      }
      lastJupRequestTime = Date.now();
  
      // Cotización de venta en Jupiter
      const jupUrl =
        `https://quote-api.jup.ag/v6/quote?inputMint=${tokenMint}` +
        `&outputMint=So11111111111111111111111111111111111111112` +
        `&amount=1000000000&slippageBps=500&priorityFeeBps=30`;
      const jupRes = await axios.get(jupUrl, {
        httpsAgent: proxyAgent,
        timeout: 5000,
      });
  
      if ([429, 407].includes(jupRes.status)) {
        await new Promise(r => setTimeout(r, 2500));
        lastJupRequestTime = Date.now();
        throw new Error(`Rate limit error from Jupiter (status ${jupRes.status})`);
      }
      if (jupRes.status !== 200) {
        throw new Error(`Error fetching Jupiter quote: ${jupRes.statusText}`);
      }
      const outAmount = Number(jupRes.data.outAmount);
      if (isNaN(outAmount)) {
        throw new Error(`Invalid outAmount from Jupiter: ${jupRes.data.outAmount}`);
      }
      const priceSolNow = outAmount / 1e9;
  
      // Formateadores
      const formatDefault = val => {
        const n = Number(val);
        if (isNaN(n)) return "N/A";
        return n >= 1 ? n.toFixed(6) : n.toFixed(9).replace(/0+$/, "");
      };
      const formatWithZeros = val => {
        const n = Number(val);
        if (isNaN(n)) return "N/A";
        if (n >= 1) return n.toFixed(6);
        const str = n.toFixed(12);
        const forced = "0.000" + str.slice(2);
        const m = forced.match(/0*([1-9]\d{0,2})/);
        if (!m) return forced;
        const idx = forced.indexOf(m[1]);
        return forced.slice(0, idx + m[1].length + 1);
      };
  
      const formattedOriginalPrice = formatDefault(original.tokenPrice);
      const formattedCurrentPrice = formatWithZeros(priceSolNow);
  
      // Cálculos PnL y porcentaje
      const currentPriceShown = Number(formattedCurrentPrice);
      const currentValue = (original.receivedAmount * currentPriceShown).toFixed(6);
      let changePercent = 0;
      if (Number(original.tokenPrice) > 0 && !isNaN(currentPriceShown)) {
        changePercent = ((currentPriceShown - Number(original.tokenPrice)) / Number(original.tokenPrice)) * 100;
        if (!isFinite(changePercent)) changePercent = 0;
      }
      const changePercentStr = changePercent.toFixed(2);
      const emojiPrice = changePercent > 100 ? "🚀" : changePercent > 0 ? "🟢" : "🔻";
  
      const pnlSol = Number(currentValue) - Number(original.solBeforeBuy);
      const emojiPNL = pnlSol > 0 ? "🟢" : pnlSol < 0 ? "🔻" : "➖";
  
      // Horario
      const rawTime = original.time || Date.now();
      const utcTimeStr = new Date(rawTime).toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
      const estTimeStr = new Date(rawTime).toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
      const formattedTime = `${utcTimeStr} UTC | ${estTimeStr} EST`;
  
      // Mensaje actualizado
      const updatedMessage =
        `✅ *Swap completed successfully* 🔗 [View in Solscan](https://solscan.io/tx/${original.txSignature})\n` +
        `*SOL/${tokenSymbol}* (Jupiter Aggregator v6)\n` +
        `🕒 *Time:* ${formattedTime}\n\n` +
        `⚡️ SWAP ⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n` +
        `💲 *Token Price:* ${formattedOriginalPrice} SOL\n` +
        `💰 *Got:* ${Number(original.receivedAmount).toFixed(3)} Tokens\n` +
        `💲 *Spent:* ${original.solBeforeBuy} SOL\n\n` +
        `⚡️ TRADE ⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️⚡️\n` +
        `💲 *Price Actual:* ${emojiPrice} ${formattedCurrentPrice} SOL (${changePercentStr}%)\n` +
        `💰 *You Get:* ${emojiPNL} ${currentValue} SOL\n\n` +
        `🔗 *Received Token ${tokenSymbol}:* \`${escapeMarkdown(tokenMint)}\`\n` +
        `🔗 *Wallet:* \`${original.walletAddress}\``;
  
      // Si no cambia nada, no editar
      if (lastMessageContent[messageId] === updatedMessage) {
        return;
      }
  
      // Editar mensaje
      await bot.editMessageText(updatedMessage, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔄 Refresh",   callback_data: `refresh_buy_${tokenMint}` },
              { text: "💯 Sell MAX",  callback_data: `sell_${tokenMint}_100` }
            ],
            [
              { text: "📊 Chart+Txns", url: `https://gemsniping.com/solana/${tokenMint}` }
            ]
          ]
        }
      });
  
      lastMessageContent[messageId] = updatedMessage;
  
    } catch (error) {
        const errMsg = error.message || "";
        if (errMsg.includes("message is not modified")) {
          return;
        } else if (/^(429|407|502)/.test(errMsg)) {
          return;
        } else {
          console.error("❌ Error while refreshing token info:", error);
          return;
        }
      }
    }

async function getSolPriceUSD() {
  try {
    const response = await axios.get("https://quote-api.jup.ag/v6/quote", {
      params: {
        inputMint: "So11111111111111111111111111111111111111112", // SOL
        outputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
        amount: 100000000, // 0.1 SOL (100M lamports)
        dynamicSlippage: true
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

// ----------------------------------------
// 1) Nuevo handler para /close_ata
// ----------------------------------------
bot.onText(/\/close/, async (msg) => {
    const chatId   = msg.chat.id;
    const cmdMsgId = msg.message_id;
  
    // 1️⃣ Borrar el comando
    await bot.deleteMessage(chatId, cmdMsgId).catch(() => {});
  
    // 2️⃣ Enviar menú inicial
    const text =
      '🗄 *Associated Token Account* 🗄\n\n' +
      'An Associated Token Account (ATA) is where your tokens live on Solana. ' +
      'Empty ATAs still hold a small rent deposit. You can either *check* how many empty ATAs you have, ' +
      'or *close* them to reclaim that rent.';
  
    const keyboard = [
      [
        { text: '🔍 Check ATAs', callback_data: 'ata_check' },
        { text: '🔒 Close ATAs', callback_data: 'ata_close' }
      ]
    ];
  
    await bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    });
  });
  
  // ----------------------------------------
  // 2) Handler para los callbacks de ATA
  // ----------------------------------------
  bot.on('callback_query', async query => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;
  
    // Helper: conexión fija a Helius
    const connection = new Connection(
      "https://ros-5f117e-fast-mainnet.helius-rpc.com",
      'confirmed'
    );
  
    // 2.1) Check ATAs
    if (data === 'ata_check') {
      await bot.answerCallbackQuery(query.id);
  
      const user = users[chatId];
      const accounts = await connection.getParsedTokenAccountsByOwner(
        new PublicKey(user.walletPublicKey),
        { programId: TOKEN_PROGRAM_ID }
      );
  
      const emptyCount = accounts.value
        .filter(acc => Number(acc.account.data.parsed.info.tokenAmount.amount) === 0)
        .length;
  
      console.log(`[ata_check] User ${chatId} has ${emptyCount} empty ATAs`);
  
      const newText = `🔍 You have *${emptyCount}* empty ATA account${emptyCount !== 1 ? 's' : ''} that can be closed.`;
  
      return bot.editMessageText(newText, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔍 Check ATAs', callback_data: 'ata_check' },
              { text: '🔒 Close ATAs', callback_data: 'ata_close' }
            ]
          ]
        }
      });
    }
  
    // 2.2) Close ATAs
    if (data === 'ata_close') {
      await bot.answerCallbackQuery(query.id);
  
      const user    = users[chatId];
      const keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
  
      let closedTotal = 0;
      let iteration   = 0;
  
      try {
        while (true) {
          iteration++;
          const accounts = await connection.getParsedTokenAccountsByOwner(
            new PublicKey(user.walletPublicKey),
            { programId: TOKEN_PROGRAM_ID }
          );
  
          const empties = accounts.value
            .filter(acc => Number(acc.account.data.parsed.info.tokenAmount.amount) === 0)
            .slice(0, 25);
  
          console.log(`[ata_close][iter ${iteration}] Found ${empties.length} empty ATAs:`,
            empties.map(a => a.pubkey.toBase58())
          );
  
          if (empties.length === 0) break;
  
          const tx = new Transaction();
          for (let { pubkey } of empties) {
            tx.add(createCloseAccountInstruction(
              pubkey,
              new PublicKey(user.walletPublicKey),
              new PublicKey(user.walletPublicKey)
            ));
          }
  
          try {
            const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
            closedTotal += empties.length;
            console.log(`[ata_close][iter ${iteration}] Closed ${empties.length} ATAs, txSig=${sig}`);
          } catch (err) {
            console.error(
              `[ata_close][iter ${iteration}] Error closing ATAs:`,
              err.message
            );
            if (err.transactionLogs) {
              console.error('[ata_close] transactionLogs:', err.transactionLogs);
            }
            break;  // salimos del loop ante error
          }
        }
      } catch (err) {
        console.error('[ata_close] Unexpected error:', err);
      }
  
      const finalText = closedTotal > 0
        ? `✅ Closed *${closedTotal}* ATA account${closedTotal !== 1 ? 's' : ''}. All rent deposits have been returned!`
        : '⚠️ No empty ATA accounts found to close.';
  
      return bot.editMessageText(finalText, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: 'Markdown'
      });
    }
  
    // responder cualquier otro callback para quitar spinner
    await bot.answerCallbackQuery(query.id);
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

// Comando /ip: consulta la IP pública a través del proxy y la devuelve al usuario.
bot.onText(/^\/ip$/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const response = await axios.get("https://api.ipify.org/?format=json", {
      httpsAgent: proxyAgent,
      timeout: 5000, // 5 segundos de tiempo de espera
    });
    // response.data debería tener el formato { ip: "..." }
    bot.sendMessage(chatId, `IP pública mediante proxy: ${JSON.stringify(response.data)}`);
  } catch (error) {
    bot.sendMessage(chatId, `Error comprobando la IP: ${error.message}`);
  }
});

// 🔥 Cargar suscriptores al iniciar
loadUsers();

console.log("🤖 Bot de Telegram iniciado.");
