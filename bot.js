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
        const name = data.fileMeta?.name || "N/A";
        const symbol = data.fileMeta?.symbol || "N/A";
        const imageUrl = data.fileMeta?.image || "";
        const riskScore = data.score || 9999;
        const riskLevel = riskScore <= 1000 ? "🟢 GOOD" : "🔴 WARNING";
        const riskDescription = data.risks?.map(r => r.description).join(", ") || "No risks detected";
        let lpLocked = "N/A";

        if (data.markets && data.markets.length > 0) {
            lpLocked = data.markets[0].lp?.lpLockedPct || "N/A";
        }

        return { name, symbol, imageUrl, riskLevel, riskDescription, lpLocked };
    } catch (error) {
        console.error("❌ Error al obtener datos desde RugCheck:", error);
        return null;
    }
}

// 🔹 Calcular el tiempo desde la creación del par en minutos y segundos
function calculateAge(timestamp) {
    if (!timestamp) return "N/A";
    const now = Date.now();
    const elapsedMs = now - timestamp;
    const minutes = Math.floor(elapsedMs / 60000);
    const seconds = Math.floor((elapsedMs % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

// 🔹 Obtener detalles de la transacción con DexScreener y RugCheck
async function getTransactionDetails(signature) {
    try {
        const mintData = await getMintAddressFromTransaction(signature);
        if (!mintData || !mintData.mintAddress) {
            return "⚠️ No se pudo obtener el Mint Address de esta transacción.";
        }

        const dexData = await getDexScreenerData(mintData.mintAddress);
        const rugCheckData = await fetchRugCheckData(mintData.mintAddress);

        if (!dexData) {
            return `⚠️ No se pudo obtener información del token ${mintData.mintAddress}`;
        }

        const priceChange24h = dexData.priceChange24h !== "N/A"
            ? `${dexData.priceChange24h > 0 ? "🟢 +" : "🔴 "}${dexData.priceChange24h}%`
            : "N/A";

        let message = `💎 **Símbolo:** ${dexData.symbol}\n`;
        message += `💎 **Nombre:** ${dexData.name}\n`;
        message += `💲 **USD:** ${dexData.priceUsd}\n`;
        message += `💰 **SOL:** ${dexData.priceSol}\n`;
        message += `💧 **Liquidity:** $${dexData.liquidity}\n`;
        message += `📈 **Market Cap:** $${dexData.marketCap}\n`;
        message += `💹 **FDV:** $${dexData.fdv}\n\n`;

        message += `⏳ **Age:** ${calculateAge(dexData.creationTimestamp)} 📊 **24H Change:** ${priceChange24h}\n\n`;
        
        message += ` **${rugCheckData.riskLevel}:** ${rugCheckData.riskDescription}\n`;
        message += `🔒 **LPLOCKED:** ${rugCheckData.lpLocked}%\n\n`;

        // 🔹 Agregar información adicional
        message += `⛓️ **Chain:** ${dexData.chain} ⚡ **Dex:** ${dexData.dex}\n`;
        message += `📆 **Fecha de Transacción:** ${mintData.date}\n`;
        message += `🔄 **Estado:** Confirmado ✅\n\n`;

        message += `🔗 **Pair:** \`${dexData.pairAddress}\`\n`;
        message += `🔗 **Token:** \`${mintData.mintAddress}\`\n\n`;

        await notifySubscribers(message, rugCheckData.imageUrl, dexData.pairAddress, mintData.mintAddress);
    } catch (error) {
        console.error("❌ Error al consultar la transacción:", error);
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
