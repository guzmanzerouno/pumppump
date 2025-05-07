import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import WebSocket from "ws";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { Connection } from "@solana/web3.js";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
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
 * @returns {Promise<{ closedTotal: number, lastSig: string|null }>}
 */
async function closeEmptyATAs(chatId) {
  const user = users[chatId];
  if (!user?.privateKey || !user.walletPublicKey) {
    return { closedTotal: 0, lastSig: null };
  }

  const keypair    = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
  const connection = new Connection("https://ros-5f117e-fast-mainnet.helius-rpc.com", "confirmed");
  let closedTotal = 0;
  let lastSig     = null;

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

    try {
      const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
      lastSig = sig;
      closedTotal += empties.length;
    } catch (err) {
      console.error(`[closeEmptyATAs] Error closing batch:`, err.message);
      break;
    }
  }

  return { closedTotal, lastSig };
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
    const { id, data, message } = query;
    const chatId = message.chat.id;
    const msgId  = message.message_id;
  
    // 1) Responder el callback de Telegram lo antes posible
    await bot.answerCallbackQuery(id);
  
    // 2) Ahora ya puedes procesar la acción
    if (data === "ata_on") {
      users[chatId] = users[chatId] || {};
      users[chatId].ataAutoCreationEnabled = true;
      saveUsers();
  
      return bot.editMessageText("✅ Auto-creation of ATAs is now *ENABLED*", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      });
    }
  
    if (data === "ata_off") {
      users[chatId] = users[chatId] || {};
      users[chatId].ataAutoCreationEnabled = false;
      saveUsers();
  
      await bot.editMessageText("❌ Auto-creation of ATAs is now *DISABLED*", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      });
  
      // 3) Cierra ATAs en background, sin bloquear el callback
      closeEmptyATAs(chatId).then(({ closedTotal, lastSig }) => {
        if (closedTotal > 0) {
          let text = `✅ Closed *${closedTotal}* empty ATA account${closedTotal !== 1 ? 's' : ''}. Rent deposits refunded!`;
          if (lastSig) {
            text += `\n🔗 [View Close Tx on Solscan](https://solscan.io/tx/${lastSig})`;
          }
          bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
          });
        } else {
          bot.sendMessage(chatId,
            `⚠️ No empty ATA accounts were found to close.`,
            { parse_mode: 'Markdown' }
          ).then(sent => {
            setTimeout(() => {
              bot.deleteMessage(chatId, sent.message_id).catch(() => {});
            }, 15_000);
          });
        }
      }).catch(err => {
        console.error("Error cerrando ATAs:", err);
      });
  
      return;
    }
  
    // En caso de otros callbacks...
    // ya hemos respondido arriba, así que aquí solo procesarías lógica extra
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

// ─────────────────────────────────────────────
// 1) Mostrar planes de pago con swaps incluidos
// ─────────────────────────────────────────────
function showPaymentButtons(chatId) {
    return bot.sendPhoto(chatId,
      "https://framerusercontent.com/images/GezLoqfssURsUYLZrfctzPEkRCw.png", {
        caption: "💳 Please select a subscription plan:",
        reply_markup: {
          inline_keyboard: [
            [{ text: "1 Day 10 Swaps – 0.05 SOL", callback_data: "pay_1d"    }],
            [{ text: "1 Month 300 Swaps – 1.00 SOL", callback_data: "pay_month" }],
            [{ text: "1 Month Unlimited – 1.25 SOL", callback_data: "pay_un"    }]
          ]
        }
      }
    );
  }
  
  // ─────────────────────────────────────────────
  // 2) Capturar la selección de pago y lanzar el flujo
  // ─────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
  
    if (!data.startsWith("pay_")) {
      return bot.answerCallbackQuery(query.id);
    }
    await bot.answerCallbackQuery(query.id); // stop the spinner
  
    // ** store the menu msg ID so we can delete it later **
    users[chatId] = users[chatId] || {};
    users[chatId].lastPaymentMsgId = query.message.message_id;
    saveUsers();
  
    // now proceed as before
    let days, solAmount, swaps;
    switch (data) {
      case "pay_1d":
        days = 1; solAmount = 0.05; swaps = 10;
        break;
      case "pay_month":
        days = 30; solAmount = 1.00; swaps = 300;
        break;
      case "pay_un":
        days = 30; solAmount = 1.25; swaps = "Unlimited";
        break;
      default:
        return;
    }
  
    return activateMembership(chatId, days, solAmount, swaps);
  });
  
  // ─────────────────────────────────────────────
  // 3) Flujo de activación de membresía (ahora con swaps)
  // ─────────────────────────────────────────────
  async function activateMembership(chatId, days, solAmount, swaps) {
    const user = users[chatId];
    const now = Date.now();
    const expiration = now + days * 24 * 60 * 60 * 1000;
  
    // Guardamos el límite de swaps en el usuario
    user.swapLimit = swaps;
    saveUsers();
  
    const sender     = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
    const receiver   = new PublicKey("8VCEaTpyg12kYHAH1oEAuWm7EHQ62e147UPrJzRZZeps");
    const connection = new Connection("https://ros-5f117e-fast-mainnet.helius-rpc.com", "confirmed");
  
    // Verificar fondos
    const balance = await connection.getBalance(sender.publicKey);
    if (balance < solAmount * 1e9) {
      return bot.sendMessage(chatId,
        `❌ *Insufficient funds.*\nYour wallet has ${(balance/1e9).toFixed(4)} SOL but needs ${solAmount} SOL.`,
        { parse_mode: "Markdown" }
      );
    }
  
    // Mensaje de “processing”
    const processingMsg = await bot.sendMessage(chatId,
      "🕐 *Processing your payment...*", { parse_mode: "Markdown" }
    );
  
    try {
      // Ejecutar transferencia
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: sender.publicKey,
          toPubkey:   receiver,
          lamports:   solAmount * 1e9
        })
      );
      const sig = await sendAndConfirmTransaction(connection, tx, [sender]);
  
      // Actualizar usuario
      user.expired    = expiration;
      user.subscribed = true;
      saveUsers();
      savePaymentRecord(chatId, sig, days, solAmount);
  
      const expirationDate = new Date(expiration).toLocaleDateString();
      const statusLine     = `✅ Active for ${Math.round((expiration - now)/(1000*60*60*24))} day(s)`;
      const limitedText    = typeof swaps === "number" ? `${swaps} Swaps` : "Unlimited";
  
      // Construir caption con “Limited”
      const fullConfirmation =
        `👤 *Name:* ${user.name}\n` +
        `📱 *Phone:* ${user.phone}\n` +
        `📧 *Email:* ${user.email}\n` +
        `🆔 *Username:* ${user.username || "None"}\n` +
        `💼 *Wallet:* \`${user.walletPublicKey}\`\n` +
        `🔐 *Referral:* ${user.rcode || "None"}\n` +
        `⏳ *Status:* ${statusLine}\n` +
        `🎟️ *Limited:* ${limitedText}`;
  
      // Editar el mensaje con solo “How to Use the Bot”
      await bot.editMessageMedia(
        {
          type: "photo",
          media:
            "https://framerusercontent.com/images/GezLoqfssURsUYLZrfctzPEkRCw.png",
          caption: fullConfirmation,
          parse_mode: "Markdown"
        },
        {
          chat_id: chatId,
          message_id: processingMsg.message_id,
          reply_markup: {
            inline_keyboard: [
              [
                { text: "📘 How to Use the Bot", url: "https://gemsniping.com/docs" }
              ]
            ]
          }
        }
      );
  
      // ─────────────────────────────────────────────
      // Mensaje final al usuario con todos los detalles
      await bot.sendMessage(
        chatId,
`✅ *Payment received successfully!*  
Your membership is now active.

💳 *Paid:* ${solAmount} SOL for ${days} day(s)  
🗓️ *Expires:* ${expirationDate}  
🎟️ *Limited:* ${limitedText}  
🔗 [View Tx](https://solscan.io/tx/${sig})`,
        {
          parse_mode: "Markdown",
          disable_web_page_preview: true
        }
      );
      // ─────────────────────────────────────────────
  
      // Borrar menú de pago antiguo
      if (user.lastPaymentMsgId) {
        try {
          await bot.deleteMessage(chatId, user.lastPaymentMsgId);
          user.lastPaymentMsgId = null;
          saveUsers();
        } catch {}
      }
  
      // Notificar al admin
      const adminMsg =
        `✅ *Payment received successfully!*\n` +
        `📧 *Email:* ${user.email}\n` +
        `🆔 *Username:* ${user.username}\n` +
        `💳 *Paid:* ${solAmount} SOL for ${days} day(s)\n` +
        `🗓️ *Expires:* ${expirationDate}\n` +
        `🎟️ *Limited:* ${limitedText}\n` +
        `🔗 [View Tx](https://solscan.io/tx/${sig})`;
  
      await bot.sendMessage(ADMIN_CHAT_ID, adminMsg, {
        parse_mode: "Markdown",
        disable_web_page_preview: true
      });
  
    } catch (err) {
      // Error en la transacción
      await bot.editMessageText(
        `❌ Transaction failed: ${err.message}`,
        { chat_id: chatId, message_id: processingMsg.message_id }
      );
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

// ────────────────────────────────
// Comando /payments con paginación (5 por página) y botón Close
// ────────────────────────────────
bot.onText(/\/payments/, async (msg) => {
    const chatId       = msg.chat.id;
    const commandMsgId = msg.message_id;
  
    // 1) Borrar el mensaje del comando inmediatamente
    try {
      await bot.deleteMessage(chatId, commandMsgId);
    } catch (e) {
      console.warn("Could not delete /payments message:", e.message);
    }
  
    // 2) Comprobar registro del usuario
    const user = users[chatId];
    if (!user || !user.walletPublicKey) {
      return bot.sendMessage(
        chatId,
        "❌ You must be registered to view your payment history."
      );
    }
  
    // 3) Leer archivo de pagos y filtrar
    const paymentsFile = "payments.json";
    if (!fs.existsSync(paymentsFile)) {
      return bot.sendMessage(chatId, "📭 No payment records found.");
    }
    const records      = JSON.parse(fs.readFileSync(paymentsFile));
    const userPayments = records.filter(p => p.chatId === chatId).reverse();
  
    if (userPayments.length === 0) {
      return bot.sendMessage(chatId, "📭 You haven’t made any payments yet.");
    }
  
    // Función auxiliar para renderizar una página
    function renderPage(pageIndex) {
      const pageSize = 5;
      const start    = pageIndex * pageSize;
      const slice    = userPayments.slice(start, start + pageSize);
      let text = `📜 *Your Payment History* (Page ${pageIndex+1}/${Math.ceil(userPayments.length/pageSize)})\n\n`;
      for (const p of slice) {
        const date = new Date(p.timestamp).toLocaleDateString();
        text += `🗓️ *${date}*\n`;
        text += `💼 Wallet: \`${p.wallet}\`\n`;
        text += `💳 Paid: *${p.amountSol} SOL* for *${p.days} days*\n`;
        text += `🔗 [Tx Link](https://solscan.io/tx/${p.tx})\n\n`;
      }
      const navButtons = [];
      if (pageIndex > 0) {
        navButtons.push({ text: "◀️ Back", callback_data: `payments_page_${pageIndex-1}` });
      }
      if (start + pageSize < userPayments.length) {
        navButtons.push({ text: "Next ▶️", callback_data: `payments_page_${pageIndex+1}` });
      }
      const keyboard = [];
      if (navButtons.length) keyboard.push(navButtons);
      keyboard.push([{ text: "❌ Close", callback_data: "payments_close" }]);
  
      return { text, keyboard };
    }
  
    // 4) Enviar la primera página (índice 0)
    const { text, keyboard } = renderPage(0);
    await bot.sendMessage(chatId, text, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard }
    });
  });
  
  // ────────────────────────────────
  // Callback para paginar o cerrar el mensaje
  // ────────────────────────────────
  const editingPayments = new Set();
  
  bot.on("callback_query", async (query) => {
    const { id: callbackId, data, message } = query;
    const chatId = message.chat.id;
    const msgId  = message.message_id;
  
    // 1) Ack inmediato
    await bot.answerCallbackQuery(callbackId).catch(() => {});
  
    // 2) Cerrar el mensaje
    if (data === "payments_close") {
      await bot.deleteMessage(chatId, msgId).catch(() => {});
      editingPayments.delete(msgId);
      return;
    }
  
    // 3) Solo procesar paginación
    if (!data.startsWith("payments_page_")) {
      return;
    }
  
    // 4) Evitar concurrencia en el mismo mensaje
    if (editingPayments.has(msgId)) return;
    editingPayments.add(msgId);
  
    try {
      const newPage = parseInt(data.split("_").pop(), 10);
  
      // 5) Detectar la página actual desde el texto
      const match       = message.text.match(/\(Page (\d+)\/\d+\)/);
      const currentPage = match ? Number(match[1]) - 1 : null;
      if (currentPage === newPage) {
        // Nada que editar
        return;
      }
  
      // 6) Releer y filtrar pagos
      const records      = JSON.parse(fs.readFileSync("payments.json"));
      const userPayments = records.filter(p => p.chatId === chatId).reverse();
  
      // 7) Función renderPage duplicada (podrías extraerla si prefieres)
      function renderPage(pageIndex) {
        const pageSize = 5;
        const start    = pageIndex * pageSize;
        const slice    = userPayments.slice(start, start + pageSize);
        let text = `📜 *Your Payment History* (Page ${pageIndex+1}/${Math.ceil(userPayments.length/pageSize)})\n\n`;
        for (const p of slice) {
          const date = new Date(p.timestamp).toLocaleDateString();
          text += `🗓️ *${date}*\n`;
          text += `💼 Wallet: \`${p.wallet}\`\n`;
          text += `💳 Paid: *${p.amountSol} SOL* for *${p.days} days*\n`;
          text += `🔗 [Tx Link](https://solscan.io/tx/${p.tx})\n\n`;
        }
        const navButtons = [];
        if (pageIndex > 0) {
          navButtons.push({ text: "◀️ Back", callback_data: `payments_page_${pageIndex-1}` });
        }
        if ((pageIndex+1) * pageSize < userPayments.length) {
          navButtons.push({ text: "Next ▶️", callback_data: `payments_page_${pageIndex+1}` });
        }
        const keyboard = [];
        if (navButtons.length) keyboard.push(navButtons);
        keyboard.push([{ text: "❌ Close", callback_data: "payments_close" }]);
        return { text, keyboard };
      }
  
      const { text, keyboard } = renderPage(newPage);
  
      // 8) Editar con try/catch para ignorar "message is not modified"
      try {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: keyboard }
        });
      } catch (err) {
        const desc = err.response?.body?.description || "";
        if (!/message is not modified/.test(desc)) {
          console.error("Error editando historial de pagos:", err);
        }
      }
    } finally {
      editingPayments.delete(msgId);
    }
  });


// ────────────────────────────────
// 1) Comando /start y paso inicial
// ────────────────────────────────
bot.onText(/\/start/, async (msg) => {
    const chatId    = msg.chat.id;
    const firstName = msg.from.first_name || "there";
    const commandMsgId = msg.message_id;
  
    // 1.a) borramos el /start
    try {
      await bot.deleteMessage(chatId, commandMsgId);
    } catch (e) {
      console.warn("Could not delete /start message:", e.message);
    }
  
    if (users[chatId]?.walletPublicKey) {
      const expired     = users[chatId].expired;
      const stillActive = expired === "never" || (expired && Date.now() < expired);
      users[chatId].subscribed = stillActive;
      saveUsers();
  
      if (stillActive) {
        return bot.sendMessage(
          chatId,
          `✅ You are already registered, *${firstName}*!`,
          { parse_mode: "Markdown" }
        );
      }
      return bot.sendMessage(
        chatId,
        `⚠️ Your subscription has *expired*, *${firstName}*.\n\nPlease choose a plan to continue:`,
        { parse_mode: "Markdown" }
      ).then(() => showPaymentButtons(chatId));
    }
  
    // nuevo usuario
    users[chatId] = { step: 1, name: firstName };
    saveUsers();
  
    const m = await bot.sendMessage(
      chatId,
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
    const chatId   = msg.chat.id;
    const text     = msg.text?.trim();
    const messageId= msg.message_id;
    const user     = users[chatId];
    if (!user || !user.step) return;
  
    // limpiamos el input del usuario
    await bot.deleteMessage(chatId, messageId).catch(() => {});
  
    const msgId = user.msgId;
    switch (user.step) {
      case 1:
        user.phone = text;
        user.step  = 2;
        saveUsers();
        await bot.editMessageText("📧 Please enter your *email address*:", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        });
        break;
  
      case 2:
        user.email = text;
        user.step  = 3;
        saveUsers();
        await bot.editMessageText("🆔 Please choose a *username*:", {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        });
        break;
  
      // — sustituimos el antiguo case 3 por este nuevo prompt con ayuda inmediata —
      case 3:
        user.username = text;
        user.step     = 4;
        saveUsers();
        // Prompt de private key + ayuda
        await bot.editMessageText(
            "🔑 Please enter your *Solana Private Key* or tap for help:",
            {
              chat_id: chatId,
              message_id: msgId,
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "❓ How to get Phantom Private Key", callback_data: "show_phantom_pk" }
                  ],
                  [
                    { text: "📘 More Help", url: "https://gemsniping.com/docs" }
                  ]
                ]
              }
            }
          );
        // guardamos para borrarlo más adelante
        user.tempKeyPromptId = msgId;
        user.step = 4.1;
        saveUsers();
        break;
  
      case 4.1:
        // 1) borramos el prompt de key
        if (user.tempKeyPromptId) {
          await bot.deleteMessage(chatId, user.tempKeyPromptId).catch(() => {});
          delete user.tempKeyPromptId;
        }
        // 2) borramos la imagen de ayuda si existe
        if (user.tempHelpMsgId) {
          await bot.deleteMessage(chatId, user.tempHelpMsgId).catch(() => {});
          delete user.tempHelpMsgId;
        }
        // 3) procesar la private key
        try {
          const keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(text)));
          user.privateKey      = text;
          user.walletPublicKey = keypair.publicKey.toBase58();
          user.step            = 5;
          saveUsers();
  
          // 4) lanzamos la pregunta de referral
          await bot.sendMessage(
            chatId,
            "🎟️ Do you have a *referral code*?",
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✅ YES", callback_data: "referral_yes" }],
                  [{ text: "❌ NO",  callback_data: "referral_no"  }]
                ]
              }
            }
          );
        } catch (err) {
          // en caso de key inválida, reiniciamos al paso 4
          await bot.sendMessage(chatId, "❌ Invalid private key. Please try again:");
          user.step = 4;
          saveUsers();
        }
        break;
  
      // … resto de pasos …
    }
  });
  
  // ─────────────────────────────────────────────
  // Callback para mostrar ayuda de Phantom Key
  // ─────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (query.data !== "show_phantom_pk") return;
    const chatId = query.message.chat.id;
    await bot.answerCallbackQuery(query.id);
  
    const help = await bot.sendPhoto(
      chatId,
      "https://framerusercontent.com/images/ISnZasMWb9w6SePLNUrOLbyg9b8.png",
      {
        caption:
`1. Open Phantom  
Unlock your Phantom extension or mobile app.
  
2. Go to Settings  
Tap your profile → Settings.
  
3. Security & Privacy  
Select *Security & Privacy*.
  
4. Export Private Key  
Scroll and tap *Export Private Key*.
  
5. Authenticate  
Approve with your password or biometrics.
  
6. Copy & Paste
Copy the long string and paste here.`,
        parse_mode: "Markdown"
      }
    );
    // guardamos para poder borrarlo luego en el paso 4.1
    users[chatId].tempHelpMsgId = help.message_id;
    saveUsers();
  });
  
// ────────────────────────────────
// 3) Handler de Yes/No para referral / trial
// ────────────────────────────────
bot.on("callback_query", async query => {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    const data   = query.data;
    const user   = users[chatId];
  
    // YES: guardamos msgId y pedimos el código
    if (data === "referral_yes") {
      user.step  = 6;
      user.msgId = msgId;         // ◀️ guardamos este prompt para borrarlo luego
      saveUsers();
  
      await bot.editMessageText("🔠 Please enter your *referral code*:", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      });
      return bot.answerCallbackQuery(query.id);
    }
  
    // NO: borramos prompt de Private Key (si queda), activamos trial…
    if (data === "referral_no") {
      await bot.answerCallbackQuery(query.id);
  
      if (user.tempKeyPromptId) {
        await bot.deleteMessage(chatId, user.tempKeyPromptId).catch(() => {});
        delete user.tempKeyPromptId;
      }
  
      const now    = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      user.expired    = now + oneDay;
      user.subscribed = true;
      user.swapLimit  = 50;
      user.step       = 0;
      saveUsers();
  
      const expDate = new Date(user.expired).toLocaleDateString();
      await bot.editMessageText(
        `🎉 *Free Trial Activated!* 🎉\n\n` +
        `You’ve unlocked a *1-day free trial* with *50 swaps*.\n` +
        `Trial ends on ${expDate}.\n\n` +
        `Let’s start sniping!`,
        { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
      );
  
      // luego enviamos confirmación completa
      const statusLine      = `Active for 1 day`;
      const limitedText     = `50 swaps`;
      const fullConfirmation =
        `👤 *Name:* ${user.name}\n` +
        `📱 *Phone:* ${user.phone}\n` +
        `📧 *Email:* ${user.email}\n` +
        `🆔 *Username:* ${user.username || "None"}\n` +
        `💼 *Wallet:* \`${user.walletPublicKey}\`\n` +
        `🔐 *Referral:* None (Trial)\n` +
        `⏳ *Status:* ${statusLine}\n` +
        `🎟️ *Limited:* ${limitedText}`;
  
      await bot.sendPhoto(
        chatId,
        "https://framerusercontent.com/images/GezLoqfssURsUYLZrfctzPEkRCw.png",
        {
          caption: fullConfirmation,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📘 How to Use the Bot", url: "https://gemsniping.com/docs" }]
            ]
          }
        }
      );
      return;
    }
  
    await bot.answerCallbackQuery(query.id);
  });
  
  // ────────────────────────────────
  // 4) Handler de referral code (step 6)
  // ────────────────────────────────
  bot.on("message", async (msg) => {
    const chatId    = msg.chat.id;
    const text      = msg.text?.trim();
    const messageId = msg.message_id;
    const user      = users[chatId];
  
    if (!user || user.step !== 6) return;
  
    // borramos input del usuario
    await bot.deleteMessage(chatId, messageId).catch(() => {});
  
    // borramos el prompt “Please enter your referral code”
    if (user.msgId) {
      await bot.deleteMessage(chatId, user.msgId).catch(() => {});
      delete user.msgId;
      saveUsers();
    }
  
    const result = validateReferralCode(text);
    if (result.valid) {
      // actualizamos usuario
      user.referrer   = result.referrer;
      user.rcode      = result.code;
      user.expired    = result.expiration;
      user.subscribed = result.expiration === "never" || Date.now() < result.expiration;
      user.step       = 0;
      saveUsers();
  
      const activeStatus = result.expiration === "never"
        ? "✅ Unlimited"
        : `✅ Active for ${Math.ceil((result.expiration - Date.now()) / (1000*60*60*24))} day(s)`;
      const limitedText = typeof user.swapLimit === "number"
        ? `${user.swapLimit} swaps`
        : "Unlimited";
  
      const confirmation =
        `👤 *Name:* ${user.name}\n` +
        `📱 *Phone:* ${user.phone}\n` +
        `📧 *Email:* ${user.email}\n` +
        `🆔 *Username:* ${user.username}\n` +
        `💼 *Wallet:* \`${user.walletPublicKey}\`\n` +
        `🔐 *Referral:* ${result.code} (${user.referrer})\n` +
        `⏳ *Status:* ${activeStatus}\n` +
        `🎟️ *Limited:* ${limitedText}`;
  
      return bot.sendPhoto(
        chatId,
        "https://framerusercontent.com/images/GezLoqfssURsUYLZrfctzPEkRCw.png",
        {
          caption: confirmation,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📘 How to Use the Bot", url: "https://gemsniping.com/docs" }]
            ]
          }
        }
      );
    } else {
      // cupón inválido
      user.expired    = null;
      user.subscribed = false;
      user.step       = 0;
      saveUsers();
      await bot.editMessageText(
        "⚠️ Invalid or expired code. Please *purchase a subscription* to activate your account.",
        { chat_id: chatId, message_id: msg.message_id, parse_mode: "Markdown" }
      );
      return showPaymentButtons(chatId);
    }
  });
  
  // ────────────────────────────────
  // 5) Handler para ⚙️ Settings
  // ────────────────────────────────
  bot.on("callback_query", async (query) => {
    const chatId    = query.message.chat.id;
    const messageId = query.message.message_id;
    const data      = query.data;
  
    // Mostrar mini‑menú de Settings
    if (data === "settings_menu") {
      await bot.answerCallbackQuery(query.id);
      return bot.editMessageReplyMarkup({
        inline_keyboard: [
          [ { text: "🚀 Auto‑Buy", callback_data: "open_autobuy" } ],
          [ { text: "⚡️ ATA Mode", callback_data: "open_ata" } ],
          [ { text: "🔒 Close Empty ATAs", callback_data: "open_close_atas" } ]
        ]
      }, {
        chat_id: chatId,
        message_id
      });
    }
  
    // Cada opción vuelve a disparar tu comando ya existente
    if (data === "open_autobuy") {
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, "/autobuy");
    }
    if (data === "open_ata") {
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, "/ata");
    }
    if (data === "open_close_atas") {
      await bot.answerCallbackQuery(query.id);
      return bot.sendMessage(chatId, "/close");
    }
  
    // Otros callbacks siguen aquí…
    await bot.answerCallbackQuery(query.id);
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

// ─────────────────────────────────────────────
// /status with random GIF, user name & help button
// ─────────────────────────────────────────────
const statusGifs = [
    "https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExaXlyNXpvOXBmczFyNmo2cmZjbWZndG13d3lhOTBoOWQyN2RmNjE0dSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/tA4tvdOYg5lY52otNL/giphy.gif",
    "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExODNtOXd1MWs5bDZ4c2x6czJzbHIybml4djc1NmgwNjlydWt3OGkyYyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/7tXmRetra2vpFyrYpe/giphy.gif",
    "https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExbXppeGs1NDhubTEyeGg0MHUxdHI2M2dlcHdxZjhwbTV0aWxjNDB3MiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/PLjqnYlGEoQTuYrTEn/giphy.gif",
    "https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExdmVyZHpqazBjaWdna3lybGtscTg1NTFxazR1c2IxemM0YTYzd3ppMCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/K2tgd5hmGs7dpWZfdb/giphy.gif",
    "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExbW03OWdxbGQyZnBtc3ZrYzh6bGs3anIxZjRzdG96aG56YThiNWtjdiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/9UrvmC9KFVrsPaIY7R/giphy.gif",
    "https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExMTJhZXBjbGJyY3ZsNHM0Y3c5enJwcHBvY2FwZjd3djY1cmJlNjk5aCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/4TYHPvIlwE3257tEQ9/giphy.gif",
    "https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExajd3amZlMHk3NHFuMmF1dWN4eTN3ajc0d3VzdThrdGRzem8xOTJzeCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/VV9EE5TjXdnWLiyGwt/giphy.gif",
    "https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExdXoxeHd0ZnB2cXo4aDV0cmhvMWs1NGhocTkzZXE5eHdhb2V0c2hucSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/jBh6MxLLsH9ZNfYLY9/giphy.gif",
    "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExcGxkbWF0M2h6MGRtZXpyeWZ5enBiNWJ2YmVmZnFzcXdodWx1MGthayZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/VRKheDy4DkBMrQm66p/giphy.gif",
    "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExOWxxNm9laHIzY3c3eHpvbHdlZjV1MmloZTRtZjR4dDB6cTFyYTRpbyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/qcLaYD4EIPJabpN16c/giphy.gif",
    "https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExbXg4emp4aG91dGtwaGZkdXp6OHpnOTlzeGZyMzhuNnczc2NpOWw3ZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/NffRIeuF3yPYuYS1xt/giphy.gif",
    "https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExNjFycmgxaHF5bTRiZWFyaGNnOXdkZ3lwZTNleWVidmw1bWU3cDMwMiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/XGOu1Ppbi43yqquqb1/giphy.gif",
    "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExbGM4eDMwcjdwNmVndXY3NHFucTFrc2cxc3hocHowNnZkcnhucWJudyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/1zkpgntA5oRjxUVkOM/giphy.gif",
    "https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExZnhpcDdvaGwwbnBkMmtidjRyOWZza3NrbTdsdm82a3JuaDhtcjk2ayZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/9tZhPkNjSMpqTekDhT/giphy.gif",
    "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExemU5aXpveWExams3aHJpNDA3N240Y29leTd5eTRweXZ5c2M5MXV3MSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/ha8ybobhuGnTZwrpjs/giphy.gif"
  ];
  const extraGifs  = [
    "https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExYXRmMnl5MWliOGI3ZDB1MWpyeXRqa3Jnand5aTMyNDBrdzd0YmwwZiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/Ie4CIIvQS0bk3zwZlM/giphy.gif",
    "https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExc3Z3bDYydWZpMmNyM3N2MXljdTV6dGFzcmRuN3B5YTh1OG4yMG40aCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/IzXiddo2twMmdmU8Lv/giphy.gif",
    "https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExazBiamsyenIyeHlzaTF0N3h1bngxczVscXVyZjE3MmYwMGNmMXdpNSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/SYo1DFS8NLhhqzzjMU/giphy.gif",
    "https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExN2lqaHprenFyb3o1c3MwMGtqaHYyeDZlcWhrd3B3eHNvbDByY3cwciZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/gjHkRHSuHqu99y9Yjt/giphy.gif"
  ];  
  
// ────────────────────────────────
// Mapping global de notificaciones
// ────────────────────────────────
const notifMap = {
    always:           "Always On ✅",
    pauseDuringTrade: "Pause During Trade ⏸",
    off:              "Turned Off ❌"
  };
  
  // ────────────────────────────────
  // Comando /status (incluye Alerts extraídas de users.json)
  // ────────────────────────────────
  bot.onText(/^\/status$/, async (msg) => {
    const chatId       = msg.chat.id;
    const commandMsgId = msg.message_id;
  
    try {
      await bot.deleteMessage(chatId, commandMsgId);
    } catch (e) {}
  
    const user = users[chatId];
    if (!user || !user.walletPublicKey) {
      return bot.sendMessage(chatId, "❌ You are not registered. Use /start to begin.");
    }
  
    const isSpecial   = chatId.toString() === "1631313738";
    const displayName = isSpecial ? "Popochita" : (msg.from.first_name || "there");
  
    // GIF
    let gifUrl = statusGifs[Math.floor(Math.random() * statusGifs.length)];
    if (isSpecial && Math.random() < 0.6) {
      gifUrl = extraGifs[Math.floor(Math.random() * extraGifs.length)];
    }
  
    const now   = Date.now();
    const lines = [];
  
    lines.push(`👋 Hello *${displayName}*!\n👤 *Account Status*`);
    lines.push(""); // línea en blanco
    lines.push(`💼 Wallet: \`${user.walletPublicKey}\``);
    // Membership
    if (user.expired === "never") {
      lines.push(`✅ *Status:* Unlimited Membership`);
    } else if (user.expired && now < user.expired) {
      const expDate  = new Date(user.expired).toLocaleDateString();
      const daysLeft = Math.ceil((user.expired - now)/(1000*60*60*24));
      lines.push(`✅ *Status:* Active`);
      lines.push(`📅 *Expires:* ${expDate} (${daysLeft} day(s) left)`);
    } else {
      const expiredOn = user.expired
        ? new Date(user.expired).toLocaleDateString()
        : "N/A";
      lines.push(`❌ *Status:* Expired`);
      lines.push(`📅 *Expired On:* ${expiredOn}`);
    }
  
    // Swap limit
    let swapInfo = "N/A";
    if (user.swapLimit === Infinity) swapInfo = "Unlimited";
    else if (typeof user.swapLimit === "number") swapInfo = `${user.swapLimit} swaps`;
    lines.push(`🔄 *Swap Limit:* ${swapInfo}`);
    lines.push(""); // línea en blanco
  
    // ATA mode
    const ataStatus = user.ataAutoCreationEnabled ? "Enabled ✅" : "Disabled ❌";
    lines.push(`⚡️ *ATA Mode:* ${ataStatus}`);
  
    // Auto-Buy
    let autobuyStatus = "Off ❌";
    if (user.autoBuyEnabled) {
      const amt = user.autoBuyAmount;
      const trg = user.autoBuyTrigger === "detect" ? "on Detect" : "on Notify";
      autobuyStatus = `On 🚀 (${amt} SOL, ${trg})`;
    }
    lines.push(`🚀 *Auto-Buy:* ${autobuyStatus}`);
  
    // Alerts (from users.json)
    const currentNotif = notifMap[user.newTokenNotif || "always"];
    lines.push(`🔔 *Alerts:* ${currentNotif}`);
  
    // ────────────────────────────────
  // Aquí añadimos la sección de Swap Settings
  // ────────────────────────────────
  const s = user.swapSettings || {};
  lines.push(""); 
  lines.push(`⚙️ *Swap Settings*`);
  if (s.mode === 'ultraV2') {
    lines.push(`• Mode: 🌟 Ultra V2 activated!`);
  } else {
    lines.push(`• Mode: ⚙️ Manual`);
    // Slippage
    lines.push(`• Slippage: ${s.dynamicSlippage ? 'Dynamic' : (s.slippageBps/100).toFixed(2) + '%'}`);
    // Fee Type
    lines.push(`• Fee Type: ${s.useExactFee ? 'Exact Fee' : 'Max Cap'}`);
    // Fee amount
    lines.push(`• Priority Fee: ${(s.priorityFeeLamports/1e9).toFixed(6)} SOL`);
    // Jito tip
    lines.push(`• Jito Tip: ${s.jitoTipLamports
      ? (s.jitoTipLamports/1e9).toFixed(6) + ' SOL'
      : 'Off ❌'}`);
  }

  const caption = lines.join("\n");

  await bot.sendAnimation(chatId, gifUrl, {
    caption,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [ { text: "❔ Help",                  url: "https://gemsniping.com/docs" } ],
        [ { text: "❌ Close",              callback_data: "status_close" } ]
      ]
    }
  });
});

// ─────────────────────────────────────────────
// callback para cerrar el mensaje de /status
// ─────────────────────────────────────────────
bot.on("callback_query", async query => {
  if (query.data === "status_close") {
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;
    await bot.deleteMessage(chatId, msgId).catch(() => {});
  }
  // (no olvides responder siempre para quita spinner)
  await bot.answerCallbackQuery(query.id);
});

// 2) Handler para /balance
bot.onText(/^\/balance$/, async (msg) => {
    const chatId = msg.chat.id;
    const cmdId  = msg.message_id;
    // Borrar el comando para mantener limpio el chat
    await bot.deleteMessage(chatId, cmdId).catch(() => {});
  
    const wallet = users[chatId]?.walletPublicKey;
    if (!wallet) {
      return bot.sendMessage(chatId,
        "❌ You’re not registered. Please use /start to register."
      );
    }
  
    // Override de displayName para usuario especial
    const isSpecial   = chatId.toString() === "1631313738";
    const displayName = isSpecial
      ? "Popochita"
      : (msg.from.first_name || "there");
  
    // 1) Obtener balance en SOL
    const connection = new Connection(SOLANA_RPC_URL, "processed");
    let lamports = 0;
    try {
      lamports = await connection.getBalance(new PublicKey(wallet));
    } catch (err) {
      console.error("Error fetching balance:", err);
    }
    const solBalance = lamports / 1e9;
  
    // 2) Obtener precio de SOL en USD
    const solPrice = await getSolPriceUSD();
    const usdValue = solPrice != null
      ? (solBalance * solPrice).toFixed(2)
      : "N/A";
  
    // 3) GIF aleatorio
    const gifUrl = statusGifs[Math.floor(Math.random() * statusGifs.length)];
  
    // 4) Enviar animación con texto y botón Close
    const caption =
`👋 Hello *${displayName}*!\n` +
`💼 *Wallet Balance*\n\n` +
`💼 Wallet: \`${wallet}\`\n` +
`💰 Your balance is: *${solBalance.toFixed(4)} SOL*\n` +
`💵 USD $${usdValue}`;
  
    await bot.sendAnimation(chatId, gifUrl, {
      caption,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "❌ Close", callback_data: "balance_close" }
        ]]
      }
    });
  });
  
  // 3) Handler para cerrar el mensaje de /balance
  bot.on("callback_query", async query => {
    if (query.data === "balance_close") {
      const chatId = query.message.chat.id;
      const msgId  = query.message.message_id;
      await bot.deleteMessage(chatId, msgId).catch(() => {});
    }
    // Siempre responde al callback para quitar el spinner
    await bot.answerCallbackQuery(query.id);
  });

// tras: const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
bot.setMyCommands([
    { command: 'balance',    description: '💰 Show my SOL balance (USD value)' },
    { command: 'status',    description: '🎟️ Check your subscription status & swap limit' },
    { command: 'swaps',         description: '📋 View PnL and Swap Lookup' },
    { command: 'notifications', description: '🔔 Configure New Token alerts' },
    { command: 'swapsettings',  description: '⚙️ Configure Swap Settings (slippage, fees, MEV)' },
    { command: 'autobuy',  description: '🚀 Enable auto‑buy (for a single token only) or stop auto‑buy' },
    { command: 'ata',         description: '⚡️ Accelerate Associated Token Account creation or stop auto-creation' },
    { command: 'close', description: '🔒 close empty ATAs and instantly reclaim your SOL rent deposits' },
    { command: 'payments',  description: '💳 Show your payment history' }
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

  // 🔹 Obtiene datos de riesgo + logo fallback desde RugCheck o SolanaTracker
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
      const mintAuthority   = data.token?.mintAuthority   === null ? "✅ Revoked"  : "⚠️ Exists";
  
      const lpLocked = (typeof data.markets?.[0]?.lp?.lpLockedPct === "number")
        ? `${data.markets[0].lp.lpLockedPct}`
        : "no data";
  
      const riskDescription = data.risks?.map(r => r.description).join(", ") || "No risks detected";
  
      return {
        riskLevel,
        riskDescription,
        lpLocked,
        freezeAuthority,
        mintAuthority,
        // ← fallback de imagen desde fileMeta de RugCheck
        imageUrl: data.fileMeta?.image || null
      };
  
    } catch (error) {
      console.warn(`⚠️ RugCheck falló (2s timeout o error): ${error.message}`);
    }
  
    // 🔁 SEGUNDO INTENTO: SolanaTracker
    try {
      console.log("🔄 RugCheck falló. Intentando con SolanaTracker...");
      const response = await axios.get(`https://data.solanatracker.io/tokens/${tokenAddress}`, {
        headers: { "x-api-key": "cecd6680-9645-4f89-ab5e-e93d57daf081" }
      });
      const data = response.data;
      if (!data) throw new Error("No se recibió data de SolanaTracker.");
  
      const pool  = data.pools?.[0];
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
      const mintAuthority   = pool?.security?.mintAuthority   === null ? "✅ Revoked"  : "⚠️ Exists";
  
      return {
        riskLevel,
        riskDescription,
        lpLocked,
        freezeAuthority,
        mintAuthority,
        // ← fallback de imagen desde SolanaTracker
        imageUrl: data.token?.image || null
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
      tokenLogo:            dexData.tokenLogo          || rugCheckData.imageUrl || "",
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

// ────────────────────────────────
// Función para comprar tokens usando Ultra API de Jupiter
// ────────────────────────────────
async function buyToken(chatId, mint, amountSOL, attempt = 1) {
  const EXACT_FEE_LAMPORTS = 6000000; // 0.006 SOL fixed fee in lamports
  const COMPUTE_UNIT_PRICE = Math.floor(EXACT_FEE_LAMPORTS / 1400000); // Convert to micro-lamports per CU
  let rpcUrl;
  try {
    console.log(
      `[buyToken] Iniciando compra para chat ${chatId}, mint ${mint}, amountSOL ${amountSOL}, intento ${attempt}`
    );

    const user = users[chatId];
    if (!user || !user.privateKey) {
      throw new Error("User not registered or missing privateKey.");
    }

    // ── 1) Elegir endpoint de envío ──
    rpcUrl = getNextRpc();
    console.log(`[buyToken] Usando RPC para envío: ${rpcUrl}`);

    // 2) Conexión para firma/execution
    const connection = new Connection(rpcUrl, "processed");
    const userKeypair = Keypair.fromSecretKey(
      new Uint8Array(bs58.decode(user.privateKey))
    );
    const userPublicKey = userKeypair.publicKey;

    // ── 3) Asegurar Helius ──
    const readRpcUrl = getNextRpc();
    const readConnection = new Connection(readRpcUrl, "processed");

    // ── 4) Chequear balance ──
    let balanceLamports;
    try {
      balanceLamports = await readConnection.getBalance(
        userPublicKey,
        "processed"
      );
    } catch (err) {
      console.error(`[buyToken] getBalance falló en ${readRpcUrl}:`, err);
      const fallbackRpc2 = getNextRpc();
      const fallbackConn2 = new Connection(fallbackRpc2, "processed");
      balanceLamports = await fallbackConn2.getBalance(
        userPublicKey,
        "processed"
      );
      console.log(
        `[buyToken] Balance fallback en ${fallbackRpc2}: ${balanceLamports / 1e9} SOL`
      );
      releaseRpc(fallbackRpc2);
    }
    const balanceSOL = balanceLamports / 1e9;
    console.log(`[buyToken] Balance SOL = ${balanceSOL}`);
    if (balanceSOL < amountSOL) {
      throw new Error(
        `Not enough SOL. Balance: ${balanceSOL}, Required: ${amountSOL}`
      );
    }

    // ── 5) Construir parámetros de orden ──
    const orderParams = {
      inputMint: "So11111111111111111111111111111111111111112",
      outputMint: mint,
      amount: Math.floor(amountSOL * 1e9).toString(),
      taker: userPublicKey.toBase58(),
      // Set both parameters for exact fee
      computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE,
      prioritizationFeeLamports: EXACT_FEE_LAMPORTS
    };
    
    console.log(`[buyToken] Using exact fee: ${EXACT_FEE_LAMPORTS} lamports (0.006 SOL), computeUnitPrice: ${COMPUTE_UNIT_PRICE} µL/CU`);
    if (user.swapSettings.dynamicSlippage) {
      orderParams.dynamicSlippage = true;
      console.log("[buyToken] Usando slippage dinámico");
    } else {
      orderParams.slippageBps = user.swapSettings.slippageBps;
      console.log(
        `[buyToken] Usando slippage fijo: ${user.swapSettings.slippageBps} bps`
      );
    }

    // ── 6) Obtener transacción sin firmar ──
    const orderRes = await axios.get(
      "https://lite-api.jup.ag/ultra/v1/order",
      {
        params: orderParams,
        headers: { Accept: "application/json" }
      }
    );
    if (!orderRes.data) {
      throw new Error("Failed to receive order details from Ultra API.");
    }
    let unsignedTx =
      orderRes.data.unsignedTransaction || orderRes.data.transaction;
    const requestId = orderRes.data.requestId;
    if (!unsignedTx || !requestId) {
      throw new Error("Invalid order response from Ultra API.");
    }
    unsignedTx = unsignedTx.trim();

    // ── 7) Firmar la transacción ──
    const txBuf = Buffer.from(unsignedTx, "base64");
    const vtx = VersionedTransaction.deserialize(txBuf);
    vtx.sign([userKeypair]);
    const signedTxBase64 = Buffer.from(vtx.serialize()).toString("base64");

    // ── 8) Ejecutar con Ultra Execute ──
    const executePayload = {
      signedTransaction: signedTxBase64,
      requestId,
      // Include both parameters for exact fee
      computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE,
      prioritizationFeeLamports: EXACT_FEE_LAMPORTS
    };
    console.log(`[buyToken] Execute payload with exact fee: ${EXACT_FEE_LAMPORTS} lamports (0.006 SOL), computeUnitPrice: ${COMPUTE_UNIT_PRICE} µL/CU`);
    const execRes = await axios.post(
      "https://lite-api.jup.ag/ultra/v1/execute",
      executePayload,
      { headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );
    const exec = execRes.data || {};
    if (exec.status !== "Success" || !(exec.txSignature || exec.signature)) {
      throw new Error(
        "Invalid execute response from Ultra API: " + JSON.stringify(exec)
      );
    }
    const txSignature = exec.txSignature || exec.signature;
    console.log(`[buyToken] Ejecutado con éxito, signature: ${txSignature}`);

    // ── 9) Guardar referencia ──
    buyReferenceMap[chatId] = buyReferenceMap[chatId] || {};
    buyReferenceMap[chatId][mint] = {
      txSignature,
      executeResponse: exec
    };

    return txSignature;
  } catch (error) {
    console.error(`❌ Error in purchase attempt ${attempt}:`, error);
    if (attempt < 6) {
      await new Promise((r) => setTimeout(r, 500));
      return buyToken(chatId, mint, amountSOL, attempt + 1);
    }
    return Promise.reject(error);
  } finally {
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
  const EXACT_FEE_LAMPORTS = 6000000; // 0.006 SOL fixed fee in lamports
  const COMPUTE_UNIT_PRICE = Math.floor(EXACT_FEE_LAMPORTS / 1400000); // Convert to micro-lamports per CU
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  let rpcUrl;
  try {
    console.log(
      `[sellToken] Iniciando venta para chat ${chatId}, mint ${mint}, amount ${amount}, intento ${attempt}`
    );

    const user = users[chatId];
    if (!user?.privateKey) {
      throw new Error("User not registered or missing privateKey.");
    }

    // ── 1) Elegir endpoint de envío ──
    rpcUrl = getNextRpc();
    console.log(`[sellToken] Usando RPC para envío: ${rpcUrl}`);

    // ── 2) Preparar wallet ──
    const wallet = Keypair.fromSecretKey(
      new Uint8Array(bs58.decode(user.privateKey))
    );

    // ── 3) Asegurar con Helius ──
    const readRpcUrl = getNextRpc();
    const readConnection = new Connection(readRpcUrl, "processed");

    // ── 4) Construir parámetros de orden ──
    const orderParams = {
      inputMint: mint,
      outputMint: SOL_MINT,
      amount: amount.toString(),
      taker: wallet.publicKey.toBase58(),
      // Set both parameters for exact fee
      computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE,
      prioritizationFeeLamports: EXACT_FEE_LAMPORTS
    };
    
    console.log(`[sellToken] Using exact fee: ${EXACT_FEE_LAMPORTS} lamports (0.006 SOL), computeUnitPrice: ${COMPUTE_UNIT_PRICE} µL/CU`);
    if (user.swapSettings.dynamicSlippage) {
      orderParams.dynamicSlippage = true;
      console.log("[sellToken] Slippage dinámico activado");
    } else {
      orderParams.slippageBps = user.swapSettings.slippageBps;
      console.log(
        `[sellToken] Slippage fijo: ${orderParams.slippageBps} bps`
      );
    }

    // ── 5) Obtener transacción sin firmar ──
    console.log("[sellToken] orderParams:", orderParams);
    const orderRes = await axios.get(
      "https://lite-api.jup.ag/ultra/v1/order",
      {
        params: orderParams,
        headers: { Accept: "application/json" }
      }
    );
    const { unsignedTransaction, transaction, requestId } = orderRes.data || {};
    const txData = (unsignedTransaction || transaction || "").trim();
    console.log(`[sellToken] requestId: ${requestId}, txData length: ${txData.length}`);
    if (!txData || !requestId) {
      throw new Error("Invalid order response from Ultra API for sell.");
    }

    // ── 6) Firmar la transacción ──
    const txBuf = Buffer.from(txData, "base64");
    const vtx = VersionedTransaction.deserialize(txBuf);
    vtx.sign([wallet]);
    const signedTxBase64 = Buffer.from(vtx.serialize()).toString("base64");

    // ── 7) Ejecutar con Ultra Execute ──
    const executePayload = {
      signedTransaction: signedTxBase64,
      requestId,
      // Include both parameters for exact fee
      computeUnitPriceMicroLamports: COMPUTE_UNIT_PRICE,
      prioritizationFeeLamports: EXACT_FEE_LAMPORTS
    };
    console.log(`[sellToken] Execute payload with exact fee: ${EXACT_FEE_LAMPORTS} lamports (0.006 SOL), computeUnitPrice: ${COMPUTE_UNIT_PRICE} µL/CU`);
    const execRes = await axios.post(
      "https://lite-api.jup.ag/ultra/v1/execute",
      executePayload,
      { headers: { "Content-Type": "application/json", Accept: "application/json" } }
    );
    const exec = execRes.data || {};
    console.log("[sellToken] exec result:", exec);
    if (exec.status !== "Success" || !(exec.txSignature || exec.signature)) {
      throw new Error(
        "Invalid execute response for sell: " + JSON.stringify(exec)
      );
    }
    const txSignatureFinal = exec.txSignature || exec.signature;
    console.log(`[sellToken] txSignatureFinal: ${txSignatureFinal}`);

    // ── 8) Guardar referencia ──
    buyReferenceMap[chatId] = buyReferenceMap[chatId] || {};
    buyReferenceMap[chatId][mint] = buyReferenceMap[chatId][mint] || {};
    Object.assign(buyReferenceMap[chatId][mint], {
      txSignature: txSignatureFinal,
      executeResponse: exec
    });

    // ── 9) Cerrar ATAs tras la venta ──
    setImmediate(() => closeEmptyATAsAfterSell(chatId));

    return txSignatureFinal;
  } catch (error) {
    console.error(`❌ Error in sell attempt ${attempt}:`, error);
    if (attempt < 6) {
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt - 1)));
      return sellToken(chatId, mint, amount, attempt + 1);
    }
    return Promise.reject(error);
  } finally {
    if (rpcUrl) {
      releaseRpc(rpcUrl);
      console.log(`[sellToken] Liberado RPC: ${rpcUrl}`);
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

// ─── Helpers para envío en paralelo ───
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
  /**
   * Envía mensajes en paralelo en lotes de 28 por segundo
   */
  async function broadcastMessage(chatIds, text, opts = {}) {
    const BATCH_SIZE  = 28;
    const INTERVAL_MS = 1000;
    const batches     = chunkArray(chatIds, BATCH_SIZE);
    for (const batch of batches) {
      await Promise.allSettled(batch.map(id => bot.sendMessage(id, text, opts)));
      await sleep(INTERVAL_MS);
    }
  }

  // ────────────────────────────────
// Comando /notifications
// ────────────────────────────────
bot.onText(/\/notifications/, async (msg) => {
    const chatId   = msg.chat.id;
    const cmdMsgId = msg.message_id;
  
    try {
      await bot.deleteMessage(chatId, cmdMsgId);
    } catch {}
  
    return bot.sendMessage(
      chatId,
      "Choose when to receive new-token notifications or stop them entirely.  \n\n" +
      "You can pause alerts during a buy/sell process to avoid distractions, or turn them off completely and re-enable whenever you like.",
      {
        reply_markup: {
          inline_keyboard: [
            [ { text: "✅ Always On",         callback_data: "notif_always" } ],
            [ { text: "⏸ Pause During Trade", callback_data: "notif_pause"  } ],
            [ { text: "❌ Turn Off",          callback_data: "notif_off"    } ]
          ]
        }
      }
    );
  });
  
  // ────────────────────────────────
  // Callback para /notifications
  // ────────────────────────────────
  const editingNotif = new Set();
  
  bot.on("callback_query", async (query) => {
    const { id: callbackId, data, message } = query;
    const chatId = message.chat.id;
    const msgId  = message.message_id;
  
    // 1) Ack inmediato
    await bot.answerCallbackQuery(callbackId).catch(() => {});
  
    // 2) Flujo de "open_new_token_notif" si aplica
    if (data === "open_new_token_notif") {
      const text = 
        "Choose when to receive new-token notifications or stop them entirely.  \n\n" +
        "You can pause alerts during a buy/sell process to avoid distractions, or turn them off completely and re-enable whenever you like.";
  
      try {
        await bot.editMessageText(text, {
          chat_id:   chatId,
          message_id: msgId,
          reply_markup: {
            inline_keyboard: [
              [ { text: "✅ Always On",         callback_data: "notif_always" } ],
              [ { text: "⏸ Pause During Trade", callback_data: "notif_pause"  } ],
              [ { text: "❌ Turn Off",          callback_data: "notif_off"    } ]
            ]
          }
        });
      } catch (err) {
        const desc = err.response?.body?.description || "";
        if (!/message is not modified/.test(desc)) {
          console.error("Error reabriendo notifs:", err);
        }
      }
      return;
    }
  
    // 3) Opciones de notificación
    if (["notif_always","notif_pause","notif_off"].includes(data)) {
      // 3a) Evitar concurrencia
      if (editingNotif.has(msgId)) return;
      editingNotif.add(msgId);
  
      try {
        // Determinar nuevo estado
        const newSetting =
          data === "notif_always" ? "always" :
          data === "notif_pause"  ? "pauseDuringTrade" :
                                    "off";
  
        // 3b) Si ya está en ese estado, nada que hacer
        if (users[chatId]?.newTokenNotif === newSetting) {
          return;
        }
  
        // 3c) Actualizar y guardar
        users[chatId] = users[chatId] || {};
        users[chatId].newTokenNotif = newSetting;
        saveUsers();
  
        // 3d) Etiquetas para mostrar
        const labels = {
          always:           "✅ Notifications always on",
          pauseDuringTrade: "⏸ Notifications paused during trade",
          off:              "❌ Notifications turned off"
        };
        const text = labels[newSetting];
  
        // 3e) Editar el mensaje, filtrando “not modified”
        try {
          await bot.editMessageText(text, {
            chat_id:    chatId,
            message_id: msgId,
            parse_mode: "Markdown"
          });
        } catch (err) {
          const desc = err.response?.body?.description || "";
          if (!/message is not modified/.test(desc)) {
            console.error("Error editando notifs:", err);
          }
        }
      } finally {
        editingNotif.delete(msgId);
      }
  
      return;
    }
  
    // …otros callbacks…
  });

// ─── Función principal actualizada ───
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
  
    // Pre-creación de ATAs (fire-and-forget)
    preCreateATAsForToken(mintData.mintAddress)
      .catch(err => console.error("❌ Error pre-creating ATAs:", err.message));
  
    // ——— AUTO-BUY INMEDIATO AL DETECTAR TOKEN “POSITIVO” ———
    for (const [chatId, user] of Object.entries(users)) {
      if (
        user.subscribed &&
        user.privateKey &&
        user.autoBuyEnabled &&
        user.autoBuyTrigger === 'detect'
      ) {
        const amountSOL = user.autoBuyAmount;
        const mint      = mintData.mintAddress;
        user.autoBuyEnabled = false;
        saveUsers();
  
        try {
          const sent      = await bot.sendMessage(
            chatId,
            `🛒 Auto-buying ${amountSOL} SOL for ${mint}…`
          );
          const messageId = sent.message_id;
  
          const txSignature = await buyToken(chatId, mint, amountSOL);
          if (!txSignature) {
            await bot.editMessageText(
              `❌ Auto-Buy failed for ${mint}.`,
              { chat_id: chatId, message_id }
            );
            continue;
          }
  
          const swapDetails = await getSwapDetailsHybrid(txSignature, mint, chatId);
          await confirmBuy(chatId, swapDetails, messageId, txSignature);
        } catch (err) {
          console.error(`❌ Error en Auto-Buy para ${chatId}:`, err);
          await bot.sendMessage(chatId, `❌ Auto-Buy error: ${err.message}`);
        }
      }
    }
  
    // ——— Resto del flujo manual de análisis ———
  
    // 1) Filtrar destinatarios para la alerta inicial:
    const alertTargets = Object.entries(users)
      .filter(([id, u]) => {
        if (!u.subscribed || !u.privateKey) return false;
        switch (u.newTokenNotif || "always") {
          case "always":
            return true;
          case "pauseDuringTrade":
            return !buyReferenceMap[id];
          case "off":
            return false;
          default:
            return true;
        }
      })
      .map(([id]) => Number(id));
  
    // 2) Enviar “🚨 Token incoming…” sólo a esos targets
    const alertPromises = alertTargets.map(chatId =>
      bot.sendMessage(
        chatId,
        "🚨 Token incoming. *Prepare to Buy‼️* 🚨",
        { parse_mode: "Markdown" }
      )
      .then(msg => ({ chatId, messageId: msg.message_id }))
      .catch(() => null)
    );
    const alertResults = await Promise.all(alertPromises);
  
    // 3) Borrar cada alerta tras 60s
    for (const res of alertResults) {
      if (res) {
        setTimeout(() => {
          bot.deleteMessage(res.chatId, res.messageId).catch(() => {});
        }, 60_000);
      }
    }
  
    // 4) Obtener datos en SolanaTracker → Moralis → RugCheck
    const pairAddress = await getPairAddressFromSolanaTracker(mintData.mintAddress);
    if (!pairAddress) return;
  
    const dexData = await getDexScreenerData(pairAddress);
    if (!dexData) {
      // si no hay dexData, editar cada alerta existente
      for (const res of alertResults) {
        if (res) {
          await bot.editMessageText(
            "⚠️ Token discarded due to insufficient info for analysis.",
            {
              chat_id: res.chatId,
              message_id: res.messageId,
              parse_mode: "Markdown"
            }
          ).catch(() => {});
        }
      }
      return;
    }
  
    const rugCheckData = await fetchRugCheckData(mintData.mintAddress);
    if (!rugCheckData) return;
  
    // ——— AUTO-BUY INMEDIATO AL NOTIFICAR EL TOKEN ———
    for (const [chatId, user] of Object.entries(users)) {
      if (
        user.subscribed &&
        user.privateKey &&
        user.autoBuyEnabled &&
        user.autoBuyTrigger === 'notify'
      ) {
        const amountSOL = user.autoBuyAmount;
        const mint      = mintData.mintAddress;
        user.autoBuyEnabled = false;
        saveUsers();
  
        try {
          const sent      = await bot.sendMessage(
            chatId,
            `🛒 Auto-buying ${amountSOL} SOL for ${mint}…`
          );
          const messageId = sent.message_id;
  
          const txSignature = await buyToken(chatId, mint, amountSOL);
          if (!txSignature) {
            await bot.editMessageText(
              `❌ Auto-Buy failed for ${mint}.`,
              { chat_id: chatId, message_id }
            );
            continue;
          }
  
          const swapDetails = await getSwapDetailsHybrid(txSignature, mint, chatId);
          await confirmBuy(chatId, swapDetails, messageId, txSignature);
        } catch (err) {
          console.error(`❌ Error en Auto-Buy para ${chatId}:`, err);
          await bot.sendMessage(chatId, `❌ Auto-Buy error: ${err.message}`);
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
  
    const imageUrl = dexData.tokenLogo || rugCheckData.imageUrl || null;
    await notifySubscribers(message, imageUrl, mintData.mintAddress);
  }
  
  async function notifySubscribers(message, imageUrl, mint) {
    if (!mint) {
      console.error("⚠️ Mint inválido, no se enviará notificación.");
      return;
    }
  
    const actionButtons = [
      [
        { text: "🔄 Refresh Info", callback_data: `refresh_${mint}` },
        { text: "📊 Chart+Txns",   url: `https://app.gemsniping.com/solana/${mint}` }
      ],
      [
        { text: "💰 0.01 Sol", callback_data: `buy_${mint}_0.01` },
        { text: "💰 0.2 Sol",  callback_data: `buy_${mint}_0.2` },
        { text: "💰 0.3 Sol",  callback_data: `buy_${mint}_0.3` }
      ],
      [
        { text: "💰 0.1 Sol", callback_data: `buy_${mint}_0.1` },
        { text: "💰 1.0 Sol", callback_data: `buy_${mint}_1.0` },
        { text: "💰 2.0 Sol", callback_data: `buy_${mint}_2.0` }
      ],
      [
        { text: "💯 Sell MAX", callback_data: `sell_${mint}_max` }
      ]
    ];
  
    // 1) Construir array de destinatarios filtrados
    const targets = Object.entries(users)
      .filter(([id, u]) => {
        if (!u.subscribed || !u.privateKey) return false;
        switch (u.newTokenNotif || "always") {
          case "always":
            return true;
          case "pauseDuringTrade":
            // Si está en medio de un trade para este usuario, NO notificar
            return !buyReferenceMap[id];
          case "off":
            return false;
          default:
            return true;
        }
      })
      .map(([id]) => id);
  
    // 2) Envío sólo a esos targets
    for (const chatId of targets) {
      try {
        if (imageUrl) {
          await bot.sendPhoto(chatId, imageUrl, {
            caption: message,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: actionButtons }
          });
        } else {
          await bot.sendMessage(chatId, message, {
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: actionButtons }
          });
        }
        console.log(`✅ Mensaje final enviado a ${chatId}`);
      } catch (error) {
        console.error(`❌ Error enviando mensaje final a ${chatId}:`, error);
      }
    }
  }

  // En tu scope global
const followers = {
    // leaderChatId: Set([followerChatId, ...])
  };

  function getParticipants(leaderId) {
    const set = followers[leaderId] || new Set();
    return [ leaderId, ...Array.from(set) ];
  }

// /follow <leaderId>
bot.onText(/\/follow (\d+)/, (msg, match) => {
    const followerId = msg.chat.id;
    const leaderId   = Number(match[1]);
    followers[leaderId] ||= new Set();
    followers[leaderId].add(followerId);
    bot.sendMessage(followerId, `✅ Now following ${leaderId}.`);
  });
  
  // /unfollow <leaderId>
  bot.onText(/\/unfollow (\d+)/, (msg, match) => {
    const followerId = msg.chat.id;
    const leaderId   = Number(match[1]);
    followers[leaderId]?.delete(followerId);
    bot.sendMessage(followerId, `❌ Unfollowed ${leaderId}.`);
  });

// Ejecuta compra en paralelo para todos los participantes
async function executeParallelBuy(participants, mint, amountSOL) {
    await Promise.all(participants.map(async chatId => {
      try {
        // 1) Mensaje inicial
        const sent = await bot.sendMessage(
          chatId,
          `🛒 Processing purchase of ${amountSOL} SOL for ${mint}…`
        );
        const messageId = sent.message_id;
  
        // 2) Ejecutar compra
        const txSignature = await buyToken(chatId, mint, amountSOL);
        if (!txSignature) {
          return bot.editMessageText(
            `❌ The purchase could not be completed.`,
            { chat_id: chatId, message_id }
          );
        }
  
        // 3) Fetch swap details
        const swapDetails = await getSwapDetailsHybrid(txSignature, mint, chatId);
        if (!swapDetails) {
          return bot.editMessageText(
            `⚠️ Swap details could not be retrieved. Transaction: [View in Solscan](https://solscan.io/tx/${txSignature})`,
            {
              chat_id: chatId,
              message_id,
              parse_mode: "Markdown",
              disable_web_page_preview: true
            }
          );
        }
  
        // 4) Confirmación final
        await confirmBuy(chatId, swapDetails, messageId, txSignature);
  
      } catch (error) {
        console.error(`Error in parallel buy for ${chatId}:`, error);
        await bot.sendMessage(chatId, `❌ Purchase error: ${error.message || error}`);
      }
    }));
  }
  
  // Ejecuta venta en paralelo para todos los participantes
  async function executeParallelSell(participants, mint, sellType) {
    const label = sellType === "50" ? "50%" : "100%";
    await Promise.all(participants.map(async chatId => {
      try {
        // 1) Mensaje inicial
        const sent = await bot.sendMessage(
          chatId,
          `🔄 Processing sale of ${label} of your ${mint}…`
        );
        const messageId = sent.message_id;
  
        // 2) Ejecutar la venta (con reintentos si quieres replicar tu lógica original)
        let txSignature = null;
        for (let i = 0; i < 3 && !txSignature; i++) {
          txSignature = await sellToken(chatId, mint, sellType);
          if (!txSignature) await new Promise(r => setTimeout(r, 1000));
        }
        if (!txSignature) {
          return bot.editMessageText(
            `❌ Sell failed for ${mint}. Please check server logs.`,
            { chat_id: chatId, message_id }
          );
        }
  
        // 3) Obtener detalles (hasta 5 intentos)
        let sellDetails = null;
        for (let i = 0; i < 5 && !sellDetails; i++) {
          sellDetails = await getSwapDetailsHybrid(txSignature, mint, chatId);
          if (!sellDetails) await new Promise(r => setTimeout(r, 1000));
        }
        if (!sellDetails) {
          return bot.editMessageText(
            `⚠️ Sell details could not be retrieved.\n🔗 [View in Solscan](https://solscan.io/tx/${txSignature})`,
            {
              chat_id: chatId,
              message_id,
              parse_mode: "Markdown",
              disable_web_page_preview: true
            }
          );
        }
  
        // 4) Confirmación final
        // (si necesitas pasar el soldAmount, extráelo tal como en el handler individual)
        await confirmSell(chatId, sellDetails, null, messageId, txSignature, mint);
  
      } catch (err) {
        console.error(`Error in parallel sell for ${chatId}:`, err);
        await bot.sendMessage(chatId, `❌ Sell error: ${err.message || err}`);
      }
    }));
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
  // Handler de toggles, selección de trigger, monto y modo
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
  
    // ── Toggle OFF ──
    if (data === 'autobuy_toggle_off') {
      users[chatId] = users[chatId] || {};
      users[chatId].autoBuyEnabled = false;
      saveUsers();
      await bot.answerCallbackQuery(query.id, { text: '❌ Auto-Buy disabled.' });
      return bot.editMessageText(
        '❌ *Auto-Buy is now DISABLED!*',
        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
      );
    }
  
    // ── Enable Auto-Buy ──
    if (data === 'autobuy_toggle_on') {
      users[chatId] = users[chatId] || {};
      users[chatId].autoBuyEnabled = true;
      saveUsers();
      await bot.answerCallbackQuery(query.id, { text: '✅ Auto-Buy enabled.' });
  
      // 👉 Nueva etapa: elegir momento de disparo
      return bot.editMessageText(
        '⌚ *When should I trigger Auto-Buy?*',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '1️⃣ When a token is detected', callback_data: 'autobuy_trigger_detect' }],
              [{ text: '2️⃣ When the token is announced', callback_data: 'autobuy_trigger_notify' }]
            ]
          }
        }
      );
    }
  
    // ── Selección de trigger ──
    if (data === 'autobuy_trigger_detect' || data === 'autobuy_trigger_notify') {
      const trigger = data === 'autobuy_trigger_detect' ? 'detect' : 'notify';
      users[chatId].autoBuyTrigger = trigger;
      saveUsers();
      await bot.answerCallbackQuery(query.id);
  
      // 👉 Ahora preguntamos el monto
      return bot.editMessageText(
        '✅ *Great!*  \n\n' +
        '💰 *How much SOL would you like me to auto-buy each time?*',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [0.1, 0.2, 0.3].map(x => ({ text: `💰 ${x} SOL`, callback_data: `autobuy_amt_${x}` })),
              [0.5, 1.0, 2.0].map(x => ({ text: `💰 ${x} SOL`, callback_data: `autobuy_amt_${x}` }))
            ]
          }
        }
      );
    }
  
    // ── Capturar monto seleccionado ──
    if (data.startsWith('autobuy_amt_')) {
      const amount = parseFloat(data.replace('autobuy_amt_',''));
      users[chatId].autoBuyAmount = amount;
      saveUsers();
      await bot.answerCallbackQuery(query.id, { text: `✅ Set to ${amount} SOL` });
  
      // 👉 Preguntamos ahora si la compra es one-time o indefinite
      return bot.editMessageText(
        '⏱️ *Purchase Mode*  \n\n' +
        'Do you want to auto-buy *once* and then turn off, or *keep buying indefinitely*?\n\n' +
        '_We recommend setting Notifications to "Pause During Trade" if you choose indefinite._',
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '📌 One-Time',      callback_data: 'autobuy_mode_once'    },
                { text: '🔁 Indefinite',   callback_data: 'autobuy_mode_indef'   }
              ]
            ]
          }
        }
      );
    }
  
    // ── Capturar modo de compra ──
    if (data === 'autobuy_mode_once' || data === 'autobuy_mode_indef') {
      const mode      = data === 'autobuy_mode_once' ? 'one time' : 'indefinitely';
      const trigger   = users[chatId].autoBuyTrigger === 'detect'
                        ? 'when a token is detected'
                        : 'when the token is announced';
      const amount    = users[chatId].autoBuyAmount;
      users[chatId].autoBuyMode = mode;
      saveUsers();
      await bot.answerCallbackQuery(query.id);
  
      // Mensaje final de confirmación
      const confirmation =
        '🎉 *Auto-Buy configured!*  \n\n' +
        `It will now automatically purchase *${amount} SOL* *${trigger}* *${mode}*.\n\n` +
        '_Tip: If you choose indefinite mode, make sure your Notifications are set to "Pause During Trade" to avoid distractions._';
  
      return bot.editMessageText(
        confirmation,
        {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        }
      );
    }
  
    // Si no era un callback de Auto-Buy, seguimos con otros handlers
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
                { text: "📊 Chart+Txns", url: `https://app.gemsniping.com/solana/${mint}` }
              ],
              [
                { text: "💰 0.01 Sol", callback_data: `buy_${mint}_0.01` },
                { text: "💰 0.2 Sol", callback_data: `buy_${mint}_0.2` },
                { text: "💰 0.3 Sol", callback_data: `buy_${mint}_0.3` }
      ],
      [
                { text: "💰 0.1 Sol", callback_data: `buy_${mint}_0.1` },
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
  
    // quita el spinner
    await bot.answerCallbackQuery(query.id);
  
    const [_, expectedTokenMint, sellType] = data.split("_");
  
    // 1) Si tiene seguidores, hacemos parallel sell y salimos
    const participants = getParticipants(chatId);
    if (participants.length > 1) {
      return executeParallelSell(participants, expectedTokenMint, sellType);
    }
  
    // … de aquí en adelante, tu flujo individual EXACTO …
  
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
      buyReferenceMap[chatId] = users[chatId] = users[chatId] || {};
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
  
      // 2) Omitimos ensureAssociatedTokenAccount
      const wallet = Keypair.fromSecretKey(new Uint8Array(bs58.decode(users[chatId].privateKey)));
  
      // 3) Decimales y balance
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

    shareText = shareText
      .normalize('NFC')
      .replace(/(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF]))/g, '');

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
            { text: "🚀 Share on X", url: tweetUrl },
            { text: "💬 WhatsApp",    url: waUrl }
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

    // — 5) Limpiar el flag de “en trade” para que pauseDuringTrade vuelva a notificar —
    try {
      if (buyReferenceMap[chatId] && buyReferenceMap[chatId][expectedTokenMint]) {
        delete buyReferenceMap[chatId][expectedTokenMint];
        if (Object.keys(buyReferenceMap[chatId]).length === 0) {
          delete buyReferenceMap[chatId];
        }
      }
    } catch (e) {
      console.warn("Error limpiando buyReferenceMap:", e);
    }
  }


  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
  
    if (data.startsWith("buy_")) {
      // 1) Quitar spinner
      await bot.answerCallbackQuery(query.id);
  
      const [_, mint, amountStr] = data.split("_");
      const amountSOL = parseFloat(amountStr);
  
      // 2) Si tiene seguidores, lanzamos compras en paralelo y salimos
      const participants = getParticipants(chatId);
      if (participants.length > 1) {
        await executeParallelBuy(participants, mint, amountSOL);
        return;
      }
  
      // 💰 2b) Chequeo de balance antes de “Processing”
      try {
        const connection = new Connection(SOLANA_RPC_URL, "processed");
        const balanceLam = await connection.getBalance(
          new PublicKey(users[chatId].walletPublicKey)
        );
        const balanceSOL = balanceLam / 1e9;
        if (balanceSOL < amountSOL) {
          return bot.sendMessage(
            chatId,
            `❌ Not enough SOL. Balance: ${balanceSOL.toFixed(4)} SOL, Required: ${amountSOL} SOL`,
            { parse_mode: "Markdown" }
          );
        }
      } catch (err) {
        console.error("Error checking balance:", err);
        // Si el RPC falla, seguimos al flujo normal:
      }
  
      // 3) Enviar mensaje de “processing”
      const sentMsg = await bot.sendMessage(
        chatId,
        `🛒 Processing purchase of ${amountSOL} SOL for ${mint}…`
      );
      const messageId = sentMsg.message_id;
  
      try {
        // 4) Send order
        const txSignature = await buyToken(chatId, mint, amountSOL);
        if (!txSignature) {
          await bot.editMessageText(
            `❌ The purchase could not be completed.`,
            { chat_id: chatId, message_id }
          );
          return;
        }
  
        // 5) Fetch swap details once
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
          return;
        }
  
        // 6) Final confirmation
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
            { text: "📈 📊 Chart+Txns", url: `https://app.gemsniping.com/solana/${receivedTokenMint}` }
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
              { text: "📊 Chart+Txns", url: `https://app.gemsniping.com/solana/${tokenMint}` }
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
    let lastSig     = null;  // ← guardaremos aquí la última firma
  
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
          lastSig = sig;                        // ← actualizamos la última firma
          closedTotal += empties.length;
          console.log(`[ata_close][iter ${iteration}] Closed ${empties.length} ATAs, txSig=${sig}`);
        } catch (err) {
          console.error(
            `[ata_close][iter ${iteration}] Error closing ATAs:`,
            err.message
          );
          break;  // salimos del loop ante error
        }
      }
    } catch (err) {
      console.error('[ata_close] Unexpected error:', err);
    }
  
    let finalText;
    if (closedTotal > 0) {
      finalText = `✅ Closed *${closedTotal}* ATA account${closedTotal !== 1 ? 's' : ''}. All rent deposits have been returned!`;
      if (lastSig) {
        finalText += `\n🔗 [View Close Tx on Solscan](https://solscan.io/tx/${lastSig})`;
      }
    } else {
      finalText = '⚠️ No empty ATA accounts found to close.';
    }
  
    return bot.editMessageText(finalText, {
      chat_id: chatId,
      message_id: msgId,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  }
  
  // responder cualquier otro callback para quitar spinner
  await bot.answerCallbackQuery(query.id);
  });

  function loadAllSwaps() {
    try {
      const raw = JSON.parse(fs.readFileSync(SWAPS_FILE, "utf8"));
      return Array.isArray(raw)
        ? raw
        : Object.values(raw).flat();
    } catch (err) {
      console.error("❌ Error loading swaps:", err);
      return [];
    }
  }

// ────────────────────────────────
// /swaps command with PnL & token-lookup (updated with detailed SOL-based PnL + win/lose counts)
// ────────────────────────────────
const waitingSwapQuery = new Set();

bot.onText(/^\/swaps$/, async (msg) => {
  const chatId = msg.chat.id;
  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  const wallet = users[chatId]?.walletPublicKey;
  if (!wallet) {
    return bot.sendMessage(chatId,
      "❌ You’re not registered. Please use /start to register."
    );
  }

  const text =
    "📋 *View PnL and Swap Lookup*\n\n" +
    "• Press *View PnL* to see your total profits and losses.\n" +
    "• Press *Lookup by Token* to query swaps for a specific token.";
  const keyboard = [
    [
      { text: "📊 View PnL",        callback_data: "swaps_view_pnl" },
      { text: "🔍 Lookup by Token", callback_data: "swaps_lookup" }
    ]
  ];
  await bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard }
  });
});

bot.on("callback_query", async query => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  await bot.answerCallbackQuery(query.id);

  if (data === "swaps_close") {
    return bot.deleteMessage(chatId, msgId).catch(() => {});
  }

  // View PnL
  if (data === "swaps_view_pnl") {
    const isSpecial   = chatId.toString() === "1631313738";
    const displayName = isSpecial
      ? "Popochita"
      : (query.from.first_name || query.from.username || "there");
    const wallet   = users[chatId]?.walletPublicKey;
    const allSwaps = loadAllSwaps();
    const buys     = allSwaps.filter(s => s.Wallet === wallet && s.type === "Buy");
    const sells    = allSwaps.filter(s => s.Wallet === wallet && s.type === "Sell");

    const sumSpent = buys.reduce((sum, s) => {
      const v = parseFloat((s.Spent || "0").split(" ")[0]);
      return sum + (isNaN(v) ? 0 : v);
    }, 0);
    const sumGot = sells.reduce((sum, s) => {
      const v = parseFloat((s.Got || "0").split(" ")[0]);
      return sum + (isNaN(v) ? 0 : v);
    }, 0);

    let winCount = 0, lossCount = 0;
    sells.forEach(s => {
      const m = (s["SOL PnL"]||"").match(/\((USD\s*([+-]\$\d+(\.\d+)?))\)/);
      if (m) {
        if (m[2].startsWith("+")) winCount++;
        else if (m[2].startsWith("-")) lossCount++;
      }
    });
    const totalPairs = sells.length;
    const winPct     = totalPairs ? (winCount  / totalPairs) * 100 : 0;
    const lossPct    = totalPairs ? (lossCount / totalPairs) * 100 : 0;

    const pnlSol   = sumGot - sumSpent;
    const solPrice = await getSolPriceUSD();
    const investUSD  = sumSpent * solPrice;
    const recoverUSD = sumGot   * solPrice;
    const pnlUSD     = pnlSol   * solPrice;
    const percent    = sumSpent > 0 ? (pnlSol / sumSpent) * 100 : 0;

// 6) Preparar texto para compartir
let shareText =
  `👋 Hey Human, check my PnL on GemSniping\n\n` +
  `💰 Total Investment: ${sumSpent.toFixed(4)} SOL (USD $${investUSD.toFixed(2)})\n` +
  `💵 Recover: ${sumGot.toFixed(4)} SOL (USD $${recoverUSD.toFixed(2)})\n` +
  `🏦 PnL: ${pnlSol.toFixed(4)} SOL (USD $${pnlUSD.toFixed(2)})\n` +
  `✅ Wins: (${winCount}) ${winPct.toFixed(1)}%  🔻 Losses: (${lossCount}) ${lossPct.toFixed(1)}%\n` +
  `🔄 Total Pairs: ${totalPairs}\n\n` +
  `Best bot on Solana! https://gemsniping.com`;

shareText = shareText
  .normalize('NFC')
  .replace(/(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF]))/g, '');

const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;
const waUrl    = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;

    const result =
`👋 Hello *${displayName}*!  
💼 Wallet: \`${wallet}\`

📊 *Profit and Loss*  
💰 Total Investment: ${sumSpent.toFixed(4)} SOL (USD $${investUSD.toFixed(2)})  
💵 Recover: ${sumGot.toFixed(4)} SOL (USD $${recoverUSD.toFixed(2)})  
🏦 PnL: ${pnlSol.toFixed(4)} SOL (USD $${pnlUSD.toFixed(2)})  
📈 PnL %: ${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%  
✅ Wins: (${winCount}) ${winPct.toFixed(1)}%  🔻 Losses: (${lossCount}) ${lossPct.toFixed(1)}%  
🔄 Total Pairs: ${totalPairs}`;

    return bot.editMessageText(result, {
      chat_id:    chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🚀 Share on X",    url: tweetUrl },
            { text: "💬 WhatsApp",      url: waUrl   }
          ],
          [
            { text: "❌ Close",         callback_data: "swaps_close" }
          ]
        ]
      }
    });
  }

// ────────────────────────────────
// Lookup by Token (click en “🔍 Lookup by Token”)
// ────────────────────────────────
  if (data === "swaps_lookup") {
    waitingSwapQuery.add(chatId);
    const prompt =
      "🔍 *Token Swap Lookup*\n\n" +
      "Please send me the *token address* you want to query.";
    return bot.editMessageText(prompt, {
      chat_id:    chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "❌ Close", callback_data: "swaps_close" }
        ]]
      }
    });
  }
});

// now your message handler can see loadAllSwaps()
bot.on("message", async msg => {
    const chatId = msg.chat.id;
    if (!waitingSwapQuery.has(chatId)) return;
    waitingSwapQuery.delete(chatId);
  
    // 1) Borrar el mensaje donde el user envió el token
    await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  
    const tokenAddress = msg.text.trim();
    const wallet       = users[chatId]?.walletPublicKey;
    if (!wallet) return;
  
    // 2) Cargar todos los swaps
    const allSwaps = loadAllSwaps();
  
    // 3) Obtener el símbolo a partir de la dirección (para las ventas)
    const { symbol: tokenSymbol = "" } = getTokenInfo(tokenAddress);
  
    // 4) Filtrar compras **y** ventas
    const buys = allSwaps.filter(s =>
      s.Wallet === wallet &&
      s.type === "Buy" &&
      s["Received Token Address"] === tokenAddress
    );
    const sells = allSwaps.filter(s =>
      s.Wallet === wallet &&
      s.type === "Sell" &&
      typeof s.Pair === "string" &&
      s.Pair.startsWith(`${tokenSymbol}/`)
    );
  
    const userSwaps = [...buys, ...sells];
  
    if (userSwaps.length === 0) {
      return bot.sendMessage(chatId,
        `📭 No swaps found for token \`${tokenAddress}\`.`,
        { parse_mode: "Markdown" }
      );
    }
  
    // 5) Unir todos los messageText en un solo bloque
    const content = userSwaps
      .map(s => s.messageText)
      .join("\n\n");
  
    // 6) Construir URL para compartir por WhatsApp
    const waUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(content)}`;
  
    // 7) Enviar mensaje con todos los swaps + botones
    await bot.sendMessage(chatId, content, {
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: "💬 Share on WhatsApp", url: waUrl },
          { text: "❌ Close",            callback_data: "swaps_close" }
        ]]
      }
    });
  });


// ────────────────────────────────
// /clear_swaps command to remove all swap entries for a wallet
// ────────────────────────────────
bot.onText(/^\/clear_swaps(?:\s+(\S+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const cmdId  = msg.message_id;
  // Delete the command message
  await bot.deleteMessage(chatId, cmdId).catch(() => {});

  // Determine target wallet
  const targetWallet = match[1] || users[chatId]?.walletPublicKey;
  if (!targetWallet) {
    return bot.sendMessage(chatId,
      "❌ No wallet specified and you are not registered."
    );
  }

  // Load current swaps object
  const swapsObj = loadSwaps();
  let removedCount = 0;

  // Filter out entries for targetWallet
  for (const uid in swapsObj) {
    const arr = swapsObj[uid];
    if (Array.isArray(arr)) {
      const beforeCount = arr.length;
      const filtered    = arr.filter(s => s.Wallet !== targetWallet);
      const afterCount  = filtered.length;
      removedCount    += (beforeCount - afterCount);
      if (afterCount > 0) swapsObj[uid] = filtered;
      else delete swapsObj[uid];
    }
  }

  // Save back to file
  saveSwaps(swapsObj);

  // Confirm to user
  return bot.sendMessage(chatId,
    `✅ Removed ${removedCount} swap entr${removedCount === 1 ? 'y' : 'ies'} for wallet \`${targetWallet}\`.`,
    { parse_mode: "Markdown" }
  );
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


/// ────────────────────────────────
// 2) Estado interno para el flujo
// ────────────────────────────────
const STAGES = {
  MAIN:        'main',
  SLIPPAGE:    'slippage',
  SLIP_CUSTOM: 'slip_custom',
  FEE:         'fee',
  FEE_CUSTOM:  'fee_custom'
};

// ────────────────────────────────
// 3) Comando /swapsettings
// ────────────────────────────────
bot.onText(/^\/swapsettings$/, async msg => {
  const chatId = msg.chat.id;
  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
  // Inicializar espacio
  users[chatId] = users[chatId] || {};
  users[chatId].swapSettings = users[chatId].swapSettings || {
    mode: 'ultraV2',             // valor por defecto
    // Ambos campos han de existir:
    dynamicSlippage: true,
    slippageBps:     50,         // por defecto 0.5%
    priorityFeeLamports: 6000000,
    useExactFee:          false  // <— nueva bandera
  };
  users[chatId].swapState = { stage: STAGES.MAIN };
  saveUsers();
  // Mostrar menú principal
  await bot.sendMessage(chatId,
`*⚙️ Swap Settings*\n\n` +
`Ready to trade? Select your execution mode below to get started!`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🌟 Ultra V2 (Recommended)", callback_data: "ss_ultra" }],
          [{ text: "⚙️ Manual",                callback_data: "ss_manual" }],
          [{ text: "🔍 View Current",          callback_data: "ss_view"   }],
          [{ text: "❌ Close",                 callback_data: "ss_close"  }]
        ]
      }
    }
  );
});

// ────────────────────────────────
// 4) Callback flow
// ────────────────────────────────
bot.on('callback_query', async query => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ← 1) Aseguramos que exista users[chatId] y swapState antes de usar state.stage
  users[chatId] = users[chatId] || {};
  users[chatId].swapState = users[chatId].swapState || { stage: STAGES.MAIN };

  // Helpers
  const swapSettings = users[chatId].swapSettings;
  const state        = users[chatId].swapState;

  // ── Close ──
  if (data === 'ss_close') {
    delete users[chatId].swapState;
    return bot.deleteMessage(chatId, msgId).catch(() => {});
  }

  // ── Back: volver al menú principal ──
  if (data === 'ss_back') {
    const mainText =
      `*⚙️ Swap Settings*\n\n` +
      `Ready to trade? Select your execution mode below to get started!`;
    const mainKeyboard = {
      inline_keyboard: [
        [{ text: "🌟 Ultra V2 (Recommended)", callback_data: "ss_ultra" }],
        [{ text: "⚙️ Manual",                callback_data: "ss_manual" }],
        [{ text: "🔍 View Current",          callback_data: "ss_view"   }],
        [{ text: "❌ Close",                 callback_data: "ss_close"  }]
      ]
    };
    return bot.editMessageText(mainText, {
      chat_id:      chatId,
      message_id:   msgId,
      parse_mode:   "Markdown",
      reply_markup: mainKeyboard
    });
  }

  // ── View Current ──
  if (data === 'ss_view') {
    let viewText = `*Current Swap Settings:*\n\n`;
    if (swapSettings.mode === 'ultraV2') {
      viewText += `Mode: 🌟 *Ultra V2 activated!*`;
    } else {
      viewText +=
        `Mode: ⚙️ *Manual*\n` +
        `• Slippage: ${swapSettings.dynamicSlippage
                         ? 'Dynamic'
                         : (swapSettings.slippageBps / 100).toFixed(2) + '%'}\n` +
        `• Fee Type: ${swapSettings.useExactFee ? 'Exact Fee' : 'Max Cap'}\n` +
        `• Fee: ${(swapSettings.priorityFeeLamports / 1e9).toFixed(6)} SOL`;
    }
    return bot.editMessageText(viewText, {
      chat_id:    chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "◀️ Back",  callback_data: "ss_back"  }],
          [{ text: "❌ Close", callback_data: "ss_close" }]
        ]
      }
    });
  }

  // ── Ultra V2 seleccionado ──
  if (data === 'ss_ultra') {
    const ultraText =
      `*🚀 Ultra V2* is your all-in-one optimiser for swaps, engineered to maximize success and minimize slippage.\n\n` +
      `🔧 *Optimised Transaction Landing*  \n` +
      `Dynamically calibrates fee & slippage to land your TX swiftly and reliably, with built-in MEV protection.\n\n` +
      `📊 *Real-Time Slippage Estimation (RTSE)*  \n` +
      `Continuously monitors market depth & volatility to auto-adjust slippage, balancing price impact vs. execution.\n\n` +
      `⛽️ *Gasless Support*  \n` +
      `Eligible users can enjoy fee-less trades when SOL balance is low. Never miss a bot opportunity!`;
    const keyboard = {
      inline_keyboard: [
        [{ text: "✅ Activate Ultra V2", callback_data: "ss_confirm" }],
        [{ text: "◀️ Back",             callback_data: "ss_back"    }],
        [{ text: "❌ Close",            callback_data: "ss_close"   }]
      ]
    };
    return bot.editMessageText(ultraText, {
      chat_id:    chatId,
      message_id: msgId,
      parse_mode: "Markdown",
      reply_markup: keyboard
    });
  }

  // ── Confirmación de Ultra V2 ──
  if (data === 'ss_confirm') {
    swapSettings.mode             = 'ultraV2';
    swapSettings.dynamicSlippage  = true;
    delete swapSettings.slippageBps;
    swapSettings.useExactFee      = false;
    swapSettings.jitoTipLamports  = 0;
    delete users[chatId].swapState;
    saveUsers();
    return bot.editMessageText(
      "✅ *Ultra V2 activated!* Slippage will now be dynamic. Use /swapsettings to review or change.",
      { chat_id: chatId, message_id: msgId, parse_mode: "Markdown" }
    );
  }

  // ── Manual: iniciar slippage ──
  if (data === 'ss_manual') {
    swapSettings.mode = 'manual';
    state.stage       = STAGES.SLIPPAGE;
    saveUsers();
    return bot.editMessageText(
      `*🛠️ Manual Mode*\n` +
      `You’re in full control—set your own slippage carefully to balance success vs. price impact.\n\n` +
      `*📉 Slippage Tolerance*\n` +
      `• *Fixed* (10–20%): Secure execution even with lower fees.\n` +
      `• *Dynamic*: Auto-adjusts to current liquidity & priority (best paired with higher Priority Fee).`,
      {
        chat_id:    chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "1%",       callback_data: "ss_slip_100"    },
              { text: "5%",       callback_data: "ss_slip_500"    },
              { text: "10%",      callback_data: "ss_slip_1000"   }
            ],
            [
              { text: "20%",      callback_data: "ss_slip_2000"   },
              { text: "Dynamic",  callback_data: "ss_slip_dynamic"}
            ],
            [
              { text: "◀️ Back",   callback_data: "ss_back"        },
              { text: "❌ Close",  callback_data: "ss_close"       }
            ]
          ]
        }
      }
    );
  }

  // ── Selección de Slippage ──
  if (state.stage === STAGES.SLIPPAGE && data.startsWith('ss_slip_')) {
    if (data === 'ss_slip_dynamic') {
      swapSettings.dynamicSlippage = true;
      delete swapSettings.slippageBps;
    } else {
      swapSettings.slippageBps     = parseInt(data.split('_')[2], 10);
      swapSettings.dynamicSlippage = false;
    }
    state.stage = STAGES.FEE;
    saveUsers();
    return bot.editMessageText(
      `*💰 Fee Settings*\n\n` +
      `• Mode: ${swapSettings.useExactFee ? '🔴 Exact Fee' : '🔵 Max Cap'}\n` +
      `• Current Fee: ${(swapSettings.priorityFeeLamports/1e9).toFixed(6)} SOL\n\n` +
      `• _Max Cap_: Let Jupiter automatically minimise your fee based on network conditions.\n` +
      `• _Exact Fee_: You choose the exact amount to pay for maximum priority.`,
      // Show warning for high fees in exact fee mode
      ...(swapSettings.useExactFee && swapSettings.priorityFeeLamports > 10000000 ? [{
        text: "⚠️ Warning: High fee selected. This will be expensive!",
        show_alert: true
      }] : []),
      {
        chat_id:    chatId,
        message_id: msgId,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Max Cap",   callback_data: "ss_fee_max"   }],
            [{ text: "Exact Fee", callback_data: "ss_fee_exact" }],
            [
              { text: "◀️ Back", callback_data: "ss_back"  },
              { text: "❌ Close",callback_data: "ss_close"}
            ]
          ]
        }
      }
    );
  }

  // ── Selección de Fee Type y Priority Fee ──
  if (state.stage === STAGES.FEE) {
    // 1) Elegir Max Cap vs Exact Fee
    if (data === 'ss_fee_max' || data === 'ss_fee_exact') {
      swapSettings.useExactFee = (data === 'ss_fee_exact');
      saveUsers();
      return bot.editMessageText(
        `*⚡ Priority Fee*\n` +
        `Pay more to jump ahead in the block and outpace other bots.\n\n` +
        `🏃 *Speed options:*  \n` +
        `• Fast:    0.0040 SOL  \n` +
        `• Turbo:   0.0050 SOL  \n` +
        `• Extreme: 0.0080 SOL`,
        {
          chat_id:    chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "Fast",    callback_data: "ss_fee_fast"    },
                { text: "Turbo",   callback_data: "ss_fee_turbo"   }
              ],
              [
                { text: "Extreme", callback_data: "ss_fee_extreme" }
              ],
              [
                { text: "◀️ Back",   callback_data: "ss_back"  },
                { text: "❌ Close",  callback_data: "ss_close" }
              ]
            ]
          }
        }
      );
    }

    // 2) Priority Fee fijo (Fast/Turbo/Extreme)
    if (['ss_fee_fast','ss_fee_turbo','ss_fee_extreme'].includes(data)) {
      const map = { fast: 4000000, turbo: 6000000, extreme: 8000000 };
      const key = data.split('_')[2];
      swapSettings.priorityFeeLamports = map[key];
      
      // Show warning for high fees in exact fee mode
      if (swapSettings.useExactFee && swapSettings.priorityFeeLamports > 10000000) { // 0.01 SOL
        await bot.answerCallbackQuery(query.id, {
          text: "⚠️ Warning: High fee selected. This will be expensive!",
          show_alert: true
        });
      }
      delete users[chatId].swapState;
      saveUsers();
      return bot.editMessageText(
        `✅ Manual swap settings saved! Slippage: ${(swapSettings.slippageBps/100).toFixed(2)}%, ` +
        `Fee: ${(swapSettings.priorityFeeLamports/1e9).toFixed(6)} SOL.\n` +
        `Use /swapsettings to review or change.`,
        {
          chat_id:    chatId,
          message_id: msgId,
          parse_mode: "Markdown"
        }
      );
    }
  }

}); // <-- cierre de bot.on('callback_query'

// 🔥 Cargar suscriptores al iniciar
loadUsers();

console.log("🤖 Bot de Telegram iniciado.");
