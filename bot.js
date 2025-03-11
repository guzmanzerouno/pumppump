import TelegramBot from "node-telegram-bot-api";
import { Connection } from "@solana/web3.js";
import fs from "fs-extra";

// 🔹 Configuración del bot y RPC
const TELEGRAM_BOT_TOKEN = "8167837961:AAFipBvWbQtFWHV_uZt1lmG4CVVnc_z8qJU";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const SUBSCRIBERS_FILE = "subscribers.json";

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
const connection = new Connection(SOLANA_RPC_URL, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0, // ✅ Se asegura la compatibilidad con nuevas versiones de transacciones
});

let activeUsers = new Set();

// 🔥 Cargar suscriptores desde el archivo JSON
function loadSubscribers() {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
        const data = fs.readFileSync(SUBSCRIBERS_FILE, "utf8");
        activeUsers = new Set(JSON.parse(data));
        console.log(`✅ ${activeUsers.size} usuarios suscritos cargados.`);
    }
}

// 📝 Guardar suscriptores en el archivo JSON
function saveSubscribers() {
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...activeUsers], null, 2));
}

// 🔹 Obtener datos del token desde una transacción
async function getTransactionDetails(signature) {
    try {
        console.log(`🔍 Consultando transacción: ${signature}`);

        const transaction = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0, // ✅ Se asegura la compatibilidad
        });

        if (!transaction) {
            return "❌ Transacción no encontrada. Verifica la firma.";
        }

        if (!transaction.meta || !transaction.meta.preTokenBalances) {
            return "⚠️ No se encontraron datos de token en esta transacción.";
        }

        // 🔹 Extraer información del token
        const tokenInfo = transaction.meta.preTokenBalances.map(token => ({
            mint: token.mint,
            owner: token.owner,
            uiTokenAmount: token.uiTokenAmount.uiAmountString
        }));

        let message = `📜 **Detalles del Token:**\n\n`;
        tokenInfo.forEach((token, index) => {
            message += `🔹 **Token #${index + 1}**\n`;
            message += `🪙 **Mint Address:** \`${token.mint}\`\n`;
            message += `👤 **Owner:** \`${token.owner || "N/A"}\`\n`;
            message += `💰 **Cantidad:** ${token.uiTokenAmount}\n\n`;
        });

        return message;
    } catch (error) {
        console.error("❌ Error al consultar la transacción:", error);
        return "❌ Error al obtener la información de la transacción.";
    }
}

// 🔹 Comando `/start` para suscribirse a notificaciones
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    activeUsers.add(chatId);
    saveSubscribers();
    bot.sendMessage(chatId, "🚀 Te has suscrito a las notificaciones de migraciones en Solana.");
});

// 🔹 Comando `/stop` para cancelar suscripción
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    activeUsers.delete(chatId);
    saveSubscribers();
    bot.sendMessage(chatId, "🛑 Has sido eliminado de las notificaciones.");
});

// 🔹 Escuchar firmas de transacción en mensajes
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (/^[A-Za-z0-9]{87}$/.test(text)) {
        bot.sendMessage(chatId, "🔄 Consultando datos de la transacción...");
        const details = await getTransactionDetails(text);
        bot.sendMessage(chatId, details, { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(chatId, "❌ Envía una firma de transacción válida.");
    }
});

// 🔥 Cargar suscriptores y mostrar mensaje en consola
loadSubscribers();
console.log("🤖 Bot de Telegram iniciado. Esperando firmas de transacción...");
