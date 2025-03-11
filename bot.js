import axios from "axios";
import fs from "fs";
import TelegramBot from "node-telegram-bot-api";
import { Connection } from "@solana/web3.js";

// 🔹 Configuración
const TELEGRAM_BOT_TOKEN = "8167837961:AAFipBvWbQtFWHV_uZt1lmG4CVVnc_z8qJU";
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";
const SUBSCRIBERS_FILE = "subscribers.json";
const RUGCHECK_API_BASE = "https://api.rugcheck.xyz/v1/tokens";
const connection = new Connection(SOLANA_RPC_URL, "confirmed");

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let subscribers = new Set();

// 🔥 Cargar suscriptores desde el archivo JSON
function loadSubscribers() {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
        try {
            const data = fs.readFileSync(SUBSCRIBERS_FILE, "utf8");
            subscribers = new Set(JSON.parse(data));
            console.log(`✅ ${subscribers.size} usuarios suscritos cargados.`);
        } catch (error) {
            console.error("❌ Error cargando suscriptores:", error);
        }
    }
}

// 📝 Guardar suscriptores en el archivo JSON
function saveSubscribers() {
    try {
        fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify([...subscribers], null, 2));
        console.log("📂 Subscriptores actualizados.");
    } catch (error) {
        console.error("❌ Error guardando suscriptores:", error);
    }
}

// 🔹 Comando `/start` para suscribirse a notificaciones
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    if (!subscribers.has(chatId)) {
        subscribers.add(chatId);
        saveSubscribers();
        bot.sendMessage(chatId, "🚀 Te has suscrito a las notificaciones de migraciones en Solana.");
    } else {
        bot.sendMessage(chatId, "⚠️ Ya estás suscrito.");
    }
});

// 🔹 Comando `/stop` para cancelar suscripción
bot.onText(/\/stop/, (msg) => {
    const chatId = msg.chat.id;
    if (subscribers.has(chatId)) {
        subscribers.delete(chatId);
        saveSubscribers();
        bot.sendMessage(chatId, "🛑 Has sido eliminado de las notificaciones.");
    } else {
        bot.sendMessage(chatId, "⚠️ No estabas suscrito.");
    }
});

// 🔹 Obtener Mint Address desde una transacción
async function getMintAddressFromTransaction(signature) {
    try {
        const transaction = await connection.getTransaction(signature, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed"
        });

        if (!transaction || !transaction.meta || !transaction.meta.preTokenBalances) {
            return null;
        }

        return {
            mintAddress: transaction.meta.preTokenBalances[0]?.mint || null,
            date: new Date(transaction.blockTime * 1000).toLocaleString()
        };
    } catch (error) {
        console.error("❌ Error al obtener Mint Address:", error);
        return null;
    }
}

// 🔹 Obtener datos del token desde DexScreener API
async function getDexScreenerData(mintAddress) {
    try {
        const response = await axios.get(`https://api.dexscreener.com/tokens/v1/solana/${mintAddress}`);
        if (response.data && response.data.length > 0) {
            const tokenData = response.data[0];

            return {
                name: tokenData.baseToken.name || "Desconocido",
                symbol: tokenData.baseToken.symbol || "N/A",
                priceUsd: tokenData.priceUsd || "N/A",
                priceSol: tokenData.priceNative || "N/A",
                liquidity: tokenData.liquidity?.usd || "N/A",
                marketCap: tokenData.marketCap || "N/A",
                fdv: tokenData.fdv || "N/A",
                pairAddress: tokenData.pairAddress || "N/A",
                dex: tokenData.dexId || "N/A",
                chain: tokenData.chainId || "solana",
                creationTimestamp: tokenData.pairCreatedAt || null,
                priceChange24h: tokenData.priceChange?.h24 || "N/A"
            };
        }
    } catch (error) {
        console.error("⚠️ Error al obtener datos desde DexScreener:", error.message);
    }
    return null;
}

// 🔹 Obtener datos de riesgo desde RugCheck API
async function fetchRugCheckData(tokenAddress) {
    try {
        const response = await axios.get(`${RUGCHECK_API_BASE}/${tokenAddress}/report`);
        if (!response.data) {
            return null;
        }

        const data = response.data;
        return {
            name: data.fileMeta?.name || "N/A",
            symbol: data.fileMeta?.symbol || "N/A",
            imageUrl: data.fileMeta?.image || "",
            riskLevel: data.score <= 1000 ? "GOOD" : "WARNING",
            riskDescription: data.risks?.map(r => r.description).join(", ") || "No risks detected",
            lpLocked: data.markets?.[0]?.lp?.lpLockedPct || "N/A"
        };
    } catch (error) {
        console.error("❌ Error al obtener datos desde RugCheck:", error);
        return null;
    }
}

// 🔹 Obtener detalles de la transacción
async function getTransactionDetails(signature) {
    try {
        const mintData = await getMintAddressFromTransaction(signature);
        if (!mintData || !mintData.mintAddress) return "⚠️ No se pudo obtener el Mint Address.";

        const dexData = await getDexScreenerData(mintData.mintAddress);
        const rugCheckData = await fetchRugCheckData(mintData.mintAddress);

        let message = `💎 **Símbolo:** ${dexData.symbol}\n💎 **Nombre:** ${dexData.name}\n💲 **USD:** ${dexData.priceUsd}\n💰 **SOL:** ${dexData.priceSol}\n📈 **Market Cap:** $${dexData.marketCap}\n📆 **Fecha de Transacción:** ${mintData.date}\n🔄 **Estado:** Confirmado ✅\n\n🔗 **Pair:** \`${dexData.pairAddress}\`\n🔗 **Token:** \`${mintData.mintAddress}\`\n`;

        await notifySubscribers(message, rugCheckData.imageUrl, dexData.pairAddress, mintData.mintAddress);
        return message;
    } catch (error) {
        console.error("❌ Error al obtener la información del token:", error);
        return "❌ Error al obtener la información del token.";
    }
}

// 🔹 Notificar a los suscriptores con imagen y botones
async function notifySubscribers(message, imageUrl, pairAddress, mint) {
    try {
        for (const userId of subscribers) {
            await bot.sendPhoto(userId, imageUrl || "https://default-image.com/no-image.jpg", {
                caption: message,
                parse_mode: "Markdown",
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "💸 Buy Token", url: `https://jup.ag/swap/SOL-${mint}` }],
                        [{ text: "📊 Dexscreener", url: `https://dexscreener.com/solana/${pairAddress}` }]
                    ]
                }
            });
        }
    } catch (error) {
        console.error("❌ Error enviando mensaje a Telegram:", error);
    }
}

// 🔥 Cargar suscriptores al iniciar
loadSubscribers();

// 🔹 Escuchar firmas en mensajes y consultar transacción
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (/^[A-HJ-NP-Za-km-z1-9]{87,}$/.test(text)) {
        bot.sendMessage(chatId, "🔄 Consultando transacción...");
        const details = await getTransactionDetails(text);
        bot.sendMessage(chatId, details, { parse_mode: "Markdown" });
    } else {
        bot.sendMessage(chatId, "❌ Envía una firma de transacción válida.");
    }
});

console.log("🤖 Bot de Telegram iniciado.");
